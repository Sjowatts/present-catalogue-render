// Push notifications through ntfy (https://ntfy.sh): free, no account. Set NTFY_TOPIC on the server to a
// long random string, install the ntfy app on a phone and subscribe to the same topic.
// NTFY_SERVER (default https://ntfy.sh) and NTFY_TOKEN (for a protected topic) are optional.
import fetch from "node-fetch";

export const alertsEnabled = () => !!process.env.NTFY_TOPIC;

// Never throws: a failed alert must not break a price check.
export async function sendAlert({ title, message, click, tags }) {
  if (!alertsEnabled()) return { sent: false, reason: "not configured" };
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  try {
    const res = await fetch(server, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.NTFY_TOKEN ? { authorization: "Bearer " + process.env.NTFY_TOKEN } : {}) },
      body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title, message, click: click || undefined, tags: tags || undefined }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { sent: false, reason: "ntfy answered " + res.status };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

const pounds = (n) => "£" + Number(n).toFixed(2);

// A drop of at least 2% (smaller moves are usually exchange-rate wobble) to a lower price.
export function priceDropped(prev, next) {
  const a = Number(prev), b = Number(next);
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && b <= a * 0.98;
}

export function dropMessage(item, prev, next) {
  const pct = Math.round((1 - Number(next) / Number(prev)) * 100);
  return {
    title: "Price drop: " + String(item.title || "A present").slice(0, 80),
    message: pounds(next) + " (was " + pounds(prev) + ", " + pct + "% off)",
    click: item.url || undefined,
    tags: ["tada"]
  };
}
