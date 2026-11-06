import type { Page } from "playwright-core";
import { launchBrowser, newContext } from "./browser.ts";

const email = process.argv[2] ?? "";
if (!email) {
  console.error("Uso: tsx src/probe-register2.ts <email>");
  process.exit(1);
}
const hardStop = setTimeout(() => {
  console.log("HARD_TIMEOUT");
  process.exit(2);
}, 100_000);
hardStop.unref();

async function tail(page: Page): Promise<string> {
  const t = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  return t.replace(/\s+/g, " ").slice(-450);
}

async function main(): Promise<void> {
  const browser = await launchBrowser();
  const context = await newContext(browser);
  const page = await context.newPage();

  let lastStatus = 0;
  let lastBody = "";
  page.on("response", async (res) => {
    if (!res.url().includes("/reset-password")) return;
    lastStatus = res.status();
    lastBody = (await res.text().catch(() => "")).slice(0, 400);
    console.log("RESET", lastStatus, lastBody);
  });

  await page.goto("https://login.basic-fit.com/register", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  const reject = page.getByRole("button", { name: /^Rechazar$/i }).first();
  if (await reject.count()) await reject.click().catch(() => {});

  const input = page.getByLabel(/Correo electr[oó]nico/i).or(page.locator('input[type="email"]')).first();
  await input.fill(email);
  await page.waitForTimeout(500);

  await page.getByRole("button", { name: /^Continuar$/i }).first().click();
  await page.waitForTimeout(12_000);
  console.log("AFTER1", lastStatus, await tail(page));
  console.log("COOKIES1", (await context.cookies()).map((c) => c.name).join(","));

  if (lastStatus === 428) {
    console.log("RETRY en 8s...");
    await page.waitForTimeout(8_000);
    await page.getByRole("button", { name: /^Continuar$/i }).first().click();
    await page.waitForTimeout(12_000);
    console.log("AFTER2", lastStatus, await tail(page));
    console.log("COOKIES2", (await context.cookies()).map((c) => c.name).join(","));
  }

  await browser.close();
  clearTimeout(hardStop);
  process.exit(0);
}

main().catch((e) => {
  console.log("ERR", (e as Error).message);
  process.exit(1);
});
