/* Draws a quote / invoice as HTML from docData(). Used by the app preview and the public link page.
   tl(lang, key, vars) supplies the words; the document has its own language, separate from the app's. */

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => (Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
const locale = lang => (lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB");
function longDate(s, lang) {
  if (!s) return "—";
  const [y, m, d] = s.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(lang), { day: "numeric", month: "long", year: "numeric" }).format(new Date(y, m - 1, d));
}

/* Text colour that stays readable on the brand colour (WCAG relative luminance). */
export function inkOn(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return L > 0.4 ? "#1F1C18" : "#FFFFFF";
}

export function renderDoc(d, { tl, lang = d.lang, logoUrl = "" }) {
  const x = (k, v) => tl(lang, k, v);
  const cur = x("cur_" + d.currency);
  const money = n => `<span class="num">${fmt(n)}</span> ${esc(cur)}`;
  const b = d.brand, f = d.from, isQuote = d.kind === "quote";
  const payLabel = p => esc(p.label || x("pk_" + p.kind));
  const contact = [f.email, f.phone, b.website].filter(Boolean).map(s => `<span dir="ltr">${esc(s)}</span>`).join("<i>·</i>");
  const footer = (b.footer?.[lang] || "").trim();
  const showPay = b.showPay && (f.instapay || f.vcash) && d.owed > 0;

  return `<article class="doc doc-${b.layout} font-${b.font}" dir="${lang === "ar" ? "rtl" : "ltr"}" lang="${lang}" style="--brand:${b.color}; --brand-ink:${inkOn(b.color)}">
    <header class="d-head">
      <div class="d-from">
        ${logoUrl ? `<img class="d-logo" src="${esc(logoUrl)}" alt="${esc(f.business || f.name)}">` : ""}
        <div>
          <h1>${esc(f.business || f.name)}</h1>
          ${f.business && f.name !== f.business ? `<div class="d-sub">${esc(f.name)}</div>` : ""}
          ${contact ? `<div class="d-contact">${contact}</div>` : ""}
          ${b.address ? `<div class="d-sub">${esc(b.address)}</div>` : ""}
          ${b.taxId ? `<div class="d-sub">${x("tax_id")}: <span dir="ltr">${esc(b.taxId)}</span></div>` : ""}
        </div>
      </div>
      <div class="d-kind">
        <div class="d-title">${x(isQuote ? "quote" : "invoice")}</div>
        <dl><dt>${x("doc_no")}</dt><dd><bdi dir="ltr">${esc(d.code)}</bdi></dd><dt>${x("doc_date")}</dt><dd>${longDate(d.date, lang)}</dd>
          ${d.project.dueDate ? `<dt>${x("f_dueDate")}</dt><dd>${longDate(d.project.dueDate, lang)}</dd>` : ""}</dl>
      </div>
    </header>

    <section class="d-parties">
      <div><div class="d-lbl">${x("bill_to")}</div><b>${esc(d.client?.name || "—")}</b>
        ${d.client?.company && d.client.company !== d.client.name ? `<div>${esc(d.client.company)}</div>` : ""}
        ${d.client?.phone ? `<div class="d-sub"><bdi dir="ltr">${esc(d.client.phone)}</bdi></div>` : ""}</div>
      <div><div class="d-lbl">${x("project")}</div><b>${esc(d.project.title)}</b>
        ${d.project.type ? `<div class="d-sub">${esc(d.project.type)}</div>` : ""}</div>
    </section>

    <table class="d-items">
      <thead><tr><th>${x("description")}</th><th class="n">${x("amount")}</th></tr></thead>
      <tbody><tr><td><b>${esc(d.project.title)}</b>
        ${d.deliverables.length ? `<ul>${d.deliverables.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
        ${d.project.revisionsAllowed ? `<div class="d-sub">${x("incl_rounds", { n: d.project.revisionsAllowed })}</div>` : ""}</td>
        <td class="n">${money(d.fee)}</td></tr></tbody>
    </table>

    ${d.payments.length ? `<table class="d-sched">
      <thead><tr><th>${x("schedule")}</th><th>${x("f_dueDate")}</th><th>${x("f_status")}</th><th class="n">${x("amount")}</th></tr></thead>
      <tbody>${d.payments.map(p => `<tr><td>${payLabel(p)}</td><td>${p.dueDate ? longDate(p.dueDate, lang) : "—"}</td>
        <td><span class="d-st ${p.state}">${p.paidAt ? x("paid_on", { d: longDate(p.paidAt, lang) }) : x("ps_" + p.state)}</span></td><td class="n">${money(p.amount)}</td></tr>`).join("")}</tbody>
    </table>` : ""}

    <section class="d-totals">
      <div class="r"><span>${x("total")}</span><span>${money(d.fee)}</span></div>
      ${isQuote ? "" : `<div class="r"><span>${x("paid")}</span><span>${money(d.paid)}</span></div>`}
      <div class="r big"><span>${x(isQuote ? "total" : "balance_due")}</span><span>${money(d.owed)}</span></div>
    </section>

    ${showPay ? `<section class="d-pay"><div class="d-lbl">${x("pay_with")}</div><div class="d-pay-grid">
      ${f.instapay ? `<div><span>InstaPay</span><b><bdi dir="ltr">${esc(f.instapay)}</bdi></b></div>` : ""}
      ${f.vcash ? `<div><span>${x("m_vcash")}</span><b><bdi dir="ltr">${esc(f.vcash)}</bdi></b></div>` : ""}
      </div><div class="d-sub">${x("pay_ref_hint", { code: esc(d.code) })}</div></section>` : ""}

    <footer class="d-foot">${footer ? esc(footer).replace(/\n/g, "<br>") : x("thanks_note")}</footer>
  </article>`;
}
