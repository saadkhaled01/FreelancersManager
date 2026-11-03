/* Demo only: the client's view of a shared quote / invoice, shown inside the app at #share/<token>~<lang>
   (the real app serves it at /d/<token>). Same renderer and accept form as app/doc-page.js. */
import { STR } from "../app/i18n.js";
import { renderDoc } from "../app/doc-render.js";

const tl = (lang, key, vars) => {
  let s = STR[lang]?.[key] ?? STR.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  return s;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const waNumber = p => { const d = String(p || "").replace(/[^\d+]/g, ""); return d.startsWith("+") ? d.slice(1) : d.startsWith("00") ? d.slice(2) : /^01\d{9}$/.test(d) ? "2" + d : d; };

let state = { token: "", lang: "ar", doc: null, done: false, appLang: "ar" };

export function shareView(raw, appLang) {
  const [tok, l] = String(raw || "").split("~");
  if (tok !== state.token) state = { token: tok, lang: l || null, doc: null, done: false, appLang };
  state.appLang = appLang;
  load();
  return `<div class="share-demo" id="shareHost"><p class="hint">…</p></div>`;
}

async function load() {
  const r = await fetch(`/api/public/doc/${encodeURIComponent(state.token)}`);
  if (!r.ok) { draw(true); return; }
  state.doc = await r.json();
  state.lang = state.lang || state.doc.lang;
  draw();
}

function draw(gone = false) {
  const host = document.getElementById("shareHost");
  if (!host) return;
  const A = state.appLang, t = (k, v) => tl(state.lang, k, v);
  const banner = `<div class="banner warn share-banner"><span><b>${tl(A, "demo_client_view")}</b> ${tl(A, "demo_client_view_hint")}</span>
    <button class="btn btn-ghost btn-sm" type="button" data-share="back">${tl(A, "demo_back")}</button></div>`;
  if (gone) { host.innerHTML = banner + `<div class="empty"><b>${t("doc_gone")}</b>${t("doc_gone_hint")}</div>`; return; }
  const d = state.doc;
  const bar = `<div class="toolbar"><div class="seg">${["ar", "en"].map(l => `<button type="button" data-share-lang="${l}" aria-pressed="${state.lang === l}">${l === "ar" ? "العربية" : "English"}</button>`).join("")}</div></div>`;
  const ask = d.from.phone ? `<a class="linkish" href="https://wa.me/${waNumber(d.from.phone)}?text=${encodeURIComponent(t("ask_text", { code: d.code }))}" target="_blank" rel="noopener">${t("ask_question")}</a>` : "";
  let accept = "";
  if (state.done) accept = `<section class="panel share-accept done"><b>${t("accept_done")}</b><span>${t("accept_done_hint", { who: esc(d.from.business || d.from.name) })}</span></section>`;
  else if (d.kind === "quote" && !d.accepted) accept = `<form class="panel share-accept" id="shareAccept" dir="${state.lang === "ar" ? "rtl" : "ltr"}">
      <h2 style="font-size:19px">${t("accept_title")}</h2>
      <p class="muted">${t("accept_hint", { who: esc(d.from.business || d.from.name) })}</p>
      <div class="field req"><label for="saName">${t("accept_name")}</label><input id="saName" name="name" required minlength="2" maxlength="120"></div>
      <label class="check"><input type="checkbox" name="agree" required><span>${t("accept_agree")}</span></label>
      <p class="err" id="saErr"></p>
      <div class="acts"><button class="btn btn-primary" type="submit">${t("accept_btn")}</button>${ask}</div>
    </form>`;
  host.innerHTML = banner + bar + renderDoc(d, { tl, lang: state.lang, logoUrl: d.logo || "" }) + accept;
}

document.addEventListener("click", e => {
  const l = e.target.closest("[data-share-lang]");
  if (l) { state.lang = l.dataset.shareLang; draw(); }
  if (e.target.closest("[data-share=back]")) history.back();
});
document.addEventListener("submit", async e => {
  if (e.target.id !== "shareAccept") return;
  e.preventDefault();
  e.stopPropagation();
  const f = new FormData(e.target);
  const r = await fetch(`/api/public/doc/${encodeURIComponent(state.token)}/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: f.get("name"), agree: f.get("agree") === "on" }),
  });
  if (!r.ok) { document.getElementById("saErr").textContent = tl(state.lang, r.status === 409 ? "accept_already" : "accept_failed"); return; }
  state.doc = await r.json();
  state.done = true;
  draw();
}, true);
