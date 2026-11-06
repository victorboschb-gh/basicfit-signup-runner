import { chromium } from "playwright";

const URL = "https://member.basic-fit.com/es-ES/signup/BlackFriday_FitTogether?bf-locale=es-ES&bf-country=ES";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const page = await (await browser.newContext({ locale: "es-ES" })).newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4_000);

  console.log("URL:", page.url());
  console.log("role=checkbox:", await page.getByRole("checkbox").count());
  console.log("[role=checkbox]:", await page.locator('[role="checkbox"]').count());
  console.log("age testid:", await page.locator('[data-testid="ageConfirmation"]').count());
  console.log("tos testid:", await page.locator('[data-testid="tos"]').count());

  const accessibility = await page.locator("body").ariaSnapshot().catch((e) => `ERR ${e.message}`);
  console.log("--- ARIA (primeros 4000) ---");
  console.log(String(accessibility).slice(0, 4000));

  for (const text of [/Declaro que tengo al menos 16/i, /T[eé]rminos y condiciones/i]) {
    const label = page.getByText(text).first();
    console.log(`texto ${text}: count=${await label.count()}`);
    const group = label.locator("xpath=ancestor::div[contains(@class,'group')][1]");
    console.log(`  grupo count=${await group.count()} checkbox=${await group.locator('[role="checkbox"]').count()}`);
    const prev = label.locator("xpath=preceding-sibling::div[@role='checkbox'][1]");
    console.log(`  sibling previo count=${await prev.count()}`);
  }

  await page.waitForTimeout(3_000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
