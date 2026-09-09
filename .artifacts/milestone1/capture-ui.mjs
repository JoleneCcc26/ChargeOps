import { chromium } from "playwright";

const out = "C:/Users/joeyc/AppData/Local/Temp/chargeops-m1";
const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

await page.goto("http://127.0.0.1:5173/login", { waitUntil: "networkidle" });
await page.getByLabel("Username").fill("ops");
await page.getByLabel("Password").fill("chargeops-demo");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/dashboard|\/$/, { timeout: 15_000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/dashboard.png`, fullPage: false });

await page.getByRole("link", { name: /^Maintenance$/i }).click();
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/maintenance.png`, fullPage: false });

await page.getByRole("link", { name: /Cloud ops/i }).click();
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/cloud-ops.png`, fullPage: false });

await browser.close();
