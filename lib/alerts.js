// Push notifications through ntfy (https://ntfy.sh): free, no account. Each person picks a long random
// topic name, installs the ntfy app and subscribes to it. (The owner's site can also use NTFY_TOPIC.)
// NTFY_SERVER (default https://ntfy.sh) and NTFY_TOKEN (for a protected topic) are optional.
import fetch from "node-fetch";

// Never throws: a failed alert must not break a price check.
export async function sendAlert({ topic, title, message, click, tags }) {
  if (!topic) return { sent: false, reason: "not configured" };
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  try {
    const res = await fetch(server, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.NTFY_TOKEN ? { authorization: "Bearer " + process.env.NTFY_TOKEN } : {}) },
      body: JSON.stringify({ topic, title, message, click: click || undefined, tags: tags || undefined }),
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

// A rise of at least 2%.
export function priceRose(prev, next) {
  const a = Number(prev), b = Number(next);
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && b >= a * 1.02;
}

export function riseMessage(item, prev, next) {
  const pct = Math.round((Number(next) / Number(prev) - 1) * 100);
  return {
    title: "Price up: " + String(item.title || "A present").slice(0, 80),
    message: pounds(next) + " (was " + pounds(prev) + ", " + pct + "% more)",
    click: item.url || undefined,
    tags: ["chart_with_upwards_trend"]
  };
}

// Someone ticked (or unticked) "I'll get this".
export function claimMessage(item, name, claimed) {
  const title = String(item.title || "A present").slice(0, 80);
  return {
    title: claimed ? name + " is getting a present" : name + " changed their mind",
    message: claimed ? title : title + " is available again",
    click: item.url || undefined,
    tags: [claimed ? "gift" : "arrows_counterclockwise"]
  };
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
