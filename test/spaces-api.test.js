// Integration tests (need DATABASE_URL): private spaces, PINs, isolation, per-person alerts.
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
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const ADMIN = { authorization: "Basic " + Buffer.from("owner:owner-pass").toString("base64") };

// A small client: sends X-Space, keeps cookies per space, can act as the owner.
function client(base, space, { admin = false } = {}) {
  let cookie = "";
  const headers = (extra = {}) => ({ "content-type": "application/json", "x-space": space, ...(admin ? ADMIN : {}), ...(cookie ? { cookie } : {}), ...extra });
  const call = (method) => (p, body, extra) =>
    fetch(base + p, { method, headers: headers(extra), body: body === undefined ? undefined : JSON.stringify(body) });
  return {
    get: call("GET"), post: call("POST"), del: call("DELETE"),
    async login(pin) {
      const r = await fetch(base + "/api/space-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space, pin }) });
      const set = r.headers.getSetCookie?.() || [];
      if (r.ok && set[0]) cookie = set[0].split(";")[0];
      return r;
    },
    setCookie(c) { cookie = c; },
    get cookie() { return cookie; }
  };
}

function mutableShop(state) {
  return http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<html><head><title>" + state.title + "</title>" +
      '<script type="application/ld+json">' + JSON.stringify({ "@type": "Product", name: state.title, offers: { "@type": "Offer", price: String(state.price), priceCurrency: "GBP" } }) +
      "</script></head><body><h1>" + state.title + "</h1></body></html>");
  });
}
function fakeNtfy(got) {
  return http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { got.push(JSON.parse(body || "{}")); res.end("{}"); });
  });
}

test("managing spaces needs the owner password", { skip: !hasDb }, async (t) => {
  const open = await startServer(3220, { APP_PASSWORD: undefined });
  t.after(open.stop);
  const r = await client(open.base, "").post("/api/spaces", { names: "Mum" });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /APP_PASSWORD/);

  const locked = await startServer(3221, { APP_PASSWORD: "owner-pass" });
  t.after(locked.stop);
  assert.equal((await client(locked.base, "").post("/api/spaces", { names: "Mum" })).status, 401);
  assert.equal((await client(locked.base, "").get("/api/spaces")).status, 401);
  assert.equal((await client(locked.base, "", { admin: true }).get("/api/spaces")).status, 200);
});

test("creating pages, opening them, PIN login and sign-out", { skip: !hasDb }, async (t) => {
  const s = await startServer(3222, { APP_PASSWORD: "owner-pass" });
  t.after(s.stop);
  const owner = client(s.base, "", { admin: true });
  const uid = Date.now().toString(36);
  const names = ["Mum" + uid, "Dad" + uid, "API", "Grandad " + uid];

  assert.equal((await owner.post("/api/spaces", { names: " , " })).status, 400);
  const made = await (await owner.post("/api/spaces", { names })).json();
  assert.equal(made.created.length, 4);
  for (const c of made.created) {
    assert.match(c.pin, /^\d{6}$/);
    assert.equal(c.path, "/" + c.slug);
  }
  const mum = made.created[0], dad = made.created[1], api = made.created[2];
  assert.equal(mum.slug, "mum" + uid);
  assert.equal(api.slug, "api-2"); // a reserved word is never used as an address

  const again = await (await owner.post("/api/spaces", { names: ["Mum" + uid, "Ben" + uid] })).json();
  assert.deepEqual(again.skipped.map((x) => x.name), ["Mum" + uid]);
  assert.equal(again.created.length, 1);

  const list = await (await owner.get("/api/spaces")).json();
  const row = list.find((x) => x.slug === mum.slug);
  assert.equal(row.name, "Mum" + uid);
  assert.equal(row.has_pin, true);
  assert.ok(!("pin" in row) && !("pin_hash" in row));

  // pages and their app files are open; the owner's home page is not
  assert.equal((await fetch(s.base + "/" + mum.slug)).status, 200);
  assert.equal((await fetch(s.base + "/no-such-person")).status, 200); // the page itself says it isn't there
  assert.equal((await fetch(s.base + "/main.js")).status, 200);
  assert.equal((await fetch(s.base + "/")).status, 401);
  const info = await (await fetch(s.base + "/api/space-info", { headers: { "x-space": mum.slug } })).json();
  assert.deepEqual(info, { name: "Mum" + uid, root: false, locked: true });
  assert.equal((await fetch(s.base + "/api/space-info", { headers: { "x-space": "nobody-here" } })).status, 404);
  const manifest = await (await fetch(s.base + "/api/manifest/" + mum.slug)).json();
  assert.equal(manifest.start_url, "/" + mum.slug);
  assert.equal(manifest.share_target.action, "/" + mum.slug);
  assert.match(manifest.name, /^Mum\w+'s? Presents$/);
  assert.equal((await fetch(s.base + "/api/manifest/nobody-here")).status, 404);
  assert.equal((await fetch(s.base + "/api/manifest/")).status, 401); // not a manifest address, so it falls under the normal rules

  // data needs the PIN
  const m = client(s.base, mum.slug);
  const blocked = await m.get("/api/items");
  assert.equal(blocked.status, 401);
  assert.equal((await blocked.json()).code, "pin_required");
  assert.equal((await m.login("000000")).status, 401);
  assert.equal((await m.login(mum.pin)).status, 200);
  assert.equal((await m.get("/api/items")).status, 200);
  assert.deepEqual(await (await m.get("/api/lists")).json(), []);

  // a PIN, or a cookie, only works for its own page
  const asDad = client(s.base, dad.slug); asDad.setCookie(m.cookie);
  assert.equal((await asDad.get("/api/items")).status, 401);
  const forged = client(s.base, mum.slug); forged.setCookie("ffi_" + mum.slug + "=" + Buffer.from(mum.slug + ".99999999999999").toString("base64url") + ".bogus");
  assert.equal((await forged.get("/api/items")).status, 401);
  assert.equal((await client(s.base, mum.slug, { admin: true }).get("/api/items")).status, 200); // the owner can open any page

  // sign out
  const out = await fetch(s.base + "/api/space-logout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space: mum.slug }) });
  assert.match(out.headers.getSetCookie().join(";"), new RegExp("ffi_" + mum.slug + "=;"));

  for (const c of [...made.created, ...again.created]) await owner.del(`/api/spaces/${c.slug}?confirm=${c.slug}`);
});

test("each person's presents, lists and links are private", { skip: !hasDb }, async (t) => {
  const s = await startServer(3223, { APP_PASSWORD: "owner-pass" });
  t.after(s.stop);
  const owner = client(s.base, "", { admin: true });
  const uid = Date.now().toString(36);
  const [mum, dad] = (await (await owner.post("/api/spaces", { names: ["Mum" + uid, "Dad" + uid] })).json()).created;
  const m = client(s.base, mum.slug), d = client(s.base, dad.slug);
  await m.login(mum.pin); await d.login(dad.pin);
  const state = { title: "Shared shop item", price: 25 };
  const shop = mutableShop(state), port = await listen(shop);
  t.after(() => shop.close());

  const rootItem = await (await owner.post("/api/items/manual", { title: "Owner's own present " + uid })).json();
  const mItem = await (await m.post("/api/items/manual", { title: "Mum's present", price: 10 })).json();
  const mList = await (await m.post("/api/lists", { name: "Mum's list", budget: 50 })).json();
  await m.post(`/api/items/${mItem.id}/list`, { list_id: mList.id });

  const seen = async (c) => (await (await c.get("/api/items")).json()).map((i) => i.id);
  assert.ok((await seen(m)).includes(mItem.id) && !(await seen(m)).includes(rootItem.id));
  assert.deepEqual(await seen(d), []);
  assert.ok((await seen(owner)).includes(rootItem.id) && !(await seen(owner)).includes(mItem.id));
  assert.deepEqual(await (await d.get("/api/lists")).json(), []);
  assert.equal((await (await owner.get("/api/lists")).json()).some((l) => l.id === mList.id), false);

  // reaching into someone else's things by id finds nothing
  for (const [fn, p, body] of [
    ["post", `/api/items/${mItem.id}/edit`, { title: "hacked" }],
    ["post", `/api/items/${mItem.id}/bought`, { bought: true }],
    ["post", `/api/items/${mItem.id}/favourite`, { favourite: true }],
    ["post", `/api/items/${mItem.id}/notes`, { notes: "x" }],
    ["post", `/api/items/${mItem.id}/claim`, { claimed_by: "x" }],
    ["post", `/api/items/${mItem.id}/list`, { list_id: null }],
    ["post", `/api/refresh/${mItem.id}`, {}],
    ["post", `/api/lists/${mList.id}`, { name: "hacked" }],
    ["post", `/api/lists/${mList.id}/share`, { enabled: true }]
  ]) assert.equal((await d[fn](p, body)).status, 404, p);
  await d.del(`/api/items/${mItem.id}`);
  await d.del(`/api/lists/${mList.id}`);
  const stillThere = (await (await m.get("/api/items")).json()).find((i) => i.id === mItem.id);
  assert.equal(stillThere.title, "Mum's present");
  assert.equal(stillThere.list_id, mList.id);
  assert.equal((await (await m.get("/api/lists")).json()).length, 1);

  // a present can't be put in someone else's list
  const dItem = await (await d.post("/api/items/manual", { title: "Dad's present", list_id: mList.id })).json();
  assert.equal(dItem.list_id, null);

  // the same link is fine in two places, but not twice in one
  const link = `http://127.0.0.1:${port}/p/${uid}`;
  assert.equal((await m.post("/api/add", { url: link })).status, 200);
  assert.equal((await d.post("/api/add", { url: link })).status, 200);
  assert.equal((await m.post("/api/add", { url: link })).status, 409);

  // exports only hold one person's things
  const exp = await (await m.get("/api/export")).json();
  assert.ok(exp.items.every((i) => i.space === mum.slug));
  assert.ok(!exp.items.some((i) => i.id === dItem.id) && exp.items.some((i) => i.id === mItem.id));
  assert.ok(exp.lists.every((l) => l.id === mList.id));

  // the owner-only diagnostics stay owner-only
  assert.equal((await m.get("/api/debug-price?url=https://example.com")).status, 403);

  for (const c of [mum, dad]) await owner.del(`/api/spaces/${c.slug}?confirm=${c.slug}`);
  await owner.del(`/api/items/${rootItem.id}`);
});

test("too many wrong PINs are blocked; the owner can reset a PIN; people can change their own", { skip: !hasDb }, async (t) => {
  const s = await startServer(3224, { APP_PASSWORD: "owner-pass" });
  t.after(s.stop);
  const owner = client(s.base, "", { admin: true });
  const uid = Date.now().toString(36);
  const [izzy] = (await (await owner.post("/api/spaces", { names: ["Izzy" + uid] })).json()).created;
  const i = client(s.base, izzy.slug);

  for (let n = 0; n < 8; n++) assert.equal((await i.login("999999")).status, 401);
  const blocked = await i.login(izzy.pin);
  assert.equal(blocked.status, 429); // even the right PIN waits
  assert.match((await blocked.json()).error, /Too many tries/);

  const reset = await (await owner.post(`/api/spaces/${izzy.slug}/reset-pin`, {})).json();
  assert.match(reset.pin, /^\d{6}$/);
  assert.notEqual(reset.pin, izzy.pin);
  assert.equal((await i.login(izzy.pin)).status, 401); // the old one is gone
  assert.equal((await i.login(reset.pin)).status, 200);

  assert.equal((await i.post("/api/space-pin", { pin: "12" })).status, 400);
  assert.equal((await i.post("/api/space-pin", { pin: "4321" })).status, 200);
  assert.equal((await client(s.base, izzy.slug).login(reset.pin)).status, 401);
  assert.equal((await client(s.base, izzy.slug).login("4321")).status, 200);
  assert.equal((await owner.post("/api/space-pin", { pin: "4321" })).status, 400); // the owner's own site has no PIN
  assert.equal((await owner.post("/api/spaces/nobody/reset-pin", {})).status, 404);

  await owner.del(`/api/spaces/${izzy.slug}?confirm=${izzy.slug}`);
});

test("alerts go to each person's own topic", { skip: !hasDb }, async (t) => {
  const got = [];
  const ntfy = fakeNtfy(got), nport = await listen(ntfy);
  t.after(() => ntfy.close());
  const s = await startServer(3225, { APP_PASSWORD: "owner-pass", NTFY_SERVER: "http://127.0.0.1:" + nport, NTFY_TOPIC: undefined });
  t.after(s.stop);
  const owner = client(s.base, "", { admin: true });
  const uid = Date.now().toString(36);
  const [mum, dad] = (await (await owner.post("/api/spaces", { names: ["Mum" + uid, "Dad" + uid] })).json()).created;
  const m = client(s.base, mum.slug), d = client(s.base, dad.slug);
  await m.login(mum.pin); await d.login(dad.pin);
  const state = { title: "Candle", price: 50 };
  const shop = mutableShop(state), port = await listen(shop);
  t.after(() => shop.close());

  assert.deepEqual(await (await m.get("/api/alerts/status")).json(), { enabled: false });
  assert.equal((await m.post("/api/alerts/test", {})).status, 400);
  assert.equal((await m.post("/api/alerts/topic", { topic: "short" })).status, 400);
  assert.equal((await m.post("/api/alerts/topic", { topic: "has spaces in it!" })).status, 400);
  assert.deepEqual(await (await m.post("/api/alerts/topic", { topic: "mums-secret-topic-" + uid })).json(), { enabled: true });
  assert.deepEqual(await (await d.get("/api/alerts/status")).json(), { enabled: false });
  assert.deepEqual(await (await owner.get("/api/alerts/status")).json(), { enabled: false });

  assert.equal((await m.post("/api/alerts/test", {})).status, 200);
  assert.equal(got.at(-1).topic, "mums-secret-topic-" + uid);
  assert.match(got.at(-1).title, /^Mum\w+'s? Presents test$/);

  const item = await (await m.post("/api/add", { url: `http://127.0.0.1:${port}/p/a-${uid}` })).json();
  const dadItem = await (await d.post("/api/add", { url: `http://127.0.0.1:${port}/p/b-${uid}` })).json();
  const before = got.length;
  state.price = 40;
  await m.post("/api/refresh/" + item.id, {});
  await d.post("/api/refresh/" + dadItem.id, {}); // Dad has no topic, so nothing is sent for his
  assert.equal(got.length, before + 1);
  assert.equal(got.at(-1).topic, "mums-secret-topic-" + uid);
  assert.match(got.at(-1).message, /£40\.00 \(was £50\.00, 20% off\)/);

  // turning alerts off
  assert.deepEqual(await (await m.post("/api/alerts/topic", { topic: "" })).json(), { enabled: false });
  state.price = 20;
  await m.post("/api/refresh/" + item.id, {});
  assert.equal(got.length, before + 1);

  for (const c of [mum, dad]) await owner.del(`/api/spaces/${c.slug}?confirm=${c.slug}`);
});

test("deleting a page removes everything in it", { skip: !hasDb }, async (t) => {
  const s = await startServer(3226, { APP_PASSWORD: "owner-pass" });
  t.after(s.stop);
  const owner = client(s.base, "", { admin: true });
  const uid = Date.now().toString(36);
  const [ben] = (await (await owner.post("/api/spaces", { names: ["Ben" + uid] })).json()).created;
  const b = client(s.base, ben.slug);
  await b.login(ben.pin);
  await b.post("/api/items/manual", { title: "Ben's thing", price: 5 });
  await b.post("/api/lists", { name: "Ben's list" });
  const total = async () => (await (await owner.get("/api/spaces")).json()).find((x) => x.slug === ben.slug)?.presents;
  assert.equal(await total(), 1);

  assert.equal((await owner.del(`/api/spaces/${ben.slug}`)).status, 400);
  assert.equal((await owner.del(`/api/spaces/${ben.slug}?confirm=nope`)).status, 400);
  assert.equal((await owner.del(`/api/spaces/${ben.slug}?confirm=${ben.slug}`)).status, 200);
  assert.equal(await total(), undefined);
  assert.equal((await fetch(s.base + "/api/space-info", { headers: { "x-space": ben.slug } })).status, 404);
  assert.equal((await b.get("/api/items")).status, 404);
  assert.equal((await owner.del(`/api/spaces/${ben.slug}?confirm=${ben.slug}`)).status, 404);
});

test("the owner's full backup covers every page and can restore one person", { skip: !hasDb }, async (t) => {
  const s = await startServer(3227, { APP_PASSWORD: "owner-pass" });
  t.after(s.stop);
  const owner = client(s.base, "", { admin: true });
  const uid = Date.now().toString(36);
  const [mum] = (await (await owner.post("/api/spaces", { names: ["Mum" + uid] })).json()).created;
  const m = client(s.base, mum.slug);
  await m.login(mum.pin);
  const mine = await (await m.post("/api/items/manual", { title: "Mum's scarf", price: 12.5 })).json();
  const rootItem = await (await owner.post("/api/items/manual", { title: "Owner's own " + uid, price: 3 })).json();
  await m.post("/api/lists", { name: "Mum's list" });

  // only the owner can ask for everyone's data
  assert.equal((await m.get("/api/export-all")).status, 403); // signed in, but not the owner
  assert.equal((await client(s.base, "").get("/api/export-all")).status, 401);
  const all = await (await owner.get("/api/export-all")).json();
  assert.equal(all.version, 3);
  const mumPart = all.spaces.find((x) => x.slug === mum.slug);
  const rootPart = all.spaces.find((x) => x.slug === "");
  assert.ok(mumPart.export.items.some((i) => i.id === mine.id));
  assert.ok(!mumPart.export.items.some((i) => i.id === rootItem.id));
  assert.ok(rootPart.export.items.some((i) => i.id === rootItem.id));
  assert.ok(!JSON.stringify(all).includes("pin_hash") && !JSON.stringify(all).includes("scrypt$"));

  // lose Mum's things, then restore just her part from the full backup
  await m.del(`/api/items/${mine.id}`);
  const lists = await (await m.get("/api/lists")).json();
  for (const l of lists) await m.del(`/api/lists/${l.id}`);
  assert.deepEqual(await (await m.get("/api/items")).json(), []);
  const restored = await (await m.post("/api/import", all)).json();
  assert.equal(restored.added, 1);
  const back = (await (await m.get("/api/items")).json()).find((i) => i.id === mine.id);
  assert.equal(back.title, "Mum's scarf");
  assert.equal(back.space, mum.slug);
  assert.equal((await (await m.get("/api/lists")).json()).length, 1);
  // a full backup with nothing for this page is refused
  const dadless = client(s.base, mum.slug, { admin: true });
  assert.equal((await dadless.post("/api/import", { spaces: [{ slug: "somebody-else", export: { items: [] } }] })).status, 400);

  await owner.del(`/api/spaces/${mum.slug}?confirm=${mum.slug}`);
  await owner.del(`/api/items/${rootItem.id}`);
});

test("the family menu lists everyone, only to people who are signed in", { skip: !hasDb }, async (t) => {
  const s = await startServer(3228, { APP_PASSWORD: "owner-pass" });
  t.after(s.stop);
  const owner = client(s.base, "", { admin: true });
  const uid = Date.now().toString(36);
  const made = (await (await owner.post("/api/spaces", { names: ["Mum" + uid, "Dad" + uid, "Owain" + uid] })).json()).created;
  const [mum, dad] = made;
  const m = client(s.base, mum.slug);

  // not signed in: nothing
  assert.equal((await m.get("/api/family")).status, 401);
  assert.equal((await client(s.base, "").get("/api/family")).status, 401);

  // signed in to one page: sees everyone's name and address, and nothing secret
  await m.login(mum.pin);
  const seen = await (await m.get("/api/family")).json();
  assert.deepEqual(seen.map((x) => x.slug), made.map((x) => x.slug));
  assert.deepEqual(Object.keys(seen[0]).sort(), ["name", "slug"]);
  assert.ok(!JSON.stringify(seen).includes(mum.pin));

  // seeing the menu doesn't open anyone else's page
  assert.equal((await client(s.base, dad.slug).get("/api/items")).status, 401);
  const asMum = client(s.base, dad.slug); asMum.setCookie(m.cookie);
  assert.equal((await asMum.get("/api/items")).status, 401);

  // the owner sees them on their own site too
  assert.deepEqual((await (await owner.get("/api/family")).json()).map((x) => x.slug), made.map((x) => x.slug));

  // a page that is signed in elsewhere and then deleted drops out of the menu
  await owner.del(`/api/spaces/${made[2].slug}?confirm=${made[2].slug}`);
  assert.deepEqual((await (await m.get("/api/family")).json()).map((x) => x.slug), [mum.slug, dad.slug]);

  for (const c of [mum, dad]) await owner.del(`/api/spaces/${c.slug}?confirm=${c.slug}`);
});

test("without a password the owner's open site shows no family menu", { skip: !hasDb }, async (t) => {
  const s = await startServer(3229, { APP_PASSWORD: undefined });
  t.after(s.stop);
  assert.deepEqual(await (await client(s.base, "").get("/api/family")).json(), []);
});

test("share everything: one link per person, only that person's presents, claim works, revoke works", { skip: !hasDb }, async (t) => {
  const s = await startServer(3230, { APP_PASSWORD: "owner-pass" });
  t.after(s.stop);
  const owner = client(s.base, "", { admin: true });
  const uid = Date.now().toString(36);
  const made = (await (await owner.post("/api/spaces", { names: ["Mum" + uid, "Dad" + uid] })).json()).created;
  const [mum, dad] = made;
  const m = client(s.base, mum.slug), d = client(s.base, dad.slug);
  await m.login(mum.pin); await d.login(dad.pin);

  const list = await (await m.post("/api/lists", { name: "Birthday" })).json();
  await m.post("/api/import", { items: [
    { id: "m1_" + uid, url: "https://example.com/m1", title: "Mum scarf", price_value: 9, notes: "secret note" },
    { id: "m2_" + uid, url: "https://example.com/m2", title: "Mum book", price_value: 7 }] });
  await m.post(`/api/items/m1_${uid}/list`, { list_id: list.id });
  await d.post("/api/import", { items: [{ id: "d1_" + uid, url: "https://example.com/d1", title: "Dad socks", price_value: 4 }] });

  // you must be signed in to manage the link
  assert.equal((await client(s.base, mum.slug).post("/api/page-share", { enabled: true })).status, 401);
  assert.equal((await m.get("/api/page-share").then((r) => r.json())).token, null);

  const { token } = await (await m.post("/api/page-share", { enabled: true })).json();
  assert.match(token, /^[a-f0-9]{32}$/);

  // no PIN needed to look; shows only Mum's lists and presents, no notes
  const anon = (p, body) => fetch(s.base + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const view = await (await anon("/api/pageshare/" + token)).json();
  assert.match(view.title, /^Mum/);
  assert.deepEqual(view.items.map((i) => i.title).sort(), ["Mum book", "Mum scarf"]);
  assert.deepEqual(view.lists.map((l) => l.name), ["Birthday"]);
  assert.ok(view.items.every((i) => !("notes" in i)));
  assert.equal((await anon("/w/" + token)).status, 200);

  // claiming works, and only for Mum's presents
  const claim = (itemId, body) => anon(`/api/pageshare/${token}/claim`, { itemId, ...body });
  assert.equal((await claim("m1_" + uid, { name: "Sam" })).status, 200);
  assert.equal((await claim("m1_" + uid, { name: "Alex" })).status, 409);
  assert.equal((await claim("d1_" + uid, { name: "Sam" })).status, 404);
  assert.equal((await claim("m1_" + uid, { name: "Sam", claim: false })).status, 200);

  // the link can't be used to reach the private page itself, or other people's data
  assert.equal((await client(s.base, mum.slug).get("/api/items")).status, 401);
  assert.equal((await anon("/api/pageshare/" + "0".repeat(32))).status, 404);

  // turning it off kills the link; turning it on again makes a different one
  await m.post("/api/page-share", { enabled: false });
  assert.equal((await anon("/api/pageshare/" + token)).status, 404);
  const again = (await (await m.post("/api/page-share", { enabled: true })).json()).token;
  assert.notEqual(again, token);

  // deleting the person's page also kills the link
  await owner.del(`/api/spaces/${mum.slug}?confirm=${mum.slug}`);
  assert.equal((await anon("/api/pageshare/" + again)).status, 404);
  await owner.del(`/api/spaces/${dad.slug}?confirm=${dad.slug}`);
});
