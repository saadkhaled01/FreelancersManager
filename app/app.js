import { STR, TEMPLATES, TYPES } from "./i18n.js";
import { docData, sampleDoc, normalizeBrand, itemTotals, fillText, normalizeReminders, BRAND_COLORS, LAYOUTS, FONTS, ACCENTS, REPEATS } from "./doc-data.js";
import { renderDoc } from "./doc-render.js";

/* ============ utilities ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const today = () => iso(new Date());
const num = v => (v == null || v === "" ? null : Number(v));
const sum = (arr, f = x => x.amount) => arr.reduce((s, x) => s + f(x), 0);
const fmtNum = n => (Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
const daysSince = isoTs => Math.floor((Date.now() - Date.parse(isoTs)) / 864e5);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};
const CACHE = "fm_cache";

/* ============ state ============ */
const S = {
  data: null,
  lang: store.get("fm_lang") || ((navigator.language || "").startsWith("ar") ? "ar" : "en"),
  route: { name: "today", id: null },
  filter: "all", q: "", clientQ: "",
  money: { month: today().slice(0, 7), state: "all", method: "all" },
  calMonth: today().slice(0, 7),
  authTab: "signup", forgotSent: false, offline: false, tplKind: "quote", invLang: null,
  confirm: null, importData: null,
};

/* ============ i18n ============ */
function tl(lang, key, vars) {
  let s = STR[lang]?.[key] ?? STR.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  return s;
}
const t = (key, vars) => tl(S.lang, key, vars);
const locale = lang => (lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB");
function fdate(s, lang = S.lang, opts = { weekday: "short", day: "numeric", month: "short" }) {
  if (!s) return "—";
  return new Intl.DateTimeFormat(locale(lang), opts).format(parse(s));
}
const fdateLong = (s, lang = S.lang) => fdate(s, lang, { day: "numeric", month: "long", year: "numeric" });
function money(n, lang = S.lang) {
  const cur = S.data?.me.currency || "EGP";
  return `${fmtNum(n)} ${tl(lang, "cur_" + cur)}`;
}
function moneyHtml(n) {
  return `${fmtNum(n)} <small>${esc(t("cur_" + (S.data?.me.currency || "EGP")))}</small>`;
}
function relDue(d) {
  if (!d) return t("no_date");
  const n = daysBetween(today(), d);
  if (n === 0) return t("due_today");
  if (n === 1) return t("due_tomorrow");
  if (n > 1) return t("due_in", { n });
  return t("late_by", { n: -n });
}

/* ============ derived data ============ */
/* Pipeline, after Sorah Ops: brief → booked → in production → client review ⇄ revisions → delivered → (collecting) → done. */
const STATUSES = ["lead", "booked", "active", "with_client", "revising", "delivered", "archived"];
const OPEN = ["lead", "booked", "active", "with_client", "revising"];
const ACTIVE = ["booked", "active", "with_client", "revising"]; // confirmed work with a deadline
/* List groups: delivered projects that still owe money sit in their own "collecting" group, as in Sorah Ops. */
const STAGES = ["lead", "booked", "active", "with_client", "revising", "delivered", "collecting", "archived"];
const METHODS = ["instapay", "vcash", "cash", "bank", "other"];
const STATUS = {
  lead: { c: "muted", color: "var(--line)" },
  booked: { c: "acc", color: "var(--accent)" },
  active: { c: "acc", color: "var(--accent)" },
  with_client: { c: "warn", color: "var(--amber)" },
  revising: { c: "acc", color: "var(--accent)" },
  delivered: { c: "good", color: "var(--success)" },
  archived: { c: "muted", color: "var(--line)" },
};
const D = () => S.data;
const P = id => D().projects.find(p => p.id === id);
const C = id => D().clients.find(c => c.id === id);
const clientOf = p => (p.clientId ? C(p.clientId) : null);
const paysOf = id => D().payments.filter(x => x.projectId === id);
const delsOf = id => D().deliverables.filter(x => x.projectId === id);
const itemsOf = id => (D().items || []).filter(x => x.projectId === id);
function payState(x) {
  if (x.paidAt) return "paid";
  if (x.dueDate && x.dueDate < today()) return "overdue";
  return "due";
}
function projMoney(p) {
  const pays = paysOf(p.id);
  const paid = sum(pays.filter(x => x.paidAt));
  const counts = p.status !== "lead";
  return {
    paid,
    owed: counts ? Math.max(0, p.fee - paid) : 0,
    overdue: counts ? sum(pays.filter(x => payState(x) === "overdue")) : 0,
    unscheduled: Math.max(0, Math.round((p.fee - sum(pays)) * 100) / 100),
  };
}
const isLate = p => ACTIVE.includes(p.status) && p.dueDate && p.dueDate < today();
const overRev = p => p.revisionsUsed > p.revisionsAllowed;
const unpaidOf = p => paysOf(p.id).filter(x => !x.paidAt).sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
function payLabel(x, lang = S.lang) { return x.label || tl(lang, "pk_" + x.kind); }
function rank(p) {
  if (ACTIVE.includes(p.status)) return 0;
  if (p.status === "lead") return 1;
  if (p.status === "delivered") return projMoney(p).owed > 0 ? 2 : 3;
  return 4;
}
const byPriority = (a, b) => rank(a) - rank(b) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || b.id - a.id;
const byDue = (a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || b.id - a.id;
const stageOf = p => (p.status === "delivered" && projMoney(p).owed > 0 ? "collecting" : p.status);
const daysLeft = p => (OPEN.includes(p.status) && p.dueDate ? daysBetween(today(), p.dueDate) : null);
const userTz = () => D()?.me.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;

/* Session times are local "YYYY-MM-DDTHH:MM" strings. */
function addHoursLocal(s, h) {
  const [d, tm] = s.split("T"), [y, m, dd] = d.split("-").map(Number), [hh, mm] = tm.split(":").map(Number);
  const x = new Date(y, m - 1, dd, hh + h, mm);
  return `${iso(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}
/* Numeric dates as in Sorah Ops (02/11/2026), built by hand: Intl's Arabic output carries direction marks that scramble inside LTR text. */
const fnum = s => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const fsession = s => `<span dir="ltr">${fnum(s.slice(0, 10))} - ${s.slice(11, 16)}</span>`;

/* "Open in Google Calendar": a prefilled event, no account link needed. Session if set, otherwise the due date. */
function gcalLink(p) {
  let dates;
  if (p.sessionAt) dates = `${p.sessionAt.replace(/[-:]/g, "")}00/${addHoursLocal(p.sessionAt, 2).replace(/[-:]/g, "")}00`;
  else if (p.dueDate) dates = `${p.dueDate.replace(/-/g, "")}/${addDays(p.dueDate, 1).replace(/-/g, "")}`;
  else return "";
  const c = clientOf(p);
  const q = new URLSearchParams({
    action: "TEMPLATE", dates, ctz: userTz(),
    text: `${p.sessionAt ? t("session") : t("due")}: ${p.title}${c ? ` — ${c.name}` : ""}`,
    details: [p.code, p.folderUrl].filter(Boolean).join("\n"),
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}
const firstName = s => String(s || "").split(/\s+[—-]\s+|\s+/)[0];

/* ============ WhatsApp ============ */
function waNumber(phone) {
  let d = String(phone || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d.slice(1);
  if (d.startsWith("00")) return d.slice(2);
  if (/^01\d{9}$/.test(d)) return "2" + d; // Egyptian mobile
  return d;
}
const waLink = (phone, text) => `https://wa.me/${waNumber(phone)}${text ? "?text=" + encodeURIComponent(text) : ""}`;

function fillTemplate(kind, p, extra = {}) {
  const c = clientOf(p);
  const lang = extra.lang || c?.lang || S.lang;
  const me = D().me;
  const tpl = me.templates?.[kind]?.[lang] || TEMPLATES[lang][kind];
  const unpaid = unpaidOf(p);
  const overdue = unpaid.filter(x => payState(x) === "overdue");
  const dep = paysOf(p.id).find(x => x.kind === "deposit");
  const link = extra.link || (p.links.length ? p.links[p.links.length - 1].url : "");
  const vars = {
    client: firstName(c?.name), project: p.title, code: p.code,
    fee: money(p.fee, lang), deposit: dep ? money(dep.amount, lang) : "",
    amount: money(extra.amount ?? (overdue.length ? sum(overdue) : unpaid[0]?.amount ?? projMoney(p).owed), lang),
    link, due: p.dueDate ? fdateLong(p.dueDate, lang) : "",
    instapay: me.instapay, vcash: me.vcash, me: me.business || me.name,
    doc: tl(lang, p.status === "lead" ? "quote" : "invoice"),
    total: money(p.status === "lead" ? p.fee : projMoney(p).owed, lang),
  };
  return fillText(tpl, vars);
}
/* Email reminders need email set up on the server and the client's email address. */
const canEmailReminder = (x, p) => D().me.mailReady && !x.paidAt && !!clientOf(p)?.email;
function reminderNote(x) {
  if (x.paidAt || !(x.remindersSent || x.beforeSent)) return "";
  return x.remindersSent ? t("reminded_n", { n: x.remindersSent, d: fdate(x.lastReminder) }) : t("reminded_before");
}
const remindBtn = x => `<button class="btn btn-ghost btn-sm" data-act="remind" data-id="${x.id}">${t("email_reminder")}</button>`;

function defaultKind(p) {
  if (p.status === "lead") return "quote";
  if (p.status === "with_client") return "delivery";
  return projMoney(p).owed > 0 ? "reminder" : "delivery";
}

/* ============ api ============ */
async function api(method, path, body) {
  if (S.offline && method !== "GET") throw new Error("offline");
  let r;
  try {
    r = await fetch("/api" + path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error("network"); }
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && S.data) { signedOut(); throw new Error("auth"); }
  if (!r.ok) throw Object.assign(new Error(j?.error || "server"), { body: j, status: r.status });
  if (j?.data) setData(j.data);
  return j;
}
function setData(d) {
  S.data = d;
  if (d.me.lang !== S.lang) { S.lang = d.me.lang; store.set("fm_lang", S.lang); applyLang(); }
  store.set(CACHE, JSON.stringify(d));
}
function signedOut() {
  S.data = null;
  store.del(CACHE);
  render();
}
function errMsg(e) {
  if (e.body?.field) return t("err_field", { field: t("f_" + e.body.field) });
  const k = "err_" + e.message;
  return STR.en[k] ? t(k) : t("err_server");
}
async function mutate(method, path, body, okMsg) {
  try {
    const j = await api(method, path, body);
    if (okMsg) toast(okMsg);
    render();
    return j || {};
  } catch (e) {
    if (e.message !== "auth") toast(errMsg(e));
    return null;
  }
}

/* ============ icons ============ */
const I = {
  today: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  projects: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  clients: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6.5 6.5 0 0 1 3 6"/></svg>`,
  money: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5" stroke-linecap="round"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>`,
  back: `<svg class="flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
  wa: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3 1 2.6 1.1 2.8.1.2 1.9 2.9 4.6 4 1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.8-1.2.2-.6.2-1.1.1-1.2l-.4-.2Z"/></svg>`,
};
const NAV = ["today", "projects", "clients", "money", "settings"];

/* ============ shell ============ */
function applyLang() {
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === "ar" ? "rtl" : "ltr";
}
function applyTheme() {
  const th = store.get("fm_theme");
  if (th) document.documentElement.setAttribute("data-theme", th);
  else document.documentElement.removeAttribute("data-theme");
}
const isDark = () => {
  const th = document.documentElement.getAttribute("data-theme");
  return th ? th === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

function renderChrome() {
  const authed = !!S.data;
  document.body.classList.toggle("authed", authed);
  const cur = { project: "projects", client: "clients", invoice: "projects", calendar: "today", style: "settings" }[S.route.name] || S.route.name;
  const links = NAV.map(n => `<a href="#${n}" ${cur === n ? `aria-current="page"` : ""}>${I[n]}<span>${t("nav_" + n)}</span></a>`).join("");
  $("#topbar").innerHTML = `
    <a class="brand" href="#today"><div class="mark">${t("brand_mark")}</div><div><b>${t("brand")}</b><span>${t("tagline")}</span></div></a>
    ${authed ? `<nav class="nav" aria-label="${t("nav_label")}">${links}</nav>` : ""}
    <div class="tools">
      <button class="icon-btn" data-act="lang" aria-label="${t("switch_lang")}">${t("other_lang")}</button>
      <button class="icon-btn" data-act="theme" aria-label="${t("switch_theme")}">${isDark() ? "☀" : "☾"}</button>
    </div>`;
  $("#tabbar").innerHTML = authed ? links : "";
  $("#tabbar").setAttribute("aria-label", t("nav_label"));
}

function render() {
  renderChrome();
  const v = $("#view");
  if (S.route.name === "reset") {
    v.innerHTML = resetView();
    document.title = `${t("reset_title")} · ${t("brand")}`;
    return;
  }
  if (!S.data) {
    v.innerHTML = authView();
    document.title = t("brand");
    return;
  }
  const r = S.route;
  const views = { today: todayView, projects: projectsView, project: projectView, clients: clientsView, client: clientView, money: moneyView, settings: settingsView, invoice: invoiceView, calendar: calendarView, style: styleView };
  const fn = views[r.name] || todayView;
  v.innerHTML = (S.offline ? `<div class="banner warn"><span><b>${t("offline")}</b> ${t("offline_hint")}</span></div>` : "") + fn(r.id);
  document.title = `${r.name === "calendar" ? t("calendar") : r.name === "style" ? t("style_title") : t("nav_" + (NAV.includes(r.name) ? r.name : r.name === "client" ? "clients" : "projects"))} · ${t("brand")}`;
}

/* ============ small components ============ */
const badge = (c, txt) => `<span class="badge ${c}">${esc(txt)}</span>`;
const kpi = (n, l, c = "") => `<div class="kpi ${c}"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
const empty = (title, hint, btn = "") => `<div class="empty"><b>${esc(title)}</b>${esc(hint)}${btn ? `<div>${btn}</div>` : ""}</div>`;
const stBadge = p => badge(STATUS[p.status].c, t("st_" + p.status));
const payBadge = x => {
  const st = payState(x);
  return badge(st === "paid" ? "good" : st === "overdue" ? "bad" : "warn", t("ps_" + st));
};
const waBtn = (pid, kind = "", small = true) =>
  `<button class="btn btn-wa ${small ? "btn-sm" : ""}" data-act="msg" data-id="${pid}" data-kind="${kind}">${I.wa}${t("wa_client")}</button>`;

/* Project row, laid out like Sorah Ops: urgency stripe, code, client — title, type, dates and links; stage picker and actions on the end. */
function prow(p) {
  const c = clientOf(p), m = projMoney(p), stg = stageOf(p), n = daysLeft(p);
  const stripe = n !== null ? (n < 0 ? "var(--danger)" : n <= 3 ? "var(--amber)" : "var(--line)")
    : stg === "collecting" ? (m.overdue ? "var(--danger)" : "var(--amber)") : "var(--line)";
  const days = n !== null
    ? badge(n < 0 ? "bad" : n <= 3 ? "warn" : "muted", n < 0 ? t("late_by", { n: -n }) : n === 0 ? t("due_today") : t("days_left", { n }))
    : stg === "collecting" ? badge(m.overdue ? "bad" : "warn", t("owed_amt", { amt: money(m.owed) })) : "";
  const gc = gcalLink(p), last = p.links[p.links.length - 1];
  const links = [
    gc ? `<a href="${esc(gc)}" target="_blank" rel="noopener">${t("open_gcal")} ↗</a>` : "",
    p.folderUrl ? `<a href="${esc(p.folderUrl)}" target="_blank" rel="noopener">${t("open_folder")} ↗</a>` : "",
    last ? `<a href="${esc(last.url)}" target="_blank" rel="noopener">${esc(last.label || t("latest_version"))} ↗</a>` : "",
  ].filter(Boolean).join("");
  const dels = delsOf(p.id);
  return `<article class="pr"><div class="stripe" style="background:${stripe}"></div>
    <div class="main">
      <div class="r1"><span class="code">${esc(p.code)}</span><a class="who" href="#project/${p.id}">${c ? `<bdi>${esc(c.company || c.name)}</bdi> — ` : ""}<bdi>${esc(p.title)}</bdi></a>${p.type ? badge("muted", p.type) : ""}${p.repeat ? badge("acc", "↻ " + t("repeat_" + p.repeat)) : ""}${overRev(p) ? badge("warn", t("over_rev")) : ""}</div>
      <div class="meta">
        ${p.sessionAt ? `<span>${t("session")}: <b>${fsession(p.sessionAt)}</b></span>` : ""}
        <span>${t("due")}: <b dir="ltr">${p.dueDate ? fnum(p.dueDate) : "—"}</b></span>
        ${p.fee > 0 ? (p.status === "lead" ? `<span>${t("quote")}: <b class="mono">${money(p.fee)}</b></span>` : `<span>${t("paid")}: <b class="mono">${fmtNum(m.paid)} / ${money(p.fee)}</b></span>`) : ""}
        ${ACTIVE.includes(p.status) && p.revisionsAllowed ? `<span>${t("round_of", { n: p.revisionsUsed, of: p.revisionsAllowed })}</span>` : ""}
      </div>
      ${links ? `<div class="meta lk">${links}</div>` : ""}
    </div>
    <div class="ctrl">${days}
      <select class="input stage" data-stage="${p.id}" aria-label="${t("f_status")}: ${esc(p.title)}">${STATUSES.map(x => `<option value="${x}" ${p.status === x ? "selected" : ""}>${t("st_" + x)}</option>`).join("")}</select>
      <a class="btn btn-ghost btn-sm" href="#project/${p.id}">${t("deliverables")} (${dels.length})</a>
      <button class="icon-btn sm wa" data-act="msg" data-id="${p.id}" aria-label="${t("wa_client")}" title="${t("wa_client")}">${I.wa}</button>
      <button class="icon-btn sm" data-act="editProject" data-id="${p.id}" aria-label="${t("edit")}" title="${t("edit")}">✎</button>
      <button class="icon-btn sm" data-act="delProject" data-id="${p.id}" aria-label="${t("delete")}" title="${t("delete")}">✕</button>
    </div></article>`;
}

/* ============ auth ============ */
function forgotPanel() {
  if (S.forgotSent) return `<section class="panel"><h2 style="font-size:18px">${t("forgot_sent")}</h2><p class="muted">${t("forgot_sent_hint")}</p>
    <button class="btn btn-ghost" data-act="authTab" data-v="login">${t("back_to_login")}</button></section>`;
  return `<section class="panel"><h2 style="font-size:18px">${t("forgot_title")}</h2><p class="muted">${t("forgot_hint")}</p>
    <form data-form="forgot">
      <div class="field req"><label for="fEmail">${t("f_email")}</label><input id="fEmail" name="email" type="email" autocomplete="email" required class="ltr"></div>
      <div class="err" id="authErr"></div>
      <button class="btn btn-primary btn-block" type="submit">${t("send_link")}</button>
      <button class="linkish" type="button" data-act="authTab" data-v="login" style="align-self:center">${t("back_to_login")}</button>
    </form></section>`;
}
function resetView() {
  return `<div class="auth"><section class="pitch"><h1>${t("reset_title")}</h1><p>${t("reset_hint")}</p></section>
    <section class="panel"><form data-form="reset">
      <div class="field req"><label for="rPass">${t("new_password")}</label><input id="rPass" name="password" type="password" minlength="8" required autocomplete="new-password"><span class="hint">${t("pass_hint")}</span></div>
      <div class="err" id="authErr"></div>
      <button class="btn btn-primary btn-block" type="submit">${t("set_password")}</button>
    </form></section></div>`;
}
function authView() {
  const su = S.authTab === "signup";
  return `<div class="auth">
    <section class="pitch">
      <h1>${t("pitch_title")}</h1>
      <p>${t("pitch_body")}</p>
      <ul>
        <li><i aria-hidden="true">✓</i><span>${t("pitch_1")}</span></li>
        <li><i aria-hidden="true">✓</i><span>${t("pitch_2")}</span></li>
        <li><i aria-hidden="true">✓</i><span>${t("pitch_3")}</span></li>
        <li><i aria-hidden="true">✓</i><span>${t("pitch_4")}</span></li>
      </ul>
    </section>
    ${S.authTab === "forgot" ? forgotPanel() : `<section class="panel">
      <div class="seg" role="tablist">
        <button type="button" data-act="authTab" data-v="signup" aria-pressed="${su}">${t("signup")}</button>
        <button type="button" data-act="authTab" data-v="login" aria-pressed="${!su}">${t("login")}</button>
      </div>
      <form data-form="${su ? "signup" : "login"}">
        ${su ? `<div class="field req"><label for="aName">${t("f_name")}</label><input id="aName" name="name" autocomplete="name" required maxlength="120"></div>` : ""}
        <div class="field req"><label for="aEmail">${t("f_email")}</label><input id="aEmail" name="email" type="email" autocomplete="email" required class="ltr"></div>
        <div class="field req"><label for="aPass">${t("f_password")}</label><input id="aPass" name="password" type="password" minlength="8" required autocomplete="${su ? "new-password" : "current-password"}">${su ? `<span class="hint">${t("pass_hint")}</span>` : ""}</div>
        ${su ? `<label class="check"><input type="checkbox" name="examples" checked><span>${t("start_examples")}</span></label>` : ""}
        <div class="err" id="authErr"></div>
        <button class="btn btn-primary btn-block" type="submit">${su ? t("create_account") : t("login")}</button>
        ${su ? "" : `<button class="linkish" type="button" data-act="authTab" data-v="forgot" style="align-self:center">${t("forgot_link")}</button>`}
      </form>
    </section>`}
  </div>`;
}

/* ============ today ============ */
function todayView() {
  const td = today(), week = addDays(td, 7);
  const ps = D().projects;
  const due = ps.filter(p => ACTIVE.includes(p.status) && p.dueDate && p.dueDate <= week).sort(byPriority);
  const dels = D().deliverables.filter(d => !d.done && d.dueDate && d.dueDate <= week && ACTIVE.includes(P(d.projectId)?.status))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const sessions = ps.filter(p => OPEN.includes(p.status) && p.sessionAt && p.sessionAt.slice(0, 10) >= td && p.sessionAt.slice(0, 10) <= week)
    .sort((a, b) => a.sessionAt.localeCompare(b.sessionAt));
  const chase = D().payments.filter(x => !x.paidAt && x.dueDate && x.dueDate <= week && P(x.projectId)?.status !== "lead")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const waiting = ps.filter(p => (p.status === "lead" || p.status === "with_client") && daysSince(p.statusAt) >= 3)
    .sort((a, b) => a.statusAt.localeCompare(b.statusAt));
  const over = ps.filter(p => ACTIVE.includes(p.status) && overRev(p));
  const me = D().me;

  const dueRows = [
    ...sessions.map(p => {
      const c = clientOf(p), d = p.sessionAt.slice(0, 10);
      return `<div class="ri"><span class="dot" style="background:var(--accent)"></span>
        <div class="txt"><a href="#project/${p.id}">${esc(p.title)}</a><span class="hint">${c ? esc(c.name) + " · " : ""}${t("session")} · <span dir="ltr">${p.sessionAt.slice(11, 16)}</span></span></div>
        ${badge(d === td ? "warn" : "acc", d === td ? t("due_today") : fdate(d))}</div>`;
    }),
    ...due.map(p => {
      const c = clientOf(p), late = isLate(p);
      return `<div class="ri"><span class="dot" style="background:${late ? "var(--danger)" : STATUS[p.status].color}"></span>
        <div class="txt"><a href="#project/${p.id}">${esc(p.title)}</a><span class="hint">${c ? esc(c.name) + " · " : ""}${t("st_" + p.status)}</span></div>
        ${badge(late ? "bad" : p.dueDate === td ? "warn" : "muted", relDue(p.dueDate))}</div>`;
    }),
    ...dels.map(d => {
      const p = P(d.projectId), late = d.dueDate < td;
      return `<div class="ri"><span class="dot" style="background:${late ? "var(--danger)" : "var(--muted)"}"></span>
        <div class="txt"><a href="#project/${p.id}">${esc(d.label)}</a><span class="hint">${esc(p.title)}</span></div>
        ${badge(late ? "bad" : "muted", relDue(d.dueDate))}<button class="btn btn-ghost btn-sm" data-act="toggleDel" data-id="${d.id}">${t("mark_done")}</button></div>`;
    }),
  ].join("");

  const chaseRows = chase.map(x => {
    const p = P(x.projectId), c = clientOf(p), st = payState(x);
    return `<div class="ri"><span class="dot" style="background:${st === "overdue" ? "var(--danger)" : "var(--amber)"}"></span>
      <div class="txt"><a href="#project/${p.id}">${esc(p.title)}</a><span class="hint">${c ? esc(c.name) + " · " : ""}${esc(payLabel(x))} · ${relDue(x.dueDate)}${reminderNote(x) ? " · " + reminderNote(x) : ""}</span></div>
      <span class="amt">${money(x.amount)}</span>
      <div class="acts">${waBtn(p.id, "reminder")}${canEmailReminder(x, p) ? remindBtn(x) : ""}<button class="btn btn-ghost btn-sm" data-act="markPaid" data-id="${x.id}">${t("mark_paid")}</button></div></div>`;
  }).join("");

  const waitRows = waiting.map(p => {
    const c = clientOf(p), n = daysSince(p.statusAt);
    return `<div class="ri"><span class="dot" style="background:var(--amber)"></span>
      <div class="txt"><a href="#project/${p.id}">${esc(p.title)}</a><span class="hint">${c ? esc(c.name) + " · " : ""}${p.status === "lead" ? t("quote_sent", { n }) : t("with_client_for", { n })}</span></div>
      ${waBtn(p.id, p.status === "lead" ? "quote" : "delivery")}</div>`;
  }).join("");

  const overRows = over.map(p => `<div class="ri"><span class="dot" style="background:var(--amber)"></span>
      <div class="txt"><a href="#project/${p.id}">${esc(p.title)}</a><span class="hint">${t("round_of", { n: p.revisionsUsed, of: p.revisionsAllowed })}</span></div>
      ${badge("warn", t("bill_extra"))}</div>`).join("");

  const nothing = !dueRows && !chaseRows && !waitRows && !overRows;
  const owed = sum(ps, p => projMoney(p).owed), overdue = sum(ps, p => projMoney(p).overdue);
  return `
    <div class="toolbar"><div><h1>${t("hello", { name: esc(firstName(me.name)) })}</h1><span class="hint">${fdateLong(td)}</span></div>
      <div class="acts"><a class="btn btn-ghost" href="#calendar">${t("calendar")}</a><button class="btn btn-ghost" data-act="newClient">+ ${t("client")}</button><button class="btn btn-primary" data-act="newProject">+ ${t("new_project")}</button></div></div>
    <div class="kpis">
      ${kpi(ps.filter(p => ACTIVE.includes(p.status)).length, t("k_active"))}
      ${kpi(due.length, t("k_due_week"), due.length ? "warn" : "")}
      ${kpi(moneyHtml(owed), t("k_owed"))}
      ${kpi(moneyHtml(overdue), t("k_overdue"), overdue ? "bad" : "")}
    </div>
    ${nothing ? empty(t("all_clear"), ps.length ? t("all_clear_hint") : t("first_project_hint"), ps.length ? "" : `<button class="btn btn-primary" data-act="newProject">+ ${t("new_project")}</button>`) : `
    <div class="split">
      <div class="stack">
        ${dueRows ? `<section class="panel"><div class="panel-head"><h2>${t("due_week")}</h2><a class="hint" href="#projects">${t("all_projects")}</a></div><div class="rows">${dueRows}</div></section>` : ""}
        ${waitRows ? `<section class="panel"><div class="panel-head"><h2>${t("waiting")}</h2><span class="hint">${t("waiting_hint")}</span></div><div class="rows">${waitRows}</div></section>` : ""}
      </div>
      <div class="stack">
        ${chaseRows ? `<section class="panel"><div class="panel-head"><h2>${t("chase")}</h2><a class="hint" href="#money">${t("nav_money")}</a></div><div class="rows">${chaseRows}</div></section>` : ""}
        ${overRows ? `<section class="panel"><div class="panel-head"><h2>${t("over_limit")}</h2></div><div class="rows">${overRows}</div></section>` : ""}
      </div>
    </div>`}`;
}

/* ============ projects ============ */
function projectMatches(p) {
  const q = S.q.trim().toLowerCase();
  if (!q) return true;
  const c = clientOf(p);
  return [p.title, p.code, p.type, c?.name, c?.company].some(s => String(s || "").toLowerCase().includes(q));
}
function projectsList() {
  const all = D().projects.filter(projectMatches);
  if (!D().projects.length) return empty(t("no_projects"), t("first_project_hint"), `<button class="btn btn-primary" data-act="newProject">+ ${t("new_project")}</button>`);
  if (S.filter === "all") {
    const html = STAGES.filter(x => x !== "archived").map(x => {
      const g = all.filter(p => stageOf(p) === x).sort(byDue);
      return g.length ? `<h2 class="group">${t("st_" + x)} <span>(${g.length})</span></h2>${g.map(prow).join("")}` : "";
    }).join("");
    return html || empty(t("no_match"), t("no_match_hint"));
  }
  const list = all.filter(p => stageOf(p) === S.filter).sort(byDue);
  return list.length ? list.map(prow).join("") : empty(t("no_match"), t("no_match_hint"));
}
function projectsView() {
  const ps = D().projects;
  if (S.filter !== "all" && !STAGES.includes(S.filter)) S.filter = "all";
  const open = ps.filter(p => OPEN.includes(p.status));
  const near = open.filter(p => { const n = daysLeft(p); return n !== null && n >= 0 && n <= 3; }).length;
  const late = open.filter(p => daysLeft(p) < 0).length;
  const owed = sum(ps, p => projMoney(p).owed);
  return `
    <div class="toolbar"><h1>${t("nav_projects")}</h1>
      <input class="input grow" id="pq" type="search" placeholder="${t("search_projects")}" value="${esc(S.q)}" aria-label="${t("search_projects")}">
      <div class="acts"><a class="btn btn-ghost" href="#calendar">${t("calendar")}</a><button class="btn btn-primary" data-act="newProject">+ ${t("new_project")}</button></div></div>
    <div class="kpis">
      ${kpi(open.length, t("k_open"))}
      ${kpi(near, t("k_near"), near ? "warn" : "")}
      ${kpi(late, t("k_late"), late ? "bad" : "")}
      ${kpi(moneyHtml(owed), t("k_collect"), owed ? "" : "good")}
    </div>
    <div class="toolbar"><div class="chips">${["all", ...STAGES].map(f => `<button class="chip" data-act="filter" data-v="${f}" aria-pressed="${S.filter === f}">${t(f === "all" ? "f_all" : "st_" + f)}${f === "all" ? "" : `<span class="n">${ps.filter(p => stageOf(p) === f).length}</span>`}</button>`).join("")}</div>
      <span class="hint">${t("projects_total", { n: ps.length })}</span></div>
    <div class="list" id="plist">${projectsList()}</div>`;
}

/* ============ project detail ============ */
function projectView(id) {
  const p = P(id);
  if (!p) return empty(t("not_found"), t("not_found_hint"), `<a class="btn btn-ghost" href="#projects">${t("all_projects")}</a>`);
  const c = clientOf(p), m = projMoney(p), dels = delsOf(p.id), pays = paysOf(p.id);
  const acts = D().activity.filter(a => a.projectId === p.id);
  const late = isLate(p);

  const quick = [];
  quick.push(waBtn(p.id, defaultKind(p), false));
  if (p.status === "lead") quick.push(`<button class="btn btn-primary" data-act="status" data-id="${p.id}" data-v="booked">${t("won")}</button>`);
  if (p.status === "booked") quick.push(`<button class="btn btn-primary" data-act="status" data-id="${p.id}" data-v="active">${t("start_work")}</button>`);
  if (["active", "revising"].includes(p.status)) quick.push(`<button class="btn btn-primary" data-act="sendVersion" data-id="${p.id}">${t("send_version")}</button>`);
  if (p.status === "with_client") quick.push(`<button class="btn btn-ghost" data-act="status" data-id="${p.id}" data-v="revising">${t("wants_changes")}</button>`);
  if (["active", "with_client", "revising"].includes(p.status)) quick.push(`<button class="btn btn-ghost" data-act="status" data-id="${p.id}" data-v="delivered">${t("mark_delivered")}</button>`);
  quick.push(`<button class="btn btn-ghost" data-act="sendDoc" data-id="${p.id}">${t(p.status === "lead" ? "send_quote" : "send_invoice")}</button>`);
  const gc = gcalLink(p);
  if (gc) quick.push(`<a class="btn btn-ghost" href="${esc(gc)}" target="_blank" rel="noopener">${t("open_gcal")} ↗</a>`);
  if (p.folderUrl) quick.push(`<a class="btn btn-ghost" href="${esc(p.folderUrl)}" target="_blank" rel="noopener">${t("open_folder")} ↗</a>`);
  if (p.status === "delivered" && !m.owed) quick.push(`<button class="btn btn-ghost" data-act="status" data-id="${p.id}" data-v="archived">${t("archive")}</button>`);

  const delRows = dels.map(d => `<div class="todo ${d.done ? "done" : ""}">
      <input type="checkbox" id="del${d.id}" data-act="toggleDel" data-id="${d.id}" ${d.done ? "checked" : ""}>
      <label class="l" for="del${d.id}">${esc(d.label)}</label>
      ${d.dueDate ? badge(!d.done && d.dueDate < today() ? "bad" : "muted", fdate(d.dueDate)) : ""}
      <button class="x" data-act="delDel" data-id="${d.id}" aria-label="${t("delete")}">✕</button></div>`).join("");

  const payRows = pays.map(x => `<div class="ri">
      <div class="txt"><b>${esc(payLabel(x))}</b><span class="hint">${x.paidAt
        ? `${t("paid_on", { d: fdate(x.paidAt) })}${x.method ? " · " + t("m_" + x.method) : ""}${x.ref ? ` · <span class="mono">${esc(x.ref)}</span>` : ""}`
        : x.dueDate ? `${t("due")} ${fdate(x.dueDate)} · ${relDue(x.dueDate)}` : t("no_date")}${reminderNote(x) ? ` · ${reminderNote(x)}` : ""}</span></div>
      <span class="amt">${money(x.amount)}</span>${payBadge(x)}
      <div class="acts">${x.paidAt ? "" : `<button class="btn btn-primary btn-sm" data-act="markPaid" data-id="${x.id}">${t("mark_paid")}</button>`}${canEmailReminder(x, p) ? remindBtn(x) : ""}
        <button class="btn btn-ghost btn-sm" data-act="editPay" data-id="${x.id}">${t("edit")}</button></div></div>`).join("");

  const feed = acts.map(a => `<div class="it ${a.kind === "note" ? "note" : ""}"><span class="when">${fdate(a.at.slice(0, 10), S.lang, { day: "numeric", month: "short" })}</span><div class="what">${activityText(a)}</div></div>`).join("");

  return `
    <a class="back" href="#projects">${I.back}${t("all_projects")}</a>
    <section class="panel">
      <div class="panel-head">
        <div style="display:flex; flex-direction:column; gap:4px; min-width:0">
          <div class="r1"><span class="code">${esc(p.code)}</span>${stBadge(p)}${late ? badge("bad", relDue(p.dueDate)) : ""}${overRev(p) ? badge("warn", t("over_rev")) : ""}${p.acceptedAt ? badge("good", t("accepted_badge", { name: p.acceptedBy })) : ""}</div>
          <h1 style="font-size:24px">${esc(p.title)}</h1>
          ${c ? `<div class="sub"><a href="#client/${c.id}">${esc(c.name)}</a>${c.phone ? `<span>·</span><span class="mono ltr">${esc(c.phone)}</span>` : ""}</div>` : `<div class="sub">${t("no_client")}</div>`}
        </div>
        <div class="acts"><button class="btn btn-ghost btn-sm" data-act="duplicate" data-id="${p.id}">${t("duplicate")}</button><a class="btn btn-ghost btn-sm" href="#invoice/${p.id}">${p.status === "lead" ? t("quote") : t("invoice")}</a>
          <button class="btn btn-ghost btn-sm" data-act="editProject" data-id="${p.id}">${t("edit")}</button>
          <button class="btn btn-danger btn-sm" data-act="delProject" data-id="${p.id}">${t("delete")}</button></div>
      </div>
      <div class="chips" aria-label="${t("f_status")}">${STATUSES.map(s => `<button class="chip" data-act="status" data-id="${p.id}" data-v="${s}" aria-pressed="${p.status === s}">${t("st_" + s)}</button>`).join("")}</div>
      <div class="facts">
        ${p.sessionAt ? `<div class="fact"><span class="k">${t("session")}</span><span class="v">${fsession(p.sessionAt)}</span></div>` : ""}
        <div class="fact"><span class="k">${t("f_dueDate")}</span><span class="v">${fdate(p.dueDate)}</span>${p.dueDate && ACTIVE.includes(p.status) ? `<span class="hint">${relDue(p.dueDate)}</span>` : ""}</div>
        <div class="fact"><span class="k">${t("f_startDate")}</span><span class="v">${fdate(p.startDate)}</span></div>
        ${p.repeat ? `<div class="fact"><span class="k">${t("f_repeat")}</span><span class="v">${t("repeat_" + p.repeat)}</span>
          <span class="hint">${p.repeatUntil && p.repeatNext > p.repeatUntil ? t("repeat_ended", { d: fdate(p.repeatUntil) }) : t("repeat_next", { d: fdate(p.repeatNext) })}</span>
          <button class="linkish hint" data-act="repeatNow" data-id="${p.id}" style="align-self:flex-start">${t("repeat_now")}</button></div>` : ""}
        ${p.seriesId && P(p.seriesId) ? `<div class="fact"><span class="k">${t("series")}</span><a class="v" href="#project/${p.seriesId}">${esc(P(p.seriesId).code)}</a></div>` : ""}
        <div class="fact"><span class="k">${t("f_fee")}</span><span class="v mono">${money(p.fee)}</span></div>
        <div class="fact"><span class="k">${t("revisions")}</span><span class="v"><span class="stepper"><button data-act="rev" data-id="${p.id}" data-v="-1" aria-label="−">−</button><span dir="ltr">${p.revisionsUsed} / ${p.revisionsAllowed}</span><button data-act="rev" data-id="${p.id}" data-v="1" aria-label="+">+</button></span></span></div>
        ${p.type ? `<div class="fact"><span class="k">${t("f_type")}</span><span class="v">${esc(p.type)}</span></div>` : ""}
      </div>
      <div class="acts">${quick.join("")}</div>
    </section>
    <div class="split">
      <div class="stack">
        ${itemsPanel(p)}
        <section class="panel">
          <div class="panel-head"><h2>${t("deliverables")}</h2>${dels.length ? `<span class="hint">${t("dels_done", { n: dels.filter(d => d.done).length, of: dels.length })}</span>` : ""}</div>
          ${delRows || `<span class="hint">${t("no_dels")}</span>`}
          <form data-form="deliverable" data-id="${p.id}" class="addrow" style="flex-direction:row"><input class="input" name="label" required maxlength="200" placeholder="${t("add_del_ph")}" aria-label="${t("add_del_ph")}"><input class="input" name="dueDate" type="date" style="max-width:150px" aria-label="${t("f_dueDate")}"><button class="btn btn-ghost" type="submit">${t("add")}</button></form>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>${t("links")}</h2>${ACTIVE.includes(p.status) ? `<button class="btn btn-ghost btn-sm" data-act="sendVersion" data-id="${p.id}">+ ${t("send_version")}</button>` : `<button class="btn btn-ghost btn-sm" data-act="addLink" data-id="${p.id}">+ ${t("add_link")}</button>`}</div>
          ${p.links.length ? `<div class="links">${p.links.slice().reverse().map((l, i) => `<div class="lnk"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" class="ltr">${esc(l.label || l.url)}</a><span class="hint">${fdate(l.at)}</span><button class="x" data-act="delLink" data-id="${p.id}" data-i="${p.links.length - 1 - i}" aria-label="${t("delete")}">✕</button></div>`).join("")}</div>` : `<span class="hint">${t("no_links")}</span>`}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>${t("notes_activity")}</h2></div>
          ${p.notes ? `<div style="white-space:pre-wrap; font-size:13.5px">${esc(p.notes)}</div>` : ""}
          <form data-form="note" data-id="${p.id}" class="addrow" style="flex-direction:row"><input class="input" name="text" required maxlength="2000" placeholder="${t("add_note_ph")}" aria-label="${t("add_note_ph")}"><button class="btn btn-ghost" type="submit">${t("add")}</button></form>
          <div class="feed">${feed}</div>
        </section>
      </div>
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><h2>${t("payments")}</h2><button class="btn btn-ghost btn-sm" data-act="newPay" data-id="${p.id}">+ ${t("add_payment")}</button></div>
          ${payRows ? `<div class="rows">${payRows}</div>` : `<span class="hint">${t("no_payments")}</span>`}
          <div class="totals">
            <div class="row"><span>${t("f_fee")}</span><span class="v">${money(p.fee)}</span></div>
            <div class="row good"><span>${t("paid")}</span><span class="v">${money(m.paid)}</span></div>
            ${m.overdue ? `<div class="row bad"><span>${t("ps_overdue")}</span><span class="v">${money(m.overdue)}</span></div>` : ""}
            <div class="row big"><span>${p.status === "lead" ? t("quote") : t("remaining")}</span><span class="v">${money(p.status === "lead" ? p.fee : m.owed)}</span></div>
          </div>
          ${m.unscheduled > 0 ? `<div class="banner warn"><span>${t("unscheduled", { amt: money(m.unscheduled) })}</span><button class="btn btn-ghost btn-sm" data-act="newPay" data-id="${p.id}" data-amount="${m.unscheduled}">${t("schedule_it")}</button></div>` : ""}
        </section>
      </div>
    </div>`;
}

/* Line items: with any, the fee is their total after discount and tax (the server calculates it too). */
function itemsPanel(p) {
  const its = itemsOf(p.id), cur = t("cur_" + D().me.currency);
  const sums = itemTotals(its, p.discount, p.taxRate);
  const rows = its.map(i => `<div class="ri">
      <div class="txt"><b>${esc(i.label)}</b><span class="hint mono">${fmtNum(i.qty)} × ${money(i.unitPrice)}</span></div>
      <span class="amt">${money(i.qty * i.unitPrice)}</span>
      <div class="acts"><button class="btn btn-ghost btn-sm" data-act="editItem" data-id="${i.id}">${t("edit")}</button><button class="x" data-act="delItem" data-id="${i.id}" aria-label="${t("delete")}">✕</button></div></div>`).join("");
  return `<section class="panel">
    <div class="panel-head"><h2>${t("items")}</h2>${its.length ? `<span class="hint">${t("fee_from_items")}</span>` : ""}</div>
    ${rows ? `<div class="rows">${rows}</div>` : `<span class="hint">${t("items_hint")}</span>`}
    <form data-form="item" data-id="${p.id}" class="item-add">
      <input class="input" name="label" required maxlength="200" placeholder="${t("item_label_ph")}" aria-label="${t("f_label")}">
      <input class="input mono" name="qty" type="number" min="0.001" step="any" value="1" aria-label="${t("qty")}" title="${t("qty")}">
      <input class="input mono" name="unitPrice" type="number" min="0" step="0.01" inputmode="decimal" required placeholder="${t("unit_price")}" aria-label="${t("unit_price")} (${esc(cur)})">
      <button class="btn btn-ghost" type="submit">${t("add_item")}</button>
    </form>
    ${its.length ? `<form data-form="pricing" data-id="${p.id}" class="grid3" style="align-items:end">
        <div class="field"><label for="prDisc">${t("discount")} (${esc(cur)})</label><input id="prDisc" class="mono" name="discount" type="number" min="0" step="0.01" value="${p.discount || 0}"></div>
        <div class="field"><label for="prTax">${t("f_taxRate")}</label><input id="prTax" class="mono" name="taxRate" type="number" min="0" max="100" step="0.01" value="${p.taxRate || 0}"></div>
        <div><button class="btn btn-ghost" type="submit">${t("save")}</button></div>
      </form>
      <div class="totals">
        <div class="row"><span>${t("subtotal")}</span><span class="v">${money(sums.subtotal)}</span></div>
        ${sums.discount ? `<div class="row"><span>${t("discount")}</span><span class="v">− ${money(sums.discount)}</span></div>` : ""}
        ${sums.tax ? `<div class="row"><span>${t("tax_n", { n: fmtNum(sums.taxRate) })}</span><span class="v">${money(sums.tax)}</span></div>` : ""}
        <div class="row big"><span>${t("total")}</span><span class="v">${money(sums.total)}</span></div>
      </div>` : ""}
  </section>`;
}

function itemForm(id) {
  const i = D().items.find(x => x.id === id);
  openModal(`${mhead(t("edit_item"))}
    <form data-form="itemEdit" data-id="${i.id}">
      <div class="field req"><label for="iLabel">${t("f_label")}</label><input id="iLabel" name="label" required maxlength="200" value="${esc(i.label)}"></div>
      <div class="grid2">
        <div class="field req"><label for="iQty">${t("qty")}</label><input id="iQty" class="mono" name="qty" type="number" min="0.001" step="any" required value="${i.qty}"></div>
        <div class="field req"><label for="iPrice">${t("unit_price")}</label><input id="iPrice" class="mono" name="unitPrice" type="number" min="0" step="0.01" required value="${i.unitPrice}"></div>
      </div>
      ${mfoot(t("save"), `<button class="btn btn-danger" type="button" data-act="delItem" data-id="${i.id}" style="margin-inline-start:auto">${t("delete")}</button>`)}
    </form>`);
}

function activityText(a) {
  const d = a.data || {};
  switch (a.kind) {
    case "created": return d.from ? t("a_created_from", { code: esc(d.from) }) : t("a_created");
    case "status": return t("a_status", { to: t("st_" + d.to) });
    case "round": return t("a_round", { n: d.n, of: d.of });
    case "link": return `${t("a_link")} <a class="ltr" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.label || d.url)}</a>`;
    case "paid": return t("a_paid", { amt: money(d.amount || 0) }) + (d.method ? ` · ${t("m_" + d.method)}` : "");
    case "done": return t("a_done", { label: esc(d.label) });
    case "note": return esc(d.text);
    case "sent": return t("a_sent", { kind: t(d.kind || "invoice"), to: esc(d.to || "") });
    case "accepted": return `<b>${t("a_accepted", { name: esc(d.name || "") })}</b>`;
    case "reminder": return t(d.upcoming ? "a_reminder_soon" : d.auto ? "a_reminder_auto" : "a_reminder", { amt: money(d.amount || 0), to: esc(d.to || "") });
    case "repeated": return t("a_repeated", { code: esc(d.code || ""), d: fdate(d.start) });
    default: return esc(a.kind);
  }
}

/* ============ clients ============ */
function clientStats(c) {
  const ps = D().projects.filter(p => p.clientId === c.id);
  return {
    ps,
    billed: sum(ps.filter(p => p.status !== "lead"), p => p.fee),
    owed: sum(ps, p => projMoney(p).owed),
    overdue: sum(ps, p => projMoney(p).overdue),
  };
}
function clientsList() {
  const q = S.clientQ.trim().toLowerCase();
  const list = D().clients.filter(c => !q || [c.name, c.company, c.phone, c.email].some(s => String(s || "").toLowerCase().includes(q)));
  if (!D().clients.length) return empty(t("no_clients"), t("no_clients_hint"), `<button class="btn btn-primary" data-act="newClient">+ ${t("client")}</button>`);
  if (!list.length) return empty(t("no_match"), t("no_match_hint"));
  return `<div class="cgrid">${list.map(c => {
    const s = clientStats(c);
    return `<article class="cc">
      <div class="r1"><div class="avatar">${esc([...c.name][0] || "?")}</div><div style="min-width:0; flex:1"><a class="nm" href="#client/${c.id}">${esc(c.name)}</a>${c.company ? `<div class="hint">${esc(c.company)}</div>` : ""}</div>${badge("muted", c.lang === "ar" ? "ع" : "EN")}</div>
      ${c.phone ? `<span class="mono ltr hint">${esc(c.phone)}</span>` : ""}
      <div class="meta"><span>${t("projects_n", { n: s.ps.length })}</span><span>${t("billed")} <b class="mono">${money(s.billed)}</b></span>${s.owed ? `<span style="color:${s.overdue ? "var(--danger)" : "var(--amber)"}">${t("owes")} <b class="mono" style="color:inherit">${money(s.owed)}</b></span>` : ""}</div>
      <div class="foot">${c.phone ? `<a class="btn btn-wa btn-sm" href="${waLink(c.phone)}" target="_blank" rel="noopener">${I.wa}WhatsApp</a>` : ""}<button class="btn btn-ghost btn-sm" data-act="newProject" data-client="${c.id}">+ ${t("project")}</button><a class="btn btn-ghost btn-sm" href="#client/${c.id}">${t("open")}</a></div>
    </article>`;
  }).join("")}</div>`;
}
function clientsView() {
  return `<div class="toolbar"><h1>${t("nav_clients")}</h1>
      <input class="input grow" id="cq" type="search" placeholder="${t("search_clients")}" value="${esc(S.clientQ)}" aria-label="${t("search_clients")}">
      <button class="btn btn-primary" data-act="newClient">+ ${t("client")}</button></div>
    <div id="clist">${clientsList()}</div>`;
}
function clientView(id) {
  const c = C(id);
  if (!c) return empty(t("not_found"), t("not_found_hint"), `<a class="btn btn-ghost" href="#clients">${t("nav_clients")}</a>`);
  const s = clientStats(c);
  return `<a class="back" href="#clients">${I.back}${t("nav_clients")}</a>
    <section class="panel">
      <div class="panel-head">
        <div class="r1"><div class="avatar">${esc([...c.name][0] || "?")}</div><div><h1 style="font-size:22px">${esc(c.name)}</h1>${c.company ? `<div class="hint">${esc(c.company)}</div>` : ""}</div></div>
        <div class="acts">${c.phone ? `<a class="btn btn-wa btn-sm" href="${waLink(c.phone)}" target="_blank" rel="noopener">${I.wa}WhatsApp</a>` : ""}
          <button class="btn btn-ghost btn-sm" data-act="editClient" data-id="${c.id}">${t("edit")}</button>
          <button class="btn btn-danger btn-sm" data-act="delClient" data-id="${c.id}">${t("delete")}</button></div>
      </div>
      <div class="facts">
        <div class="fact"><span class="k">${t("f_phone")}</span><span class="v mono ltr">${esc(c.phone || "—")}</span></div>
        <div class="fact"><span class="k">${t("f_email")}</span><span class="v ltr" style="overflow-wrap:anywhere">${esc(c.email || "—")}</span></div>
        <div class="fact"><span class="k">${t("f_lang")}</span><span class="v">${c.lang === "ar" ? "العربية" : "English"}</span></div>
        <div class="fact"><span class="k">${t("billed")}</span><span class="v mono">${money(s.billed)}</span></div>
        <div class="fact"><span class="k">${t("owes")}</span><span class="v mono" style="color:${s.overdue ? "var(--danger)" : "inherit"}">${money(s.owed)}</span></div>
      </div>
      ${c.notes ? `<div style="white-space:pre-wrap; font-size:13.5px">${esc(c.notes)}</div>` : ""}
    </section>
    <div class="toolbar"><h2 style="font-size:18px">${t("projects_n", { n: s.ps.length })}</h2><button class="btn btn-primary btn-sm" data-act="newProject" data-client="${c.id}">+ ${t("new_project")}</button></div>
    <div class="list">${s.ps.sort(byPriority).map(prow).join("") || empty(t("no_projects"), t("client_no_projects"))}</div>`;
}

/* ============ calendar ============ */
/* Same rules as the server's calendar feed: sessions and due dates of open projects, open deliverables, unpaid payments. */
function calEvents() {
  const out = [];
  for (const p of D().projects) {
    if (!OPEN.includes(p.status)) continue;
    if (p.sessionAt) out.push({ date: p.sessionAt.slice(0, 10), time: p.sessionAt.slice(11, 16), kind: "session", p, label: p.title });
    if (p.dueDate) out.push({ date: p.dueDate, kind: p.dueDate < today() ? "late" : "due", p, label: p.title });
  }
  for (const d of D().deliverables) {
    const p = P(d.projectId);
    if (d.dueDate && !d.done && p && OPEN.includes(p.status)) out.push({ date: d.dueDate, kind: "deliverable", p, label: d.label });
  }
  for (const x of D().payments) {
    const p = P(x.projectId);
    if (x.dueDate && !x.paidAt && p && p.status !== "lead" && p.status !== "archived")
      out.push({ date: x.dueDate, kind: payState(x) === "overdue" ? "overdue" : "payment", p, label: money(x.amount) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time || "99").localeCompare(b.time || "99"));
}
const evChip = e => `<a class="ev ev-${e.kind}" href="#project/${e.p.id}" title="${esc(t("ev_" + e.kind))}: ${esc(e.p.title)}">${e.time ? `<b dir="ltr">${e.time}</b> ` : ""}${esc(e.label)}</a>`;

function calendarView() {
  const ym = S.calMonth, [y, m] = ym.split("-").map(Number);
  const first = new Date(y, m - 1, 1), daysIn = new Date(y, m, 0).getDate();
  const weekStart = S.lang === "ar" ? 6 : 1; // Saturday in Egypt, Monday otherwise
  const offset = (first.getDay() - weekStart + 7) % 7;
  const start = addDays(iso(first), -offset);
  const cells = Math.ceil((offset + daysIn) / 7) * 7;
  const evs = calEvents(), byDay = new Map();
  for (const e of evs) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
  const td = today();
  const heads = Array.from({ length: 7 }, (_, i) => `<div class="wd">${esc(fdate(addDays(start, i), S.lang, { weekday: "short" }))}</div>`).join("");
  const grid = Array.from({ length: cells }, (_, i) => {
    const d = addDays(start, i), list = byDay.get(d) || [];
    return `<div class="day ${d.slice(0, 7) !== ym ? "out" : ""} ${d === td ? "now" : ""}"><span class="dn">${Number(d.slice(8))}</span>
      ${list.slice(0, 3).map(evChip).join("")}${list.length > 3 ? `<span class="more">${t("more_n", { n: list.length - 3 })}</span>` : ""}</div>`;
  }).join("");
  const monthDays = [...byDay.keys()].filter(d => d.startsWith(ym));
  const agenda = monthDays.map(d => `<div class="agday ${d === td ? "now" : ""}"><div class="agd">${esc(fdate(d))}</div><div class="agl">${byDay.get(d).map(evChip).join("")}</div></div>`).join("");
  const legend = ["session", "due", "late", "deliverable", "payment", "overdue"].map(k => `<span class="lg"><i class="ev-${k}"></i>${t("ev_" + k)}</span>`).join("");
  return `
    <a class="back" href="#today">${I.back}${t("nav_today")}</a>
    <div class="toolbar"><h1>${t("calendar")}</h1>
      <div class="monthnav"><button class="icon-btn" data-act="calMonth" data-v="-1" aria-label="${t("prev_month")}">${S.lang === "ar" ? "›" : "‹"}</button><b>${esc(monthLabel(ym))}</b><button class="icon-btn" data-act="calMonth" data-v="1" aria-label="${t("next_month")}">${S.lang === "ar" ? "‹" : "›"}</button>
        <button class="btn btn-ghost btn-sm" data-act="calMonth" data-v="0">${t("this_month")}</button></div></div>
    <div class="legend">${legend}<a class="hint" href="#settings/calendar" style="margin-inline-start:auto">${t("cal_sync_link")}</a></div>
    <section class="panel cal-grid"><div class="cal">${heads}${grid}</div></section>
    <section class="panel cal-agenda">${agenda || empty(t("cal_empty"), t("cal_empty_hint"))}</section>`;
}

/* ============ money ============ */
function monthLabel(ym, lang = S.lang, short = false) {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(lang), short ? { month: "short" } : { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
}
function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function chart(month) {
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  const vals = months.map(ym => sum(D().payments.filter(x => x.paidAt && x.paidAt.startsWith(ym))));
  const max = Math.max(...vals, 1);
  const short = v => (v >= 10000 ? fmtNum(Math.round(v / 1000)) + "k" : fmtNum(v));
  return `<div class="bars" role="img" aria-label="${t("chart_label")}: ${months.map((ym, i) => `${monthLabel(ym)} ${money(vals[i])}`).join(", ")}">
    ${months.map((ym, i) => `<div class="col"><span class="v">${vals[i] ? short(vals[i]) : ""}</span><i class="b ${ym === month ? "cur" : ""}" style="height:calc((100% - 22px) * ${vals[i] / max})"></i></div>`).join("")}
  </div><div class="bars-l">${months.map(ym => `<span>${esc(monthLabel(ym, S.lang, true))}</span>`).join("")}</div>`;
}
function moneyView() {
  const M = S.money, ym = M.month;
  const pays = D().payments.filter(x => P(x.projectId)?.status !== "lead");
  const received = sum(pays.filter(x => x.paidAt?.startsWith(ym)));
  const expected = sum(pays.filter(x => !x.paidAt && x.dueDate?.startsWith(ym)));
  const owed = sum(D().projects, p => projMoney(p).owed), overdue = sum(D().projects, p => projMoney(p).overdue);
  let list = M.state === "overdue"
    ? pays.filter(x => payState(x) === "overdue")
    : pays.filter(x => (x.paidAt ? x.paidAt.startsWith(ym) : x.dueDate?.startsWith(ym)));
  if (M.state === "paid") list = list.filter(x => x.paidAt);
  if (M.state === "due") list = list.filter(x => !x.paidAt);
  if (M.method !== "all") list = list.filter(x => x.method === M.method);
  list.sort((a, b) => (b.paidAt || b.dueDate || "").localeCompare(a.paidAt || a.dueDate || ""));
  const rows = list.map(x => {
    const p = P(x.projectId), c = clientOf(p);
    return `<div class="ri"><div class="txt"><a href="#project/${p.id}">${esc(p.title)}</a><span class="hint">${c ? esc(c.name) + " · " : ""}${esc(payLabel(x))} · ${x.paidAt ? t("paid_on", { d: fdate(x.paidAt) }) + (x.method ? " · " + t("m_" + x.method) : "") : `${t("due")} ${fdate(x.dueDate)}`}</span></div>
      <span class="amt">${money(x.amount)}</span>${payBadge(x)}
      ${x.paidAt ? "" : `<div class="acts">${waBtn(p.id, "reminder")}${canEmailReminder(x, p) ? remindBtn(x) : ""}<button class="btn btn-ghost btn-sm" data-act="markPaid" data-id="${x.id}">${t("mark_paid")}</button></div>`}</div>`;
  }).join("");
  return `
    <div class="toolbar"><h1>${t("nav_money")}</h1>
      <div class="monthnav"><button class="icon-btn" data-act="month" data-v="-1" aria-label="${t("prev_month")}">${S.lang === "ar" ? "›" : "‹"}</button><b>${esc(monthLabel(ym))}</b><button class="icon-btn" data-act="month" data-v="1" aria-label="${t("next_month")}">${S.lang === "ar" ? "‹" : "›"}</button></div></div>
    <div class="kpis">
      ${kpi(moneyHtml(received), t("k_received"), "good")}
      ${kpi(moneyHtml(expected), t("k_expected"), expected ? "warn" : "")}
      ${kpi(moneyHtml(owed), t("k_owed"))}
      ${kpi(moneyHtml(overdue), t("k_overdue"), overdue ? "bad" : "")}
    </div>
    <section class="panel"><div class="panel-head"><h2>${t("last6")}</h2><span class="hint">${t("received_per_month")}</span></div>${chart(ym)}</section>
    <section class="panel">
      <div class="panel-head"><h2>${t("payments")}</h2>
        <div class="chips">${["all", "paid", "due", "overdue"].map(s => `<button class="chip" data-act="moneyState" data-v="${s}" aria-pressed="${M.state === s}">${t(s === "all" ? "f_all" : "ps_" + s)}</button>`).join("")}
          <select class="input" id="mMethod" style="width:auto; padding-block:4px" aria-label="${t("f_method")}"><option value="all">${t("all_methods")}</option>${METHODS.map(m => `<option value="${m}" ${M.method === m ? "selected" : ""}>${t("m_" + m)}</option>`).join("")}</select></div></div>
      ${M.state === "overdue" ? `<span class="hint">${t("overdue_any_month")}</span>` : ""}
      ${rows ? `<div class="rows">${rows}</div>` : empty(t("no_payments_month"), t("no_payments_month_hint"))}
    </section>`;
}

/* ============ settings ============ */
function settingsView() {
  const me = D().me, k = S.tplKind;
  const tplField = lang => `<div class="field"><label for="tpl_${lang}">${lang === "ar" ? "العربية" : "English"}</label>
    <textarea id="tpl_${lang}" name="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}" rows="7" maxlength="2000">${esc(me.templates?.[k]?.[lang] || TEMPLATES[lang][k])}</textarea></div>`;
  return `<div class="toolbar"><h1>${t("nav_settings")}</h1></div>
    <div class="split">
      <div class="stack">
        <section class="panel style-card"><div><h2 style="font-size:16px">${t("style_title")}</h2><span class="hint">${t("style_card_hint")}</span></div>
          <a class="btn btn-primary" href="#style">${t("customize")}</a></section>
        <section class="panel"><h2 style="font-size:16px">${t("profile")}</h2>
          <form data-form="profile">
            <div class="grid2"><div class="field req"><label for="sName">${t("f_name")}</label><input id="sName" name="name" required maxlength="120" value="${esc(me.name)}"></div>
              <div class="field"><label for="sBiz">${t("f_business")}</label><input id="sBiz" name="business" maxlength="120" value="${esc(me.business)}"></div></div>
            <div class="field"><label for="sPhone">${t("f_my_phone")}</label><input id="sPhone" name="phone" class="mono ltr" inputmode="tel" maxlength="40" value="${esc(me.phone)}"></div>
            <div class="grid2"><div class="field"><label for="sInsta">${t("f_instapay")}</label><input id="sInsta" name="instapay" class="mono ltr" maxlength="120" value="${esc(me.instapay)}" placeholder="name@instapay"></div>
              <div class="field"><label for="sVcash">${t("f_vcash")}</label><input id="sVcash" name="vcash" class="mono ltr" maxlength="40" value="${esc(me.vcash)}" placeholder="010…"></div></div>
            <span class="hint">${t("pay_details_hint")}</span>
            <div><button class="btn btn-primary" type="submit">${t("save")}</button></div>
          </form></section>
        <section class="panel"><h2 style="font-size:16px">${t("templates")}</h2>
          <div class="chips">${["quote", "delivery", "reminder", "thanks", "document"].map(x => `<button class="chip" data-act="tplKind" data-v="${x}" aria-pressed="${k === x}">${t("tk_" + x)}</button>`).join("")}</div>
          <form data-form="templates" data-kind="${k}">
            <div class="grid2">${tplField("ar")}${tplField("en")}</div>
            <span class="hint">${t("tpl_hint")}</span>
            <div class="acts"><button class="btn btn-primary" type="submit">${t("save")}</button><button class="btn btn-ghost" type="button" data-act="tplReset" data-v="${k}">${t("reset_default")}</button></div>
          </form></section>
      </div>
      <div class="stack">
        <section class="panel"><h2 style="font-size:16px">${t("prefs")}</h2>
          <div class="field"><span class="lbl">${t("f_lang")}</span><div class="seg"><button type="button" data-act="setLang" data-v="ar" aria-pressed="${S.lang === "ar"}">العربية</button><button type="button" data-act="setLang" data-v="en" aria-pressed="${S.lang === "en"}">English</button></div></div>
          <form data-form="defaults">
            <div class="grid3">
              <div class="field"><label for="sCur">${t("f_currency")}</label><select id="sCur" name="currency">${["EGP", "USD", "EUR", "SAR", "AED", "KWD", "QAR", "GBP"].map(c => `<option value="${c}" ${me.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
              <div class="field"><label for="sDep">${t("f_depositPct")}</label><input id="sDep" name="depositPct" type="number" min="0" max="100" value="${me.depositPct}"></div>
              <div class="field"><label for="sRev">${t("f_revisionsAllowed")}</label><input id="sRev" name="revisions" type="number" min="0" max="50" value="${me.revisions}"></div>
              <div class="field"><label for="sTax">${t("f_taxRate")}</label><input id="sTax" name="taxRate" type="number" min="0" max="100" step="0.01" value="${me.taxRate || 0}"><span class="hint">${t("tax_default_hint")}</span></div>
            </div>
            <div><button class="btn btn-primary" type="submit">${t("save")}</button></div>
          </form></section>
        ${remindersPanel()}
        ${calendarPanel()}
        <section class="panel"><h2 style="font-size:16px">${t("your_data")}</h2>
          <span class="hint">${t("data_hint")}</span>
          <div class="acts"><a class="btn btn-ghost" href="/api/export" download>${t("export")}</a>
            <label class="btn btn-ghost" for="importFile">${t("import")}</label><input type="file" id="importFile" accept="application/json,.json" hidden></div>
        </section>
        <section class="panel"><h2 style="font-size:16px">${t("account")}</h2>
          <span class="hint">${t("signed_in_as")} <b class="ltr" style="color:var(--ink)">${esc(me.email)}</b></span>
          <form data-form="password">
            <div class="grid2"><div class="field"><label for="pCur">${t("current_password")}</label><input id="pCur" name="current" type="password" required autocomplete="current-password"></div>
              <div class="field"><label for="pNew">${t("new_password")}</label><input id="pNew" name="next" type="password" minlength="8" required autocomplete="new-password"></div></div>
            <div><button class="btn btn-ghost" type="submit">${t("change_password")}</button></div>
          </form>
          <div class="acts" style="padding-top:8px; border-top:1px solid var(--line)"><button class="btn btn-ghost" data-act="logout">${t("logout")}</button><button class="btn btn-danger" data-act="delAccount">${t("delete_account")}</button></div>
        </section>
      </div>
    </div>`;
}

function remindersPanel() {
  const me = D().me, r = normalizeReminders(me.reminders);
  const num = (name, lo, hi, label) => `<div class="field"><label for="r_${name}">${label}</label><input id="r_${name}" class="mono" name="${name}" type="number" min="${lo}" max="${hi}" value="${r[name]}"></div>`;
  return `<section class="panel"><h2 style="font-size:16px">${t("reminders")}</h2>
    ${me.mailReady ? "" : `<div class="banner warn"><span>${t("reminders_need_email")}</span></div>`}
    <form data-form="reminders">
      <label class="check"><input type="checkbox" name="digest" ${r.digest ? "checked" : ""}><span>${t("rem_digest")}</span></label>
      <label class="check"><input type="checkbox" name="clients" ${r.clients ? "checked" : ""}><span>${t("rem_clients")}</span></label>
      <div class="grid2">${num("before", 0, 14, t("rem_before"))}${num("after", 0, 60, t("rem_after"))}${num("every", 1, 60, t("rem_every"))}${num("max", 1, 10, t("rem_max"))}</div>
      <span class="hint">${t("rem_hint")}</span>
      <div><button class="btn btn-primary" type="submit">${t("save")}</button></div>
    </form></section>`;
}

function calendarPanel() {
  const me = D().me, g = me.google || {};
  const feed = me.calToken ? `${location.origin}/cal/${me.calToken}.ics` : "";
  const googleBlock = !g.available
    ? `<span class="hint">${t("gcal_unavailable")}</span>`
    : g.connected
      ? `<div class="r1">${badge(g.lastError ? "bad" : "good", g.lastError ? t("gcal_err_" + g.lastError) : t("gcal_connected"))}
           ${g.lastSync ? `<span class="hint">${t("gcal_last_sync", { when: fdate(g.lastSync.slice(0, 10)) + " " + new Date(g.lastSync).toTimeString().slice(0, 5) })}</span>` : ""}</div>
         <span class="hint">${t("gcal_connected_hint")}</span>
         <div class="acts">${g.lastError === "revoked" ? `<a class="btn btn-primary btn-sm" href="/api/google/connect?tz=${encodeURIComponent(userTz())}">${t("gcal_reconnect")}</a>` : `<button class="btn btn-ghost btn-sm" data-act="gSync">${t("gcal_sync_now")}</button>`}
           <button class="btn btn-danger btn-sm" data-act="gDisconnect">${t("gcal_disconnect")}</button></div>`
      : `<span class="hint">${t("gcal_hint")}</span>
         <div><a class="btn btn-primary" href="/api/google/connect?tz=${encodeURIComponent(userTz())}">${t("gcal_connect")}</a></div>`;
  return `<section class="panel" id="calendar-settings"><h2 style="font-size:16px">${t("calendar")}</h2>
    <div class="field"><span class="lbl">Google Calendar</span>${googleBlock}</div>
    <div class="field" style="padding-top:10px; border-top:1px solid var(--line)"><span class="lbl">${t("feed_title")}</span>
      <span class="hint">${t("feed_hint")}</span>
      ${feed ? `<input class="input mono ltr" id="feedUrl" readonly value="${esc(feed)}" aria-label="${t("feed_title")}">
        <div class="acts"><button class="btn btn-ghost btn-sm" data-act="copyFeed">${t("copy")}</button>
          <a class="btn btn-ghost btn-sm" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feed.replace(/^https?:/, "webcal:"))}" target="_blank" rel="noopener">${t("feed_google")} ↗</a>
          <a class="btn btn-ghost btn-sm" href="${esc(feed.replace(/^https?:/, "webcal:"))}">${t("feed_apple")}</a>
          <button class="btn btn-danger btn-sm" data-act="feedOff">${t("feed_off")}</button></div>
        <span class="hint">${t("feed_private")}</span>`
      : `<div><button class="btn btn-ghost" data-act="feedOn">${t("feed_on")}</button></div>`}
    </div>
  </section>`;
}

/* ============ invoice / quote ============ */
/* ============ branded documents ============ */
const docFor = p => docData({ project: p, client: clientOf(p), payments: paysOf(p.id), deliverables: delsOf(p.id), items: itemsOf(p.id), me: D().me, today: today() });
const logoUrl = () => (D().me.logoVersion ? `/api/me/logo?v=${D().me.logoVersion}` : "");
const shareUrl = (p, lang) => `${location.origin}/d/${p.shareToken}?lang=${lang}`;
const langSeg = (act, cur, extra = "") => `<div class="seg">${["ar", "en"].map(l => `<button type="button" data-act="${act}" data-v="${l}" ${extra} aria-pressed="${cur === l}">${l === "ar" ? "العربية" : "English"}</button>`).join("")}</div>`;

function invoiceView(id) {
  const p = P(id);
  if (!p) return empty(t("not_found"), t("not_found_hint"));
  const d = docFor(p), L = S.invLang || d.lang;
  return `<div class="toolbar noprint"><a class="back" href="#project/${p.id}">${I.back}${esc(p.title)}</a>
      <div class="acts">${langSeg("invLang", L)}
        <a class="btn btn-ghost btn-sm" href="#style">${t("edit_style")}</a>
        <button class="btn btn-ghost btn-sm" data-act="print">${t("print")}</button>
        <button class="btn btn-primary btn-sm" data-act="sendDoc" data-id="${p.id}">${t(d.kind === "quote" ? "send_quote" : "send_invoice")}</button></div></div>
    ${p.shareToken ? `<div class="banner ok noprint"><span>${t("doc_shared")}</span><a class="btn btn-ghost btn-sm" href="${esc(shareUrl(p, L))}" target="_blank" rel="noopener">${t("preview_link")} ↗</a></div>` : ""}
    ${renderDoc(d, { tl, lang: L, logoUrl: logoUrl() })}`;
}

async function sendDocModal(pid) {
  if (!P(pid).shareToken && !await mutate("POST", `/projects/${pid}/share`, {})) return;
  const p = P(pid), c = clientOf(p), d = docFor(p), me = D().me;
  const L = S.invLang || d.lang, link = shareUrl(p, L);
  const subject = `${tl(L, d.kind)} ${p.code} · ${me.business || me.name}`;
  const mailBody = fillTemplate("document", p, { link, lang: L });
  openModal(`${mhead(t(d.kind === "quote" ? "send_quote" : "send_invoice"))}
    <div class="field"><span class="lbl">${t("doc_lang")}</span>${langSeg("sendLang", L, `data-id="${p.id}"`)}</div>
    <div class="field"><label for="shareUrl">${t("doc_link")}</label>
      <div class="addrow" style="flex-direction:row"><input class="input mono ltr" id="shareUrl" readonly value="${esc(link)}"><button type="button" class="btn btn-ghost" data-act="copyShare">${t("copy")}</button></div>
      <span class="hint">${t("doc_link_hint")} <button type="button" class="linkish" data-act="unshare" data-id="${p.id}">${t("stop_sharing")}</button></span></div>
    <div class="sendgrid">
      <button type="button" class="btn btn-wa" data-act="msg" data-id="${p.id}" data-kind="document" data-link="${esc(link)}" data-lang="${L}">${I.wa}${t("send_wa")}</button>
      ${me.mailReady
        ? `<button type="button" class="btn btn-ghost" data-act="emailDoc" data-id="${p.id}">${t("send_email")}</button>`
        : `<a class="btn btn-ghost" href="mailto:${encodeURIComponent(c?.email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody)}">${t("send_email")}</a>`}
      <a class="btn btn-ghost" href="${esc(link)}" target="_blank" rel="noopener">${t("preview_link")} ↗</a>
    </div>`);
}

function emailDocForm(pid) {
  const p = P(pid), c = clientOf(p), d = docFor(p), L = S.invLang || d.lang;
  openModal(`${mhead(t("send_email"))}
    <form data-form="emailDoc" data-id="${p.id}" data-lang="${L}">
      <div class="field req"><label for="eTo">${t("email_to")}</label><input id="eTo" name="to" type="email" required class="ltr" value="${esc(c?.email)}"></div>
      <div class="field"><label for="eNote">${t("email_note")}</label><textarea id="eNote" name="message" maxlength="2000" dir="${L === "ar" ? "rtl" : "ltr"}" placeholder="${esc(tl(L, "email_note_ph"))}"></textarea></div>
      <span class="hint">${t("email_hint", { kind: tl(L, d.kind), lang: L === "ar" ? "العربية" : "English" })}</span>
      ${mfoot(t("send"))}
    </form>`);
}

/* ============ your style ============ */
function brandFromForm(o) {
  return {
    color: o.color, layout: o.layout, font: o.font, accent: o.accent, address: o.address, website: o.website, taxId: o.taxId,
    showPay: !!o.showPay, footer: { ar: o.footer_ar || "", en: o.footer_en || "" }, intro: { ar: o.intro_ar || "", en: o.intro_en || "" },
  };
}
/* The document the style page previews: the user's busiest real project, or a sample, with the unsaved form applied. */
function previewDoc() {
  const form = $("#styleForm"), L = S.styleLang || S.lang;
  const me = { ...D().me };
  if (form) { const o = formObj(form); me.brand = brandFromForm(o); me.business = o.business; }
  const p = D().projects.filter(x => x.status !== "archived" && x.fee > 0).sort(byPriority)[0];
  const d = p ? docData({ project: p, client: clientOf(p), payments: paysOf(p.id), deliverables: delsOf(p.id), items: itemsOf(p.id), me, today: today() }) : sampleDoc(me, L, today());
  return { d, L };
}
function stylePreviewHtml() {
  const { d, L } = previewDoc();
  return renderDoc(d, { tl, lang: L, logoUrl: logoUrl() });
}
const thumbHtml = (d, L, layout) => renderDoc({ ...d, brand: { ...d.brand, layout } }, { tl, lang: L, logoUrl: logoUrl() });
function styleView() {
  const me = D().me, b = normalizeBrand(me.brand), lv = me.logoVersion;
  const FONT_FACE = { modern: "Alexandria", clean: "Readex Pro", elegant: "El Messiri" };
  const ta = (l, v, kind = "footer") => `<div class="field"><label for="b${kind}_${l}">${l === "ar" ? "العربية" : "English"}</label><textarea id="b${kind}_${l}" name="${kind}_${l}" dir="${l === "ar" ? "rtl" : "ltr"}" maxlength="${kind === "intro" ? 1200 : 600}" rows="3" placeholder="${esc(tl(l, kind + "_ph"))}">${esc(v)}</textarea></div>`;
  return `<a class="back" href="#settings">${I.back}${t("nav_settings")}</a>
    <div class="toolbar"><div><h1>${t("style_title")}</h1><span class="hint">${t("style_hint")}</span></div></div>
    <div class="style-layout">
      <form data-form="style" class="panel" id="styleForm">
        <div class="field"><span class="lbl">${t("logo")}</span>
          <div class="logo-row"><div class="logo-box">${lv ? `<img src="${logoUrl()}" alt="${t("logo")}">` : `<span>${t("no_logo")}</span>`}</div>
            <div class="acts"><label class="btn btn-ghost btn-sm" for="logoFile">${lv ? t("change_logo") : t("upload_logo")}</label>
              <input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" hidden>
              ${lv ? `<button type="button" class="btn btn-danger btn-sm" data-act="logoRemove">${t("remove")}</button>` : ""}</div></div>
          <span class="hint">${t("logo_hint")}</span></div>
        <div class="field"><span class="lbl">${t("brand_color")}</span>
          <div class="swatches">${BRAND_COLORS.map(c => `<button type="button" class="swatch" data-act="pickColor" data-v="${c}" style="--c:${c}" aria-label="${c}" aria-pressed="${b.color.toLowerCase() === c.toLowerCase()}"></button>`).join("")}
            <label class="swatch custom" title="${t("custom_color")}"><input type="color" id="bColor" name="color" value="${b.color}" aria-label="${t("custom_color")}"></label></div></div>
        <fieldset class="field tpl-field"><legend class="lbl">${t("layout")}</legend>
          <div class="tpl-gallery">${LAYOUTS.map(l => `<label class="tpl"><input type="radio" name="layout" value="${l}" ${b.layout === l ? "checked" : ""}>
            <span class="tpl-view" aria-hidden="true"><span class="tpl-doc" data-layout="${l}">${thumbHtml(previewDoc().d, S.styleLang || S.lang, l)}</span></span>
            <span class="tpl-name">${t("layout_" + l)}</span></label>`).join("")}</div></fieldset>
        <div class="field"><span class="lbl">${t("accent")}</span>
          <div class="seg">${ACCENTS.map(a => `<button type="button" data-act="segPick" data-target="bAccent" data-v="${a}" aria-pressed="${b.accent === a}">${t("accent_" + a)}</button>`).join("")}</div>
          <input type="hidden" id="bAccent" name="accent" value="${b.accent}"></div>
        <div class="field"><span class="lbl">${t("font")}</span>
          <div class="seg">${FONTS.map(f => `<button type="button" data-act="segPick" data-target="bFont" data-v="${f}" aria-pressed="${b.font === f}" style="font-family:'${FONT_FACE[f]}'">${t("font_" + f)}</button>`).join("")}</div>
          <input type="hidden" id="bFont" name="font" value="${b.font}"></div>
        <div class="grid2">
          <div class="field"><label for="bBiz">${t("f_business")}</label><input id="bBiz" name="business" maxlength="120" value="${esc(me.business)}" placeholder="${esc(me.name)}"></div>
          <div class="field"><label for="bWeb">${t("f_website")}</label><input id="bWeb" name="website" class="ltr" maxlength="200" value="${esc(b.website)}" placeholder="studio.com"></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="bAddr">${t("f_address")}</label><input id="bAddr" name="address" maxlength="200" value="${esc(b.address)}"></div>
          <div class="field"><label for="bTax">${t("f_taxId")}</label><input id="bTax" name="taxId" class="ltr" maxlength="60" value="${esc(b.taxId)}"></div>
        </div>
        <label class="check"><input type="checkbox" name="showPay" ${b.showPay ? "checked" : ""}><span>${t("show_pay")}</span></label>
        <div class="field"><span class="lbl">${t("intro_note")}</span><div class="grid2">${ta("ar", b.intro.ar, "intro")}${ta("en", b.intro.en, "intro")}</div><span class="hint">${t("intro_hint")}</span></div>
        <div class="field"><span class="lbl">${t("footer_note")}</span><div class="grid2">${ta("ar", b.footer.ar)}${ta("en", b.footer.en)}</div></div>
        <div class="acts"><button type="submit" class="btn btn-primary">${t("save_style")}</button></div>
      </form>
      <div class="style-preview">
        <div class="toolbar"><span class="lbl">${t("preview")}</span>${langSeg("styleLang", S.styleLang || S.lang)}</div>
        <div id="stylePreview">${stylePreviewHtml()}</div>
      </div>
    </div>`;
}
/* Re-draws the big preview and, unless only the layout changed, the gallery thumbnails (inputs stay, so focus isn't lost). */
function refreshPreview(withGallery = true) {
  const el = $("#stylePreview");
  if (!el) return;
  el.innerHTML = stylePreviewHtml();
  if (!withGallery) return;
  const { d, L } = previewDoc();
  document.querySelectorAll(".tpl-doc[data-layout]").forEach(t => { t.innerHTML = thumbHtml(d, L, t.dataset.layout); });
}

/* Logos are scaled to at most 600px in the browser, so uploads stay small whatever the original size. */
async function logoDataUrl(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("logo_type");
  const img = await createImageBitmap(file);
  const k = Math.min(1, 600 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  let url = c.toDataURL("image/png");
  if (url.length > 500000) url = c.toDataURL("image/webp", 0.9);
  if (url.length > 500000) url = c.toDataURL("image/jpeg", 0.85); // last resort; drops transparency
  return url;
}

/* ============ modals ============ */
function openModal(html) {
  $("#modal").innerHTML = html;
  $("#overlay").hidden = false;
  const f = $("#modal").querySelector("[autofocus], input:not([type=hidden]):not([type=checkbox]), textarea, select");
  if (f && matchMedia("(min-width:640px)").matches) f.focus();
}
function closeModal() { $("#overlay").hidden = true; $("#modal").innerHTML = ""; S.confirm = null; }
const mhead = title => `<div class="modal-head"><h2>${esc(title)}</h2><button class="close" type="button" data-act="close" aria-label="${t("close")}">✕</button></div>`;
const mfoot = (label, extra = "") => `<div class="modal-actions"><button class="btn btn-primary" type="submit">${esc(label)}</button><button class="btn btn-ghost" type="button" data-act="close">${t("cancel")}</button>${extra}</div>`;

function confirmBox(msg, yesLabel, onYes, extra = "") {
  S.confirm = onYes;
  openModal(`${mhead(t("are_you_sure"))}<p>${esc(msg)}</p>${extra}
    <div class="modal-actions"><button class="btn btn-danger" data-act="confirmYes">${esc(yesLabel)}</button><button class="btn btn-ghost" data-act="close">${t("cancel")}</button></div>`);
}

function projectForm(id, { clientId } = {}) {
  const p = id ? P(id) : null, me = D().me;
  const cid = p ? p.clientId : clientId;
  openModal(`${mhead(p ? t("edit_project") : t("new_project"))}
    <form data-form="project" data-id="${p?.id || ""}">
      <div class="field req"><label for="pTitle">${t("f_title")}</label><input id="pTitle" name="title" required maxlength="160" value="${esc(p?.title)}" placeholder="${t("title_ph")}"></div>
      <div class="grid2">
        <div class="field"><label for="pClient">${t("client")}</label><select id="pClient" name="clientId"><option value="">${t("no_client")}</option>${D().clients.map(c => `<option value="${c.id}" ${cid === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
          <button type="button" class="linkish hint" data-act="newClient" data-then="project" style="align-self:flex-start">+ ${t("new_client")}</button></div>
        <div class="field"><label for="pType">${t("f_type")}</label><input id="pType" name="type" maxlength="60" list="types" value="${esc(p?.type)}"><datalist id="types">${TYPES[S.lang].map(x => `<option value="${esc(x)}">`).join("")}</datalist></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="pStage">${t("f_status")}</label><select id="pStage" name="status">${STATUSES.map(x => `<option value="${x}" ${(p?.status || "lead") === x ? "selected" : ""}>${t("st_" + x)}</option>`).join("")}</select></div>
        <div class="field"><label for="pSession">${t("f_sessionAt")}</label><input id="pSession" name="sessionAt" type="datetime-local" value="${p?.sessionAt || ""}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="pStart">${t("f_startDate")}</label><input id="pStart" name="startDate" type="date" value="${p ? p.startDate || "" : today()}"></div>
        <div class="field"><label for="pDue">${t("f_dueDate")}</label><input id="pDue" name="dueDate" type="date" value="${p?.dueDate || ""}"></div>
      </div>
      <div class="field"><label for="pFolder">${t("f_folderUrl")}</label><input id="pFolder" name="folderUrl" type="url" class="ltr" maxlength="1000" value="${esc(p?.folderUrl)}" placeholder="https://drive.google.com/drive/folders/…"></div>
      <div class="grid3">
        <div class="field"><label for="pFee">${t("f_fee")} (${esc(t("cur_" + me.currency))})</label><input id="pFee" name="fee" type="number" min="0" step="0.01" inputmode="decimal" class="mono" value="${p ? p.fee : ""}" ${p && itemsOf(p.id).length ? `readonly title="${t("fee_from_items")}"` : ""}></div>
        ${p ? "" : `<div class="field"><label for="pDep">${t("f_depositPct")}</label><input id="pDep" name="depositPct" type="number" min="0" max="100" value="${me.depositPct}"></div>`}
        <div class="field"><label for="pRev">${t("f_revisionsAllowed")}</label><input id="pRev" name="revisionsAllowed" type="number" min="0" max="50" value="${p ? p.revisionsAllowed : me.revisions}"></div>
      </div>
      <span class="hint">${t(p ? "fee_edit_hint" : "new_project_hint")}</span>
      <div class="grid2">
        <div class="field"><label for="pRepeat">${t("f_repeat")}</label><select id="pRepeat" name="repeat"><option value="">${t("repeat_none")}</option>${REPEATS.map(r => `<option value="${r}" ${p?.repeat === r ? "selected" : ""}>${t("repeat_" + r)}</option>`).join("")}</select></div>
        <div class="field"><label for="pUntil">${t("f_repeatUntil")}</label><input id="pUntil" name="repeatUntil" type="date" value="${p?.repeatUntil || ""}"></div>
      </div>
      <span class="hint">${t("repeat_hint")}</span>
      <label class="check"><input type="checkbox" name="noReminders" ${p?.noReminders ? "checked" : ""}><span>${t("no_reminders")}</span></label>
      <div class="field"><label for="pNotes">${t("f_notes")}</label><textarea id="pNotes" name="notes" maxlength="8000">${esc(p?.notes)}</textarea></div>
      ${mfoot(p ? t("save") : t("create_project"))}
    </form>`);
}

function clientForm(id, { then } = {}) {
  const c = id ? C(id) : null;
  openModal(`${mhead(c ? t("edit_client") : t("new_client"))}
    <form data-form="client" data-id="${c?.id || ""}" data-then="${then || ""}">
      <div class="field req"><label for="cName">${t("f_name")}</label><input id="cName" name="name" required maxlength="120" value="${esc(c?.name)}"></div>
      <div class="grid2">
        <div class="field"><label for="cPhone">${t("f_phone")}</label><input id="cPhone" name="phone" inputmode="tel" class="mono ltr" maxlength="40" value="${esc(c?.phone)}" placeholder="01XXXXXXXXX / +44…"></div>
        <div class="field"><label for="cEmail">${t("f_email")}</label><input id="cEmail" name="email" type="email" class="ltr" maxlength="160" value="${esc(c?.email)}"></div>
      </div>
      <div class="field"><label for="cCompany">${t("f_company")}</label><input id="cCompany" name="company" maxlength="120" value="${esc(c?.company)}"></div>
      <div class="field"><span class="lbl">${t("f_client_lang")}</span>
        <div class="seg"><button type="button" data-act="segPick" data-target="cLang" data-v="ar" aria-pressed="${(c?.lang || S.lang) === "ar"}">العربية</button><button type="button" data-act="segPick" data-target="cLang" data-v="en" aria-pressed="${(c?.lang || S.lang) === "en"}">English</button></div>
        <input type="hidden" id="cLang" name="lang" value="${c?.lang || S.lang}"></div>
      <div class="field"><label for="cNotes">${t("f_notes")}</label><textarea id="cNotes" name="notes" maxlength="4000">${esc(c?.notes)}</textarea></div>
      ${mfoot(c ? t("save") : t("add_client"))}
    </form>`);
}

function paymentForm(id, { projectId, amount } = {}) {
  const x = id ? D().payments.find(y => y.id === id) : null;
  const pid = x ? x.projectId : projectId;
  openModal(`${mhead(x ? t("edit_payment") : t("add_payment"))}
    <form data-form="payment" data-id="${x?.id || ""}" data-project="${pid}">
      <div class="grid2">
        <div class="field"><label for="yKind">${t("f_kind")}</label><select id="yKind" name="kind">${["deposit", "balance", "extra"].map(k => `<option value="${k}" ${(x?.kind || "extra") === k ? "selected" : ""}>${t("pk_" + k)}</option>`).join("")}</select></div>
        <div class="field"><label for="yLabel">${t("f_label")}</label><input id="yLabel" name="label" maxlength="120" value="${esc(x?.label)}" placeholder="${t("label_ph")}"></div>
      </div>
      <div class="grid2">
        <div class="field req"><label for="yAmt">${t("amount")}</label><input id="yAmt" name="amount" type="number" min="0" step="0.01" inputmode="decimal" class="mono" required value="${x ? x.amount : amount ?? ""}"></div>
        <div class="field"><label for="yDue">${t("f_dueDate")}</label><input id="yDue" name="dueDate" type="date" value="${x?.dueDate || ""}"></div>
      </div>
      <div class="grid3">
        <div class="field"><label for="yPaid">${t("f_paidAt")}</label><input id="yPaid" name="paidAt" type="date" value="${x?.paidAt || ""}"></div>
        <div class="field"><label for="yMethod">${t("f_method")}</label><select id="yMethod" name="method"><option value="">—</option>${METHODS.map(m => `<option value="${m}" ${x?.method === m ? "selected" : ""}>${t("m_" + m)}</option>`).join("")}</select></div>
        <div class="field"><label for="yRef">${t("f_ref")}</label><input id="yRef" name="ref" class="mono ltr" maxlength="80" value="${esc(x?.ref)}"></div>
      </div>
      <span class="hint">${t("paid_blank_hint")}</span>
      ${mfoot(x ? t("save") : t("add_payment"), x ? `<button class="btn btn-danger" type="button" data-act="delPay" data-id="${x.id}" style="margin-inline-start:auto">${t("delete")}</button>` : "")}
    </form>`);
}

function markPaidForm(id) {
  const x = D().payments.find(y => y.id === id), p = P(x.projectId);
  openModal(`${mhead(t("log_payment"))}
    <p class="hint">${esc(p.title)} · ${esc(payLabel(x))}</p>
    <form data-form="markPaid" data-id="${x.id}">
      <div class="grid2">
        <div class="field req"><label for="mAmt">${t("amount")}</label><input id="mAmt" name="amount" type="number" min="0" step="0.01" inputmode="decimal" class="mono" required value="${x.amount}"></div>
        <div class="field req"><label for="mDate">${t("f_paidAt")}</label><input id="mDate" name="paidAt" type="date" required value="${today()}"></div>
      </div>
      <div class="field"><span class="lbl">${t("f_method")}</span>
        <div class="seg">${METHODS.map((m, i) => `<button type="button" data-act="segPick" data-target="mMethodIn" data-v="${m}" aria-pressed="${i === 0}">${t("m_" + m)}</button>`).join("")}</div>
        <input type="hidden" id="mMethodIn" name="method" value="instapay"></div>
      <div class="field"><label for="mRef">${t("f_ref")}</label><input id="mRef" name="ref" class="mono ltr" maxlength="80" placeholder="${t("ref_ph")}"></div>
      ${clientOf(p)?.phone ? `<label class="check"><input type="checkbox" name="thank"><span>${t("send_thanks")}</span></label>` : ""}
      ${mfoot(t("mark_paid"))}
    </form>`);
}

function versionForm(id, plainLink = false) {
  const p = P(id);
  const n = p.links.length + 1;
  openModal(`${mhead(plainLink ? t("add_link") : t("send_version"))}
    ${plainLink ? "" : `<p class="hint">${t("send_version_hint")}</p>`}
    <form data-form="version" data-id="${p.id}" data-plain="${plainLink ? 1 : ""}">
      <div class="field req"><label for="vUrl">${t("f_link")}</label><input id="vUrl" name="url" type="url" required class="ltr" placeholder="https://drive.google.com/…"></div>
      <div class="field"><label for="vLabel">${t("f_label")}</label><input id="vLabel" name="label" maxlength="80" value="${plainLink ? "" : esc(t("version_n", { n }))}"></div>
      ${plainLink ? "" : `<label class="check"><input type="checkbox" name="wa" checked><span>${t("open_wa_after")}</span></label>`}
      ${mfoot(plainLink ? t("add") : t("send_version"))}
    </form>`);
}

function msgModal(pid, kind, extra = {}) {
  const p = P(pid), c = clientOf(p);
  kind = kind || defaultKind(p);
  if (kind === "document" && !extra.link && p.shareToken) extra = { link: shareUrl(p, c?.lang || S.lang) };
  const text = fillTemplate(kind, p, extra);
  openModal(`${mhead(t("wa_client"))}
    <div class="chips">${["quote", "delivery", "reminder", "thanks", "document"].map(k => `<button class="chip" data-act="msgKind" data-id="${p.id}" data-v="${k}" aria-pressed="${k === kind}">${t("tk_" + k)}</button>`).join("")}</div>
    <div class="hint">${c ? `${t("to")} <b style="color:var(--ink)">${esc(c.name)}</b>${c.phone ? ` · <span class="mono ltr">${esc(c.phone)}</span>` : ` · ${t("no_phone")}`} · ${c.lang === "ar" ? "العربية" : "English"}` : t("no_client_msg")}</div>
    <div class="field"><label for="msgText">${t("message")}</label><textarea id="msgText" class="msgbox" dir="${(c?.lang || S.lang) === "ar" ? "rtl" : "ltr"}" maxlength="4000">${esc(text)}</textarea></div>
    <div class="modal-actions">
      <a class="btn btn-wa" id="waGo" href="${esc(waLink(c?.phone, text))}" target="_blank" rel="noopener" data-act="close">${I.wa}${t("open_wa")}</a>
      <button class="btn btn-ghost" data-act="copyMsg">${t("copy")}</button>
      <button class="btn btn-ghost" data-act="close">${t("cancel")}</button>
    </div>`);
  $("#modal").dataset.phone = c?.phone || "";
}

/* ============ toast ============ */
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._h);
  el._h = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ============ actions ============ */
const ACTS = {
  lang: () => setLang(S.lang === "ar" ? "en" : "ar"),
  setLang: el => setLang(el.dataset.v),
  theme: () => {
    store.set("fm_theme", isDark() ? "light" : "dark");
    applyTheme();
    renderChrome();
  },
  close: closeModal,
  authTab: el => { S.authTab = el.dataset.v; S.forgotSent = false; render(); },
  filter: el => { S.filter = el.dataset.v; render(); },
  moneyState: el => { S.money.state = el.dataset.v; render(); },
  month: el => { S.money.month = shiftMonth(S.money.month, Number(el.dataset.v)); render(); },
  tplKind: el => { S.tplKind = el.dataset.v; render(); },
  invLang: el => { S.invLang = el.dataset.v; render(); },
  print: () => window.print(),
  segPick: el => {
    $("#" + el.dataset.target).value = el.dataset.v;
    el.parentElement.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b === el));
    if (el.closest("#styleForm")) refreshPreview();
  },

  newProject: el => projectForm(null, { clientId: num(el.dataset.client) }),
  editProject: el => projectForm(num(el.dataset.id)),
  delProject: el => {
    const id = num(el.dataset.id);
    confirmBox(t("confirm_del_project", { title: P(id).title }), t("delete"), async () => {
      if (await mutate("DELETE", `/projects/${id}`, undefined, t("deleted"))) { closeModal(); go("projects"); }
    });
  },
  status: el => mutate("PATCH", `/projects/${el.dataset.id}`, { status: el.dataset.v }, t("status_set", { s: t("st_" + el.dataset.v) })),
  rev: el => {
    const p = P(num(el.dataset.id));
    const n = Math.max(0, p.revisionsUsed + Number(el.dataset.v));
    if (n !== p.revisionsUsed) mutate("PATCH", `/projects/${p.id}`, { revisionsUsed: n });
  },
  sendVersion: el => versionForm(num(el.dataset.id)),
  addLink: el => versionForm(num(el.dataset.id), true),
  delLink: el => {
    const p = P(num(el.dataset.id)), i = Number(el.dataset.i);
    mutate("PATCH", `/projects/${p.id}`, { links: p.links.filter((_, j) => j !== i) }, t("deleted"));
  },
  toggleDel: el => {
    const d = D().deliverables.find(x => x.id === num(el.dataset.id));
    mutate("PATCH", `/deliverables/${d.id}`, { done: !d.done });
  },
  delDel: el => mutate("DELETE", `/deliverables/${el.dataset.id}`, undefined, t("deleted")),

  newPay: el => paymentForm(null, { projectId: num(el.dataset.id), amount: num(el.dataset.amount) }),
  editPay: el => paymentForm(num(el.dataset.id)),
  delPay: el => {
    const id = num(el.dataset.id);
    confirmBox(t("confirm_del_payment"), t("delete"), async () => {
      if (await mutate("DELETE", `/payments/${id}`, undefined, t("deleted"))) closeModal();
    });
  },
  markPaid: el => markPaidForm(num(el.dataset.id)),

  newClient: el => clientForm(null, { then: el.dataset.then }),
  editClient: el => clientForm(num(el.dataset.id)),
  delClient: el => {
    const c = C(num(el.dataset.id));
    if (clientStats(c).ps.length) { toast(t("err_client_has_projects")); return; }
    confirmBox(t("confirm_del_client", { name: c.name }), t("delete"), async () => {
      if (await mutate("DELETE", `/clients/${c.id}`, undefined, t("deleted"))) { closeModal(); go("clients"); }
    });
  },

  msg: el => msgModal(num(el.dataset.id), el.dataset.kind, el.dataset.link ? { link: el.dataset.link, lang: el.dataset.lang } : {}),
  msgKind: el => msgModal(num(el.dataset.id), el.dataset.v),
  copyMsg: async () => {
    const ta = $("#msgText");
    try { await navigator.clipboard.writeText(ta.value); toast(t("copied")); }
    catch { ta.select(); toast(t("copy_manual")); }
  },

  tplReset: el => {
    const k = el.dataset.v, tpls = structuredClone(D().me.templates || {});
    delete tpls[k];
    mutate("PATCH", "/me", { templates: tpls }, t("reset_done"));
  },
  logout: async () => {
    try { await api("POST", "/logout", {}); } catch { /* signing out locally anyway */ }
    signedOut();
    go("today");
  },
  delAccount: () => {
    S.confirm = null;
    openModal(`${mhead(t("delete_account"))}<p>${t("delete_account_hint")}</p>
      <form data-form="deleteAccount"><div class="field req"><label for="dPass">${t("f_password")}</label><input id="dPass" name="password" type="password" required autocomplete="current-password"></div>
      <div class="modal-actions"><button class="btn btn-danger" type="submit">${t("delete_account")}</button><button class="btn btn-ghost" type="button" data-act="close">${t("cancel")}</button></div></form>`);
  },
  confirmYes: () => S.confirm?.(),
  remind: el => mutate("POST", `/payments/${el.dataset.id}/remind`, {}, t("reminder_sent")),
  repeatNow: async el => {
    const j = await mutate("POST", `/projects/${el.dataset.id}/repeat-now`, {}, t("repeat_created"));
    if (j) go(`project/${j.id}`);
  },
  editItem: el => itemForm(num(el.dataset.id)),
  delItem: async el => { if (await mutate("DELETE", `/items/${el.dataset.id}`, undefined, t("deleted"))) closeModal(); },
  sendDoc: el => sendDocModal(num(el.dataset.id)),
  sendLang: el => { S.invLang = el.dataset.v; sendDocModal(num(el.dataset.id)); if (S.route.name === "invoice") render(); },
  copyShare: async () => {
    const el = $("#shareUrl");
    try { await navigator.clipboard.writeText(el.value); toast(t("copied")); }
    catch { el.select(); toast(t("copy_manual")); }
  },
  unshare: el => {
    const id = num(el.dataset.id);
    confirmBox(t("stop_sharing_confirm"), t("stop_sharing"), async () => {
      if (await mutate("DELETE", `/projects/${id}/share`, undefined, t("sharing_stopped"))) closeModal();
    });
  },
  emailDoc: el => emailDocForm(num(el.dataset.id)),
  styleLang: el => { S.styleLang = el.dataset.v; el.parentElement.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b === el)); refreshPreview(); },
  pickColor: el => {
    $("#bColor").value = el.dataset.v;
    el.parentElement.querySelectorAll(".swatch[data-v]").forEach(b => b.setAttribute("aria-pressed", b === el));
    refreshPreview();
  },
  logoRemove: () => mutate("DELETE", "/me/logo", undefined, t("logo_removed")),
  calMonth: el => { const v = Number(el.dataset.v); S.calMonth = v ? shiftMonth(S.calMonth, v) : today().slice(0, 7); render(); },
  duplicate: async el => {
    const p = P(num(el.dataset.id));
    const j = await mutate("POST", `/projects/${p.id}/duplicate`, { title: p.title }, t("duplicated"));
    if (j) { S.editAfterRoute = j.id; go(`project/${j.id}`); }
  },
  gSync: async el => { el.disabled = true; await mutate("POST", "/google/sync", {}, t("gcal_synced")); },
  gDisconnect: () => confirmBox(t("gcal_disconnect_confirm"), t("gcal_disconnect"), async () => {
    if (await mutate("DELETE", "/google", undefined, t("gcal_disconnected"))) closeModal();
  }),
  feedOn: () => mutate("POST", "/me/calendar", {}),
  feedOff: () => confirmBox(t("feed_off_confirm"), t("feed_off"), async () => {
    if (await mutate("DELETE", "/me/calendar")) closeModal();
  }),
  copyFeed: async () => {
    const el = $("#feedUrl");
    try { await navigator.clipboard.writeText(el.value); toast(t("copied")); }
    catch { el.select(); toast(t("copy_manual")); }
  },
};

async function setLang(lang) {
  if (lang === S.lang) return;
  S.lang = lang;
  store.set("fm_lang", lang);
  applyLang();
  if (S.data && !S.offline) await mutate("PATCH", "/me", { lang });
  else render();
}

/* ============ forms ============ */
const formObj = form => Object.fromEntries(new FormData(form).entries());
const FORMS = {
  async login(o) {
    try {
      await api("POST", "/login", { email: o.email, password: o.password });
      go("today");
      render();
    } catch (e) { $("#authErr").textContent = errMsg(e); }
  },
  async signup(o) {
    try {
      await api("POST", "/signup", { name: o.name, email: o.email, password: o.password, lang: S.lang, examples: !!o.examples });
      location.hash = "today";
      render();
      toast(t("welcome"));
    } catch (e) { $("#authErr").textContent = errMsg(e); }
  },
  async forgot(o) {
    try {
      await api("POST", "/forgot", { email: o.email });
      S.forgotSent = true;
      render();
    } catch (e) { $("#authErr").textContent = errMsg(e); }
  },
  async reset(o) {
    try {
      await api("POST", "/reset", { token: S.route.raw, password: o.password });
      history.replaceState(null, "", "#today");
      S.route = parseHash();
      render();
      toast(t("password_reset_done"));
    } catch (e) { $("#authErr").textContent = errMsg(e); }
  },
  async project(o, form) {
    const id = num(form.dataset.id);
    const body = {
      title: o.title, clientId: num(o.clientId), type: o.type, status: o.status, startDate: o.startDate || null, dueDate: o.dueDate || null,
      sessionAt: o.sessionAt ? o.sessionAt.slice(0, 16) : null, folderUrl: o.folderUrl,
      repeat: o.repeat || "", repeatUntil: o.repeatUntil || null, noReminders: !!o.noReminders,
      fee: Number(o.fee || 0), revisionsAllowed: Number(o.revisionsAllowed || 0), notes: o.notes,
    };
    if (!id) body.depositPct = Number(o.depositPct || 0);
    const j = await mutate(id ? "PATCH" : "POST", id ? `/projects/${id}` : "/projects", body, t(id ? "saved" : "project_created"));
    if (j) { closeModal(); if (!id) go(`project/${j.id}`); }
  },
  async client(o, form) {
    const id = num(form.dataset.id);
    const j = await mutate(id ? "PATCH" : "POST", id ? `/clients/${id}` : "/clients", o, t(id ? "saved" : "client_added"));
    if (!j) return;
    if (form.dataset.then === "project") projectForm(null, { clientId: j.id });
    else closeModal();
  },
  async payment(o, form) {
    const id = num(form.dataset.id);
    const body = { kind: o.kind, label: o.label, amount: Number(o.amount), dueDate: o.dueDate || null, paidAt: o.paidAt || null, method: o.method, ref: o.ref };
    if (!id) body.projectId = num(form.dataset.project);
    if (await mutate(id ? "PATCH" : "POST", id ? `/payments/${id}` : "/payments", body, t("saved"))) closeModal();
  },
  async markPaid(o, form) {
    const x = D().payments.find(y => y.id === num(form.dataset.id));
    if (!await mutate("PATCH", `/payments/${x.id}`, { amount: Number(o.amount), paidAt: o.paidAt, method: o.method, ref: o.ref }, t("payment_logged"))) return;
    if (o.thank) msgModal(x.projectId, "thanks", { amount: Number(o.amount) });
    else closeModal();
  },
  async version(o, form) {
    const p = P(num(form.dataset.id));
    const links = [...p.links, { url: o.url, label: o.label, at: today() }];
    const body = form.dataset.plain ? { links } : { links, status: "with_client" };
    if (!await mutate("PATCH", `/projects/${p.id}`, body, t(form.dataset.plain ? "saved" : "version_sent"))) return;
    if (o.wa) msgModal(p.id, "delivery", { link: o.url });
    else closeModal();
  },
  async deliverable(o, form) {
    if (await mutate("POST", "/deliverables", { projectId: num(form.dataset.id), label: o.label, dueDate: o.dueDate || null })) {
      $(`form[data-form="deliverable"] input[name="label"]`)?.focus();
    }
  },
  async item(o, form) {
    if (await mutate("POST", "/items", { projectId: num(form.dataset.id), label: o.label, qty: Number(o.qty || 1), unitPrice: Number(o.unitPrice || 0) })) {
      $(`form[data-form="item"] input[name="label"]`)?.focus();
    }
  },
  async itemEdit(o, form) {
    if (await mutate("PATCH", `/items/${form.dataset.id}`, { label: o.label, qty: Number(o.qty), unitPrice: Number(o.unitPrice) }, t("saved"))) closeModal();
  },
  async pricing(o, form) {
    await mutate("PATCH", `/projects/${form.dataset.id}`, { discount: Number(o.discount || 0), taxRate: Number(o.taxRate || 0) }, t("saved"));
  },
  async note(o, form) {
    await mutate("POST", `/projects/${form.dataset.id}/notes`, { text: o.text });
  },
  async profile(o) { await mutate("PATCH", "/me", o, t("saved")); },
  async reminders(o) {
    const n = k => Number(o[k]);
    await mutate("PATCH", "/me", { reminders: { digest: !!o.digest, clients: !!o.clients, before: n("before"), after: n("after"), every: n("every"), max: n("max") } }, t("saved"));
  },
  async style(o) {
    await mutate("PATCH", "/me", { business: o.business, brand: brandFromForm(o) }, t("style_saved"));
  },
  async emailDoc(o, form) {
    const j = await mutate("POST", `/projects/${form.dataset.id}/email`, { to: o.to, message: o.message, lang: form.dataset.lang }, t("email_sent", { to: o.to }));
    if (j) closeModal();
  },
  async defaults(o) {
    await mutate("PATCH", "/me", { currency: o.currency, depositPct: Number(o.depositPct), revisions: Number(o.revisions), taxRate: Number(o.taxRate || 0) }, t("saved"));
  },
  async templates(o, form) {
    const tpls = structuredClone(D().me.templates || {});
    const k = form.dataset.kind;
    tpls[k] = {};
    for (const l of ["ar", "en"]) if (o[l].trim() && o[l].trim() !== TEMPLATES[l][k]) tpls[k][l] = o[l].trim();
    await mutate("PATCH", "/me", { templates: tpls }, t("saved"));
  },
  async password(o, form) {
    if (await mutate("POST", "/me/password", { current: o.current, next: o.next }, t("password_changed"))) form.reset();
  },
  async deleteAccount(o) {
    try {
      await api("DELETE", "/me", { password: o.password });
      closeModal();
      signedOut();
      toast(t("account_deleted"));
    } catch (e) { toast(errMsg(e)); }
  },
};

/* ============ events ============ */
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (el && ACTS[el.dataset.act]) {
    if (el.tagName !== "A" && !(el.tagName === "INPUT" && el.type === "checkbox")) e.preventDefault();
    if (el.id === "waGo") { setTimeout(closeModal, 0); return; }
    ACTS[el.dataset.act](el);
  }
  if (e.target === $("#overlay")) closeModal();
});
document.addEventListener("submit", async e => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector("[type=submit]");
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try { await FORMS[form.dataset.form](formObj(form), form); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
});
document.addEventListener("input", e => {
  if (e.target.id === "pq") { S.q = e.target.value; $("#plist").innerHTML = projectsList(); }
  if (e.target.id === "cq") { S.clientQ = e.target.value; $("#clist").innerHTML = clientsList(); }
  if (e.target.id === "msgText") $("#waGo").href = waLink($("#modal").dataset.phone, e.target.value);
  if (e.target.closest?.("#styleForm") && e.target.type !== "file") {
    if (e.target.id === "bColor") document.querySelectorAll(".swatch[data-v]").forEach(b => b.setAttribute("aria-pressed", b.dataset.v.toLowerCase() === e.target.value.toLowerCase()));
    refreshPreview(e.target.name !== "layout");
  }
});
document.addEventListener("change", e => {
  if (e.target.id === "mMethod") { S.money.method = e.target.value; render(); }
  if (e.target.dataset.stage) {
    const v = e.target.value;
    mutate("PATCH", `/projects/${e.target.dataset.stage}`, { status: v }, t("status_set", { s: t("st_" + v) }));
  }
  if (e.target.id === "importFile") readImport(e.target);
  if (e.target.id === "logoFile") uploadLogo(e.target);
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#overlay").hidden) closeModal(); });

async function uploadLogo(input) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  let dataUrl;
  try { dataUrl = await logoDataUrl(file); }
  catch (e) { toast(t(e.message === "logo_type" ? "err_logo_type" : "err_logo_read")); return; }
  await mutate("PUT", "/me/logo", { dataUrl }, t("logo_saved"));
}

async function readImport(input) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast(t("err_bad_file")); return; }
  if (data?.app !== "freelancers-manager") { toast(t("err_bad_file")); return; }
  confirmBox(t("confirm_import", { p: data.projects?.length || 0, c: data.clients?.length || 0 }), t("replace_data"), async () => {
    if (await mutate("POST", "/import", data, t("imported"))) closeModal();
  });
}

/* ============ routing & boot ============ */
function parseHash() {
  const [name, id] = location.hash.slice(1).split("/");
  return { name: name || "today", id: id && /^\d+$/.test(id) ? Number(id) : null, raw: id || "" };
}
function go(h) {
  if (location.hash.slice(1) === h) { S.route = parseHash(); render(); }
  else location.hash = h;
}
/* One-off routes: the Google sign-in comes back to #settings/google-ok or google-error; #settings/calendar jumps to the panel. */
function routeEffects() {
  const r = S.route;
  if (r.name !== "settings" || !r.raw || !S.data) return;
  if (r.raw === "google-ok") toast(t("gcal_connected_toast"));
  if (r.raw === "google-error") toast(t("gcal_connect_failed"));
  if (r.raw === "google-ok" || r.raw === "google-error") history.replaceState(null, "", "#settings");
  requestAnimationFrame(() => $("#calendar-settings")?.scrollIntoView({ block: "start" }));
}
window.addEventListener("hashchange", () => {
  S.route = parseHash();
  if (S.route.name !== "invoice") S.invLang = null;
  closeModal();
  render();
  window.scrollTo(0, 0);
  routeEffects();
  if (S.editAfterRoute) { const id = S.editAfterRoute; S.editAfterRoute = null; projectForm(id); }
});
window.addEventListener("online", () => { if (S.offline) location.reload(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", renderChrome);

async function boot() {
  applyTheme();
  applyLang();
  S.route = parseHash();
  try {
    const r = await fetch("/api/data");
    if (r.status === 401) { S.data = null; store.del(CACHE); }
    else if (r.ok) setData((await r.json()).data);
    else throw new Error("server");
  } catch {
    const cached = store.get(CACHE);
    if (cached) { S.data = JSON.parse(cached); S.offline = true; S.lang = S.data.me.lang; applyLang(); }
  }
  render();
  routeEffects();
  // Remember the browser's time zone so session times land correctly in calendars.
  if (S.data && !S.offline && !S.data.me.tz) api("PATCH", "/me", { tz: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
