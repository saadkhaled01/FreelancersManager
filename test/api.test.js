import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";

let server, base, gserver, gbase;
const outbox = [];
const mailer = { configured: true, async send(m) { outbox.push(m); } };

/* A tiny stand-in for Google's OAuth and Calendar APIs. */
const G = { calendars: new Map(), revoked: [], seq: 1 };
function fakeGoogle(req, res) {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://g");
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(obj ? JSON.stringify(obj) : ""); };
    if (url.pathname === "/token") {
      const p = new URLSearchParams(raw);
      if (p.get("grant_type") === "authorization_code" && p.get("code") === "good-code")
        return json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
      if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "rt-1") return json(200, { access_token: "at-2", expires_in: 3600 });
      return json(400, { error: "invalid_grant" });
    }
    if (url.pathname === "/revoke") { G.revoked.push(url.searchParams.get("token")); return json(200, {}); }
    if (!/^Bearer at-/.test(req.headers.authorization || "")) return json(401, {});
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const body = raw ? JSON.parse(raw) : null;
    if (parts[0] !== "calendars") return json(404);
    if (parts.length === 1 && req.method === "POST") {
      const id = `cal${G.seq++}@group.calendar.google.com`;
      G.calendars.set(id, { ...body, id, events: new Map() });
      return json(200, { id });
    }
    const cal = G.calendars.get(parts[1]);
    if (!cal) return json(404);
    if (parts.length === 2 && req.method === "GET") return json(200, { id: cal.id });
    if (parts.length === 2 && req.method === "DELETE") { G.calendars.delete(parts[1]); return json(204); }
    if (parts[2] !== "events") return json(404);
    if (parts.length === 3 && req.method === "POST") { const id = `ev${G.seq++}`; cal.events.set(id, body); return json(200, { id }); }
    if (!cal.events.has(parts[3])) return json(404);
    if (req.method === "PUT") { cal.events.set(parts[3], body); return json(200, { id: parts[3] }); }
    if (req.method === "DELETE") { cal.events.delete(parts[3]); return json(204); }
    return json(404);
  });
}

before(async () => {
  gserver = http.createServer(fakeGoogle);
  await new Promise(r => gserver.listen(0, r));
  gbase = `http://127.0.0.1:${gserver.address().port}`;
  server = http.createServer(createApp(openDb(":memory:"), {
    trustProxy: true, appUrl: "https://fm.example", mailer,
    google: { clientId: "cid", clientSecret: "secret", secretKey: "test-secret-key", authUrl: gbase + "/auth", tokenUrl: gbase + "/token", apiBase: gbase, revokeUrl: gbase + "/revoke", syncDelay: 20 },
  }));
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); gserver.close(); });

let ipSeq = 1;
function agent(ip = `10.0.0.${ipSeq++}`) {
  const jar = new Map();
  return async function call(method, path, body, headers = {}) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(base + "/api" + path, {
      method,
      headers: { "x-forwarded-for": `203.0.113.9, ${ip}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      if (/Max-Age=0/.test(c)) jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* redirects and calendars aren't JSON */ }
    return { status: r.status, body: json, text, location: r.headers.get("location") };
  };
}

const signup = async (call, email, extra = {}) =>
  call("POST", "/signup", { name: "Test", email, password: "password123", lang: "en", ...extra });

test("signup, session, logout, login", async () => {
  const a = agent();
  assert.equal((await a("GET", "/data")).status, 401);
  const s = await signup(a, "one@example.com");
  assert.equal(s.status, 200);
  assert.equal(s.body.data.me.email, "one@example.com");
  assert.equal(s.body.data.me.currency, "USD");
  assert.equal((await signup(agent(), "ONE@example.com")).status, 409);
  assert.equal((await a("POST", "/logout", {})).status, 200);
  assert.equal((await a("GET", "/data")).status, 401);
  assert.equal((await a("POST", "/login", { email: "one@example.com", password: "nope-nope" })).status, 400);
  assert.equal((await a("POST", "/login", { email: "one@example.com", password: "password123" })).status, 200);
  assert.equal((await a("GET", "/data")).status, 200);
});

test("rejects weak input and non-JSON or cross-site mutations", async () => {
  const a = agent();
  assert.equal((await a("POST", "/signup", { name: "x", email: "bad", password: "password123" })).body.field, "email");
  assert.equal((await a("POST", "/signup", { name: "x", email: "x@y.co", password: "short" })).body.field, "password");
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(r.status, 415);
  assert.equal((await a("POST", "/login", {}, { origin: "https://evil.example" })).status, 403);
});

test("project creation splits deposit and balance, codes increment", async () => {
  const a = agent();
  await signup(a, "two@example.com");
  const c = await a("POST", "/clients", { name: "Acme", phone: "01011112222", lang: "ar" });
  const p = await a("POST", "/projects", { title: "Promo", clientId: c.body.id, fee: 1000, dueDate: "2030-01-10", depositPct: 30 });
  assert.equal(p.status, 200);
  const proj = p.body.data.projects.find(x => x.id === p.body.id);
  assert.match(proj.code, /^FM-\d{4}-001$/);
  assert.equal(proj.status, "lead");
  assert.equal(proj.revisionsAllowed, 3);
  const pays = p.body.data.payments.filter(x => x.projectId === proj.id);
  assert.deepEqual(pays.map(x => [x.kind, x.amount]), [["deposit", 300], ["balance", 700]]);
  assert.equal(pays[1].dueDate, "2030-01-10");
  const p2 = await a("POST", "/projects", { title: "Second" });
  assert.match(p2.body.data.projects.find(x => x.id === p2.body.id).code, /^FM-\d{4}-002$/);
  assert.equal(p2.body.data.payments.filter(x => x.projectId === p2.body.id).length, 0);
});

test("revision rounds, payments and activity log", async () => {
  const a = agent();
  await signup(a, "three@example.com");
  const { body } = await a("POST", "/projects", { title: "Film", fee: 500 });
  const id = body.id;
  await a("PATCH", `/projects/${id}`, { status: "with_client", links: [{ url: "https://x.example/v1", label: "v1" }] });
  const r = await a("PATCH", `/projects/${id}`, { status: "revising" });
  assert.equal(r.body.data.projects[0].revisionsUsed, 1);
  const dep = r.body.data.payments.find(p => p.kind === "deposit");
  const paid = await a("PATCH", `/payments/${dep.id}`, { paidAt: "2026-01-01", method: "instapay", ref: "IP-1" });
  const kinds = paid.body.data.activity.map(x => x.kind);
  for (const k of ["created", "status", "round", "link", "paid"]) assert.ok(kinds.includes(k), k);
  await a("POST", `/projects/${id}/notes`, { text: "Client loved it" });
  const d = await a("GET", "/data");
  assert.equal(d.body.data.activity[0].data.text, "Client loved it");
  assert.equal((await a("PATCH", `/projects/${id}`, { status: "bogus" })).status, 400);
  assert.equal((await a("PATCH", `/payments/${dep.id}`, { method: "bitcoin" })).status, 400);
  assert.equal((await a("PATCH", `/projects/${id}`, { links: [{ url: "javascript:alert(1)" }] })).status, 400);
});

test("users cannot see or touch each other's records", async () => {
  const a = agent(), b = agent();
  await signup(a, "a@example.com");
  await signup(b, "b@example.com");
  const c = await a("POST", "/clients", { name: "Private" });
  const p = await a("POST", "/projects", { title: "Secret", clientId: c.body.id, fee: 100 });
  const bd = await b("GET", "/data");
  assert.equal(bd.body.data.clients.length, 0);
  assert.equal(bd.body.data.projects.length, 0);
  assert.equal((await b("PATCH", `/projects/${p.body.id}`, { title: "pwned" })).status, 404);
  assert.equal((await b("DELETE", `/clients/${c.body.id}`)).status, 404);
  assert.equal((await b("POST", "/payments", { projectId: p.body.id, amount: 1 })).status, 404);
  assert.equal((await b("POST", "/projects", { title: "x", clientId: c.body.id })).status, 404);
});

test("client with projects can't be deleted; project delete cascades", async () => {
  const a = agent();
  await signup(a, "four@example.com");
  const c = await a("POST", "/clients", { name: "Busy" });
  const p = await a("POST", "/projects", { title: "Job", clientId: c.body.id, fee: 200 });
  await a("POST", "/deliverables", { projectId: p.body.id, label: "Cut 1" });
  assert.equal((await a("DELETE", `/clients/${c.body.id}`)).status, 409);
  const del = await a("DELETE", `/projects/${p.body.id}`);
  assert.equal(del.body.data.payments.length, 0);
  assert.equal(del.body.data.deliverables.length, 0);
  assert.equal((await a("DELETE", `/clients/${c.body.id}`)).status, 200);
});

test("examples, export and import round trip", async () => {
  const a = agent();
  const s = await signup(a, "five@example.com", { examples: true, lang: "ar" });
  assert.equal(s.body.data.projects.length, 5);
  assert.equal(s.body.data.me.currency, "EGP");
  const ex = await a("GET", "/export");
  assert.equal(ex.body.app, "freelancers-manager");
  const b = agent();
  await signup(b, "six@example.com");
  const imp = await b("POST", "/import", ex.body);
  assert.equal(imp.status, 200);
  const d = imp.body.data;
  assert.equal(d.projects.length, 5);
  assert.equal(d.clients.length, 4);
  assert.equal(d.payments.length, 10);
  assert.ok(d.projects.every(p => d.clients.some(c => c.id === p.clientId)));
  assert.ok(d.projects.some(p => p.sessionAt && p.folderUrl === "" || p.folderUrl));
  const p = await b("POST", "/projects", { title: "After import" });
  assert.match(p.body.data.projects.find(x => x.id === p.body.id).code, /^FM-\d{4}-006$/);
  assert.equal((await b("POST", "/import", { app: "other" })).status, 400);
});

test("settings, password change, account delete", async () => {
  const a = agent();
  await signup(a, "seven@example.com");
  const r = await a("PATCH", "/me", { currency: "EGP", instapay: "me@instapay", templates: { reminder: { en: "Pay {amount}" } } });
  assert.equal(r.body.data.me.templates.reminder.en, "Pay {amount}");
  assert.equal((await a("PATCH", "/me", { currency: "XXX" })).status, 400);
  assert.equal((await a("POST", "/me/password", { current: "wrong-pass", next: "newpassword1" })).status, 400);
  assert.equal((await a("POST", "/me/password", { current: "password123", next: "newpassword1" })).status, 200);
  assert.equal((await a("GET", "/data")).status, 200);
  assert.equal((await a("DELETE", "/me", { password: "newpassword1" })).status, 200);
  assert.equal((await agent()("POST", "/login", { email: "seven@example.com", password: "newpassword1" })).status, 400);
});

test("static files and SPA fallback", async () => {
  assert.equal((await fetch(base + "/healthz")).status, 200);
  const r = await fetch(base + "/projects");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.equal((await fetch(base + "/../server/db.js")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e/server/db.js")).status, 404);
});

test("password reset by email", async () => {
  const a = agent();
  await signup(a, "reset@example.com", { lang: "ar" });
  outbox.length = 0;
  assert.equal((await a("POST", "/forgot", { email: "nobody@example.com" })).status, 200);
  assert.equal(outbox.length, 0);
  assert.equal((await a("POST", "/forgot", { email: "RESET@example.com" })).status, 200);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, "reset@example.com");
  const token = outbox[0].text.match(/https:\/\/fm\.example\/#reset\/([\w-]+)/)[1];
  assert.match(outbox[0].subject, /باسورد/);
  const b = agent();
  assert.equal((await b("POST", "/reset", { token: "bogus", password: "brandnew123" })).body.error, "bad_token");
  assert.equal((await b("POST", "/reset", { token, password: "short" })).body.field, "password");
  const r = await b("POST", "/reset", { token, password: "brandnew123" });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.me.email, "reset@example.com");
  assert.equal((await b("POST", "/reset", { token, password: "another123" })).body.error, "bad_token");
  assert.equal((await a("GET", "/data")).status, 401, "old sessions end");
  assert.equal((await agent()("POST", "/login", { email: "reset@example.com", password: "brandnew123" })).status, 200);
});

test("rate limits: signups per IP, reset emails per address", async () => {
  const ip = "10.9.9.9";
  for (let i = 0; i < 5; i++) assert.equal((await signup(agent(ip), `bulk${i}@example.com`)).status, 200);
  assert.equal((await signup(agent(ip), "bulk5@example.com")).status, 429);
  assert.equal((await signup(agent("10.9.9.10"), "bulk5@example.com")).status, 200);
  outbox.length = 0;
  for (let i = 0; i < 5; i++) await agent()("POST", "/forgot", { email: "bulk0@example.com" });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(outbox.length, 3);
});

test("duplicate, session time, folder link, and auto-done when paid", async () => {
  const a = agent();
  await signup(a, "dup@example.com");
  const c = await a("POST", "/clients", { name: "Repeat Co" });
  const p = await a("POST", "/projects", { title: "Monthly reel", clientId: c.body.id, fee: 1000, status: "active", sessionAt: "2030-03-04T10:30", folderUrl: "https://drive.google.com/x" });
  await a("POST", "/deliverables", { projectId: p.body.id, label: "Reel" });
  assert.equal((await a("PATCH", `/projects/${p.body.id}`, { sessionAt: "2030-03-04 10:30" })).status, 400);
  assert.equal((await a("PATCH", `/projects/${p.body.id}`, { folderUrl: "ftp://x" })).status, 400);
  const d = await a("POST", `/projects/${p.body.id}/duplicate`, { title: "Monthly reel (April)" });
  const copy = d.body.data.projects.find(x => x.id === d.body.id);
  assert.equal(copy.status, "lead");
  assert.equal(copy.clientId, c.body.id);
  assert.equal(copy.folderUrl, "https://drive.google.com/x");
  assert.equal(copy.sessionAt, null);
  assert.equal(d.body.data.deliverables.filter(x => x.projectId === copy.id).length, 1);
  await a("PATCH", `/projects/${p.body.id}`, { status: "delivered" });
  let data;
  for (const pay of (await a("GET", "/data")).body.data.payments.filter(x => x.projectId === p.body.id))
    data = (await a("PATCH", `/payments/${pay.id}`, { paidAt: "2030-03-10", method: "cash" })).body.data;
  assert.equal(data.projects.find(x => x.id === p.body.id).status, "archived");
});

test("calendar feed: off by default, private link, valid iCalendar", async () => {
  const a = agent();
  await signup(a, "cal@example.com", { examples: true, lang: "ar" });
  assert.equal((await a("GET", "/data")).body.data.me.calToken, null);
  const on = await a("POST", "/me/calendar", {});
  const token = on.body.data.me.calToken;
  assert.ok(token.length > 20);
  const r = await fetch(`${base}/cal/${token}.ics`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/calendar/);
  const ics = await r.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(ics.includes("SUMMARY:تسليم"));
  assert.ok(/DTSTART:\d{8}T100000/.test(ics), "timed session event");
  assert.ok(ics.split("\r\n").every(l => Buffer.byteLength(l) <= 75), "lines folded to 75 octets");
  await a("DELETE", "/me/calendar");
  assert.equal((await fetch(`${base}/cal/${token}.ics`)).status, 404);
  assert.equal((await fetch(`${base}/cal/nope.ics`)).status, 404);
});

test("Google Calendar: connect, sync changes, disconnect", async () => {
  const a = agent();
  await signup(a, "gcal@example.com", { examples: true });
  assert.deepEqual((await a("GET", "/data")).body.data.me.google, { available: true, connected: false });
  const go = await a("GET", "/google/connect?tz=Africa/Cairo");
  assert.equal(go.status, 302);
  const auth = new URL(go.location);
  assert.equal(auth.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.app.created");
  assert.equal(auth.searchParams.get("redirect_uri"), "https://fm.example/api/google/callback");
  const state = auth.searchParams.get("state");
  assert.equal((await a("GET", `/google/callback?code=good-code&state=wrong`)).location, "/#settings/google-error");
  // The bad attempt cleared the state cookie, so start again.
  const go2 = await a("GET", "/google/connect");
  const state2 = new URL(go2.location).searchParams.get("state");
  assert.notEqual(state, state2);
  assert.equal((await a("GET", `/google/callback?code=good-code&state=${state2}`)).location, "/#settings/google-ok");
  await a("POST", "/google/sync", {});
  const me = (await a("GET", "/data")).body.data.me;
  assert.equal(me.google.connected, true);
  assert.equal(me.google.lastError, "");
  assert.equal(me.tz, "Africa/Cairo");
  const [cal] = [...G.calendars.values()];
  assert.equal(cal.timeZone, "Africa/Cairo");
  const n = cal.events.size;
  assert.ok(n >= 5, `events: ${n}`);
  const session = [...cal.events.values()].find(e => e.start.dateTime);
  assert.equal(session.start.timeZone, "Africa/Cairo");

  // Changing a due date updates the event; deleting a project removes its events (sync runs after each change).
  const data = (await a("GET", "/data")).body.data;
  const proj = data.projects.find(p => p.status === "active");
  await a("PATCH", `/projects/${proj.id}`, { dueDate: "2031-01-15" });
  await new Promise(r => setTimeout(r, 150));
  assert.ok([...cal.events.values()].some(e => e.start.date === "2031-01-15"));
  await a("DELETE", `/projects/${proj.id}`);
  await new Promise(r => setTimeout(r, 150));
  assert.ok(cal.events.size < n);

  // If the user deletes the calendar in Google, the next sync makes a new one.
  G.calendars.clear();
  await a("POST", "/google/sync", {});
  assert.equal(G.calendars.size, 1);
  assert.ok([...G.calendars.values()][0].events.size > 0);

  await a("DELETE", "/google");
  assert.equal(G.calendars.size, 0);
  assert.deepEqual(G.revoked, ["rt-1"]);
  assert.equal((await a("GET", "/data")).body.data.me.google.connected, false);
});

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("style: brand settings and logo", async () => {
  const a = agent();
  await signup(a, "brand@example.com");
  const brand = { color: "#2F5D8A", layout: "bold", font: "elegant", accent: "gradient", address: "Cairo", website: "studio.example", taxId: "123-456", showPay: false, footer: { ar: "شكرًا", en: "Thanks" }, intro: { en: "Dear client" } };
  const r = await a("PATCH", "/me", { brand });
  assert.deepEqual(r.body.data.me.brand, brand);
  for (const layout of ["sidebar", "studio", "corporate", "receipt", "letterhead", "split"])
    assert.equal((await a("PATCH", "/me", { brand: { ...brand, layout } })).body.data.me.brand.layout, layout);
  await a("PATCH", "/me", { brand });
  for (const bad of [{ color: "red" }, { layout: "fancy" }, { font: "comic" }, { accent: "neon" }, { website: "javascript:alert(1)" }, { footer: { en: "x".repeat(601) } }, { intro: { ar: "x".repeat(1201) } }])
    assert.equal((await a("PATCH", "/me", { brand: { ...brand, ...bad } })).status, 400, JSON.stringify(bad));
  assert.equal(r.body.data.me.logoVersion, null);
  assert.equal((await a("PUT", "/me/logo", { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).status, 400);
  assert.equal((await a("PUT", "/me/logo", { dataUrl: "data:image/png;base64,AAAA" })).status, 400, "wrong signature");
  const up = await a("PUT", "/me/logo", { dataUrl: PNG });
  assert.match(up.body.data.me.logoVersion, /^[0-9a-f]{10}$/);
  const img = await a("GET", "/me/logo");
  assert.equal(img.status, 200);
  const ex = await a("GET", "/export");
  assert.equal(ex.body.settings.logo, PNG);
  assert.equal(ex.body.settings.brand.layout, "bold");
  await a("DELETE", "/me/logo");
  assert.equal((await a("GET", "/me/logo")).status, 404);
});

test("shared document link: public view, logo, revoke", async () => {
  const a = agent();
  await signup(a, "share@example.com", { lang: "en" });
  await a("PATCH", "/me", { business: "Lens & Co", brand: { color: "#B23A2E", layout: "minimal", font: "modern" } });
  await a("PUT", "/me/logo", { dataUrl: PNG });
  const c = await a("POST", "/clients", { name: "Mona Adel", phone: "01011112222", email: "mona@example.com", lang: "ar" });
  const p = await a("POST", "/projects", { title: "Wedding film", clientId: c.body.id, fee: 9000, status: "active" });
  const s = await a("POST", `/projects/${p.body.id}/share`, {});
  const token = s.body.data.projects.find(x => x.id === p.body.id).shareToken;
  assert.ok(token.length >= 20);
  assert.equal((await a("POST", `/projects/${p.body.id}/share`, {})).body.data.projects.find(x => x.id === p.body.id).shareToken, token, "stable");
  const pub = await fetch(`${base}/api/public/doc/${token}`);
  assert.equal(pub.status, 200);
  const d = await pub.json();
  assert.equal(d.kind, "invoice");
  assert.equal(d.lang, "ar");
  assert.equal(d.fee, 9000);
  assert.equal(d.owed, 9000);
  assert.equal(d.from.business, "Lens & Co");
  assert.equal(d.brand.layout, "minimal");
  assert.equal(d.client.email, undefined, "client email is not exposed");
  assert.equal(d.hasLogo, true);
  assert.equal((await fetch(`${base}/api/public/doc/${token}/logo`)).headers.get("content-type"), "image/png");
  const page = await fetch(`${base}/d/${token}`);
  assert.match(await page.text(), /doc-page\.js/);
  // Other users can't share someone else's project.
  assert.equal((await agent()("POST", `/projects/${p.body.id}/share`, {})).status, 401);
  await a("DELETE", `/projects/${p.body.id}/share`);
  assert.equal((await fetch(`${base}/api/public/doc/${token}`)).status, 404);
});

test("email a document with branding", async () => {
  const a = agent();
  await signup(a, "mailer@example.com", { lang: "ar" });
  await a("PATCH", "/me", { business: "استوديو نور", brand: { color: "#6B4E9B" } });
  const c = await a("POST", "/clients", { name: "Omar Said", lang: "en" });
  const p = await a("POST", "/projects", { title: "Menu photos", clientId: c.body.id, fee: 3000 });
  outbox.length = 0;
  assert.equal((await a("POST", `/projects/${p.body.id}/email`, { to: "not-an-email", lang: "en" })).status, 400);
  const r = await a("POST", `/projects/${p.body.id}/email`, { to: "omar@example.com", lang: "en", message: "Here's the quote we discussed." });
  assert.equal(r.status, 200);
  assert.equal(outbox.length, 1);
  const m = outbox[0];
  assert.equal(m.to, "omar@example.com");
  assert.equal(m.replyTo, "mailer@example.com");
  assert.match(m.subject, /^Quote FM-\d{4}-001 from استوديو نور$/);
  assert.ok(m.html.includes("#6B4E9B"));
  const link = m.text.match(/https:\/\/fm\.example\/d\/([\w-]+)\?lang=en/);
  assert.ok(link, m.text);
  assert.equal((await fetch(`${base}/api/public/doc/${link[1]}`)).status, 200);
  const act = r.body.data.activity.find(x => x.kind === "sent");
  assert.equal(act.data.via, "email");
});
