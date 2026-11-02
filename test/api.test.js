import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";

let server, base;
const outbox = [];
const mailer = { configured: true, async send(m) { outbox.push(m); } };
before(async () => {
  server = http.createServer(createApp(openDb(":memory:"), { trustProxy: true, appUrl: "https://fm.example", mailer }));
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let ipSeq = 1;
function agent(ip = `10.0.0.${ipSeq++}`) {
  let cookie = "";
  return async function call(method, path, body, headers = {}) {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: { "x-forwarded-for": `203.0.113.9, ${ip}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, body: await r.json() };
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
  assert.equal(proj.code, "FM-1001");
  assert.equal(proj.status, "active");
  assert.equal(proj.revisionsAllowed, 3);
  const pays = p.body.data.payments.filter(x => x.projectId === proj.id);
  assert.deepEqual(pays.map(x => [x.kind, x.amount]), [["deposit", 300], ["balance", 700]]);
  assert.equal(pays[1].dueDate, "2030-01-10");
  const p2 = await a("POST", "/projects", { title: "Second" });
  assert.equal(p2.body.data.projects.find(x => x.id === p2.body.id).code, "FM-1002");
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
  assert.equal(s.body.data.projects.length, 4);
  assert.equal(s.body.data.me.currency, "EGP");
  const ex = await a("GET", "/export");
  assert.equal(ex.body.app, "freelancers-manager");
  const b = agent();
  await signup(b, "six@example.com");
  const imp = await b("POST", "/import", ex.body);
  assert.equal(imp.status, 200);
  const d = imp.body.data;
  assert.equal(d.projects.length, 4);
  assert.equal(d.clients.length, 4);
  assert.equal(d.payments.length, 8);
  assert.ok(d.projects.every(p => d.clients.some(c => c.id === p.clientId)));
  const p = await b("POST", "/projects", { title: "After import" });
  assert.equal(p.body.data.projects.find(x => x.id === p.body.id).code, "FM-1005");
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
