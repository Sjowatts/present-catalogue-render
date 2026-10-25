import { chromium } from "playwright";

// Look like a visitor in the UK so shops show pounds. The app may be hosted elsewhere.
export async function renderHtmlWithPlaywright(url) {
  // CHROMIUM_PATH lets a host point at a browser that is already installed.
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const ctx = await browser.newContext({
      locale: "en-GB",
      timezoneId: "Europe/London",
      extraHTTPHeaders: { "accept-language": "en-GB,en;q=0.9" }
    });
    try {
      const { hostname } = new URL(url);
      await ctx.addCookies([
        { name: "localization", value: "GB", domain: hostname, path: "/" },
        { name: "cart_currency", value: "GBP", domain: hostname, path: "/" }
      ]);
    } catch {}
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    return await page.content();
  } finally {
    await browser.close();
  }
}
