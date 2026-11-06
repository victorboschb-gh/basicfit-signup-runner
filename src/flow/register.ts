import type { Page } from "playwright";
import type { AppConfig } from "../config.ts";
import type { Mailbox, MailMessage } from "../mail/types.ts";
import { info, ok, warn, step, error } from "../logger.ts";
import { dismissCookies, stepSnap, waitPastChallenge, bodyText } from "../browser.ts";
import { extractLinks, pickPasswordLink, scorePasswordLink } from "../mail/links.ts";

export interface RegisterResult {
  passwordEmail: MailMessage;
  link: string;
}

export interface RegisterOptions {
  /** El correo de contraseña ya se solicitó antes: solo esperar y abrir el enlace. */
  skipSubmit?: boolean;
  /** Se invoca justo después de pulsar Continuar. */
  onSubmitted?: () => Promise<void>;
}

async function waitForPasswordEmail(
  mailbox: Mailbox,
  config: AppConfig,
  startedAt: string,
  excludeIds: string[],
): Promise<MailMessage> {
  return mailbox.waitForMessage({
    label: "correo para crear la contraseña",
    timeoutMs: config.mailWaitMs,
    since: startedAt,
    excludeIds,
    match: (m) =>
      /basic-?fit/i.test(`${m.from.address} ${m.text}`) ||
      /contrase[ñn]a|password|wachtwoord|mot de passe/i.test(`${m.subject} ${m.text}`),
  });
}

async function fillVisiblePasswordFields(page: Page, password: string): Promise<number> {
  const inputs = page.locator('input[type="password"]');
  const count = await inputs.count();
  let filled = 0;

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    await input.fill(password);
    filled++;
  }

  if (filled === 0) {
    const byLabel = page.getByLabel(/contrase[ñn]a/i);
    const labelCount = await byLabel.count();
    for (let i = 0; i < labelCount; i++) {
      const input = byLabel.nth(i);
      if (!(await input.isVisible().catch(() => false))) continue;
      await input.fill(password);
      filled++;
    }
  }

  return filled;
}

export async function runRegister(
  page: Page,
  config: AppConfig,
  mailbox: Mailbox,
  runDir: string,
  startedAt: string,
  excludeIds: string[],
  options: RegisterOptions = {},
): Promise<RegisterResult | null> {
  if (options.skipSubmit) {
    info("La solicitud de contraseña ya se envió en una ejecución anterior; salto al correo.");
  } else {
    step("PASO 3/5 — Registro en login.basic-fit.com/register con el mismo correo");
    const response = await page.goto(config.registerUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    info(`HTTP ${response?.status() ?? "?"} ${page.url()}`);
    await waitPastChallenge(page, config.challengeWaitMs);
    await dismissCookies(page);
    await stepSnap(page, runDir, "05-register");

    const text = await bodyText(page);
    if (!/contrase[ñn]a|correo electr[oó]nico/i.test(text)) {
      throw new Error("No parece la pantalla de registro/establecer contraseña");
    }

    const emailInput = page
      .getByLabel(/Correo electr[oó]nico/i)
      .or(page.locator('input[name="email"], input[type="email"]'))
      .first();
    await emailInput.fill(mailbox.address);
    info(`Email introducido: ${mailbox.address}`);

    const actualEmail = await emailInput.inputValue();
    if (actualEmail !== mailbox.address) {
      throw new Error(`Email no verificado: esperado "${mailbox.address}", leído "${actualEmail}"`);
    }

    const continueButton = page.getByRole("button", { name: /^Continuar$/i }).first();
    info(`Botón Continuar habilitado: ${await continueButton.isEnabled().catch(() => false)}`);
    await stepSnap(page, runDir, "06-register-email");

    if (config.mode === "audit") {
      warn("MODO AUDIT: email relleno, NO se pulsa Continuar. Revisa la captura y ejecuta con --mode=live.");
      return null;
    }

    const submit = page.getByRole("button", { name: /^Continuar$/i }).first();
    await submit.click();
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    await waitPastChallenge(page, config.challengeWaitMs);
    await stepSnap(page, runDir, "07-register-enviado");

    const afterSubmit = await bodyText(page);
    info(`Tras Continuar: ${page.url()}`);
    if (/no (existe|encontramos)|no est[aá] registrad/i.test(afterSubmit)) {
      throw new Error("La web no reconoce ese correo como registrado; el alta del paso 1 no llegó a crear la cuenta");
    }
    if (/error|inv[aá]lid/i.test(afterSubmit)) {
      error("Posible error al solicitar el correo de contraseña", { texto: afterSubmit.slice(0, 800) });
    }

    await options.onSubmitted?.();
  }

  step("PASO 4/5 — Esperando el correo para crear la contraseña");
  let passwordEmail: MailMessage;
  try {
    passwordEmail = await waitForPasswordEmail(mailbox, config, startedAt, excludeIds);
  } catch (e) {
    await stepSnap(page, runDir, "08-sin-correo-password");
    throw e;
  }

  ok(`Correo de contraseña recibido: "${passwordEmail.subject}"`);
  const links = extractLinks(passwordEmail);
  info(`Enlaces encontrados en el correo (${links.length}):`, links.slice(0, 15));

  const link = pickPasswordLink(passwordEmail);
  if (!link) throw new Error("El correo de contraseña no contiene ningún enlace");

  const ordered = [...links].sort((a, b) => scorePasswordLink(b) - scorePasswordLink(a));
  info("Enlace elegido", { link, alternativas: ordered.slice(1, 5) });

  step("PASO 5/5 — Abriendo el enlace en el MISMO contexto y creando la contraseña");
  const context = page.context();
  const passwordPage = await context.newPage();
  await passwordPage.goto(link, { waitUntil: "domcontentloaded", timeout: 90_000 });
  info(`HTTP enlace -> ${passwordPage.url()}`);
  await waitPastChallenge(passwordPage, config.challengeWaitMs);
  await dismissCookies(passwordPage);
  await stepSnap(passwordPage, runDir, "09-password-page");

  // Algunos enlaces piden confirmar el email antes de la contraseña.
  const emailField = passwordPage
    .getByLabel(/Correo electr[oó]nico/i)
    .or(passwordPage.locator('input[type="email"]'))
    .first();
  if ((await emailField.count()) > 0 && (await emailField.isVisible().catch(() => false))) {
    const current = await emailField.inputValue().catch(() => "");
    if (!current) {
      await emailField.fill(mailbox.address);
      info("Email completado en la pantalla de contraseña");
    }
  }

  const filled = await fillVisiblePasswordFields(passwordPage, config.password);
  if (filled === 0) {
    await stepSnap(passwordPage, runDir, "10-sin-campos-password");
    throw new Error("No encuentro campos de contraseña en la página del enlace");
  }
  info(`Campos de contraseña rellenados: ${filled}`);
  await stepSnap(passwordPage, runDir, "10-password-relleno");

  const submitPassword = passwordPage
    .getByRole("button", {
      name: /^(Continuar|Guardar|Establecer|Crear|Confirmar|Aceptar|Enviar|Hecho)$/i,
    })
    .first();
  if ((await submitPassword.count()) === 0) {
    const fallback = passwordPage.locator('button[type="submit"]').first();
    if ((await fallback.count()) === 0) throw new Error("No encuentro el botón para guardar la contraseña");
    await fallback.click();
  } else {
    await submitPassword.click();
  }

  await passwordPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await passwordPage.waitForTimeout(3_000);
  await stepSnap(passwordPage, runDir, "11-final");

  const finalText = await bodyText(passwordPage);
  const success =
    /contrase[ñn]a.*(creada|establecida|actualizada|guardada)|tu cuenta est[aá] lista|bienvenid|inicia sesi[oó]n/i.test(
      finalText,
    );
  if (success) {
    ok(`Contraseña creada. Pantalla final: ${passwordPage.url()}`);
  } else {
    warn(`No reconozco confirmación explícita. Revisa 11-final. URL: ${passwordPage.url()}`);
  }

  return { passwordEmail, link };
}
