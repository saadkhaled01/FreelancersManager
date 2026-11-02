import { OPEN } from "./model.js";

/* Calendar events derived from a user's data. The same list feeds the .ics subscription and Google Calendar sync. */
const L = {
  en: { session: "Session", due: "Due", deliverable: "Deliver", payment: "Payment due", deposit: "Deposit", balance: "Balance", extra: "Payment" },
  ar: { session: "تصوير / جلسة", due: "تسليم", deliverable: "تسليم ملف", payment: "دفعة مستحقة", deposit: "عربون", balance: "الباقي", extra: "دفعة" },
};
export const SESSION_HOURS = 2;

/* Each event: { uid, summary, description, date } for all-day, or { uid, summary, description, start } with start "YYYY-MM-DDTHH:MM". */
export function calendarEvents(data, money) {
  const t = L[data.me.lang] || L.en;
  const projects = new Map(data.projects.map(p => [p.id, p]));
  const clients = new Map(data.clients.map(c => [c.id, c]));
  const who = p => (p.clientId && clients.get(p.clientId) ? ` · ${clients.get(p.clientId).name}` : "");
  const info = p => [p.code, p.folderUrl].filter(Boolean).join("\n");
  const out = [];
  for (const p of data.projects) {
    if (!OPEN.includes(p.status)) continue;
    if (p.sessionAt) out.push({ uid: `session-${p.id}`, start: p.sessionAt, summary: `${t.session}: ${p.title}${who(p)}`, description: info(p) });
    if (p.dueDate) out.push({ uid: `project-${p.id}`, date: p.dueDate, summary: `${t.due}: ${p.title}${who(p)}`, description: info(p) });
  }
  for (const d of data.deliverables) {
    const p = projects.get(d.projectId);
    if (d.dueDate && !d.done && p && OPEN.includes(p.status))
      out.push({ uid: `deliverable-${d.id}`, date: d.dueDate, summary: `${t.deliverable}: ${d.label} (${p.title})`, description: p.code });
  }
  for (const x of data.payments) {
    const p = projects.get(x.projectId);
    if (x.dueDate && !x.paidAt && p && p.status !== "lead" && p.status !== "archived")
      out.push({ uid: `payment-${x.id}`, date: x.dueDate, summary: `${t.payment}: ${money(x.amount)}${who(p)}`, description: `${x.label || t[x.kind] || ""} · ${p.title} · ${p.code}` });
  }
  return out;
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function addHours(start, h) {
  const [date, time] = start.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh + h, mm)).toISOString().slice(0, 16);
}

const text = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const compact = s => s.replace(/[-:]/g, "");

/* RFC 5545: lines longer than 75 octets are folded, never splitting a UTF-8 character. */
function fold(line) {
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function buildIcs(data, money) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const tz = data.me.tz;
  const lines = calendarEvents(data, money).flatMap(e => [
    "BEGIN:VEVENT", `UID:${e.uid}@freelancers-manager`, `DTSTAMP:${stamp}`,
    ...(e.date
      ? [`DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(addDays(e.date, 1))}`, "TRANSP:TRANSPARENT"]
      // Sessions are local times: pinned to the user's time zone when known, otherwise floating.
      : [`DTSTART${tz ? `;TZID=${tz}` : ""}:${compact(e.start)}00`, `DTEND${tz ? `;TZID=${tz}` : ""}:${compact(addHours(e.start, SESSION_HOURS))}00`]),
    `SUMMARY:${text(e.summary)}`, ...(e.description ? [`DESCRIPTION:${text(e.description)}`] : []), "END:VEVENT",
  ]);
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Freelancers Manager//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${text(`Freelancers Manager · ${data.me.name}`)}`, ...(tz ? [`X-WR-TIMEZONE:${tz}`] : []),
    "X-PUBLISHED-TTL:PT3H", "REFRESH-INTERVAL;VALUE=DURATION:PT3H",
    ...lines, "END:VCALENDAR",
  ].map(fold).join("\r\n") + "\r\n";
}
