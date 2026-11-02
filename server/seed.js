import { insert, log, now, nextCode } from "./model.js";

const day = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ago = n => new Date(Date.now() - n * 864e5).toISOString();

const EXAMPLES = {
  ar: {
    clients: [
      { name: "سلمى — Nile Coffee", company: "Nile Coffee", phone: "01012345678", lang: "ar" },
      { name: "يوسف — Bloom Studio", company: "Bloom Studio", phone: "01198765432", lang: "ar" },
      { name: "مريم وعمر", company: "", phone: "01287654321", lang: "ar" },
      { name: "Daniel — Koshary Lab", company: "Koshary Lab", phone: "+447700900123", lang: "en" },
    ],
    projects: [
      { c: 0, title: "فيديو إطلاق منتج (مثال)", type: "فيديو", status: "with_client", start: -12, due: 3, fee: 12000, rev: [3, 1], paid: [true, false],
        deliverables: [["نسخة 16:9 كاملة", true], ["نسخة 9:16 للريلز", false], ["3 كتات 15 ثانية", false]],
        link: { url: "https://drive.google.com/example-v2", label: "النسخة 2" }, folder: "https://drive.google.com/drive/folders/example" },
      { c: 0, title: "تصوير منيو الخريف (مثال)", type: "تصوير", status: "booked", start: 0, due: 8, fee: 5000, rev: [2, 0], paid: [false, false],
        deliverables: [["30 صورة متعدلة", false]], session: [2, "10:00"] },
      { c: 1, title: "ريلز رمضان ×6 (مثال)", type: "ريلز", status: "active", start: -5, due: 9, fee: 8000, rev: [2, 0], paid: [true, false],
        deliverables: [["ريل 1", true], ["ريل 2", true], ["ريل 3", true], ["ريل 4", false], ["ريل 5", false], ["ريل 6", false]] },
      { c: 2, title: "تصوير فرح (مثال)", type: "تصوير", status: "delivered", start: -40, due: -9, fee: 9000, rev: [2, 2], paid: [true, false],
        deliverables: [["فيلم الفرح", true], ["هايلايت دقيقة", true]] },
      { c: 3, title: "Brand identity (example)", type: "Design", status: "lead", start: null, due: 21, fee: 6500, rev: [3, 0], paid: [false, false],
        deliverables: [] },
    ],
  },
  en: {
    clients: [
      { name: "Sara Lee", company: "Northwind Coffee", phone: "+14155550134", lang: "en" },
      { name: "Marco Rossi", company: "Bloom Studio", phone: "+393471234567", lang: "en" },
      { name: "Emma & Jack", company: "", phone: "+447700900456", lang: "en" },
      { name: "سلمى — Nile Coffee", company: "Nile Coffee", phone: "01012345678", lang: "ar" },
    ],
    projects: [
      { c: 0, title: "Product launch video (example)", type: "Video", status: "with_client", start: -12, due: 3, fee: 2400, rev: [3, 1], paid: [true, false],
        deliverables: [["Full 16:9 master", true], ["9:16 cut for Reels", false], ["Three 15s cutdowns", false]],
        link: { url: "https://drive.google.com/example-v2", label: "Version 2" }, folder: "https://drive.google.com/drive/folders/example" },
      { c: 0, title: "Autumn menu shoot (example)", type: "Photo", status: "booked", start: 0, due: 8, fee: 900, rev: [2, 0], paid: [false, false],
        deliverables: [["30 edited photos", false]], session: [2, "10:00"] },
      { c: 1, title: "Six launch reels (example)", type: "Reels", status: "active", start: -5, due: 9, fee: 1800, rev: [2, 0], paid: [true, false],
        deliverables: [["Reel 1", true], ["Reel 2", true], ["Reel 3", true], ["Reel 4", false], ["Reel 5", false], ["Reel 6", false]] },
      { c: 2, title: "Wedding film (example)", type: "Photo & video", status: "delivered", start: -40, due: -9, fee: 3200, rev: [2, 2], paid: [true, false],
        deliverables: [["Feature film", true], ["One-minute highlight", true]] },
      { c: 3, title: "Café menu photos (example)", type: "Photo", status: "lead", start: null, due: 21, fee: 900, rev: [2, 0], paid: [false, false],
        deliverables: [] },
    ],
  },
};

export function seedExamples(db, userId, lang) {
  const ex = EXAMPLES[lang] || EXAMPLES.ar;
  const t = now();
  const clientIds = ex.clients.map(c => insert(db, "clients", { ...c, user_id: userId, notes: "", email: "", created_at: t, updated_at: t }));
  for (const p of ex.projects) {
    const statusAt = p.status === "lead" ? ago(4) : ago(2);
    const id = insert(db, "projects", {
      user_id: userId, client_id: clientIds[p.c], code: nextCode(db, userId), title: p.title, type: p.type, status: p.status,
      start_date: p.start == null ? null : day(p.start), due_date: day(p.due), fee: p.fee,
      revisions_allowed: p.rev[0], revisions_used: p.rev[1],
      links: JSON.stringify(p.link ? [{ ...p.link, at: day(-2) }] : []), notes: "",
      session_at: p.session ? `${day(p.session[0])}T${p.session[1]}` : null, folder_url: p.folder || "",
      status_at: statusAt, created_at: ago(p.start == null ? 4 : -p.start), updated_at: t,
    });
    const deposit = Math.round(p.fee / 2);
    insert(db, "payments", { user_id: userId, project_id: id, kind: "deposit", amount: deposit, due_date: day(p.start ?? 0),
      paid_at: p.paid[0] ? day(p.start ?? 0) : null, method: p.paid[0] ? "instapay" : "", ref: p.paid[0] ? `IP-${80000 + id}` : "", label: "", created_at: t });
    insert(db, "payments", { user_id: userId, project_id: id, kind: "balance", amount: p.fee - deposit, due_date: day(p.due),
      paid_at: null, method: "", ref: "", label: "", created_at: t });
    for (const [label, done] of p.deliverables)
      insert(db, "deliverables", { user_id: userId, project_id: id, label, done: done ? 1 : 0, due_date: null, created_at: t });
    log(db, userId, id, "created", {});
    if (p.link) log(db, userId, id, "link", { url: p.link.url, label: p.link.label });
  }
}
