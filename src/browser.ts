import { Camoufox } from "camoufox";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { info, warn, step } from "./logger.ts";

const BLOCK_PATTERNS = [
  "access denied",
  "challenge validation",
  "just a moment",
  "checking your browser",
  "verify you are human",
  "px-captcha",
];

export interface LaunchOptions {
  headless?: boolean;
}

/**
 * Lanza Camoufox (Firefox anti-detección) a través de Playwright.
 * Reemplaza al Chromium de Playwright: la identidad (navigator, pantalla,
 * WebGL, fuentes, audio, WebRTC) se falsea dentro del motor y el ratón se
 * mueve de forma humana.
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  // Requisito del proyecto: navegador visible, sin headless y sin proxies.
  // En contenedores que corren como root se desactiva el sandbox de Firefox.
  const headless = opts.headless ?? process.env.CAMOUFOX_HEADLESS === "1";
  const noSandbox = process.env.PLAYWRIGHT_NO_SANDBOX === "1";
  // Opcional: coherentiza zona horaria/idioma/WebRTC con la IP de salida.
  const geoip = process.env.CAMOUFOX_GEOIP === "1";

  return Camoufox({
    headless,
    humanize: true,
    locale: ["es-ES"],
    ...(noSandbox
      ? {
          env: {
            ...process.env,
            MOZ_DISABLE_CONTENT_SANDBOX: "1",
            MOZ_DISABLE_GMP_SANDBOX: "1",
          },
        }
      : {}),
    ...(geoip ? { geoip: true } : {}),
  });
}

export async function newContext(browser: Browser): Promise<BrowserContext> {
  // Con geoip la zona horaria la fija Camoufox según la IP de salida.
  if (process.env.CAMOUFOX_GEOIP === "1") {
    return browser.newContext({ locale: "es-ES" });
  }
  return browser.newContext({
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
  });
}

export async function bodyText(page: Page): Promise<string> {
  // Expresión string (no función) para que funcione igual con tsx/esbuild y con Node nativo.
  return page
    .evaluate<string>("document.body ? document.body.innerText : ''")
    .catch(() => "");
}

export async function isBlocked(page: Page): Promise<string | null> {
  const text = (await bodyText(page)).toLowerCase();
  for (const pattern of BLOCK_PATTERNS) {
    if (text.includes(pattern)) return pattern;
  }
  return null;
}

/**
 * Si aparece un reto anti-bot, NO se intenta resolver por código:
 * se avisa y se espera a que una persona lo resuelva en la ventana visible.
 */
export async function waitPastChallenge(page: Page, timeoutMs: number): Promise<void> {
  let blocked = await isBlocked(page);
  if (!blocked) return;

  warn(`Protección anti-bot detectada ("${blocked}"). Resuélvela manualmente en la ventana del navegador.`);
  const started = Date.now();
  let last = 0;

  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(2_000);
    blocked = await isBlocked(page);
    if (!blocked) {
      info("Reto superado, continúo.");
      return;
    }
    const elapsed = Date.now() - started;
    if (elapsed - last >= 30_000) {
      last = elapsed;
      warn(`Sigue bloqueado ("${blocked}") tras ${Math.round(elapsed / 1000)}s. Esperando...`);
    }
  }

  throw new Error("La página sigue bloqueada por anti-bot; no se continúa.");
}

export async function dismissCookies(page: Page): Promise<void> {
  for (const name of [/^Rechazar$/i, /^Aceptar$/i]) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5_000 }).catch(() => {});
      info(`Banner de cookies: ${name.source}`);
      await page.waitForTimeout(600);
      return;
    }
  }
}

export async function snap(page: Page, dir: string, label: string): Promise<string> {
  const out = join(dir, label);
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, "page.png"), fullPage: true }).catch(() => {});
  writeFileSync(join(out, "page.html"), await page.content().catch(() => ""), "utf8");
  writeFileSync(
    join(out, "page.txt"),
    `${page.url()}\n\n${await bodyText(page)}`,
    "utf8",
  );
  return out;
}

export async function stepSnap(page: Page, dir: string, label: string): Promise<void> {
  const path = await snap(page, dir, label);
  step(`Captura: ${path}`);
}
