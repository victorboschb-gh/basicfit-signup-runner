import type { Page } from "playwright-core";
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

    const emailInput = page
      .getByLabel(/Correo electr[oó]nico/i)
      .or(page.locator('input[name="email"], input[type="email"]'))
      .first();
    // La app es React: domcontentloaded puede llegar antes de que pinte el formulario.
    await emailInput.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    await stepSnap(page, runDir, "05-register");

    const text = await bodyText(page);
    if (!/contrase[ñn]a|correo electr[oó]nico/i.test(text)) {
      throw new Error("No parece la pantalla de registro/establecer contraseña");
    }

    await emailInput.fill(mailbox.address);
    info(`Email introducido: ${mailbox.address}`);

    const actualEmail = await emailInput.inputValue();
    if (actualEmail !== mailbox.address) {
      throw new Error(`Email no verificado: esperado "${mailbox.address}", leído "${actualEmail}"`);
    }

    const continueButton = page
      .locator("#root")
      .getByRole("button", { name: /^Continuar$/i })
      .first();
    info(`Botón Continuar habilitado: ${await continueButton.isEnabled().catch(() => false)}`);
    await stepSnap(page, runDir, "06-register-email");

    if (config.mode === "audit") {
      warn("MODO AUDIT: email relleno, NO se pulsa Continuar. Revisa la captura y ejecuta con --mode=live.");
      return null;
    }

    const submit = page
      .locator("#root")
      .getByRole("button", { name: /^Continuar$/i })
      .first();
    const resetResponse = page
      .waitForResponse(
        (r) => r.url().includes("/reset-password") && r.request().method() === "POST",
        { timeout: 45_000 },
      )
      .catch(() => null);

    await submit.click();
    const resetResp = await resetResponse;
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    await stepSnap(page, runDir, "07-register-enviado");

    const afterSubmit = await bodyText(page);
    info(
      `Tras Continuar: ${page.url()} ${
        resetResp ? `(reset-password HTTP ${resetResp.status()})` : "(sin respuesta de reset-password)"
      }`,
    );

    if (resetResp?.status() === 428) {
      await stepSnap(page, runDir, "07-register-bloqueado");
      throw new Error(
        "Basic-Fit bloqueó el registro con un reto anti-bot (HTTP 428, Check Point). " +
          "Este paso necesita una persona en un navegador normal; no se espera el correo.",
      );
    }
    if (/algo ha ido mal|int[eé]ntalo de nuevo/i.test(afterSubmit)) {
      await stepSnap(page, runDir, "07-register-bloqueado");
      throw new Error(
        "El registro devolvió 'Algo ha ido mal' (reto anti-bot). " +
          "Este paso necesita una persona en un navegador normal; no se espera el correo.",
      );
    }
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
  // Igual que en el registro: espera a que React pinte antes de buscar campos.
  await passwordPage
    .waitForFunction(
      "() => /contrase[ñn]a|correo electr[oó]nico/i.test(document.body ? document.body.innerText : '')",
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
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

  // Solo botones de la app (#root); el banner de Cookiebot tiene sus propios submit.
  const submitPassword = passwordPage
    .locator('#root button[data-cy="submit-button"], #root button[type="submit"]')
    .first();
  if ((await submitPassword.count()) === 0) {
    throw new Error("No encuentro el botón para guardar la contraseña");
  }
  await submitPassword.click();

  await passwordPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await passwordPage.waitForTimeout(3_000);
  await stepSnap(passwordPage, runDir, "11-final");

  const finalText = await bodyText(passwordPage);
  const success =
    /contrase[ñn]a.*(creada|establecida|actualizada|guardada)|finalizado con [eé]xito|nueva contrase[ñn]a|tu cuenta est[aá] lista|bienvenid|inicia sesi[oó]n/i.test(
      finalText,
    );
  if (success) {
    ok(`Contraseña creada. Pantalla final: ${passwordPage.url()}`);
  } else {
    const visiblePasswords = await passwordPage
      .locator('input[type="password"]')
      .evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).length)
      .catch(() => 0);
    if (visiblePasswords > 0) {
      throw new Error(
        "El formulario de contraseña sigue visible tras enviarlo: no se estableció la contraseña.",
      );
    }
    warn(`No reconozco confirmación explícita. Revisa 11-final. URL: ${passwordPage.url()}`);
  }

  return { passwordEmail, link };
}
