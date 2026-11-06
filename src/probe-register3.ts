import type { Page, Response } from "playwright-core";
import { launchBrowser, newContext } from "./browser.ts";

const email = process.argv[2] ?? "";
if (!email) {
  console.error("Uso: tsx src/probe-register3.ts <email>");
  process.exit(1);
}
const hardStop = setTimeout(() => {
  console.log("HARD_TIMEOUT");
  process.exit(2);
}, 150_000);
hardStop.unref();

async function attempt(page: Page, label: string): Promise<number> {
  let status = 0;
  const handler = async (res: Response) => {
    if (res.url().includes("/reset-password")) {
      status = res.status();
      console.log(`${label} RESET ${status}`, (await res.text().catch(() => "")).slice(0, 200));
    }
  };
  page.on("response", handler);

  const input = page.getByLabel(/Correo electr[oó]nico/i).or(page.locator('input[type="email"]')).first();
  await input.fill(email);
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /^Continuar$/i }).first().click();
  await page.waitForTimeout(15_000);
  const text = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  console.log(`${label} STATUS ${status} TAIL ${text.replace(/\s+/g, " ").slice(-250)}`);
  page.off("response", handler);
  return status;
}

async function abck(page: Page): Promise<string> {
  const cookies = await page.context().cookies("https://login.basic-fit.com");
  const c = cookies.find((x) => x.name === "_abck");
  return c ? `len=${c.value.length} tail=${c.value.slice(-8)}` : "sin _abck";
}

async function main(): Promise<void> {
  const browser = await launchBrowser();
  const context = await newContext(browser);
  const page = await context.newPage();

  await page.goto("https://login.basic-fit.com/register", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const reject = page.getByRole("button", { name: /^Rechazar$/i }).first();
  if (await reject.count()) await reject.click().catch(() => {});
  console.log("ABCK inicial", await abck(page));

  const first = await attempt(page, "A1");
  console.log("ABCK tras A1", await abck(page));

  // Dejar que el reto termine y recargar la página con las cookies nuevas.
  await page.waitForTimeout(25_000);
  console.log("ABCK tras espera", await abck(page));
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const reject2 = page.getByRole("button", { name: /^Rechazar$/i }).first();
  if (await reject2.count()) await reject2.click().catch(() => {});

  const second = await attempt(page, "A2");
  console.log("ABCK tras A2", await abck(page));
  console.log("RESULTADO", { first, second });

  await browser.close();
  clearTimeout(hardStop);
  process.exit(0);
}

main().catch((e) => {
  console.log("ERR", (e as Error).message);
  process.exit(1);
});
