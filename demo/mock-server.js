/* In-browser stand-in for the Freelancers Manager server, for the clickable demo.
   It answers the app's /api calls with the same rules as server/app.js (project codes, deposit and balance,
   revision rounds, line items and tax, auto-done, sharing, quote acceptance, backups) and keeps everything in
   this browser's localStorage. Nothing leaves the browser: no email, Google Calendar or calendar feed. */
import { docData, itemTotals, addPeriod, daysBetween, normalizeReminders, REPEATS, EXPENSE_CATEGORIES, EXPENSE_REPEATS } from "../app/doc-data.js";
import { EXAMPLES } from "../server/examples.js";

const KEY = "fm_demo_v3";
const STATUSES = ["lead", "booked", "active", "with_client", "revising", "delivered", "archived"];
const METHODS = ["", "instapay", "vcash", "cash", "bank", "other"];
const r2 = n => Math.round(n * 100) / 100;
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const now = () => new Date().toISOString();
const ago = n => new Date(Date.now() - n * 864e5).toISOString();
const token = (n = 18) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join("");

class ApiError extends Error {
  constructor(status, error, extra = {}) { super(error); this.status = status; this.body = { error, ...extra }; }
}
const bad = field => new ApiError(400, "invalid", { field });

/* ---------- storage ---------- */
function fresh() {
  return { seq: 1, session: null, users: [], clients: [], projects: [], deliverables: [], payments: [], items: [], expenses: [], activity: [] };
}
let db;
function load() {
  try { db = JSON.parse(localStorage.getItem(KEY)) || null; } catch { db = null; }
  if (!db) { db = fresh(); seedDemoAccount(); save(); }
  for (const [k, v] of Object.entries(fresh())) if (!(k in db)) db[k] = v; // data saved by an older demo
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* private window: lives for this visit only */ } }
export function resetDemo() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
const id = () => db.seq++;

/* ---------- helpers mirroring server/model.js ---------- */
const mine = (table, uid) => db[table].filter(r => r.userId === uid);
function owned(table, uid, rid) {
  const r = db[table].find(x => x.id === Number(rid) && x.userId === uid);
  if (!r) throw new ApiError(404, "not_found");
  return r;
}
function log(uid, projectId, kind, data = {}) { db.activity.push({ id: id(), userId: uid, projectId, at: now(), kind, data }); }
function nextCode(uid, d = new Date()) {
  const prefix = `FM-${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}-`;
  const n = mine("projects", uid).filter(p => p.code.startsWith(prefix)).reduce((m, p) => Math.max(m, Number(p.code.slice(prefix.length)) || 0), 0) + 1;
  return prefix + String(n).padStart(3, "0");
}
function defaultPayments(fee, pct, start, due) {
  if (!(fee > 0)) return [];
  const deposit = Math.round(fee * pct / 100), out = [];
  if (deposit > 0) out.push({ kind: "deposit", amount: deposit, dueDate: start || today() });
  if (fee - deposit > 0) out.push({ kind: "balance", amount: r2(fee - deposit), dueDate: due || null });
  return out;
}
const str = (v, max, field, required) => {
  if (v == null) v = "";
  if (typeof v !== "string") throw bad(field);
  v = v.trim();
  if (v.length > max || (required && !v)) throw bad(field);
  return v;
};
const date = (v, field) => { if (v == null || v === "") return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(field); return v; };
const amount = (v, field) => { const n = Number(v); if (!isFinite(n) || n < 0 || n > 1e10) throw bad(field); return r2(n); };
const pick = (body, spec, partial) => {
  const out = {};
  for (const [k, fn] of Object.entries(spec)) {
    if (!(k in body)) { if (!partial && fn.required) throw bad(k); continue; }
    out[k] = fn(body[k]);
  }
  return out;
};
const req = fn => Object.assign(fn, { required: true });
const SPECS = {
  clients: {
    name: req(v => str(v, 120, "name", true)), phone: v => str(v, 40, "phone"), email: v => str(v, 160, "email"),
    company: v => str(v, 120, "company"), lang: v => { if (!["ar", "en"].includes(v)) throw bad("lang"); return v; }, notes: v => str(v, 4000, "notes"),
  },
  projects: {
    clientId: v => (v == null || v === "" ? null : Number(v)), title: req(v => str(v, 160, "title", true)), type: v => str(v, 60, "type"),
    status: v => { if (!STATUSES.includes(v)) throw bad("status"); return v; }, startDate: v => date(v, "startDate"), dueDate: v => date(v, "dueDate"),
    sessionAt: v => { if (v == null || v === "") return null; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) throw bad("sessionAt"); return v; },
    folderUrl: v => { v = str(v, 1000, "folderUrl"); if (v && !/^https?:\/\/\S+$/i.test(v)) throw bad("folderUrl"); return v; },
    fee: v => amount(v, "fee"), discount: v => amount(v, "discount"),
    taxRate: v => { const n = Number(v); if (!isFinite(n) || n < 0 || n > 100) throw bad("taxRate"); return r2(n); },
    revisionsAllowed: v => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 50) throw bad("revisionsAllowed"); return n; },
    revisionsUsed: v => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 99) throw bad("revisionsUsed"); return n; },
    links: v => {
      if (!Array.isArray(v)) throw bad("links");
      return v.map(l => { if (!/^https?:\/\/\S+$/i.test(l?.url || "")) throw bad("links"); return { url: l.url, label: String(l.label || "").slice(0, 80), at: l.at || today() }; });
    },
    notes: v => str(v, 8000, "notes"),
    noReminders: v => !!v,
    repeat: v => { if (!["", ...REPEATS].includes(v || "")) throw bad("repeat"); return v || ""; },
    repeatNext: v => date(v, "repeatNext"), repeatUntil: v => date(v, "repeatUntil"),
  },
  deliverables: { projectId: req(v => Number(v)), label: req(v => str(v, 200, "label", true)), dueDate: v => date(v, "dueDate"), done: v => !!v },
  expenses: {
    projectId: v => (v == null || v === "" ? null : Number(v)), label: req(v => str(v, 160, "label", true)),
    category: v => { if (!EXPENSE_CATEGORIES.includes(v)) throw bad("category"); return v; },
    amount: req(v => amount(v, "amount")), spentOn: req(v => { const d = date(v, "spentOn"); if (!d) throw bad("spentOn"); return d; }),
    note: v => str(v, 500, "note"), repeat: v => { if (!["", ...EXPENSE_REPEATS].includes(v || "")) throw bad("repeat"); return v || ""; },
  },
  items: {
    projectId: req(v => Number(v)), label: req(v => str(v, 200, "label", true)),
    qty: v => { const n = Number(v); if (!isFinite(n) || n <= 0 || n > 1e6) throw bad("qty"); return Math.round(n * 1000) / 1000; },
    unitPrice: req(v => amount(v, "unitPrice")),
  },
  payments: {
    projectId: req(v => Number(v)), kind: v => { if (!["deposit", "balance", "extra"].includes(v)) throw bad("kind"); return v; },
    label: v => str(v, 120, "label"), amount: req(v => amount(v, "amount")), dueDate: v => date(v, "dueDate"), paidAt: v => date(v, "paidAt"),
    method: v => { if (!METHODS.includes(v || "")) throw bad("method"); return v || ""; }, ref: v => str(v, 80, "ref"),
  },
};
const ME_FIELDS = ["name", "business", "phone", "lang", "currency", "instapay", "vcash", "depositPct", "revisions", "templates", "tz", "brand", "taxRate", "reminders"];

function publicMe(u) {
  const { pass, logo, ...me } = u;
  return { ...me, reminders: normalizeReminders(me.reminders), logo, logoVersion: logo ? String(logo.length) : null, google: { available: false, connected: false }, mailReady: false };
}
function snapshot(uid) {
  const u = db.users.find(x => x.id === uid);
  const strip = ({ userId, acceptedIp, ...r }) => r;
  return {
    me: publicMe(u),
    clients: mine("clients", uid).map(strip).sort((a, b) => a.name.localeCompare(b.name)),
    projects: mine("projects", uid).map(strip).sort((a, b) => b.id - a.id),
    deliverables: mine("deliverables", uid).map(strip),
    payments: mine("payments", uid).map(strip).sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.id - b.id),
    items: mine("items", uid).map(strip),
    expenses: mine("expenses", uid).map(strip).sort((a, b) => b.spentOn.localeCompare(a.spentOn) || b.id - a.id),
    activity: mine("activity", uid).map(strip).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, 2000),
  };
}

/* ---------- accounts ---------- */
function createUser({ name, email, password, lang }) {
  const u = {
    id: id(), email, pass: password, name, business: "", phone: "", lang, currency: lang === "ar" ? "EGP" : "USD",
    instapay: "", vcash: "", depositPct: 50, revisions: 3, templates: {}, tz: "", brand: {}, logo: "", taxRate: 0, calToken: null,
  };
  db.users.push(u);
  return u;
}
function seedExamples(uid, lang) {
  const ex = EXAMPLES[lang] || EXAMPLES.ar, t = now();
  const pids = [];
  const cids = ex.clients.map(c => { const cid = id(); db.clients.push({ id: cid, userId: uid, ...c, email: "", notes: "", createdAt: t, updatedAt: t }); return cid; });
  for (const p of ex.projects) {
    const pid = id();
    pids.push(pid);
    db.projects.push({
      id: pid, userId: uid, clientId: cids[p.c], code: nextCode(uid), title: p.title, type: p.type, status: p.status,
      startDate: p.start == null ? null : day(p.start), dueDate: day(p.due), fee: p.fee, discount: 0, taxRate: 0,
      revisionsAllowed: p.rev[0], revisionsUsed: p.rev[1], links: p.link ? [{ ...p.link, at: day(-2) }] : [], notes: "",
      sessionAt: p.session ? `${day(p.session[0])}T${p.session[1]}` : null, folderUrl: p.folder || "", shareToken: null,
      acceptedAt: null, acceptedBy: "", statusAt: p.status === "lead" ? ago(4) : ago(2), createdAt: ago(p.start == null ? 4 : -p.start), updatedAt: t,
    });
    const dep = Math.round(p.fee / 2);
    db.payments.push({ id: id(), userId: uid, projectId: pid, kind: "deposit", label: "", amount: dep, dueDate: day(p.start ?? 0), paidAt: p.paid[0] ? day(p.start ?? 0) : null, method: p.paid[0] ? "instapay" : "", ref: p.paid[0] ? `IP-${80000 + pid}` : "", createdAt: t });
    db.payments.push({ id: id(), userId: uid, projectId: pid, kind: "balance", label: "", amount: p.fee - dep, dueDate: day(p.due), paidAt: null, method: "", ref: "", createdAt: t });
    for (const [label, done] of p.deliverables) db.deliverables.push({ id: id(), userId: uid, projectId: pid, label, done, dueDate: null, createdAt: t });
    log(uid, pid, "created");
    if (p.link) log(uid, pid, "link", { url: p.link.url, label: p.link.label });
  }
  for (const e of ex.expenses || [])
    db.expenses.push({ id: id(), userId: uid, projectId: e.p == null ? null : pids[e.p], label: e.label, category: e.category, amount: e.amount,
      spentOn: day(e.day), note: "", repeat: e.repeat || "", repeatNext: e.repeat ? nextExpense(day(e.day), e.repeat) : null, createdAt: t });
}
/* A ready-made account so there's something to explore straight away. */
function seedDemoAccount() {
  const u = createUser({ name: "نور حسن", email: "demo@example.com", password: "demo1234", lang: "ar" });
  Object.assign(u, { business: "استوديو نور", phone: "01055554444", instapay: "noor@instapay", vcash: "01099998888", taxRate: 14,
    brand: { color: "#1E6F5C", layout: "classic", font: "modern", accent: "solid", address: "المعادي، القاهرة", website: "noor.studio", taxId: "", showPay: true, footer: {}, intro: {} } });
  seedExamples(u.id, "ar");
  const reels = db.projects.find(p => p.userId === u.id && p.status === "active");
  if (reels) Object.assign(reels, { repeat: "monthly", repeatNext: firstRepeat(reels.startDate, "monthly") }); // a retainer to show recurring projects
  db.session = u.id; // start signed in
}

/* ---------- projects: same rules as server/app.js ---------- */
function createProject(uid, v, body) {
  const u = db.users.find(x => x.id === uid), t = now();
  const p = {
    id: id(), userId: uid, clientId: null, title: "", type: "", status: "lead", startDate: null, dueDate: null, sessionAt: null, folderUrl: "",
    fee: 0, discount: 0, taxRate: u.taxRate || 0, revisionsAllowed: u.revisions, revisionsUsed: 0, links: [], notes: "",
    shareToken: null, acceptedAt: null, acceptedBy: "", noReminders: false, repeat: "", repeatNext: null, repeatUntil: null, seriesId: null,
    ...v, code: nextCode(uid), statusAt: t, createdAt: t, updatedAt: t,
  };
  if (p.repeat && !p.repeatNext) p.repeatNext = firstRepeat(p.startDate, p.repeat);
  db.projects.push(p);
  const pct = Number.isInteger(body.depositPct) && body.depositPct >= 0 && body.depositPct <= 100 ? body.depositPct : u.depositPct;
  for (const x of defaultPayments(p.fee, pct, p.startDate, p.dueDate)) db.payments.push({ id: id(), userId: uid, projectId: p.id, label: "", paidAt: null, method: "", ref: "", createdAt: t, ...x });
  log(uid, p.id, "created");
  return p.id;
}
function nextExpense(d, repeat) {
  let next = addPeriod(d, repeat);
  for (let i = 0; i < 520 && next <= today(); i++) next = addPeriod(next, repeat);
  return next;
}

/* Recurring projects, as in server/app.js. */
function firstRepeat(start, repeat) {
  let next = addPeriod(start || today(), repeat);
  for (let i = 0; i < 520 && next <= today(); i++) next = addPeriod(next, repeat);
  return next;
}
function shiftDate(d, n) { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); }
function repeatProject(uid, srcId, start) {
  const src = owned("projects", uid, srcId), u = db.users.find(x => x.id === uid), t = now();
  const shift = daysBetween(src.startDate || src.createdAt.slice(0, 10), start);
  const move = d => (d ? shiftDate(d, shift) : null);
  const label = new Intl.DateTimeFormat(u.lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", src.repeat === "weekly" ? { day: "numeric", month: "short" } : { month: "long", year: "numeric" }).format(new Date(`${start}T12:00:00Z`));
  const pid = id();
  db.projects.push({
    ...src, id: pid, code: nextCode(uid), title: `${src.title} · ${label}`.slice(0, 160), status: "booked", startDate: start, dueDate: move(src.dueDate),
    sessionAt: src.sessionAt ? `${move(src.sessionAt.slice(0, 10))}${src.sessionAt.slice(10)}` : null, revisionsUsed: 0, links: [], shareToken: null,
    acceptedAt: null, acceptedBy: "", repeat: "", repeatNext: null, repeatUntil: null, seriesId: src.id, statusAt: t, createdAt: t, updatedAt: t,
  });
  for (const d of db.deliverables.filter(x => x.projectId === src.id)) db.deliverables.push({ id: id(), userId: uid, projectId: pid, label: d.label, done: false, dueDate: move(d.dueDate), createdAt: t });
  for (const i of db.items.filter(x => x.projectId === src.id)) db.items.push({ id: id(), userId: uid, projectId: pid, label: i.label, qty: i.qty, unitPrice: i.unitPrice, createdAt: t });
  const pays = db.payments.filter(x => x.projectId === src.id);
  const fresh = pays.length ? pays.map(x => ({ kind: x.kind, label: x.label, amount: x.amount, dueDate: move(x.dueDate) || start })) : defaultPayments(src.fee, u.depositPct, start, move(src.dueDate));
  for (const x of fresh) db.payments.push({ id: id(), userId: uid, projectId: pid, label: "", paidAt: null, method: "", ref: "", createdAt: t, ...x });
  log(uid, pid, "created", { from: src.code });
  log(uid, src.id, "repeated", { code: db.projects.find(x => x.id === pid).code, start });
  return pid;
}
/* The demo has no daily job: catch up recurring cycles whenever it opens. */
function catchUpRecurring() {
  const date = today();
  for (const s of db.projects.filter(p => p.repeat && p.repeatNext && p.repeatNext <= date)) {
    let next = s.repeatNext;
    for (let i = 0; i < 24 && next <= date && (!s.repeatUntil || next <= s.repeatUntil); i++) { repeatProject(s.userId, s.id, next); next = addPeriod(next, s.repeat); }
    s.repeatNext = next;
  }
  for (const e of db.expenses.filter(x => x.repeat && x.repeatNext && x.repeatNext <= date)) {
    let next = e.repeatNext;
    for (let i = 0; i < 24 && next <= date; i++) { db.expenses.push({ ...e, id: id(), spentOn: next, repeat: "", repeatNext: null, createdAt: now() }); next = addPeriod(next, e.repeat); }
    e.repeatNext = next;
  }
}

function recalc(uid, pid) {
  const p = owned("projects", uid, pid);
  const its = db.items.filter(i => i.projectId === p.id);
  if (!its.length) return;
  const fee = itemTotals(its, p.discount, p.taxRate).total;
  if (Math.abs(fee - p.fee) < 0.005) return;
  const old = p.fee;
  p.fee = fee;
  rebalance(uid, p, old, fee);
}
function rebalance(uid, p, oldFee, newFee) {
  const pays = db.payments.filter(x => x.projectId === p.id);
  if (!pays.length) {
    const u = db.users.find(x => x.id === uid);
    for (const x of defaultPayments(newFee, u.depositPct, p.startDate, p.dueDate)) db.payments.push({ id: id(), userId: uid, projectId: p.id, label: "", paidAt: null, method: "", ref: "", createdAt: now(), ...x });
    return;
  }
  const bal = [...pays].reverse().find(x => x.kind === "balance" && !x.paidAt);
  if (!bal) return;
  const a = r2(bal.amount + newFee - oldFee);
  if (a >= 0) bal.amount = a;
}
function settle(uid, pid) {
  const p = db.projects.find(x => x.id === pid && x.userId === uid);
  if (!p || p.status !== "delivered" || !(p.fee > 0)) return;
  const paid = db.payments.filter(x => x.projectId === p.id && x.paidAt).reduce((s, x) => s + x.amount, 0);
  if (paid + 0.005 < p.fee) return;
  p.status = "archived"; p.statusAt = now();
  log(uid, p.id, "status", { from: "delivered", to: "archived", auto: true });
}
function checkRefs(table, uid, v) {
  if (table === "projects" && v.clientId != null) owned("clients", uid, v.clientId);
  if (["deliverables", "payments", "items", "expenses"].includes(table) && v.projectId != null) owned("projects", uid, v.projectId);
}
function create(table, uid, body) {
  const v = pick(body, SPECS[table], false);
  checkRefs(table, uid, v);
  const t = now();
  if (table === "clients") { const cid = id(); db.clients.push({ id: cid, userId: uid, phone: "", email: "", company: "", lang: "ar", notes: "", ...v, createdAt: t, updatedAt: t }); return cid; }
  if (table === "projects") return createProject(uid, v, body);
  const base = { deliverables: { done: false, dueDate: null }, items: { qty: 1 }, payments: { kind: "extra", label: "", dueDate: null, paidAt: null, method: "", ref: "" },
    expenses: { projectId: null, category: "other", note: "", repeat: "", repeatNext: null } }[table];
  if (table === "expenses" && v.repeat) v.repeatNext = nextExpense(v.spentOn, v.repeat);
  const rid = id();
  db[table].push({ id: rid, userId: uid, ...base, ...v, createdAt: t });
  if (table === "items") recalc(uid, v.projectId);
  if (table === "expenses" && v.projectId) log(uid, v.projectId, "expense", { label: v.label, amount: v.amount });
  if (table === "payments" && v.paidAt) { log(uid, v.projectId, "paid", { amount: v.amount, method: v.method || "" }); settle(uid, v.projectId); }
  return rid;
}
function patch(table, uid, rid, body) {
  const old = owned(table, uid, rid);
  const v = pick(body, SPECS[table], true);
  if (table !== "expenses") delete v.projectId;
  if (table === "expenses" && ("repeat" in v || "spentOn" in v)) {
    const r = v.repeat ?? old.repeat;
    v.repeatNext = r ? nextExpense(v.spentOn ?? old.spentOn, r) : null;
  }
  checkRefs(table, uid, v);
  const t = now();
  if (table === "clients") v.updatedAt = t;
  if (table === "projects") {
    v.updatedAt = t;
    if ("fee" in v && db.items.some(i => i.projectId === old.id)) delete v.fee;
    if ("repeat" in v) {
      if (!v.repeat) v.repeatNext = null;
      else if (!("repeatNext" in v) && (v.repeat !== old.repeat || !old.repeatNext)) v.repeatNext = firstRepeat(v.startDate ?? old.startDate, v.repeat);
    }
    if (v.status && v.status !== old.status) {
      v.statusAt = t;
      if (old.status === "with_client" && v.status === "revising" && !("revisionsUsed" in v)) {
        v.revisionsUsed = old.revisionsUsed + 1;
        log(uid, old.id, "round", { n: v.revisionsUsed, of: v.revisionsAllowed ?? old.revisionsAllowed });
      }
      log(uid, old.id, "status", { from: old.status, to: v.status });
    }
    if (v.links) { const before = new Set(old.links.map(l => l.url)); for (const l of v.links) if (!before.has(l.url)) log(uid, old.id, "link", { url: l.url, label: l.label }); }
  }
  if (table === "payments" && v.paidAt && !old.paidAt) log(uid, old.projectId, "paid", { amount: v.amount ?? old.amount, method: v.method ?? old.method });
  if (table === "deliverables" && v.done === true && !old.done) log(uid, old.projectId, "done", { label: v.label ?? old.label });
  const oldFee = old.fee;
  Object.assign(old, v);
  if (table === "items") recalc(uid, old.projectId);
  if (table === "projects") {
    if ("discount" in v || "taxRate" in v) recalc(uid, old.id);
    else if ("fee" in v && v.fee !== oldFee) rebalance(uid, old, oldFee, v.fee);
    if (v.status === "delivered") settle(uid, old.id);
  }
  if (table === "payments") settle(uid, old.projectId);
}
function remove(table, uid, rid) {
  const old = owned(table, uid, rid);
  if (table === "clients" && db.projects.some(p => p.clientId === old.id)) throw new ApiError(409, "client_has_projects");
  db[table] = db[table].filter(r => r !== old);
  if (table === "projects") {
    for (const k of ["deliverables", "payments", "items", "activity"]) db[k] = db[k].filter(r => r.projectId !== old.id);
    for (const e of db.expenses) if (e.projectId === old.id) e.projectId = null; // costs stay, as business expenses
  }
  if (table === "items") recalc(uid, old.projectId);
}
function duplicate(uid, rid, body) {
  const src = owned("projects", uid, rid);
  const v = {
    clientId: src.clientId, title: str(body.title ?? src.title, 160, "title", true), type: src.type, status: "lead", startDate: today(), dueDate: null,
    fee: src.fee, revisionsAllowed: src.revisionsAllowed, notes: src.notes, folderUrl: src.folderUrl, discount: src.discount, taxRate: src.taxRate,
  };
  const pid = createProject(uid, v, {}), t = now();
  for (const d of db.deliverables.filter(x => x.projectId === src.id)) db.deliverables.push({ id: id(), userId: uid, projectId: pid, label: d.label, done: false, dueDate: null, createdAt: t });
  for (const i of db.items.filter(x => x.projectId === src.id)) db.items.push({ id: id(), userId: uid, projectId: pid, label: i.label, qty: i.qty, unitPrice: i.unitPrice, createdAt: t });
  return pid;
}
function buildDoc(p) {
  const u = db.users.find(x => x.id === p.userId);
  const d = docData({
    project: p, me: publicMe(u), today: today(),
    client: db.clients.find(c => c.id === p.clientId) || null,
    payments: db.payments.filter(x => x.projectId === p.id), deliverables: db.deliverables.filter(x => x.projectId === p.id),
    items: db.items.filter(x => x.projectId === p.id),
  });
  d.logo = u.logo || "";
  return d;
}
function importAll(uid, body) {
  if (body?.app !== "freelancers-manager" || body.version !== 1) throw new ApiError(400, "bad_file");
  const list = k => (Array.isArray(body[k]) ? body[k] : []);
  for (const k of ["activity", "expenses", "items", "payments", "deliverables", "projects", "clients"]) db[k] = db[k].filter(r => r.userId !== uid);
  const u = db.users.find(x => x.id === uid);
  if (body.settings) for (const k of [...ME_FIELDS, "logo"]) if (k in body.settings) u[k] = body.settings[k];
  const cmap = new Map(), pmap = new Map(), t = now();
  for (const c of list("clients")) { const cid = id(); cmap.set(c.id, cid); db.clients.push({ ...c, id: cid, userId: uid }); }
  for (const p of list("projects")) { const pid = id(); pmap.set(p.id, pid); db.projects.push({ ...p, id: pid, userId: uid, clientId: cmap.get(p.clientId) ?? null, shareToken: null, updatedAt: t }); }
  for (const k of ["deliverables", "payments", "items", "activity"])
    for (const r of list(k)) if (pmap.has(r.projectId)) db[k].push({ ...r, id: id(), userId: uid, projectId: pmap.get(r.projectId) });
  for (const e of list("expenses")) db.expenses.push({ ...e, id: id(), userId: uid, projectId: pmap.get(e.projectId) ?? null });
}

/* ---------- router ---------- */
function route(method, path, body) {
  const parts = path.split("?")[0].split("/").filter(Boolean);
  const uid = db.session;

  if (parts[0] === "public" && parts[1] === "doc") {
    const p = db.projects.find(x => x.shareToken && x.shareToken === parts[2]);
    if (!p) throw new ApiError(404, "not_found");
    if (method === "GET" && !parts[3]) return buildDoc(p);
    if (method === "POST" && parts[3] === "accept") {
      if (p.status !== "lead" || p.acceptedAt) throw new ApiError(409, "not_a_quote");
      const name = String(body.name ?? "").trim();
      if (name.length < 2 || name.length > 120) throw bad("name");
      if (body.agree !== true) throw bad("agree");
      Object.assign(p, { status: "booked", statusAt: now(), acceptedAt: now(), acceptedBy: name });
      log(p.userId, p.id, "status", { from: "lead", to: "booked" });
      log(p.userId, p.id, "accepted", { name });
      return buildDoc(p);
    }
  }
  if (method === "POST" && parts[0] === "signup") {
    const email = String(body.email ?? "").trim().toLowerCase(), name = String(body.name ?? "").trim(), lang = body.lang === "en" ? "en" : "ar";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("email");
    if (!name) throw bad("name");
    if (typeof body.password !== "string" || body.password.length < 8) throw bad("password");
    if (db.users.some(u => u.email === email)) throw new ApiError(409, "email_taken");
    const u = createUser({ name, email, password: body.password, lang });
    if (body.examples === true) seedExamples(u.id, lang);
    db.session = u.id;
    return { data: snapshot(u.id) };
  }
  if (method === "POST" && parts[0] === "login") {
    const u = db.users.find(x => x.email === String(body.email ?? "").trim().toLowerCase());
    if (!u || u.pass !== body.password) throw new ApiError(400, "bad_login");
    db.session = u.id;
    return { data: snapshot(u.id) };
  }
  if (method === "POST" && parts[0] === "logout") { db.session = null; return { ok: true }; }
  if (method === "POST" && parts[0] === "forgot") return { ok: true };
  if (method === "POST" && parts[0] === "reset") throw new ApiError(400, "bad_token");

  if (!uid || !db.users.some(u => u.id === uid)) throw new ApiError(401, "auth");
  const me = db.users.find(u => u.id === uid);
  const reply = (extra = {}) => ({ ...extra, data: snapshot(uid) });

  if (parts[0] === "data" && method === "GET") return reply();
  if (parts[0] === "google") throw new ApiError(404, "google_unavailable");
  if (parts[0] === "me") {
    if (!parts[1] && method === "PATCH") {
      for (const k of ME_FIELDS) if (k in body) {
        if (k === "name" && !String(body.name).trim()) throw bad("name");
        me[k] = body[k];
      }
      return reply();
    }
    if (parts[1] === "password" && method === "POST") {
      if (body.current !== me.pass) throw new ApiError(400, "wrong_password");
      if (typeof body.next !== "string" || body.next.length < 8) throw bad("password");
      me.pass = body.next;
      return reply();
    }
    if (!parts[1] && method === "DELETE") {
      if (body.password !== me.pass) throw new ApiError(400, "wrong_password");
      for (const k of ["activity", "expenses", "items", "payments", "deliverables", "projects", "clients"]) db[k] = db[k].filter(r => r.userId !== uid);
      db.users = db.users.filter(u => u.id !== uid);
      db.session = null;
      return { ok: true };
    }
    if (parts[1] === "logo") {
      if (method === "PUT") {
        if (!/^data:image\/(png|jpeg|webp);base64,/.test(String(body.dataUrl || "")) || body.dataUrl.length > 560000) throw bad("logo");
        me.logo = body.dataUrl;
        return reply();
      }
      if (method === "DELETE") { me.logo = ""; return reply(); }
    }
    if (parts[1] === "calendar") { me.calToken = method === "POST" ? token(24) : null; return reply(); }
  }
  if (parts[0] === "export" && method === "GET") {
    const d = snapshot(uid), { email, id: _, calToken, logoVersion, google, mailReady, ...settings } = d.me;
    return { app: "freelancers-manager", version: 1, exportedAt: now(), settings, clients: d.clients, projects: d.projects, deliverables: d.deliverables, payments: d.payments, items: d.items, expenses: d.expenses, activity: d.activity };
  }
  if (parts[0] === "import" && method === "POST") { importAll(uid, body); return reply(); }
  if (parts[0] === "projects" && parts[2] === "notes" && method === "POST") {
    owned("projects", uid, parts[1]);
    const text = String(body.text ?? "").trim();
    if (!text) throw bad("text");
    log(uid, Number(parts[1]), "note", { text });
    return reply();
  }
  if (parts[0] === "projects" && parts[2] === "share") {
    const p = owned("projects", uid, parts[1]);
    p.shareToken = method === "POST" ? p.shareToken || token() : null;
    return reply();
  }
  if (parts[0] === "projects" && parts[2] === "email") throw new ApiError(400, "mail_unavailable");
  if (parts[0] === "payments" && parts[2] === "remind") throw new ApiError(400, "mail_unavailable");
  if (parts[0] === "projects" && parts[2] === "repeat-now" && method === "POST") {
    const p = owned("projects", uid, parts[1]);
    if (!p.repeat) throw new ApiError(400, "not_recurring");
    const start = p.repeatNext || today();
    const pid = repeatProject(uid, p.id, start);
    p.repeatNext = addPeriod(start, p.repeat);
    return reply({ id: pid });
  }
  if (parts[0] === "projects" && parts[2] === "duplicate" && method === "POST") return reply({ id: duplicate(uid, parts[1], body) });

  const table = parts[0];
  if (!SPECS[table]) throw new ApiError(404, "not_found");
  if (method === "POST" && parts.length === 1) return reply({ id: create(table, uid, body) });
  if (method === "PATCH" && parts.length === 2) { patch(table, uid, parts[1], body); return reply({ id: Number(parts[1]) }); }
  if (method === "DELETE" && parts.length === 2) { remove(table, uid, parts[1]); return reply(); }
  throw new ApiError(404, "not_found");
}

/* Answers fetch("/api/…") in this page; everything else goes to the real network. */
export function install() {
  load();
  catchUpRecurring();
  save();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const m = /^(?:https?:\/\/[^/]+)?\/api\/(.*)$/.exec(url);
    if (!m) return realFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    await new Promise(r => setTimeout(r, 60)); // a touch of latency, like a real server
    try {
      const out = route(method, m[1], body);
      save();
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      if (!(e instanceof ApiError)) { console.error(e); return new Response(JSON.stringify({ error: "server" }), { status: 500 }); }
      return new Response(JSON.stringify(e.body), { status: e.status, headers: { "content-type": "application/json" } });
    }
  };
}
