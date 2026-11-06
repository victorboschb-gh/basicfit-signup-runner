import "dotenv/config";
import { launchBrowser, newContext } from "./browser.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  process.env.SIGNUP_URL ?? "https://member.basic-fit.com/es-ES/signup/BlackFriday_FitTogether",
  process.env.REGISTER_URL ?? "https://login.basic-fit.com/register",
];

async function main(): Promise<void> {
  const browser = await launchBrowser();
  const context = await newContext(browser);

  const out: unknown[] = [];
  for (const url of TARGETS) {
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForTimeout(5_000);
      const title = await page.title();
      const text = await page.evaluate<string>("document.body ? document.body.innerText.slice(0, 500) : ''");
      out.push({ requested: url, finalUrl: page.url(), status: response?.status() ?? null, title, text });
      mkdirSync(join(process.cwd(), "runs"), { recursive: true });
      const name = url.includes("register") ? "vps-register.png" : "vps-signup.png";
      await page.screenshot({ path: join(process.cwd(), "runs", name), fullPage: true }).catch(() => {});
    } catch (e) {
      out.push({ requested: url, error: (e as Error).message });
    } finally {
      await page.close();
    }
  }

  console.log(JSON.stringify(out, null, 2));
  await context.close();
  await browser.close();
}

main().catch((e) => {
  console.error(JSON.stringify({ error: (e as Error).message }));
  process.exitCode = 1;
});
