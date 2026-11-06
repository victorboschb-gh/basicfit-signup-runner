import type { Page } from "playwright";
import type { AppConfig } from "../config.ts";
import type { Mailbox, MailMessage } from "../mail/types.ts";
import { info, ok, warn, step, error } from "../logger.ts";
import { dismissCookies, stepSnap, waitPastChallenge, bodyText } from "../browser.ts";

export interface SignupResult {
  email: MailMessage | null;
}

export interface SignupOptions {
  /** El formulario ya se envió en una ejecución anterior: solo esperar el correo. */
  skipSubmit?: boolean;
  /** Se invoca justo después de pulsar Enviar (para persistir el estado). */
  onSubmitted?: () => Promise<void>;
}

async function fillByLabel(
  page: Page,
  label: RegExp,
  value: string,
  fallbackSelector: string,
  fieldName: string,
): Promise<void> {
  const byLabel = page.getByLabel(label).first();
  if ((await byLabel.count()) > 0 && (await byLabel.isVisible().catch(() => false))) {
    await byLabel.fill(value);
    info(`${fieldName}: rellenado por etiqueta ${label}`);
    return;
  }

  const fallback = page.locator(fallbackSelector).first();
  if ((await fallback.count()) > 0) {
    await fallback.fill(value);
    warn(`${fieldName}: etiqueta no encontrada, usado selector ${fallbackSelector}`);
    return;
  }

  throw new Error(`No encuentro el campo "${fieldName}"`);
}

async function ensureChecked(page: Page, name: RegExp, fieldName: string): Promise<void> {
  // 1) Caso nativo/accesible: el nombre accesible contiene el texto.
  let box = page.getByRole("checkbox", { name }).first();

  // 2) El formulario real usa div[role=checkbox] con aria-labelledby a un id
  //    dinámico; el nombre accesible queda roto. Se localiza por el texto
  //    visible y se sube al contenedor .group que aloja el checkbox.
  if ((await box.count()) === 0) {
    const label = page.getByText(name).first();
    if ((await label.count()) === 0) throw new Error(`No encuentro el texto del checkbox "${fieldName}"`);
    const group = label.locator("xpath=ancestor::div[contains(@class,'group')][1]");
    box = group.locator('[role="checkbox"]').first();
  }

  if ((await box.count()) === 0) throw new Error(`No encuentro el checkbox "${fieldName}"`);

  const ariaChecked = await box.getAttribute("aria-checked");
  if (ariaChecked === "true") {
    info(`${fieldName}: ya estaba marcado`);
    return;
  }

  await box.click();
  await page.waitForTimeout(300);

  const after = await box.getAttribute("aria-checked");
  if (after !== "true") {
    const checked = await box.isChecked().catch(() => false);
    if (!checked) throw new Error(`No se pudo marcar "${fieldName}"`);
  }
  info(`${fieldName}: marcado`);
}

async function resolveCountryLanguage(page: Page): Promise<void> {
  if (!page.url().includes("language-country")) return;

  step("Selector de país/idioma detectado: España + Español");
  const selects = page.locator("select");
  if ((await selects.count()) < 2) {
    throw new Error("No encuentro los dos selectores de país/idioma");
  }

  await selects.nth(0).selectOption({ value: "ES" });
  await page.waitForTimeout(400);
  await selects.nth(1).selectOption({ value: "es-ES" });
  await page.waitForTimeout(400);

  const choose = page
    .getByRole("link", { name: /^Elegir$/i })
    .or(page.getByRole("button", { name: /^Elegir$/i }))
    .first();

  if ((await choose.count()) > 0) {
    const href = await choose.getAttribute("href").catch(() => null);
    info(`Elegir -> ${href ?? "(botón)"}`);
    await choose.click();
  } else {
    const url = new URL(page.url());
    url.pathname = "/es-ES/signup/BlackFriday_FitTogether";
    url.searchParams.set("bf-locale", "es-ES");
    url.searchParams.set("bf-country", "ES");
    warn(`Enlace "Elegir" no disponible; navego a ${url.toString()}`);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2_500);
}

async function waitForSignupEmail(
  mailbox: Mailbox,
  config: AppConfig,
  startedAt: string,
  excludeIds: string[],
): Promise<MailMessage> {
  return mailbox.waitForMessage({
    label: "correo de alta / código QR de Basic-Fit",
    timeoutMs: config.mailWaitMs,
    since: startedAt,
    excludeIds,
    match: (m) => /basic-?fit/i.test(`${m.from.address} ${m.subject} ${m.text}`),
  });
}

export async function runSignup(
  page: Page,
  config: AppConfig,
  mailbox: Mailbox,
  runDir: string,
  startedAt: string,
  excludeIds: string[],
  options: SignupOptions = {},
): Promise<SignupResult> {
  const person = config.person;

  if (options.skipSubmit) {
    info("El alta ya se envió en una ejecución anterior; salto al correo.");
  } else {
    step("PASO 1/5 — Alta en member.basic-fit.com");
    const response = await page.goto(config.signupUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    info(`HTTP ${response?.status() ?? "?"} ${page.url()}`);

    await waitPastChallenge(page, config.challengeWaitMs);
    await dismissCookies(page);
    await resolveCountryLanguage(page);
    await waitPastChallenge(page, config.challengeWaitMs);
    await dismissCookies(page);

    const heading = await bodyText(page);
    if (!/ENTRENA 2 SEMANAS GRATIS|Nombre/i.test(heading)) {
      await stepSnap(page, runDir, "01-formulario-inesperado");
      throw new Error("No parece el formulario de alta esperado");
    }
    await stepSnap(page, runDir, "01-formulario");

    step("Rellenando datos personales");
    await fillByLabel(page, /Nombre/i, person.firstName, 'input[name="firstName"]', "Nombre");
    await fillByLabel(page, /Apellido/i, person.lastName, 'input[name="lastName"]', "Apellido");
    await fillByLabel(
      page,
      /Fecha de nacimiento/i,
      person.birthDate,
      'input[name="dateOfBirth"], input[type="date"]',
      "Fecha de nacimiento",
    );
    await fillByLabel(
      page,
      /Correo electr[oó]nico/i,
      mailbox.address,
      'input[name="email"], input[type="email"]',
      "Correo electrónico",
    );

    await ensureChecked(page, /al menos 16/i, "Declaro que tengo al menos 16 años");
    await ensureChecked(page, /T[eé]rminos y condiciones/i, "Acepto términos y condiciones");

    // Verificación programática: lo que se ve en pantalla es lo que se envía.
    const checks: Array<[RegExp, string, string, string]> = [
      [/Nombre/i, person.firstName, 'input[name="firstName"]', "Nombre"],
      [/Apellido/i, person.lastName, 'input[name="lastName"]', "Apellido"],
      [/Fecha de nacimiento/i, person.birthDate, 'input[name="dateOfBirth"]', "Fecha de nacimiento"],
      [/Correo electr[oó]nico/i, mailbox.address, 'input[name="email"]', "Correo electrónico"],
    ];
    for (const [re, expected, fallback, field] of checks) {
      const byLabel = page.getByLabel(re).first();
      const input = (await byLabel.count()) > 0 ? byLabel : page.locator(fallback).first();
      const actual = await input.inputValue();
      if (actual !== expected) {
        throw new Error(`Verificación fallida en "${field}": esperado "${expected}", leído "${actual}"`);
      }
      info(`${field}: valor verificado`);
    }

    await stepSnap(page, runDir, "02-formulario-relleno");

    if (config.mode === "audit") {
      warn("MODO AUDIT: formulario relleno, NO se pulsa Enviar. Revisa la captura y ejecuta con --mode=live.");
      return { email: null };
    }

    step("Enviando el formulario (correo desechable)");
    const submit = page.getByRole("button", { name: /^Enviar$/i }).first();
    await submit.click();
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3_000);
    await waitPastChallenge(page, config.challengeWaitMs);
    await stepSnap(page, runDir, "03-enviado");

    const afterSubmit = await bodyText(page);
    info(`Tras enviar: ${page.url()}`);
    if (/ya est[aá] registrad|ya existe/i.test(afterSubmit)) {
      throw new Error("Ese correo ya está registrado; no se enviará el alta");
    }
    if (/error|no se ha podido|inv[aá]lid/i.test(afterSubmit)) {
      error("La web ha mostrado un posible error tras el envío", { texto: afterSubmit.slice(0, 800) });
    }

    await options.onSubmitted?.();
  }

  step("PASO 2/5 — Esperando el correo de confirmación (código QR)");
  let email: MailMessage;
  try {
    email = await waitForSignupEmail(mailbox, config, startedAt, excludeIds);
  } catch (e) {
    await stepSnap(page, runDir, "04-sin-correo");
    throw e;
  }

  ok(`Correo de alta recibido: "${email.subject}"`);
  return { email };
}
