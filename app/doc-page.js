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

function draw() {
  main.innerHTML = renderDoc(doc, { tl, lang, logoUrl: doc.hasLogo ? `/api/public/doc/${encodeURIComponent(token)}/logo` : "" });
  document.title = `${tl(lang, doc.kind)} ${doc.code} · ${doc.from.business || doc.from.name}`;
  document.getElementById("print").textContent = tl(lang, "print");
  document.getElementById("made").textContent = tl(lang, "made_with");
  document.querySelectorAll("[data-lang]").forEach(b => b.setAttribute("aria-pressed", b.dataset.lang === lang));
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
