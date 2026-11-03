import crypto from "node:crypto";
/* Pipeline, after Sorah Ops: brief → booked → in production → client review ⇄ revisions → delivered → done. */
export const STATUSES = ["lead", "booked", "active", "with_client", "revising", "delivered", "archived"];
export const OPEN = ["lead", "booked", "active", "with_client", "revising"];
export const METHODS = ["", "instapay", "vcash", "cash", "bank", "other"];
export const PAY_KINDS = ["deposit", "balance", "extra"];
export const CURRENCIES = ["EGP", "USD", "EUR", "SAR", "AED", "KWD", "QAR", "GBP"];
export const LANGS = ["ar", "en"];
export { LAYOUTS, FONTS, ACCENTS } from "../app/doc-data.js";
import { LAYOUTS, FONTS, ACCENTS } from "../app/doc-data.js";
export const TEMPLATE_KINDS = ["quote", "delivery", "reminder", "thanks", "document"];

export class HttpError extends Error {
  constructor(status, error, extra = {}) {
    super(error);
    this.status = status;
    this.body = { error, ...extra };
  }
}

/* Field specs: API key -> column + type. Only listed keys are ever written. */
export const SPECS = {
  clients: {
    name: { col: "name", type: "str", max: 120, required: true },
    phone: { col: "phone", type: "str", max: 40 },
    email: { col: "email", type: "str", max: 160 },
    company: { col: "company", type: "str", max: 120 },
    lang: { col: "lang", type: "enum", values: LANGS },
    notes: { col: "notes", type: "str", max: 4000 },
  },
  projects: {
    clientId: { col: "client_id", type: "ref", table: "clients", nullable: true },
    title: { col: "title", type: "str", max: 160, required: true },
    type: { col: "type", type: "str", max: 60 },
    status: { col: "status", type: "enum", values: STATUSES },
    startDate: { col: "start_date", type: "date" },
    dueDate: { col: "due_date", type: "date" },
    sessionAt: { col: "session_at", type: "datetime" },
    folderUrl: { col: "folder_url", type: "url" },
    fee: { col: "fee", type: "money" },
    revisionsAllowed: { col: "revisions_allowed", type: "int", min: 0, max: 50 },
    revisionsUsed: { col: "revisions_used", type: "int", min: 0, max: 99 },
    links: { col: "links", type: "links" },
    notes: { col: "notes", type: "str", max: 8000 },
  },
  deliverables: {
    projectId: { col: "project_id", type: "ref", table: "projects", required: true, fixed: true },
    label: { col: "label", type: "str", max: 200, required: true },
    dueDate: { col: "due_date", type: "date" },
    done: { col: "done", type: "bool" },
  },
  payments: {
    projectId: { col: "project_id", type: "ref", table: "projects", required: true, fixed: true },
    kind: { col: "kind", type: "enum", values: PAY_KINDS },
    label: { col: "label", type: "str", max: 120 },
    amount: { col: "amount", type: "money", required: true },
    dueDate: { col: "due_date", type: "date" },
    paidAt: { col: "paid_at", type: "date" },
    method: { col: "method", type: "enum", values: METHODS },
    ref: { col: "ref", type: "str", max: 80 },
  },
};

export const ME_SPEC = {
  name: { col: "name", type: "str", max: 120, required: true },
  business: { col: "business", type: "str", max: 120 },
  phone: { col: "phone", type: "str", max: 40 },
  lang: { col: "lang", type: "enum", values: LANGS },
  currency: { col: "currency", type: "enum", values: CURRENCIES },
  instapay: { col: "instapay", type: "str", max: 120 },
  vcash: { col: "vcash", type: "str", max: 40 },
  depositPct: { col: "deposit_pct", type: "int", min: 0, max: 100 },
  revisions: { col: "revisions", type: "int", min: 0, max: 50 },
  templates: { col: "templates", type: "templates" },
  tz: { col: "tz", type: "tz" },
  brand: { col: "brand", type: "brand" },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const bad = field => new HttpError(400, "invalid", { field });

function coerce(spec, key, v) {
  switch (spec.type) {
    case "str": {
      if (v == null) v = "";
      if (typeof v !== "string") throw bad(key);
      v = v.trim();
      if (v.length > spec.max) throw bad(key);
      if (spec.required && !v) throw bad(key);
      return v;
    }
    case "enum":
      if (!spec.values.includes(v)) throw bad(key);
      return v;
    case "date":
      if (v == null || v === "") return null;
      if (typeof v !== "string" || !DATE_RE.test(v) || isNaN(Date.parse(v))) throw bad(key);
      return v;
    case "datetime":
      if (v == null || v === "") return null;
      if (typeof v !== "string" || !DATETIME_RE.test(v) || isNaN(Date.parse(v))) throw bad(key);
      return v;
    case "url": {
      if (v == null || v === "") return "";
      if (typeof v !== "string") throw bad(key);
      v = v.trim();
      if (!/^https?:\/\/\S+$/i.test(v) || v.length > 1000) throw bad(key);
      return v;
    }
    case "money": {
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || !isFinite(n) || n < 0 || n > 1e10) throw bad(key);
      return Math.round(n * 100) / 100;
    }
    case "int": {
      const n = typeof v === "string" ? Number(v) : v;
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw bad(key);
      return n;
    }
    case "bool":
      if (typeof v !== "boolean") throw bad(key);
      return v ? 1 : 0;
    case "ref":
      if (v == null || v === "") { if (spec.nullable) return null; throw bad(key); }
      if (!Number.isInteger(Number(v))) throw bad(key);
      return Number(v);
    case "links": {
      if (!Array.isArray(v) || v.length > 30) throw bad(key);
      return JSON.stringify(v.map(l => {
        const url = String(l?.url ?? "").trim(), label = String(l?.label ?? "").trim().slice(0, 80);
        if (!/^https?:\/\/\S+$/i.test(url) || url.length > 1000) throw bad(key);
        const at = typeof l?.at === "string" && DATE_RE.test(l.at) ? l.at : today();
        return { url, label, at };
      }));
    }
    case "tz":
      if (v == null || v === "") return "";
      if (typeof v !== "string" || v.length > 64) throw bad(key);
      try { new Intl.DateTimeFormat("en", { timeZone: v }); } catch { throw bad(key); }
      return v;
    case "brand": {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(key);
      const str = (s, max) => { if (s == null) return ""; if (typeof s !== "string" || s.trim().length > max) throw bad(key); return s.trim(); };
      const out = {
        color: v.color ?? "#1E6F5C", layout: v.layout ?? "classic", font: v.font ?? "modern", accent: v.accent ?? "solid",
        address: str(v.address, 200), website: str(v.website, 200), taxId: str(v.taxId, 60), showPay: v.showPay !== false, footer: {}, intro: {},
      };
      if (!/^#[0-9a-f]{6}$/i.test(out.color) || !LAYOUTS.includes(out.layout) || !FONTS.includes(out.font) || !ACCENTS.includes(out.accent)) throw bad(key);
      if (out.website && !/^(https?:\/\/)?[^\s<>"]+\.[^\s<>"]+$/i.test(out.website)) throw bad(key);
      for (const l of LANGS) {
        const s = str(v.footer?.[l], 600); if (s) out.footer[l] = s;
        const i = str(v.intro?.[l], 1200); if (i) out.intro[l] = i;
      }
      return JSON.stringify(out);
    }
    case "templates": {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(key);
      const out = {};
      for (const k of TEMPLATE_KINDS) {
        if (!v[k]) continue;
        out[k] = {};
        for (const l of LANGS) {
          const s = v[k][l];
          if (s == null || s === "") continue;
          if (typeof s !== "string" || s.length > 2000) throw bad(key);
          out[k][l] = s;
        }
      }
      return JSON.stringify(out);
    }
  }
  throw bad(key);
}

/* Returns {col: value} for the keys present in body. With partial=false, required keys must be present. */
export function validate(spec, body, { partial }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid");
  const out = {};
  for (const [key, s] of Object.entries(spec)) {
    if (!(key in body)) {
      if (!partial && s.required) throw bad(key);
      continue;
    }
    if (partial && s.fixed) continue;
    out[s.col] = coerce(s, key, body[key]);
  }
  return out;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export const now = () => new Date().toISOString();

const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function mapRow(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "user_id") continue;
    o[camel(k)] = v;
  }
  if ("links" in o) o.links = JSON.parse(o.links || "[]");
  if ("data" in o) o.data = JSON.parse(o.data || "{}");
  if ("done" in o) o.done = !!o.done;
  return o;
}

export function publicMe(u) {
  return {
    id: u.id, email: u.email, name: u.name, business: u.business, phone: u.phone,
    lang: u.lang, currency: u.currency, instapay: u.instapay, vcash: u.vcash,
    depositPct: u.deposit_pct, revisions: u.revisions, templates: JSON.parse(u.templates || "{}"),
    calToken: u.cal_token || null, tz: u.tz || "",
    brand: JSON.parse(u.brand || "{}"),
    logoVersion: u.logo ? crypto.createHash("sha1").update(u.logo).digest("hex").slice(0, 10) : null,
  };
}

/* Project codes follow Sorah Ops: FM-YYMM-NNN, numbered per user per month. */
export function nextCode(db, userId, date = new Date()) {
  const prefix = `FM-${String(date.getFullYear()).slice(2)}${String(date.getMonth() + 1).padStart(2, "0")}-`;
  const rows = db.prepare("SELECT code FROM projects WHERE user_id = ? AND code LIKE ?").all(userId, prefix + "%");
  const n = rows.reduce((m, r) => Math.max(m, Number(r.code.slice(prefix.length)) || 0), 0) + 1;
  return prefix + String(n).padStart(3, "0");
}

export function moneyFormatter(u) {
  const label = u.currency === "EGP" ? (u.lang === "ar" ? "ج.م" : "EGP") : u.currency;
  return n => `${(Math.round(n * 100) / 100).toLocaleString("en-US")} ${label}`;
}

export function snapshot(db, userId) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const all = (sql) => db.prepare(sql).all(userId).map(mapRow);
  return {
    me: publicMe(u),
    clients: all("SELECT * FROM clients WHERE user_id = ? ORDER BY name COLLATE NOCASE"),
    projects: all("SELECT * FROM projects WHERE user_id = ? ORDER BY id DESC"),
    deliverables: all("SELECT * FROM deliverables WHERE user_id = ? ORDER BY id"),
    payments: all("SELECT * FROM payments WHERE user_id = ? ORDER BY due_date IS NULL, due_date, id"),
    activity: all("SELECT * FROM activity WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT 2000"),
  };
}

export function log(db, userId, projectId, kind, data = {}) {
  db.prepare("INSERT INTO activity(user_id, project_id, at, kind, data) VALUES(?,?,?,?,?)")
    .run(userId, projectId, now(), kind, JSON.stringify(data));
}

export function owned(db, table, userId, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(Number(id), userId);
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

export function insert(db, table, values) {
  const cols = Object.keys(values);
  const r = db.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`)
    .run(...cols.map(c => values[c]));
  return Number(r.lastInsertRowid);
}

export function update(db, table, id, values) {
  const cols = Object.keys(values);
  if (!cols.length) return;
  db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(",")} WHERE id = ?`)
    .run(...cols.map(c => values[c]), id);
}

/* Deposit + balance split for a new project. */
export function defaultPayments(fee, depositPct, startDate, dueDate) {
  if (!(fee > 0)) return [];
  const deposit = Math.round(fee * depositPct / 100);
  const out = [];
  if (deposit > 0) out.push({ kind: "deposit", amount: deposit, due_date: startDate || today() });
  if (fee - deposit > 0) out.push({ kind: "balance", amount: Math.round((fee - deposit) * 100) / 100, due_date: dueDate || null });
  return out;
}
