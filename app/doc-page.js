import { STR } from "./i18n.js";
import { renderDoc } from "./doc-render.js";

/* Public view of a shared quote / invoice: /d/<token>?lang=ar|en. Read-only; the link is the only key. */
const tl = (lang, key, vars) => {
  let s = STR[lang]?.[key] ?? STR.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  return s;
};
const token = location.pathname.split("/")[2] || "";
const q = new URLSearchParams(location.search);
const main = document.getElementById("doc");
let doc = null, lang = null;

function setLang(l) {
  lang = l === "en" ? "en" : "ar";
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}

const waNumber = p => { const d = String(p || "").replace(/[^\d+]/g, ""); return d.startsWith("+") ? d.slice(1) : d.startsWith("00") ? d.slice(2) : /^01\d{9}$/.test(d) ? "2" + d : d; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let justAccepted = false;

/* Quotes get an accept form under the document: the client types their name and ticks the box. */
function drawAccept() {
  const box = document.getElementById("accept");
  const t = (k, v) => tl(lang, k, v);
  const ask = doc.from.phone ? `<a class="ask" href="https://wa.me/${waNumber(doc.from.phone)}?text=${encodeURIComponent(t("ask_text", { code: doc.code }))}" target="_blank" rel="noopener">${t("ask_question")}</a>` : "";
  if (justAccepted) {
    box.innerHTML = `<div class="done"><b>${t("accept_done")}</b>${t("accept_done_hint", { who: esc(doc.from.business || doc.from.name) })}</div>`;
    box.hidden = false;
    return;
  }
  if (doc.kind !== "quote" || doc.accepted) { box.hidden = true; return; }
  box.innerHTML = `<form id="acceptForm">
      <h2>${t("accept_title")}</h2>
      <p>${t("accept_hint", { who: esc(doc.from.business || doc.from.name) })}</p>
      <label for="aName">${t("accept_name")}</label>
      <input id="aName" name="name" required minlength="2" maxlength="120" autocomplete="name">
      <label class="chk"><input type="checkbox" name="agree" required><span>${t("accept_agree")}</span></label>
      <p class="err" id="aErr" role="alert"></p>
      <div class="row"><button type="submit">${t("accept_btn")}</button>${ask}</div>
    </form>`;
  box.hidden = false;
}

document.addEventListener("submit", async e => {
  if (e.target.id !== "acceptForm") return;
  e.preventDefault();
  const f = new FormData(e.target), btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const r = await fetch(`/api/public/doc/${encodeURIComponent(token)}/accept`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: f.get("name"), agree: f.get("agree") === "on" }),
    });
    if (!r.ok) throw new Error(r.status === 409 ? "accept_already" : r.status === 429 ? "accept_busy" : "accept_failed");
    doc = { ...(await r.json()), hasLogo: doc.hasLogo };
    justAccepted = true;
    draw();
    document.getElementById("accept").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    document.getElementById("aErr").textContent = tl(lang, err.message);
    btn.disabled = false;
  }
});

function draw() {
  main.innerHTML = renderDoc(doc, { tl, lang, logoUrl: doc.hasLogo ? `/api/public/doc/${encodeURIComponent(token)}/logo` : "" });
  document.title = `${tl(lang, doc.kind)} ${doc.code} · ${doc.from.business || doc.from.name}`;
  document.getElementById("print").textContent = tl(lang, "print");
  document.getElementById("made").textContent = tl(lang, "made_with");
  document.querySelectorAll("[data-lang]").forEach(b => b.setAttribute("aria-pressed", b.dataset.lang === lang));
  drawAccept();
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-lang]");
  if (b) {
    setLang(b.dataset.lang);
    history.replaceState(null, "", `?lang=${lang}`);
    draw();
  }
  if (e.target.id === "print") window.print();
});

(async () => {
  try {
    const r = await fetch(`/api/public/doc/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(String(r.status));
    doc = await r.json();
    setLang(q.get("lang") || doc.lang);
    document.getElementById("bar").hidden = false;
    draw();
  } catch {
    setLang(q.get("lang") || ((navigator.language || "").startsWith("ar") ? "ar" : "en"));
    main.innerHTML = `<p class="msg"><b>${tl(lang, "doc_gone")}</b>${tl(lang, "doc_gone_hint")}</p>`;
  }
})();
