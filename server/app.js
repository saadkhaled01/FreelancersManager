import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tx } from "./db.js";
import * as auth from "./auth.js";
import {
  SPECS, ME_SPEC, HttpError, validate, snapshot, publicMe, log, owned, insert, update,
  defaultPayments, today, now,
} from "./model.js";
import { seedExamples } from "./seed.js";
import { createMailer, resetEmail } from "./mail.js";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
].join("; ");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BODY_LIMIT = 5 * 1024 * 1024;

export function createApp(db, { secureCookies = false, trustProxy = false, appUrl = "", mailer = createMailer() } = {}) {
  setInterval(() => auth.pruneSessions(db), 6 * 3600e3).unref();
  const limits = {
    login: new auth.Limiter(10, 15 * 60e3),      // failed logins per IP + email
    signup: new auth.Limiter(5, 3600e3),         // new accounts per IP
    forgotIp: new auth.Limiter(10, 3600e3),      // reset requests per IP
    forgotEmail: new auth.Limiter(3, 3600e3),    // reset emails per address
    reset: new auth.Limiter(20, 3600e3),         // reset attempts per IP
  };
  /* Behind a proxy (Railway), the client is the last address the proxy appended. Only trusted when TRUST_PROXY is on. */
  const clientIp = req => {
    const xff = trustProxy && req.headers["x-forwarded-for"];
    return xff ? String(xff).split(",").pop().trim() : req.socket.remoteAddress;
  };

  return async function handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", CSP);
    try {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, e.body);
      console.error(e);
      return send(res, 500, { error: "server" });
    }
  };

  async function api(req, res, url) {
    const method = req.method;
    const parts = url.pathname.slice(5).split("/").filter(Boolean);
    const secure = secureCookies || req.headers["x-forwarded-proto"] === "https";
    let body = null;
    if (method !== "GET" && method !== "HEAD") {
      checkOrigin(req);
      body = await readJson(req);
    }
    const token = cookies(req)[auth.COOKIE];

    // Public routes
    if (method === "POST" && parts[0] === "signup") return signup(req, res, body, secure);
    if (method === "POST" && parts[0] === "forgot") return forgot(req, res, body, secure);
    if (method === "POST" && parts[0] === "reset") return reset(req, res, body, secure);
    if (method === "POST" && parts[0] === "login") return login(req, res, body, secure);
    if (method === "POST" && parts[0] === "logout") {
      auth.endSession(db, token);
      setCookie(res, "", 0, secure);
      return send(res, 200, { ok: true });
    }

    const userId = auth.sessionUser(db, token);
    if (!userId) throw new HttpError(401, "auth");
    const reply = (extra = {}) => send(res, 200, { ...extra, data: snapshot(db, userId) });

    if (parts[0] === "data" && method === "GET") return reply();

    if (parts[0] === "me") {
      if (parts[1] === "password" && method === "POST") {
        const u = db.prepare("SELECT pass_hash FROM users WHERE id = ?").get(userId);
        if (!auth.checkPassword(String(body.current ?? ""), u.pass_hash)) throw new HttpError(400, "wrong_password");
        checkNewPassword(body.next);
        db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(auth.hashPassword(body.next), userId);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        setCookie(res, auth.createSession(db, userId), auth.SESSION_DAYS * 86400, secure);
        return reply();
      }
      if (!parts[1] && method === "PATCH") {
        update(db, "users", userId, validate(ME_SPEC, body, { partial: true }));
        return reply();
      }
      if (!parts[1] && method === "DELETE") {
        const u = db.prepare("SELECT pass_hash FROM users WHERE id = ?").get(userId);
        if (!auth.checkPassword(String(body.password ?? ""), u.pass_hash)) throw new HttpError(400, "wrong_password");
        tx(db, () => {
          for (const t of ["activity", "payments", "deliverables", "projects", "clients", "sessions"])
            db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
          db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        });
        setCookie(res, "", 0, secure);
        return send(res, 200, { ok: true });
      }
    }

    if (parts[0] === "export" && method === "GET") {
      const d = snapshot(db, userId);
      const { email, id, ...settings } = d.me;
      res.setHeader("Content-Disposition", `attachment; filename="freelancers-manager-${today()}.json"`);
      return send(res, 200, {
        app: "freelancers-manager", version: 1, exportedAt: now(), settings,
        clients: d.clients, projects: d.projects, deliverables: d.deliverables, payments: d.payments, activity: d.activity,
      });
    }
    if (parts[0] === "import" && method === "POST") {
      importAll(userId, body);
      return reply();
    }

    if (parts[0] === "projects" && parts[2] === "notes" && method === "POST") {
      owned(db, "projects", userId, parts[1]);
      const text = String(body.text ?? "").trim();
      if (!text || text.length > 2000) throw new HttpError(400, "invalid", { field: "text" });
      log(db, userId, Number(parts[1]), "note", { text });
      return reply();
    }

    const table = parts[0];
    if (!SPECS[table]) throw new HttpError(404, "not_found");
    if (method === "POST" && parts.length === 1) {
      const id = tx(db, () => create(table, userId, body));
      return reply({ id });
    }
    if (parts.length === 2 && method === "PATCH") {
      tx(db, () => patch(table, userId, parts[1], body));
      return reply({ id: Number(parts[1]) });
    }
    if (parts.length === 2 && method === "DELETE") {
      tx(db, () => remove(table, userId, parts[1]));
      return reply();
    }
    throw new HttpError(404, "not_found");
  }

  /* ---------- auth ---------- */
  function checkNewPassword(p) {
    if (typeof p !== "string" || p.length < 8 || p.length > 200) throw new HttpError(400, "invalid", { field: "password" });
  }

  function signup(req, res, body, secure) {
    const ip = clientIp(req);
    if (limits.signup.blocked(ip)) throw new HttpError(429, "too_many");
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim();
    const lang = body.lang === "en" ? "en" : "ar";
    if (!EMAIL_RE.test(email) || email.length > 160) throw new HttpError(400, "invalid", { field: "email" });
    if (!name || name.length > 120) throw new HttpError(400, "invalid", { field: "name" });
    checkNewPassword(body.password);
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "email_taken");
    limits.signup.hit(ip);
    const userId = tx(db, () => {
      const id = insert(db, "users", {
        email, name, lang, pass_hash: auth.hashPassword(body.password), created_at: now(),
        currency: lang === "ar" ? "EGP" : "USD",
      });
      if (body.examples === true) seedExamples(db, id, lang);
      return id;
    });
    setCookie(res, auth.createSession(db, userId), auth.SESSION_DAYS * 86400, secure);
    return send(res, 200, { data: snapshot(db, userId) });
  }

  function login(req, res, body, secure) {
    const email = String(body.email ?? "").trim().toLowerCase();
    const key = `${clientIp(req)}|${email}`;
    if (limits.login.blocked(key)) throw new HttpError(429, "too_many");
    const u = db.prepare("SELECT id, pass_hash FROM users WHERE email = ?").get(email);
    if (!u || !auth.checkPassword(String(body.password ?? ""), u.pass_hash)) {
      limits.login.hit(key);
      throw new HttpError(400, "bad_login");
    }
    limits.login.clear(key);
    setCookie(res, auth.createSession(db, u.id), auth.SESSION_DAYS * 86400, secure);
    return send(res, 200, { data: snapshot(db, u.id) });
  }

  /* Always answers ok, so the response never reveals whether an email has an account. */
  function forgot(req, res, body, secure) {
    const ip = clientIp(req);
    const email = String(body.email ?? "").trim().toLowerCase();
    if (limits.forgotIp.blocked(ip)) throw new HttpError(429, "too_many");
    limits.forgotIp.hit(ip);
    const u = EMAIL_RE.test(email) && db.prepare("SELECT id, name, lang FROM users WHERE email = ?").get(email);
    if (u && !limits.forgotEmail.blocked(email)) {
      limits.forgotEmail.hit(email);
      // Never build the link from the Host header when real email goes out: a forged Host would mail the token to another site.
      const origin = appUrl || (mailer.configured ? "" : `${secure ? "https" : "http"}://${req.headers.host}`);
      if (!origin) console.error("APP_URL is not set, so password reset emails can't be sent.");
      else {
        const token = auth.createResetToken(db, u.id);
        const msg = resetEmail({ lang: u.lang, name: u.name, link: `${origin.replace(/\/$/, "")}/#reset/${token}`, minutes: auth.RESET_MINUTES });
        mailer.send({ to: email, ...msg }).catch(e => console.error("Reset email failed:", e.message));
      }
    }
    return send(res, 200, { ok: true });
  }

  function reset(req, res, body, secure) {
    const ip = clientIp(req);
    if (limits.reset.blocked(ip)) throw new HttpError(429, "too_many");
    limits.reset.hit(ip);
    checkNewPassword(body.password);
    const userId = auth.useResetToken(db, body.token);
    if (!userId) throw new HttpError(400, "bad_token");
    db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(auth.hashPassword(body.password), userId);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    setCookie(res, auth.createSession(db, userId), auth.SESSION_DAYS * 86400, secure);
    return send(res, 200, { data: snapshot(db, userId) });
  }

  /* ---------- records ---------- */
  function checkRefs(table, userId, values) {
    if (table === "projects" && values.client_id != null) owned(db, "clients", userId, values.client_id);
    if ((table === "deliverables" || table === "payments") && values.project_id != null) owned(db, "projects", userId, values.project_id);
  }

  function create(table, userId, body) {
    const values = validate(SPECS[table], body, { partial: false });
    checkRefs(table, userId, values);
    const t = now();
    if (table === "clients") return insert(db, table, { ...values, user_id: userId, created_at: t, updated_at: t });
    if (table === "projects") return createProject(userId, values, body, t);
    const id = insert(db, table, { ...values, user_id: userId, created_at: t });
    if (table === "payments" && values.paid_at) log(db, userId, values.project_id, "paid", { amount: values.amount, method: values.method || "" });
    return id;
  }

  function createProject(userId, values, body, t) {
    const u = db.prepare("SELECT next_code, deposit_pct, revisions FROM users WHERE id = ?").get(userId);
    db.prepare("UPDATE users SET next_code = next_code + 1 WHERE id = ?").run(userId);
    const row = {
      status: "active", revisions_allowed: u.revisions, ...values,
      user_id: userId, code: `FM-${u.next_code}`, status_at: t, created_at: t, updated_at: t,
    };
    const id = insert(db, "projects", row);
    const pct = Number.isInteger(body.depositPct) && body.depositPct >= 0 && body.depositPct <= 100 ? body.depositPct : u.deposit_pct;
    for (const p of defaultPayments(row.fee || 0, pct, row.start_date, row.due_date))
      insert(db, "payments", { ...p, user_id: userId, project_id: id, created_at: t });
    log(db, userId, id, "created", {});
    return id;
  }

  function patch(table, userId, id, body) {
    const old = owned(db, table, userId, id);
    const values = validate(SPECS[table], body, { partial: true });
    checkRefs(table, userId, values);
    const t = now();
    if (table === "clients") values.updated_at = t;
    if (table === "projects") {
      values.updated_at = t;
      if (values.status && values.status !== old.status) {
        values.status_at = t;
        if (old.status === "with_client" && values.status === "revising" && !("revisions_used" in values)) {
          values.revisions_used = old.revisions_used + 1;
          log(db, userId, old.id, "round", { n: values.revisions_used, of: values.revisions_allowed ?? old.revisions_allowed });
        }
        log(db, userId, old.id, "status", { from: old.status, to: values.status });
      }
      if (values.links) {
        const before = new Set(JSON.parse(old.links).map(l => l.url));
        for (const l of JSON.parse(values.links)) if (!before.has(l.url)) log(db, userId, old.id, "link", { url: l.url, label: l.label });
      }
    }
    if (table === "payments" && values.paid_at && !old.paid_at)
      log(db, userId, old.project_id, "paid", { amount: values.amount ?? old.amount, method: values.method ?? old.method });
    if (table === "deliverables" && values.done === 1 && !old.done)
      log(db, userId, old.project_id, "done", { label: values.label ?? old.label });
    update(db, table, old.id, values);
  }

  function remove(table, userId, id) {
    const old = owned(db, table, userId, id);
    if (table === "clients") {
      const n = db.prepare("SELECT COUNT(*) n FROM projects WHERE client_id = ?").get(old.id).n;
      if (n) throw new HttpError(409, "client_has_projects", { count: n });
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(old.id);
  }

  /* ---------- import (replaces everything the user has) ---------- */
  function importAll(userId, body) {
    if (body?.app !== "freelancers-manager" || body.version !== 1) throw new HttpError(400, "bad_file");
    const list = k => (Array.isArray(body[k]) ? body[k] : []);
    tx(db, () => {
      for (const t of ["activity", "payments", "deliverables", "projects", "clients"])
        db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
      if (body.settings) update(db, "users", userId, validate(ME_SPEC, body.settings, { partial: true }));
      const t = now();
      const clientIds = new Map(), projectIds = new Map();
      for (const c of list("clients")) {
        const v = validate(SPECS.clients, c, { partial: false });
        clientIds.set(c.id, insert(db, "clients", { ...v, user_id: userId, created_at: str(c.createdAt) || t, updated_at: t }));
      }
      let maxCode = 1000;
      for (const p of list("projects")) {
        const v = validate(SPECS.projects, { ...p, clientId: null }, { partial: false });
        v.client_id = clientIds.get(p.clientId) ?? null;
        const code = /^FM-\d{1,9}$/.test(p.code) ? p.code : `FM-${++maxCode}`;
        maxCode = Math.max(maxCode, Number(code.slice(3)));
        projectIds.set(p.id, insert(db, "projects", {
          ...v, user_id: userId, code, status_at: str(p.statusAt) || t, created_at: str(p.createdAt) || t, updated_at: t,
        }));
      }
      db.prepare("UPDATE users SET next_code = MAX(next_code, ?) WHERE id = ?").run(maxCode + 1, userId);
      for (const k of ["deliverables", "payments"]) {
        for (const r of list(k)) {
          const pid = projectIds.get(r.projectId);
          if (!pid) continue;
          const v = validate(SPECS[k], { ...r, projectId: pid }, { partial: false });
          insert(db, k, { ...v, user_id: userId, created_at: str(r.createdAt) || t });
        }
      }
      for (const a of list("activity")) {
        const pid = projectIds.get(a.projectId);
        if (!pid || typeof a.kind !== "string" || a.kind.length > 20) continue;
        const data = JSON.stringify(a.data && typeof a.data === "object" ? a.data : {});
        if (data.length > 4000) continue;
        insert(db, "activity", { user_id: userId, project_id: pid, at: str(a.at) || t, kind: a.kind, data });
      }
    });
  }
}

const str = v => (typeof v === "string" && v.length < 40 ? v : "");

/* ---------- http helpers ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, value, maxAge, secure) {
  res.setHeader("Set-Cookie", `${auth.COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}

/* Mutations must be JSON from this origin. Cross-site forms can't send application/json (or DELETE) without a preflight. */
function checkOrigin(req) {
  if (req.method !== "DELETE" && !String(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "json_only");
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, "origin"); }
  if (host !== (req.headers["x-forwarded-host"] || req.headers.host)) throw new HttpError(403, "origin");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new HttpError(413, "too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === "object" ? v : {});
      } catch { reject(new HttpError(400, "bad_json")); }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const file = path.resolve(APP_DIR, "." + path.posix.normalize(rel));
  if (!file.startsWith(APP_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}
