/* Quote / invoice data and branding. Shared by the app (preview), the public link page and the server (link, email),
   so all three always show the same document. No DOM or Node APIs here. */

export const LAYOUTS = ["classic", "bold", "minimal"];
export const FONTS = ["modern", "clean", "elegant"];
export const BRAND_COLORS = ["#1E6F5C", "#221E19", "#B23A2E", "#B9761F", "#2F5D8A", "#6B4E9B", "#0F7C8C", "#C2185B"];
export const BRAND_DEFAULT = { color: "#1E6F5C", layout: "classic", font: "modern", address: "", website: "", taxId: "", showPay: true, footer: {} };

export function normalizeBrand(b) {
  b = b && typeof b === "object" ? b : {};
  return {
    ...BRAND_DEFAULT, ...b,
    color: /^#[0-9a-f]{6}$/i.test(b.color || "") ? b.color : BRAND_DEFAULT.color,
    layout: LAYOUTS.includes(b.layout) ? b.layout : BRAND_DEFAULT.layout,
    font: FONTS.includes(b.font) ? b.font : BRAND_DEFAULT.font,
    showPay: b.showPay !== false,
    footer: { ...(b.footer && typeof b.footer === "object" ? b.footer : {}) },
  };
}

/* project, client, payments (this project's), deliverables (this project's), me (account settings), today "YYYY-MM-DD" */
export function docData({ project, client, payments, deliverables, me, today }) {
  const paid = payments.filter(x => x.paidAt).reduce((s, x) => s + x.amount, 0);
  const isQuote = project.status === "lead";
  return {
    kind: isQuote ? "quote" : "invoice",
    code: project.code,
    date: today,
    lang: client?.lang || me.lang || "ar",
    project: { title: project.title, type: project.type, dueDate: project.dueDate, sessionAt: project.sessionAt || null, revisionsAllowed: project.revisionsAllowed },
    deliverables: deliverables.map(d => d.label),
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
