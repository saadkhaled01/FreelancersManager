/* Draws a quote / invoice as HTML from docData(). Used by the app preview, the style gallery and the public link page.
   tl(lang, key, vars) supplies the words; the document has its own language, separate from the app's.
   The document is built from parts (header, parties, items, totals…) that each layout arranges its own way;
   all layouts share the brand colour, accent style, fonts, logo and both languages. */

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => (Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
const locale = lang => (lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB");
function longDate(s, lang) {
  if (!s) return "—";
  const [y, m, d] = s.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(lang), { day: "numeric", month: "long", year: "numeric" }).format(new Date(y, m - 1, d));
}
const nl2br = s => esc(s).replace(/\n/g, "<br>");
const iso = s => `<bdi>${esc(s)}</bdi>`; // user text inside a sentence keeps its own direction

/* Text colour that stays readable on the brand colour (WCAG relative luminance). */
export function inkOn(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return L > 0.4 ? "#1F1C18" : "#FFFFFF";
}

/* Second stop for the gradient accent: the brand colour turned 30° round the wheel, same lightness. */
export function gradientPartner(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, dlt = max - min;
  let h = 0, s = 0;
  if (dlt) {
    s = dlt / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / dlt) % 6 : max === g ? (b - r) / dlt + 2 : (r - g) / dlt + 4;
    h *= 60;
  }
  h = (h + 30 + 360) % 360;
  if (s < 0.15) s = 0.15; // greys still get a visible gradient
  const C = (1 - Math.abs(2 * l - 1)) * s, X = C * (1 - Math.abs((h / 60) % 2 - 1)), m = l - C / 2;
  const [r1, g1, b1] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return "#" + [r1, g1, b1].map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}

export function renderDoc(d, { tl, lang = d.lang, logoUrl = "" }) {
  const x = (k, v) => tl(lang, k, v);
  const cur = x("cur_" + d.currency);
  const money = n => `<span class="num">${fmt(n)}</span> ${esc(cur)}`;
  const b = d.brand, f = d.from, isQuote = d.kind === "quote";
  const who = f.business || f.name;
  const clientFirst = (d.client?.name || "").split(/\s+[—-]\s+|\s+/)[0];
  const payLabel = p => esc(p.label || x("pk_" + p.kind));
  const contact = [f.email, f.phone, b.website].filter(Boolean).map(s => `<span dir="ltr">${esc(s)}</span>`).join("<i>·</i>");
  const footer = (b.footer?.[lang] || "").trim();
  const intro = (b.intro?.[lang] || "").trim();
  const showPay = b.showPay && (f.instapay || f.vcash) && d.owed > 0;
  const dueLabel = x(isQuote ? "total" : "balance_due");

  /* ---------- parts ---------- */
  const logo = logoUrl ? `<img class="d-logo" src="${esc(logoUrl)}" alt="${esc(who)}">` : "";
  const fromText = `<div class="d-fromtext">
      <h1>${esc(who)}</h1>
      ${f.business && f.name !== f.business ? `<div class="d-sub">${esc(f.name)}</div>` : ""}
      ${contact ? `<div class="d-contact">${contact}</div>` : ""}
      ${b.address ? `<div class="d-sub">${esc(b.address)}</div>` : ""}
      ${b.taxId ? `<div class="d-sub">${x("tax_id")}: <bdi dir="ltr">${esc(b.taxId)}</bdi></div>` : ""}
    </div>`;
  const title = `<div class="d-title">${x(isQuote ? "quote" : "invoice")}</div>`;
  const meta = `<dl class="d-meta"><dt>${x("doc_no")}</dt><dd><bdi dir="ltr">${esc(d.code)}</bdi></dd><dt>${x("doc_date")}</dt><dd>${longDate(d.date, lang)}</dd>
      ${d.project.dueDate ? `<dt>${x("f_dueDate")}</dt><dd>${longDate(d.project.dueDate, lang)}</dd>` : ""}</dl>`;
  const billTo = `<div class="d-billto"><div class="d-lbl">${x("bill_to")}</div><b>${esc(d.client?.name || "—")}</b>
      ${d.client?.company && d.client.company !== d.client.name ? `<div>${esc(d.client.company)}</div>` : ""}
      ${d.client?.phone ? `<div class="d-sub"><bdi dir="ltr">${esc(d.client.phone)}</bdi></div>` : ""}</div>`;
  const projectBox = `<div class="d-proj"><div class="d-lbl">${x("project")}</div><b>${esc(d.project.title)}</b>
      ${d.project.type ? `<div class="d-sub">${esc(d.project.type)}</div>` : ""}</div>`;
  const parties = `<section class="d-parties">${billTo}${projectBox}</section>`;
  const introBox = intro ? `<section class="d-intro">${nl2br(intro)}</section>` : "";
  const items = `<table class="d-items">
      <thead><tr><th>${x("description")}</th><th class="n">${x("amount")}</th></tr></thead>
      <tbody><tr><td><b>${esc(d.project.title)}</b>
        ${d.deliverables.length ? `<ul>${d.deliverables.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
        ${d.project.revisionsAllowed ? `<div class="d-sub">${x("incl_rounds", { n: d.project.revisionsAllowed })}</div>` : ""}</td>
        <td class="n">${money(d.fee)}</td></tr></tbody>
    </table>`;
  const sched = d.payments.length ? `<table class="d-sched">
      <thead><tr><th>${x("schedule")}</th><th>${x("f_dueDate")}</th><th>${x("f_status")}</th><th class="n">${x("amount")}</th></tr></thead>
      <tbody>${d.payments.map(p => `<tr><td>${payLabel(p)}</td><td>${p.dueDate ? longDate(p.dueDate, lang) : "—"}</td>
        <td><span class="d-st ${p.state}">${p.paidAt ? x("paid_on", { d: longDate(p.paidAt, lang) }) : x("ps_" + p.state)}</span></td><td class="n">${money(p.amount)}</td></tr>`).join("")}</tbody>
    </table>` : "";
  const totals = `<section class="d-totals">
      <div class="r"><span>${x("total")}</span><span>${money(d.fee)}</span></div>
      ${isQuote ? "" : `<div class="r"><span>${x("paid")}</span><span>${money(d.paid)}</span></div>`}
      <div class="r big"><span>${dueLabel}</span><span>${money(d.owed)}</span></div>
    </section>`;
  const due = `<div class="d-due"><span>${dueLabel}</span><b>${money(d.owed)}</b>${d.project.dueDate ? `<span>${x("f_dueDate")}: ${longDate(d.project.dueDate, lang)}</span>` : ""}</div>`;
  const pay = showPay ? `<section class="d-pay"><div class="d-lbl">${x("pay_with")}</div><div class="d-pay-grid">
      ${f.instapay ? `<div><span>InstaPay</span><b><bdi dir="ltr">${esc(f.instapay)}</bdi></b></div>` : ""}
      ${f.vcash ? `<div><span>${x("m_vcash")}</span><b><bdi dir="ltr">${esc(f.vcash)}</bdi></b></div>` : ""}
      </div><div class="d-sub">${x("pay_ref_hint", { code: esc(d.code) })}</div></section>` : "";
  const sign = `<section class="d-sign">
      <div><span class="line"></span><b>${x("sign_for", { who: iso(who) })}</b><span class="d-sub">${x("doc_date")}: ____________</span></div>
      <div><span class="line"></span><b>${x(isQuote ? "sign_accept" : "sign_client")}</b><span class="d-sub">${x("doc_date")}: ____________</span></div>
    </section>`;
  const foot = `<footer class="d-foot">${footer ? nl2br(footer) : x("thanks_note")}</footer>`;

  /* ---------- layouts ---------- */
  let body;
  switch (b.layout) {
    case "sidebar":
      body = `<aside class="d-side">${logo}${fromText}<div class="d-side-kind">${title}${meta}</div>${due}${pay}</aside>
        <div class="d-main">${parties}${introBox}${items}${sched}${totals}${foot}</div>`;
      break;
    case "studio":
      body = `<header class="d-head">${logo}<div class="d-studio-title">${title}<div class="d-studio-for">${x("for_client", { name: iso(d.client?.name || "—") })} · ${iso(d.project.title)}</div></div></header>
        <div class="d-strip">${meta}${due}</div>
        ${introBox}${items}${sched}${totals}${pay}
        <div class="d-studio-from">${fromText}</div>${foot}`;
      break;
    case "corporate":
      body = `<header class="d-head"><div class="d-from">${logo}${fromText}</div><div class="d-kind">${title}${meta}</div></header>
        ${parties}${introBox}${items}${sched}${totals}${pay}${sign}${foot}`;
      break;
    case "receipt":
      body = `<header class="d-head">${logo}${fromText}<div class="d-cut"></div>${title}${meta}</header>
        <div class="d-cut"></div>${parties}${introBox}${items}${sched}<div class="d-cut"></div>${totals}${pay}${foot}`;
      break;
    case "letterhead": {
      const letter = intro || x(isQuote ? "letter_quote" : "letter_invoice", { project: iso(d.project.title) });
      body = `<header class="d-head">${logo}${fromText}</header>
        <div class="d-letter-meta">${billTo}${meta}</div>
        <div class="d-subject">${x("re_subject", { kind: x(isQuote ? "quote" : "invoice"), project: iso(d.project.title) })}</div>
        <section class="d-intro">${clientFirst ? `<p>${x("dear", { name: iso(clientFirst) })}</p>` : ""}<p>${intro ? nl2br(letter) : letter}</p></section>
        ${items}${sched}${totals}${pay}
        <div class="d-signoff">${x("regards")}<b>${esc(f.name)}</b>${f.business && f.business !== f.name ? `<span class="d-sub">${esc(f.business)}</span>` : ""}</div>${foot}`;
      break;
    }
    case "split":
      body = `<header class="d-head"><div class="d-from">${logo}${fromText}</div><div class="d-kind">${title}${due}</div></header>
        <section class="d-summary">${billTo}${projectBox}<div>${meta}</div></section>
        ${introBox}${items}${sched}${totals}${pay}${foot}`;
      break;
    default: // classic, bold, minimal
      body = `<header class="d-head"><div class="d-from">${logo}${fromText}</div><div class="d-kind">${title}${meta}</div></header>
        ${parties}${introBox}${items}${sched}${totals}${pay}${foot}`;
  }
  const style = `--brand:${b.color}; --brand-2:${gradientPartner(b.color)}; --brand-ink:${inkOn(b.color)}`;
  return `<article class="doc doc-${b.layout} font-${b.font} acc-${b.accent}" dir="${lang === "ar" ? "rtl" : "ltr"}" lang="${lang}" style="${style}">${body}</article>`;
}
