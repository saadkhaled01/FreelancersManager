/* Quote / invoice data and branding. Shared by the app (preview), the public link page and the server (link, email),
   so all three always show the same document. No DOM or Node APIs here. */

export const LAYOUTS = ["classic", "bold", "minimal", "sidebar", "studio", "corporate", "receipt", "letterhead", "split"];
export const FONTS = ["modern", "clean", "elegant"];
export const ACCENTS = ["solid", "outline", "gradient"];
export const BRAND_COLORS = ["#1E6F5C", "#221E19", "#B23A2E", "#B9761F", "#2F5D8A", "#6B4E9B", "#0F7C8C", "#C2185B"];
export const BRAND_DEFAULT = { color: "#1E6F5C", layout: "classic", font: "modern", accent: "solid", address: "", website: "", taxId: "", showPay: true, footer: {}, intro: {} };

const r2 = n => Math.round(n * 100) / 100;

/* Fills {placeholders} in a message template. A line whose placeholder has no value (e.g. no InstaPay set) is dropped. */
export function fillText(tpl, vars) {
  return tpl.split("\n").filter(line => {
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    return !keys.some(k => k in vars && !vars[k]);
  }).join("\n").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).replace(/\n{3,}/g, "\n\n").trim();
}

/* Recurring projects: how far apart each cycle starts. Months keep the day, clamped to the month's last day. */
export const REPEATS = ["weekly", "monthly", "quarterly"];
/* Expenses: what a freelancer spends, per project or for the business as a whole. Never shown to clients. */
export const EXPENSE_CATEGORIES = ["equipment", "software", "crew", "travel", "rent", "marketing", "fees", "other"];
export const EXPENSE_REPEATS = ["monthly", "yearly"];
export function addPeriod(date, repeat) {
  const [y, m, d] = date.split("-").map(Number);
  if (repeat === "weekly") {
    const t = new Date(Date.UTC(y, m - 1, d + 7));
    return t.toISOString().slice(0, 10);
  }
  const months = { quarterly: 3, yearly: 12 }[repeat] || 1;
  const ty = y + Math.floor((m - 1 + months) / 12), tm = (m - 1 + months) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
export function daysBetween(a, b) {
  const t = s => Date.UTC(...s.split("-").map((n, i) => Number(n) - (i === 1 ? 1 : 0)));
  return Math.round((t(b) - t(a)) / 864e5);
}
/* Payment reminder settings, with defaults: summary email on, client emails off. */
export const REMINDER_DEFAULT = { digest: true, clients: false, before: 0, after: 1, every: 7, max: 3 };
export function normalizeReminders(r) {
  r = r && typeof r === "object" ? r : {};
  const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  return {
    digest: r.digest !== false, clients: r.clients === true,
    before: int(r.before, 0, 14, 0), after: int(r.after, 0, 60, 1), every: int(r.every, 1, 60, 7), max: int(r.max, 1, 10, 3),
  };
}

/* Totals from line items: subtotal − discount, then tax on the discounted amount. Shared by server, app and documents. */
export function itemTotals(items, discount = 0, taxRate = 0) {
  const subtotal = r2(items.reduce((s, i) => s + i.qty * i.unitPrice, 0));
  const disc = r2(Math.min(Math.max(discount || 0, 0), subtotal));
  const tax = r2((subtotal - disc) * (taxRate || 0) / 100);
  return { subtotal, discount: disc, taxRate: taxRate || 0, tax, total: r2(subtotal - disc + tax) };
}

export function normalizeBrand(b) {
  b = b && typeof b === "object" ? b : {};
  return {
    ...BRAND_DEFAULT, ...b,
    color: /^#[0-9a-f]{6}$/i.test(b.color || "") ? b.color : BRAND_DEFAULT.color,
    layout: LAYOUTS.includes(b.layout) ? b.layout : BRAND_DEFAULT.layout,
    font: FONTS.includes(b.font) ? b.font : BRAND_DEFAULT.font,
    accent: ACCENTS.includes(b.accent) ? b.accent : BRAND_DEFAULT.accent,
    showPay: b.showPay !== false,
    footer: { ...(b.footer && typeof b.footer === "object" ? b.footer : {}) },
    intro: { ...(b.intro && typeof b.intro === "object" ? b.intro : {}) },
  };
}

/* project, client, payments / deliverables / items (this project's), me (account settings), today "YYYY-MM-DD" */
export function docData({ project, client, payments, deliverables, items = [], me, today }) {
  const lines = items.map(i => ({ label: i.label, qty: i.qty, unitPrice: i.unitPrice, amount: r2(i.qty * i.unitPrice) }));
  const sums = lines.length ? itemTotals(items, project.discount, project.taxRate) : null;
  const paid = payments.filter(x => x.paidAt).reduce((s, x) => s + x.amount, 0);
  const isQuote = project.status === "lead";
  return {
    kind: isQuote ? "quote" : "invoice",
    code: project.code,
    date: today,
    lang: client?.lang || me.lang || "ar",
    project: { title: project.title, type: project.type, dueDate: project.dueDate, sessionAt: project.sessionAt || null, revisionsAllowed: project.revisionsAllowed },
    deliverables: deliverables.map(d => d.label),
    items: lines,
    subtotal: sums ? sums.subtotal : project.fee,
    discount: sums ? sums.discount : 0,
    taxRate: sums ? sums.taxRate : 0,
    tax: sums ? sums.tax : 0,
    accepted: project.acceptedAt ? { at: project.acceptedAt, by: project.acceptedBy } : null,
    client: client ? { name: client.name, company: client.company, phone: client.phone } : null,
    payments: payments.map(x => ({
      kind: x.kind, label: x.label, amount: x.amount, dueDate: x.dueDate, paidAt: x.paidAt,
      state: x.paidAt ? "paid" : x.dueDate && x.dueDate < today ? "overdue" : "due",
    })),
    fee: project.fee,
    paid,
    owed: isQuote ? project.fee : Math.max(0, Math.round((project.fee - paid) * 100) / 100),
    currency: me.currency || "EGP",
    from: { name: me.name, business: me.business, email: me.email, phone: me.phone, instapay: me.instapay, vcash: me.vcash },
    brand: normalizeBrand(me.brand),
  };
}

/* Example document for the style preview when the account has no projects yet. */
export function sampleDoc(me, lang, today) {
  const ar = lang === "ar";
  return docData({
    project: { status: "active", code: "FM-0000-001", title: ar ? "فيديو إطلاق منتج" : "Product launch video", type: ar ? "فيديو" : "Video", dueDate: today, revisionsAllowed: 2, fee: 12000 },
    client: { name: ar ? "سلمى أحمد" : "Sara Lee", company: "Nile Coffee", phone: "01012345678", lang },
    payments: [
      { kind: "deposit", label: "", amount: 6000, dueDate: today, paidAt: today },
      { kind: "balance", label: "", amount: 6000, dueDate: today, paidAt: null },
    ],
    deliverables: ar ? [{ label: "نسخة 16:9 كاملة" }, { label: "نسخة 9:16 للريلز" }] : [{ label: "Full 16:9 master" }, { label: "9:16 cut for Reels" }],
    me, today,
  });
}
