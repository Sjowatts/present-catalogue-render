import { chromium } from "playwright";

export async function renderHtmlWithPlaywright(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    return await page.content();
  } finally {
    await browser.close();
  }
}
