/* Builds the clickable demo: the real app plus an in-browser server (mock-server.js), in one flat folder
   ready to publish as a static page. Usage: node demo/build.mjs <out-dir> */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || path.join(root, "demo-build"));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "fonts"), { recursive: true });

const read = p => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, s) => fs.writeFileSync(path.join(out, p), s);
function patch(src, pairs, file) {
  for (const [a, b] of pairs) {
    if (!src.includes(a)) throw new Error(`${file}: patch target not found: ${a.slice(0, 70)}`);
    src = src.split(a).join(b);
  }
  return src;
}

/* App files, mostly as they are. */
for (const f of ["doc-data.js", "doc-render.js", "app.css", "doc.css"]) write(f, read(`app/${f}`));
for (const f of fs.readdirSync(path.join(root, "app/fonts"))) fs.copyFileSync(path.join(root, "app/fonts", f), path.join(out, "fonts", f));
write("fonts.css", read("app/fonts.css").replaceAll("url(/fonts/", "url(fonts/"));
write("examples.js", read("server/examples.js"));

/* Demo-only words, added to the app's own string table. */
write("i18n.js", read("app/i18n.js") + `
/* demo build */
Object.assign(STR.en, {
  demo_client_view: "This is what your client sees.", demo_client_view_hint: "In the real app this opens as its own page at the private link.",
  demo_back: "Back to the app", demo_note: "Downloads, printing and email are turned off in this demo. They work in the real app.",
});
Object.assign(STR.ar, {
  demo_client_view: "ده اللي العميل بيشوفه.", demo_client_view_hint: "في التطبيق الحقيقي بيتفتح كصفحة لوحده على اللينك الخاص.",
  demo_back: "رجوع للتطبيق", demo_note: "التنزيل والطباعة والإيميل مقفولين في النسخة التجريبية. بيشتغلوا في التطبيق الحقيقي.",
});
`);

write("app.js", patch(read("app/app.js"), [
  [`import { renderDoc } from "./doc-render.js";`, `import { renderDoc } from "./doc-render.js";\nimport { shareView } from "./share-view.js";`],
  // No server: the logo comes from memory, shared links open the in-app client view.
  ["const logoUrl = () => (D().me.logoVersion ? `/api/me/logo?v=${D().me.logoVersion}` : \"\");", `const logoUrl = () => D().me.logo || "";`],
  ["const shareUrl = (p, lang) => `${location.origin}/d/${p.shareToken}?lang=${lang}`;",
   "const shareUrl = (p, lang) => `https://freelancers-manager.app/d/${p.shareToken}?lang=${lang}`;\nconst demoHref = (p, lang) => `#share/${p.shareToken}~${lang}`;"],
  [`<a class="btn btn-ghost btn-sm" href="\${esc(shareUrl(p, L))}" target="_blank" rel="noopener">`, `<a class="btn btn-ghost btn-sm" href="\${demoHref(p, L)}">`],
  [`<a class="btn btn-ghost" href="\${esc(link)}" target="_blank" rel="noopener">\${t("preview_link")} ↗</a>`, `<a class="btn btn-ghost" href="\${demoHref(p, L)}" data-act="close">\${t("preview_link")}</a>`],
  [`  if (S.route.name === "reset") {`, `  if (S.route.name === "share") {\n    v.innerHTML = shareView(S.route.raw, S.lang);\n    return;\n  }\n  if (S.route.name === "reset") {`],
  [`<a class="btn btn-ghost" href="/api/export" download>\${t("export")}</a>`, `<button class="btn btn-ghost" type="button" data-act="demoNote">\${t("export")}</button>`],
  [`  print: () => window.print(),`, `  print: () => toast(t("demo_note")),\n  demoNote: () => toast(t("demo_note")),`],
  [`  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});`, ``],
  // Keep the viewer's own light / dark choice unless the user picks one in the app.
  [`  else document.documentElement.removeAttribute("data-theme");`, ``],
  // The client view changes data behind the app's back (accepting a quote), so reload when leaving it.
  [`window.addEventListener("hashchange", () => {\n  S.route = parseHash();`, `window.addEventListener("hashchange", () => {\n  if (S.route.name === "share" && S.data) api("GET", "/data").then(() => render()).catch(() => {});\n  S.route = parseHash();`],
  ["const feed = me.calToken ? `${location.origin}/cal/${me.calToken}.ics` : \"\";", "const feed = me.calToken ? `https://freelancers-manager.app/cal/${me.calToken}.ics` : \"\";"],
], "app.js"));

write("mock-server.js", read("demo/mock-server.js").replace(`"../app/doc-data.js"`, `"./doc-data.js"`).replace(`"../server/examples.js"`, `"./examples.js"`));
write("share-view.js", read("demo/share-view.js").replace(`"../app/i18n.js"`, `"./i18n.js"`).replace(`"../app/doc-render.js"`, `"./doc-render.js"`));
write("demo.js", `import { install, resetDemo } from "./mock-server.js";
install();
document.addEventListener("click", e => {
  if (!e.target.closest("#demoReset")) return;
  resetDemo();
  location.hash = "";
  location.reload();
});
await import("./app.js");
`);
write("demo.css", `/* demo strip above the app */
.demo-strip{max-width:1180px; margin:0 auto 12px; display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; justify-content:space-between;
  background:var(--ink); color:var(--bg); border-radius:12px; padding:8px 14px; font-size:12.5px;}
.demo-strip b{font-weight:700;}
.demo-strip code{font-family:var(--f-mono); background:rgba(255,255,255,.12); border-radius:6px; padding:1px 6px;}
.demo-strip button{border:1px solid rgba(255,255,255,.35); background:none; color:inherit; border-radius:8px; padding:4px 10px; font:inherit; cursor:pointer;}
.share-banner{margin-bottom:4px;}
.share-accept{max-width:820px; width:100%; margin-inline:auto;}
.share-accept.done{border:2px solid var(--success);}
.share-accept.done b{color:var(--success); font-size:17px;}
`);

/* The page itself: the publish step wraps it in <html>/<head>/<body>. */
const body = read("app/index.html").match(/<body>([\s\S]*)<\/body>/)[1].replace(/<noscript>[\s\S]*?<\/noscript>/, "");
write("index.html", `<title>Freelancers Manager</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="fonts.css">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="doc.css">
<link rel="stylesheet" href="demo.css">
<div class="demo-strip" dir="ltr">
  <span><b>Demo · تجربة</b> Everything runs in your browser. Log in as <code>demo@example.com</code> / <code>demo1234</code>, or sign up with any email.</span>
  <button type="button" id="demoReset">Reset demo</button>
</div>
${body.trim()}
<script type="module" src="demo.js"></script>
`);
console.log("Demo built in", out);
