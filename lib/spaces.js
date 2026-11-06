// Private spaces: one site, a separate set of presents for each person, each with its own PIN.
import crypto from "node:crypto";

// Words that are already used by the site's own addresses.
export const RESERVED = new Set([
  "api", "s", "u", "p", "healthz", "admin", "family", "login", "logout", "static", "public", "assets",
  "manifest", "sw", "favicon", "style", "main", "shared", "index", "new", "robots", "sitemap"
]);
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;
export const isUsableSlug = (slug) => SLUG_RE.test(slug) && !RESERVED.has(slug);

// "Grandad Izzy" -> "grandad-izzy", "Zoë" -> "zoe"
export function slugify(name) {
  return String(name ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
}

// A free address for a name: the plain version if possible, else with -2, -3...
export function uniqueSlug(name, taken) {
  let base = slugify(name);
  if (base.length < 2) base = ("p-" + base).replace(/-+$/, "") || "person";
  let slug = base, n = 2;
  while (!isUsableSlug(slug) || taken.has(slug)) slug = base.slice(0, 27) + "-" + n++;
  return slug;
}

// "Mum's Presents", "Chris' Presents"
export const possessive = (name) => (/s$/i.test(name) ? name + "'" : name + "'s");

// A 6-digit PIN that is easy to type on a phone.
export const generatePin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex");
}
export function verifyPin(pin, stored) {
  const [kind, saltHex, hashHex] = String(stored || "").split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  const got = crypto.scryptSync(String(pin), Buffer.from(saltHex, "hex"), want.length);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Signed cookie value: base64url("slug.expiry").signature
export function signToken(secret, slug, ttlMs, now = Date.now()) {
  const body = Buffer.from(slug + "." + (now + ttlMs)).toString("base64url");
  return body + "." + crypto.createHmac("sha256", secret).update(body).digest("base64url");
}
// -> the slug, or null if the value is forged, expired or malformed
export function verifyToken(secret, token, now = Date.now()) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(body, "base64url").toString();
  const dot = decoded.lastIndexOf(".");
  const slug = decoded.slice(0, dot), expires = Number(decoded.slice(dot + 1));
  return Number.isFinite(expires) && expires > now ? slug : null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Allow `max` tries per key every `windowMs`; a success can reset the key.
export function makeRateLimiter({ max, windowMs }) {
  const seen = new Map();
  return {
    hit(key, now = Date.now()) {
      let e = seen.get(key);
      if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; seen.set(key, e); }
      e.count += 1;
      if (seen.size > 5000) for (const [k, v] of seen) if (v.resetAt <= now) seen.delete(k);
      return e.count <= max ? { ok: true } : { ok: false, retryAfterMs: e.resetAt - now };
    },
    reset(key) { seen.delete(key); }
  };
}

// "Mum, Dad\nGrandma" -> ["Mum", "Dad", "Grandma"]
export function parseNames(input) {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(/[\n,;]+/);
  const seen = new Set(), out = [];
  for (const r of raw) {
    const name = String(r ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const key = name.toLowerCase();
    if (name && !seen.has(key)) { seen.add(key); out.push(name); }
  }
  return out;
}
