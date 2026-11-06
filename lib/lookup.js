// When a shop won't let the app read its pages (bot protection), these helpers keep the result honest:
// recognise the error page, make a sensible name from the link, and accept details sent from the
// person's own browser instead.
import { parsePriceString } from "./heuristics.js";

// Titles of "go away" pages: Akamai "Access Denied", Cloudflare "Just a moment...", captchas...
const BLOCK_TITLE = /access denied|just a moment|attention required|are you a (?:human|robot)|captcha|request blocked|unusual traffic|pardon our interruption|forbidden|security check|verify you are|robot check|service unavailable|error 403|403 error/i;

export function looksBlocked(status, title) {
  if ([401, 403, 407, 429, 451, 503].includes(Number(status))) return true;
  return BLOCK_TITLE.test(String(title || ""));
}

// "https://shop.example/products/goose-knitted-stripe-jumper-denim-blue" -> "Goose knitted stripe jumper denim blue"
// A link with no readable words ("/e00398s1") gives "shop.example item".
export function titleFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return "New present"; }
  const host = u.hostname.replace(/^www\./, "");
  const words = u.pathname.split("/").filter(Boolean)
    .map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } })
    .map((seg) => seg.replace(/\.(html?|php|aspx?)$/i, ""))
    .filter((seg) => /^[a-z]+(?:[-_][a-z0-9]+)+$/i.test(seg) && /[a-z]{3,}/i.test(seg));
  const best = words.sort((a, b) => b.length - a.length)[0];
  if (!best) return host + " item";
  const text = best.replace(/[-_]+/g, " ").trim();
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 120);
}

const httpUrl = (v) => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// Details the person's browser read from the shop's page: { title, image, description, price, currency }.
// Anything odd is dropped rather than trusted.
export function cleanHint(raw) {
  const h = raw && typeof raw === "object" ? raw : {};
  const out = {};
  const title = clean(h.title, 200);
  if (title && !looksBlocked(200, title)) out.title = title;
  const image = httpUrl(clean(h.image, 1000));
  if (image) out.image = image;
  const description = clean(h.description, 500);
  if (description) out.description = description;
  let price = null;
  if (typeof h.price === "number") price = h.price;
  else if (String(h.price ?? "").trim() !== "") price = parsePriceString(String(h.price)).value;
  if (Number.isFinite(price) && price >= 0 && price < 1e7) out.price = price;
  const currency = String(h.currency ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(currency)) out.currency = currency;
  return out;
}
