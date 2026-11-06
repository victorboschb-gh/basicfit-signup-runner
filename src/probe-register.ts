import { chromium } from "playwright";

const email = process.argv[2];
if (!email) {
  console.error("Uso: node src/probe-register.ts correo@dominio.com");
  process.exit(1);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "es-ES", timezoneId: "Europe/Madrid", viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  page.on("request", (req) => {
    if (!/basic-fit\.com/.test(req.url())) return;
    if (req.method() === "GET" && /\.(js|css|png|svg|woff2?|jpg|webp)/.test(req.url())) return;
    console.log("REQ ", req.method(), req.url());
    const body = req.postData();
    if (body) console.log("  BODY", body.slice(0, 600));
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (!/basic-fit\.com/.test(url)) return;
    if (res.request().method() === "GET" && /\.(js|css|png|svg|woff2?|jpg|webp)/.test(url)) return;
    let body = "";
    try {
      body = (await res.text()).slice(0, 1500);
    } catch {
      /* sin cuerpo */
    }
    console.log("RESP", res.status(), res.request().method(), url, body.replace(/\s+/g, " ").slice(0, 900));
  });

  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 300));
  });

  await page.goto("https://login.basic-fit.com/register", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(4_000);

  const reject = page.getByRole("button", { name: /^Rechazar$/i }).first();
  if (await reject.count()) await reject.click().catch(() => {});
  await page.waitForTimeout(800);

  console.log("TITLE", await page.title());
  const input = page
    .getByLabel(/Correo electr[oó]nico/i)
    .or(page.locator('input[type="email"]'))
    .first();
  await input.fill(email!);
  await page.waitForTimeout(800);
  console.log("VALUE", await input.inputValue());

  await page.getByRole("button", { name: /^Continuar$/i }).first().click();
  await page.waitForTimeout(12_000);

  const text = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  console.log("--- PAGE TAIL ---");
  console.log(text.slice(-900));

  console.log("--- COOKIES ---");
  console.log((await context.cookies()).map((c) => `${c.domain} ${c.name}`).join("\n"));
  console.log("--- FRAMES ---");
  console.log(page.frames().map((f) => f.url()).join("\n"));
  console.log("--- BUTTONS ---");
  console.log((await page.getByRole("button").allTextContents()).join(" | "));
  console.log("--- IFRAMES ---");
  console.log((await page.locator("iframe").evaluateAll((els) => els.map((e) => e.getAttribute("src")))).join("\n"));

  console.log("--- RETRY CONTINUAR ---");
  await page.getByRole("button", { name: /^Continuar$/i }).first().click();
  await page.waitForTimeout(12_000);
  console.log("--- PAGE TAIL 2 ---");
  console.log((await page.evaluate<string>("document.body ? document.body.innerText : ''")).slice(-700));

  await page.waitForTimeout(2_000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
