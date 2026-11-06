import "dotenv/config";
import type { Page } from "playwright-core";
import { launchBrowser, newContext } from "./browser.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initLogging, info, ok, warn, step, runDirectory } from "./logger.ts";

const SIGNUP_URL =
  process.env.SIGNUP_URL ?? "https://member.basic-fit.com/es-ES/signup/BlackFriday_FitTogether";

async function dump(page: Page, label: string): Promise<void> {
  const out = join(runDirectory(), label);
  mkdirSync(out, { recursive: true });
  const data = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
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
    return {
      title: document.title,
      url: location.href,
      headings: Array.from(document.querySelectorAll("h1,h2,h3,legend"))
        .filter(isVisible)
        .map((e) => ({ tag: e.tagName.toLowerCase(), text: (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 200) })),
      fields: Array.from(document.querySelectorAll("input,select,textarea"))
        .filter((e) => (e as HTMLInputElement).type !== "hidden")
        .map((e) => ({
          tag: e.tagName.toLowerCase(),
          type: e.getAttribute("type"),
          name: e.getAttribute("name"),
          id: e.getAttribute("id"),
          placeholder: e.getAttribute("placeholder"),
          ariaLabel: e.getAttribute("aria-label"),
          autocomplete: e.getAttribute("autocomplete"),
          inputMode: e.getAttribute("inputmode"),
          label: labelFor(e),
          required: (e as HTMLInputElement).required === true,
          visible: isVisible(e),
          options:
            e.tagName === "SELECT"
              ? Array.from((e as HTMLSelectElement).options).map((o) => ({ value: o.value, text: o.text.trim() }))
              : undefined,
        })),
      buttons: Array.from(document.querySelectorAll("button,[role=button],input[type=submit],a"))
        .filter(isVisible)
        .map((e) => ({
          tag: e.tagName.toLowerCase(),
          text: (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
          ariaLabel: e.getAttribute("aria-label"),
          href: e.getAttribute("href"),
          type: e.getAttribute("type"),
          disabled: (e as HTMLButtonElement).disabled === true,
        }))
        .filter((b) => b.text || b.ariaLabel),
      bodyText: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 8000),
    };
  });
  writeFileSync(join(out, "page.json"), JSON.stringify(data, null, 2), "utf8");
  writeFileSync(join(out, "page.html"), await page.content(), "utf8");
  await page.screenshot({ path: join(out, "page.png"), fullPage: true });
  info(`[${label}] ${data.title} -> ${data.url}`);
  info(`[${label}] headings`, data.headings);
  info(`[${label}] fields`, data.fields);
  info(`[${label}] botones`, data.buttons.slice(0, 25));
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(2_500);
}

async function main(): Promise<void> {
  const dir = join(process.cwd(), "runs", `probe-signup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  initLogging(dir);
  const browser = await launchBrowser();
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    step(`Abriendo ${SIGNUP_URL}`);
    const resp = await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    info(`HTTP ${resp?.status() ?? "?"}`);
    await settle(page);
    await dump(page, "01-aterrizaje");

    if (page.url().includes("language-country")) {
      // Cookie banner, si aparece
      const reject = page.getByRole("button", { name: /^Rechazar$/i });
      if (await reject.count()) {
        await reject.first().click().catch(() => {});
        await page.waitForTimeout(800);
      }
      const selects = page.locator("select");
      const n = await selects.count();
      info(`Selects encontrados: ${n}`);
      for (let i = 0; i < n; i++) {
        const opts = await selects.nth(i).locator("option").allTextContents();
        info(`Select ${i + 1}`, opts.map((t) => t.trim()));
      }
      if (n >= 2) {
        await selects.nth(0).selectOption({ label: "España" });
        await page.waitForTimeout(400);
        const langOpts = await selects.nth(1).locator("option").allTextContents();
        info("Idiomas tras elegir España", langOpts.map((t) => t.trim()));
        const spanish = langOpts.find((t) => /espa[ñn]ol|spanish/i.test(t));
        if (spanish) await selects.nth(1).selectOption({ label: spanish.trim() });
        await page.waitForTimeout(400);
        const choose = page.getByRole("link", { name: /^Elegir$/i }).or(page.getByRole("button", { name: /^Elegir$/i }));
        const href = await choose.first().getAttribute("href").catch(() => null);
        info(`Destino de Elegir: ${href ?? "(sin href)"}`);
        await dump(page, "02-idioma-seleccionado");
        await choose.first().click();
        await settle(page);
        await dump(page, "03-tras-elegir");
      }
    }

    const text = await page.evaluate(() => document.body.innerText);
    if (/access denied|challenge validation/i.test(text)) warn("Página bloqueada por anti-bot");

    info("Esperando 25s con el navegador abierto para revisión manual (sin enviar formularios).");
    await page.waitForTimeout(25_000);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
