import express from "express";
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { scrapeWithHeuristics } from "./lib/heuristics.js";
import { renderHtmlWithPlaywright } from "./lib/renderers/playwright.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let items = [];

const normalizeHost = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
};

async function scrapeProduct(url) {
  const host = normalizeHost(url);
  let title = null, image = null, priceValue = null, priceCurrency = null, source = "heuristics";

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0",
        "accept": "text/html"
      },
      redirect: "follow"
    });
    if (res.ok) {
      const html = await res.text();
      const h = scrapeWithHeuristics(html);
      if (h) ({ title, image, priceValue, priceCurrency } = h);
    }
  } catch {}

  if (priceValue == null) {
    try {
      const html = await renderHtmlWithPlaywright(url);
      const h = scrapeWithHeuristics(html);
      if (h) ({ title, image, priceValue, priceCurrency } = h);
      source = "playwright";
    } catch {}
  }

  return {
    url,
    store: host,
    title: title || "(No title found)",
    image,
    priceValue: priceValue ?? null,
    priceCurrency: priceCurrency ?? null,
    lastChecked: new Date().toISOString(),
    source
  };
}

app.post("/api/add", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url" });
  try {
    const data = await scrapeProduct(url);
    const id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const item = { id, ...data };
    items.unshift(item);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message || "Scrape failed" });
  }
});

app.post("/api/refresh/:id", async (req, res) => {
  const item = items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  try {
    const data = await scrapeProduct(item.url);
    Object.assign(item, data);
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message || "Refresh failed" });
  }
});

app.get("/api/items", (_req, res) => res.json(items));

app.get("/", (_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end("<!doctype html><html><body><h1>Price Catalogue</h1><p>Paste URL box will go here.</p></body></html>");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Price catalogue on http://localhost:"+PORT));
