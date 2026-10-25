// Pasted links are often messy: shared text around the link, tracking junk, no https://.
// These helpers tidy them and tell whether two links point at the same product.

// Only names that are tracking and nothing else; product options (colour, size, variant...) are kept.
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "li_fat_id",
  "mc_cid", "mc_eid", "_ga", "_gl", "_hsenc", "_hsmi", "igshid", "igsh", "srsltid", "cmpid",
  "ref", "ref_", "referrer", "referral", "affid", "affiliate", "irclickid", "irgwc", "sscid",
  "gad_source", "gad_campaignid", "pf_rd_r", "pf_rd_p", "pf_rd_m", "pf_rd_s", "pf_rd_t", "pf_rd_i",
  "pd_rd_r", "pd_rd_w", "pd_rd_wg", "pd_rd_i", "linkcode", "creativeasin"
]);

const isTracking = (name) => {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || n.startsWith("pk_") || n.startsWith("mtm_") || n.startsWith("hsa_") || TRACKING_PARAMS.has(n);
};

// The first link inside pasted or shared text ("Look at this https://shop.example/x great!").
// Also accepts a bare "www.shop.com/product" or "shop.com/product".
export function extractUrl(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const full = t.match(/https?:\/\/[^\s<>"']+/i);
  let candidate = full ? full[0] : null;
  if (!candidate) {
    const bare = t.match(/(?:^|\s)((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s<>"']*)?)(?:\s|$)/i);
    if (bare) candidate = "https://" + bare[1];
  }
  if (!candidate) return null;
  candidate = candidate.replace(/[)\].,;:!?]+$/, ""); // punctuation that came with the sentence
  try { return new URL(candidate).href; } catch { return null; }
}

// Strip tracking parameters and the #fragment; shorten Amazon links to /dp/<ASIN>.
export function cleanUrl(input) {
  let u;
  try { u = new URL(String(input)); } catch { return String(input ?? ""); }
  if (!/^https?:$/.test(u.protocol)) return String(input);
  u.hash = "";
  const host = u.hostname.toLowerCase();
  if (/(^|\.)amazon\.[a-z.]+$/.test(host) || host === "amzn.eu" || host === "a.co") {
    const m = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (m) { u.pathname = "/dp/" + m[1].toUpperCase(); u.search = ""; return u.href; }
  }
  for (const key of [...u.searchParams.keys()]) {
    if (isTracking(key)) u.searchParams.delete(key);
  }
  return u.href;
}

// Same product? Ignores www., a trailing slash, and the order of parameters.
export function urlKey(input) {
  let u;
  try { u = new URL(cleanUrl(input)); } catch { return ""; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const pathname = u.pathname.replace(/\/+$/, "") || "/";
  const params = [...u.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.map(([k, v]) => k + "=" + v).join("&");
  return host + pathname + (query ? "?" + query : "");
}
