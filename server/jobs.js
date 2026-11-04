/* Daily jobs, run once a day per user at 9:00 in their own time zone:
   - create the next project of each recurring series whose date has come (catching up if the server was down)
   - email clients payment reminders, when the user turned that on (before the due date, then every N days, up to a limit)
   - email the user a short summary of what's overdue, due this week, created and sent
   Email needs RESEND_API_KEY + MAIL_FROM and APP_URL; without them only the recurring projects run. */
import { addPeriod, daysBetween, fillText, normalizeReminders } from "../app/doc-data.js";
import { STR, TEMPLATES } from "../app/i18n.js";
import { docEmail, digestEmail } from "./mail.js";
import { log } from "./model.js";

export const RUN_HOUR = 9;

/* The user's local date and hour, from their IANA time zone (UTC if unset). */
export function localNow(tz, at = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  } catch {
    return localNow("UTC", at);
  }
  const g = t => parts.find(p => p.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) };
}

export class JobError extends Error {}

export function createJobs({ db, mailer, appUrl, buildDoc, shareToken, repeatProject }) {
  const canEmail = () => mailer.configured && !!appUrl;
  const base = () => appUrl.replace(/\/$/, "");
  const firstName = s => String(s || "").split(/\s+[—-]\s+|\s+/)[0];

  /* One payment reminder to the client: their language, the user's own reminder wording, a link to the invoice. */
  async function sendReminder(userId, paymentId, date, { upcoming = false, manual = false } = {}) {
    if (!canEmail()) throw new JobError("mail_unavailable");
    const pay = db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").get(paymentId, userId);
    const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(pay.project_id);
    const c = p.client_id ? db.prepare("SELECT * FROM clients WHERE id = ?").get(p.client_id) : null;
    if (!c?.email) throw new JobError("no_client_email");
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    const lang = c.lang || u.lang;
    const cur = STR[lang]["cur_" + u.currency] || u.currency;
    const money = n => `${(Math.round(n * 100) / 100).toLocaleString("en-US")} ${cur}`;
    const tpl = JSON.parse(u.templates || "{}").reminder?.[lang] || TEMPLATES[lang].reminder;
    const message = fillText(tpl, {
      client: firstName(c.name), project: p.title, code: p.code, amount: money(pay.amount),
      instapay: u.instapay, vcash: u.vcash, me: u.business || u.name, link: "", due: pay.due_date || "",
    });
    const token = shareToken(userId, p.id);
    const msg = docEmail({
      lang, doc: buildDoc(userId, p.id), message, greet: false,
      link: `${base()}/d/${token}?lang=${lang}`,
      logoUrl: u.logo ? `${base()}/api/public/doc/${token}/logo` : "",
      subjectPrefix: STR[lang][upcoming ? "reminder_soon_subject" : "reminder_subject"],
    });
    await mailer.send({ to: c.email, replyTo: u.email, ...msg });
    if (upcoming) db.prepare("UPDATE payments SET before_sent = 1 WHERE id = ?").run(pay.id);
    else db.prepare("UPDATE payments SET reminders_sent = reminders_sent + 1, last_reminder = ? WHERE id = ?").run(date, pay.id);
    log(db, userId, p.id, "reminder", { amount: pay.amount, to: c.email, upcoming, auto: !manual, n: upcoming ? 0 : pay.reminders_sent + 1 });
    return { paymentId: pay.id, to: c.email, upcoming };
  }

  async function runUser(u, date) {
    const out = { created: [], sent: [], overdue: [], soon: [] };

    // Recurring projects: every cycle whose start date has come, up to the series' end date.
    const series = db.prepare("SELECT id, repeat, repeat_next, repeat_until FROM projects WHERE user_id = ? AND repeat != '' AND repeat_next IS NOT NULL AND repeat_next <= ?").all(u.id, date);
    for (const s of series) {
      let next = s.repeat_next;
      for (let i = 0; i < 24 && next <= date && (!s.repeat_until || next <= s.repeat_until); i++) {
        out.created.push(repeatProject(u.id, s.id, next));
        next = addPeriod(next, s.repeat);
      }
      db.prepare("UPDATE projects SET repeat_next = ? WHERE id = ?").run(next, s.id);
    }

    // Payment reminders.
    const r = normalizeReminders(JSON.parse(u.reminders || "{}"));
    const rows = db.prepare(`SELECT pay.id, pay.amount, pay.due_date, pay.reminders_sent, pay.last_reminder, pay.before_sent,
        p.title, p.code, p.no_reminders, c.email AS client_email, c.name AS client_name
      FROM payments pay JOIN projects p ON p.id = pay.project_id LEFT JOIN clients c ON c.id = p.client_id
      WHERE pay.user_id = ? AND pay.paid_at IS NULL AND pay.due_date IS NOT NULL AND p.status NOT IN ('lead', 'archived')
      ORDER BY pay.due_date`).all(u.id);
    for (const pay of rows) {
      const until = daysBetween(date, pay.due_date); // days until due; negative once late
      if (until < 0) out.overdue.push(pay);
      else if (until <= 7) out.soon.push(pay);
      if (!r.clients || !canEmail() || pay.no_reminders || !pay.client_email) continue;
      const upcoming = r.before > 0 && until >= 0 && until <= r.before && !pay.before_sent;
      const late = until <= -Math.max(1, r.after) && pay.reminders_sent < r.max &&
        (!pay.last_reminder || daysBetween(pay.last_reminder, date) >= r.every);
      if (!upcoming && !late) continue;
      try { out.sent.push({ ...pay, ...(await sendReminder(u.id, pay.id, date, { upcoming })) }); }
      catch (e) { console.error(`Reminder for payment ${pay.id} failed:`, e.message); }
    }

    // The user's own summary, only when there's something in it.
    if (r.digest && mailer.configured && (out.overdue.length || out.soon.length || out.created.length || out.sent.length)) {
      const projects = out.created.length ? db.prepare(`SELECT code, title FROM projects WHERE id IN (${out.created.map(() => "?").join(",")})`).all(...out.created) : [];
      const msg = digestEmail({ lang: u.lang, name: u.name, currency: u.currency, date, appUrl: appUrl ? base() : "", ...out, projects });
      try { await mailer.send({ to: u.email, ...msg }); }
      catch (e) { console.error(`Daily summary for user ${u.id} failed:`, e.message); }
    }
    return out;
  }

  /* Runs every user whose local time has passed RUN_HOUR and who hasn't run today. force: run now regardless. */
  let busy = false;
  async function runAll({ at = new Date(), force = false, userId = null } = {}) {
    if (busy) return {};
    busy = true;
    const results = {};
    try {
      const users = userId ? db.prepare("SELECT * FROM users WHERE id = ?").all(userId) : db.prepare("SELECT * FROM users").all();
      for (const u of users) {
        const { date, hour } = localNow(u.tz, at);
        if (!force && (hour < RUN_HOUR || u.last_daily === date)) continue;
        db.prepare("UPDATE users SET last_daily = ? WHERE id = ?").run(date, u.id); // claim the day first: never run twice
        try { results[u.id] = await runUser(u, date); }
        catch (e) { console.error(`Daily jobs for user ${u.id} failed:`, e); }
      }
    } finally { busy = false; }
    return results;
  }

  return { runAll, sendReminder, canEmail };
}
