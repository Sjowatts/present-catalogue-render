// Integration tests: need a Postgres. Run with DATABASE_URL=postgres://... npm test
// Without DATABASE_URL these are skipped.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasDb = !!process.env.DATABASE_URL;

async function startServer(port, extraEnv = {}) {
  const child = spawn("node", ["app.js"], { cwd: root, env: { ...process.env, PORT: String(port), ...extraEnv }, stdio: "ignore" });
  const base = "http://localhost:" + port;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/healthz"); if ((await r.json()).db) return { base, stop: () => child.kill() }; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("server did not start");
}
const post = (base, p, body, headers = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });

test("lists, budgets, favourites, price history and export", { skip: !hasDb }, async (t) => {
  const s = await startServer(3201);
  t.after(s.stop);
  const uid = Date.now().toString(36);

  const bad = await post(s.base, "/api/lists", { name: "Bad", budget: "abc" });
  assert.equal(bad.status, 400);
  assert.equal((await post(s.base, "/api/lists", { name: "  " })).status, 400);

  const list = await (await post(s.base, "/api/lists", { name: "Mum " + uid, budget: 100 })).json();
  assert.equal(list.name, "Mum " + uid);
  assert.equal(Number(list.budget), 100);

  const renamed = await (await post(s.base, "/api/lists/" + list.id, { budget: null })).json();
  assert.equal(renamed.budget, null);
  assert.equal(renamed.name, list.name);

  // seed two items through import (scraping needs the network)
  const imp = await (await post(s.base, "/api/import", {
    lists: [], price_history: [
      { item_id: "t1_" + uid, price: 50, currency: "GBP", at: "2026-01-01T00:00:00Z" },
      { item_id: "t1_" + uid, price: 40, currency: "GBP", at: "2026-02-01T00:00:00Z" }
    ],
    items: [
      { id: "t1_" + uid, url: "https://example.com/a", title: "A", price_value: 40, price_currency: "GBP", notes: "secret size" },
      { id: "t2_" + uid, url: "https://example.com/b", title: "B", price_value: 10, price_currency: "USD" }
    ]
  })).json();
  assert.equal(imp.added, 2);
  assert.equal((await (await post(s.base, "/api/import", { items: [{ id: "t1_" + uid, url: "https://example.com/a" }] })).json()).added, 0);

  assert.equal((await post(s.base, `/api/items/t1_${uid}/list`, { list_id: list.id })).status, 200);
  assert.equal((await post(s.base, `/api/items/t1_${uid}/favourite`, { favourite: true })).status, 200);
  assert.equal((await post(s.base, `/api/items/nope/favourite`, { favourite: true })).status, 404);

  const items = await (await fetch(s.base + "/api/items")).json();
  const a = items.find((i) => i.id === "t1_" + uid);
  assert.equal(a.list_id, list.id);
  assert.equal(a.favourite, true);
  assert.deepEqual(a.history.map((h) => h.p), [50, 40]);
  assert.equal(items.find((i) => i.id === "t2_" + uid).history.length, 1);

  const exp = await (await fetch(s.base + "/api/export")).json();
  assert.equal(exp.version, 2);
  assert.ok(exp.items.some((i) => i.id === "t1_" + uid));
  assert.ok(exp.lists.every((l) => !("share_token" in l)));

  // deleting a list keeps its presents
  await fetch(s.base + "/api/lists/" + list.id, { method: "DELETE" });
  const after = await (await fetch(s.base + "/api/items")).json();
  assert.equal(after.find((i) => i.id === "t1_" + uid).list_id, null);

  for (const id of ["t1_" + uid, "t2_" + uid]) await fetch(s.base + "/api/items/" + id, { method: "DELETE" });
});

test("shared list: hides notes, claims, revoking", { skip: !hasDb }, async (t) => {
  const s = await startServer(3202);
  t.after(s.stop);
  const uid = Date.now().toString(36);
  const list = await (await post(s.base, "/api/lists", { name: "Share " + uid })).json();
  await post(s.base, "/api/import", { items: [{ id: "s1_" + uid, url: "https://example.com/s", title: "Shared one", price_value: 5, notes: "private note" }] });
  await post(s.base, `/api/items/s1_${uid}/list`, { list_id: list.id });

  assert.equal((await fetch(s.base + "/api/share/" + "0".repeat(32))).status, 404);
  assert.equal((await fetch(s.base + "/api/share/not-a-token")).status, 404);

  const shared = await (await post(s.base, `/api/lists/${list.id}/share`, { enabled: true })).json();
  assert.match(shared.share_token, /^[a-f0-9]{32}$/);
  const view = await (await fetch(s.base + "/api/share/" + shared.share_token)).json();
  assert.equal(view.list.name, "Share " + uid);
  assert.equal(view.items.length, 1);
  assert.ok(!("notes" in view.items[0]));

  const claim = (body) => post(s.base, `/api/share/${shared.share_token}/claim`, { itemId: "s1_" + uid, ...body });
  assert.equal((await claim({})).status, 400);
  assert.equal((await claim({ name: "Sam" })).status, 200);
  assert.equal((await claim({ name: "Alex" })).status, 409);
  assert.equal((await claim({ name: "Alex", claim: false })).status, 403);
  assert.equal((await claim({ name: "sam" })).status, 200);
  assert.equal((await claim({ name: "sam", claim: false })).status, 200);
  assert.equal((await post(s.base, `/api/share/${shared.share_token}/claim`, { itemId: "unknown", name: "Sam" })).status, 404);

  const page = await fetch(s.base + "/s/" + shared.share_token);
  assert.equal(page.status, 200);

  await post(s.base, `/api/lists/${list.id}/share`, { enabled: false });
  assert.equal((await fetch(s.base + "/api/share/" + shared.share_token)).status, 404);

  await fetch(s.base + "/api/items/s1_" + uid, { method: "DELETE" });
  await fetch(s.base + "/api/lists/" + list.id, { method: "DELETE" });
});

test("optional password and refresh token", { skip: !hasDb }, async (t) => {
  const s = await startServer(3203, { APP_PASSWORD: "open-sesame", REFRESH_TOKEN: "tok" });
  t.after(s.stop);
  assert.equal((await fetch(s.base + "/api/items")).status, 401);
  assert.equal((await fetch(s.base + "/")).status, 401);
  assert.equal((await fetch(s.base + "/healthz")).status, 200);
  const auth = { authorization: "Basic " + Buffer.from("anyone:open-sesame").toString("base64") };
  assert.equal((await fetch(s.base + "/api/items", { headers: auth })).status, 200);
  assert.equal((await fetch(s.base + "/", { headers: auth })).status, 200);
  assert.equal((await fetch(s.base + "/api/items", { headers: { authorization: "Basic " + Buffer.from("x:wrong").toString("base64") } })).status, 401);
  // shared links and the scheduled refresh are not behind the password
  assert.equal((await fetch(s.base + "/api/share/" + "0".repeat(32))).status, 404);
  assert.equal((await post(s.base, "/api/refresh-all", {}, { "x-refresh-token": "bad" })).status, 401);
  assert.equal((await post(s.base, "/api/refresh-all", {}, { "x-refresh-token": "tok" })).status, 202);
});
