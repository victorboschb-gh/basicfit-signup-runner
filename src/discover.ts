import "dotenv/config";
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initLogging, info, ok, warn, error, step, runDirectory } from "./logger.ts";

const TARGETS = [
  {
    name: "signup",
    url: process.env.SIGNUP_URL ?? "https://member.basic-fit.com/es-ES/signup/BlackFriday_FitTogether",
  },
  {
    name: "register",
    url: process.env.REGISTER_URL ?? "https://login.basic-fit.com/register",
  },
];

type FieldInfo = {
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  autocomplete: string | null;
  label: string | null;
  required: boolean;
  visible: boolean;
  valueLength: number;
};

async function describePage(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };

    const labelFor = (el: Element): string | null => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l?.textContent?.trim()) return l.textContent.trim().replace(/\s+/g, " ");
      }
      const wrapping = el.closest("label");
      if (wrapping?.textContent?.trim()) return wrapping.textContent.trim().replace(/\s+/g, " ");
      return null;
    };

    const fields = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter((el) => (el as HTMLInputElement).type !== "hidden")
      .map((el) => {
        const input = el as HTMLInputElement;
        return {
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          name: el.getAttribute("name"),
          id: el.getAttribute("id"),
          placeholder: el.getAttribute("placeholder"),
          ariaLabel: el.getAttribute("aria-label"),
          autocomplete: el.getAttribute("autocomplete"),
          label: labelFor(el),
          required: input.required === true,
          visible: visible(el),
          valueLength: (input.value ?? "").length,
        };
      });

    const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=submit], a"))
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120),
        ariaLabel: el.getAttribute("aria-label"),
        href: el.getAttribute("href"),
        type: el.getAttribute("type"),
        disabled: (el as HTMLButtonElement).disabled === true,
      }))
      .filter((b) => b.text || b.ariaLabel);

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, legend"))
      .filter(visible)
      .map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 200) }));

    const bodyText = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 6000);

    return {
      title: document.title,
      url: location.href,
      lang: document.documentElement.lang,
      headings,
      fields,
      buttons,
      bodyText,
      forms: Array.from(document.forms).map((f) => ({
        action: f.getAttribute("action"),
        method: f.getAttribute("method"),
        id: f.getAttribute("id"),
        inputCount: f.querySelectorAll("input,select,textarea").length,
      })),
      iframes: Array.from(document.querySelectorAll("iframe")).map((f) => f.getAttribute("src")),
      hasShadowRoots: Array.from(document.querySelectorAll("*")).some((el) => el.shadowRoot !== null),
    };
  });
}

function detectChallenge(page: Page, bodyText: string): string | null {
  const signals = [
    "Challenge Validation",
    "Just a moment",
    "Checking your browser",
    "Verify you are human",
    "Access Denied",
    "captcha",
    "px-captcha",
  ];
  const title = page.url();
  for (const s of signals) {
    if (bodyText.toLowerCase().includes(s.toLowerCase())) return s;
  }
  if (/\/register$/.test(title) && bodyText.trim().length < 200) return "pagina casi vacia";
  return null;
}

async function probe(browser: Browser, target: { name: string; url: string }): Promise<void> {
  step(`Abriendo ${target.name}: ${target.url}`);
  const context = await browser.newContext({
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  const out = join(runDirectory(), `discover-${target.name}`);
  mkdirSync(out, { recursive: true });

  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on("response", (r) => {
    if (r.status() >= 400) consoleLines.push(`HTTP ${r.status()} ${r.url()}`);
  });

  try {
    const response = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    info(`HTTP ${response?.status() ?? "?"} ${page.url()}`);

    // Dar tiempo a que un challenge JS se resuelva solo (sin interactuar).
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(2_000);
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      const challenge = detectChallenge(page, text);
      if (!challenge) break;
      warn(`Challenge detectado (${challenge}), esperando... intento ${i + 1}/6`);
    }

    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => warn("networkidle no alcanzado"));
    await page.waitForTimeout(1_000);

    const infoPage = await describePage(page);
    const text = infoPage.bodyText;
    const challenge = detectChallenge(page, text);

    if (challenge) {
      error(`Sigue habiendo protección anti-bot: ${challenge}`);
    } else {
      ok(`Página accesible. Título: ${infoPage.title}`);
    }

    info("Resumen de campos", infoPage.fields);
    info("Botones/links visibles", infoPage.buttons.slice(0, 40));
    info("Encabezados", infoPage.headings);

    writeFileSync(join(out, "page.json"), JSON.stringify(infoPage, null, 2), "utf8");
    writeFileSync(join(out, "console.log"), consoleLines.join("\n"), "utf8");
    writeFileSync(join(out, "page.html"), await page.content(), "utf8");
    await page.screenshot({ path: join(out, "page.png"), fullPage: true });

    if (process.env.HEADFUL === "1") {
      info("HEADFUL=1: dejo el navegador 20s abierto para inspección manual.");
      await page.waitForTimeout(20_000);
    }
    info(`Artefactos en ${out}`);
  } catch (e) {
    error(`Fallo abriendo ${target.name}`, { message: (e as Error).message });
    writeFileSync(join(out, "console.log"), consoleLines.join("\n"), "utf8");
    await page.screenshot({ path: join(out, "error.png"), fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const dir = join(process.cwd(), "runs", `discover-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  initLogging(dir);
  info(`Salida: ${dir}`);

  const browser = await chromium.launch({ headless: process.env.HEADFUL !== "1" });

  const only = process.env.ONLY;
  for (const t of TARGETS) {
    if (only && only !== t.name) continue;
    await probe(browser, t);
  }

  await browser.close();
}

main().catch((e) => {
  error("Error fatal", { message: (e as Error).message, stack: (e as Error).stack });
  process.exitCode = 1;
});
