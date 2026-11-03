import { insert, log, now, nextCode } from "./model.js";
import { EXAMPLES } from "./examples.js";

const day = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ago = n => new Date(Date.now() - n * 864e5).toISOString();

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
