// Integration tests (need DATABASE_URL): manual items, locks, link cleaning, duplicates, price alerts.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasDb = !!process.env.DATABASE_URL;

async function startServer(port, extraEnv = {}) {
  const env = { ...process.env, PORT: String(port), ...extraEnv };
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  const child = spawn("node", ["app.js"], { cwd: root, env, stdio: "ignore" });
  const base = "http://localhost:" + port;
  for (let i = 0; i < 60; i++) {
    try { if ((await (await fetch(base + "/healthz")).json()).db) return { base, stop: () => child.kill() }; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("server did not start");
}
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const del = (base, id) => fetch(base + "/api/items/" + id, { method: "DELETE" });

// A shop whose price (in pounds) the test can change.
function mutableShop(state) {
  return http.createServer((req, res) => {
    state.hits.push(req.url);
    res.setHeader("content-type", "text/html");
    res.end("<html><head><title>" + state.title + "</title>" +
      '<script type="application/ld+json">' + JSON.stringify({ "@type": "Product", name: state.title, offers: { "@type": "Offer", price: String(state.price), priceCurrency: "GBP" } }) +
      "</script></head><body><h1>" + state.title + "</h1></body></html>");
  });
}
// Collects what ntfy would receive.
function fakeNtfy(state) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.got.push(JSON.parse(body || "{}"));
      res.statusCode = state.status || 200;
      res.end("{}");
    });
  });
}
const getItem = async (base, id) => (await (await fetch(base + "/api/items")).json()).find((i) => i.id === id);

test("links are tidied, bad input is rejected, duplicates are caught", { skip: !hasDb }, async (t) => {
  const s = await startServer(3210);
  t.after(s.stop);
  const state = { title: "Jumper", price: 50, hits: [] };
  const shop = mutableShop(state), port = await listen(shop);
  t.after(() => shop.close());
  const base = `http://127.0.0.1:${port}/products/jumper-${Date.now().toString(36)}`;

  assert.equal((await post(s.base, "/api/add", { url: "hello there" })).status, 400);
  assert.equal((await post(s.base, "/api/add", { url: "" })).status, 400);

  const first = await (await post(s.base, "/api/add", { url: `Look at this ${base}?utm_source=ig&variant=1&fbclid=zzz#reviews so nice` })).json();
  assert.equal(first.url, base + "?variant=1");
  assert.deepEqual(state.hits, [new URL(base).pathname + "?variant=1"]);

  const dup = await post(s.base, "/api/add", { url: base + "/?variant=1&utm_medium=x" });
  assert.equal(dup.status, 409);
  const dupBody = await dup.json();
  assert.equal(dupBody.duplicate.id, first.id);
  assert.match(dupBody.error, /already/);

  const forced = await post(s.base, "/api/add", { url: base + "?variant=1", force: true });
  assert.equal(forced.status, 200);
  const other = await post(s.base, "/api/add", { url: base + "?variant=2" }); // a different variant is a different present
  assert.equal(other.status, 200);

  for (const r of [first, await forced.json(), await other.json()]) await del(s.base, r.id);
});

test("presents added by hand and edits", { skip: !hasDb }, async (t) => {
  const s = await startServer(3211);
  t.after(s.stop);

  assert.equal((await post(s.base, "/api/items/manual", { title: " " })).status, 400);
  assert.equal((await post(s.base, "/api/items/manual", { title: "X", price: "abc" })).status, 400);
  assert.equal((await post(s.base, "/api/items/manual", { title: "X", image: "javascript:alert(1)" })).status, 400);
  assert.equal((await post(s.base, "/api/items/manual", { title: "X", url: "not a link" })).status, 400);

  const item = await (await post(s.base, "/api/items/manual", { title: "Hand-made scarf", price: "£12.50", description: "From the market" })).json();
  assert.equal(Number(item.price_value), 12.5);
  assert.equal(item.price_currency, "GBP");
  assert.equal(item.url, "");
  assert.equal(item.price_locked, true);
  assert.equal(item.details_locked, true);
  assert.equal(item.source, "manual");

  assert.equal((await post(s.base, "/api/refresh/" + item.id, {})).status, 400); // nothing to check without a link

  const blank = await (await post(s.base, "/api/items/manual", { title: "No price yet" })).json();
  assert.equal(blank.price_value, null);
  assert.equal(blank.price_locked, false);

  const e1 = await (await post(s.base, `/api/items/${item.id}/edit`, { title: "Scarf, blue", image: "https://img.example/a.jpg", url: "https://shop.example/scarf?utm_source=x" })).json();
  assert.equal(e1.title, "Scarf, blue");
  assert.equal(e1.image, "https://img.example/a.jpg");
  assert.equal(e1.url, "https://shop.example/scarf");
  assert.equal(Number(e1.price_value), 12.5); // untouched

  assert.equal((await post(s.base, `/api/items/${item.id}/edit`, { title: "" })).status, 400);
  assert.equal((await post(s.base, `/api/items/${item.id}/edit`, { price: "abc" })).status, 400);
  assert.equal((await post(s.base, `/api/items/nope/edit`, { title: "x" })).status, 404);

  const e2 = await (await post(s.base, `/api/items/${item.id}/edit`, { price: 20 })).json();
  assert.equal(Number(e2.price_value), 20);
  assert.equal(e2.price_locked, true); // changing the price protects it
  const e3 = await (await post(s.base, `/api/items/${item.id}/edit`, { price_locked: false })).json();
  assert.equal(e3.price_locked, false);
  const e4 = await (await post(s.base, `/api/items/${item.id}/edit`, { price: "" })).json();
  assert.equal(e4.price_value, null);

  const hist = (await getItem(s.base, item.id)).history.map((h) => h.p);
  assert.deepEqual(hist, [12.5, 20]);
  await del(s.base, item.id); await del(s.base, blank.id);
});

test("refresh leaves protected prices and details alone", { skip: !hasDb }, async (t) => {
  const s = await startServer(3212);
  t.after(s.stop);
  const state = { title: "Shop title", price: 50, hits: [] };
  const shop = mutableShop(state), port = await listen(shop);
  t.after(() => shop.close());

  const item = await (await post(s.base, "/api/add", { url: `http://127.0.0.1:${port}/p/lock-${Date.now().toString(36)}` })).json();
  assert.equal(Number(item.price_value), 50);

  state.price = 40;
  assert.equal(Number((await (await post(s.base, "/api/refresh/" + item.id, {})).json()).price_value), 40);

  await post(s.base, `/api/items/${item.id}/edit`, { price: 99 }); // locks the price
  state.price = 30;
  assert.equal(Number((await (await post(s.base, "/api/refresh/" + item.id, {})).json()).price_value), 99);

  await post(s.base, `/api/items/${item.id}/edit`, { price_locked: false });
  assert.equal(Number((await (await post(s.base, "/api/refresh/" + item.id, {})).json()).price_value), 30);

  await post(s.base, `/api/items/${item.id}/edit`, { title: "My own title", details_locked: true });
  state.title = "Shop changed its title";
  const after = await (await post(s.base, "/api/refresh/" + item.id, {})).json();
  assert.equal(after.title, "My own title");
  await del(s.base, item.id);
});

test("price-drop alerts", { skip: !hasDb }, async (t) => {
  const ntfy = { got: [], status: 200 };
  const nsrv = fakeNtfy(ntfy), nport = await listen(nsrv);
  t.after(() => nsrv.close());
  const s = await startServer(3213, { NTFY_TOPIC: "test-topic-123", NTFY_SERVER: "http://127.0.0.1:" + nport });
  t.after(s.stop);
  const state = { title: "Candle Set", price: 50, hits: [] };
  const shop = mutableShop(state), port = await listen(shop);
  t.after(() => shop.close());

  assert.deepEqual(await (await fetch(s.base + "/api/alerts/status")).json(), { enabled: true });

  const item = await (await post(s.base, "/api/add", { url: `http://127.0.0.1:${port}/p/alert-${Date.now().toString(36)}` })).json();
  assert.equal(ntfy.got.length, 0); // adding is not a drop

  state.price = 45; // rise? no: fall 10%
  await post(s.base, "/api/refresh/" + item.id, {});
  assert.equal(ntfy.got.length, 1);
  assert.equal(ntfy.got[0].topic, "test-topic-123");
  assert.match(ntfy.got[0].title, /Price drop: Candle Set/);
  assert.match(ntfy.got[0].message, /£45\.00 \(was £50\.00, 10% off\)/);
  assert.equal(ntfy.got[0].click, item.url);

  state.price = 44.5; // only 1.1% lower: not worth an alert
  await post(s.base, "/api/refresh/" + item.id, {});
  state.price = 60; // a rise
  await post(s.base, "/api/refresh/" + item.id, {});
  assert.equal(ntfy.got.length, 1);

  // protected prices never alert
  await post(s.base, `/api/items/${item.id}/edit`, { price: 80 });
  state.price = 10;
  await post(s.base, "/api/refresh/" + item.id, {});
  assert.equal(ntfy.got.length, 1);

  // the test button
  assert.equal((await post(s.base, "/api/alerts/test", {})).status, 200);
  assert.equal(ntfy.got.length, 2);
  assert.match(ntfy.got[1].message, /working/);
  ntfy.status = 500;
  assert.equal((await post(s.base, "/api/alerts/test", {})).status, 502);
  await del(s.base, item.id);
});

test("alerts stay off unless configured", { skip: !hasDb }, async (t) => {
  const s = await startServer(3214, { NTFY_TOPIC: undefined });
  t.after(s.stop);
  assert.deepEqual(await (await fetch(s.base + "/api/alerts/status")).json(), { enabled: false });
  assert.equal((await post(s.base, "/api/alerts/test", {})).status, 400);
});

import { existsSync } from "node:fs";
import { chromium } from "playwright";
const hasBrowser = (() => { try { return existsSync(process.env.CHROMIUM_PATH || chromium.executablePath()); } catch { return false; } })();

test("a shop that draws its price with JavaScript is read through the browser", { skip: !hasDb || !hasBrowser }, async (t) => {
  const s = await startServer(3215);
  t.after(s.stop);
  const seen = [];
  const shop = http.createServer((req, res) => {
    seen.push({ lang: req.headers["accept-language"], cookie: req.headers.cookie || "" });
    res.setHeader("content-type", "text/html");
    res.end('<html><head><title>JS shop</title></head><body><h1>Lamp</h1><div class="price" id="p"></div>' +
      "<script>setTimeout(function(){document.getElementById('p').textContent='£34.00'}, 200)</script></body></html>");
  });
  const port = await listen(shop);
  t.after(() => shop.close());
  const item = await (await post(s.base, "/api/add", { url: `http://127.0.0.1:${port}/lamp-${Date.now().toString(36)}` })).json();
  assert.equal(Number(item.price_value), 34);
  assert.equal(item.price_currency, "GBP");
  assert.equal(item.source, "playwright");
  const browserVisit = seen[seen.length - 1];
  assert.match(browserVisit.lang, /en-GB/);
  assert.match(browserVisit.cookie, /localization=GB/);
  await del(s.base, item.id);
});
