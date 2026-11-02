import crypto from "node:crypto";
import { calendarEvents, addDays, addHours, SESSION_HOURS } from "./ics.js";
import { snapshot, moneyFormatter, now } from "./model.js";

/* Google Calendar sync. Each user connects their own Google account; the app creates a "Freelancers Manager"
   calendar there and keeps it matching the user's due dates. The calendar.app.created scope only lets the app
   touch calendars it created, never the rest of the user's calendar. Sync is one-way: app → Google. */
export const SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const DEFAULTS = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  apiBase: "https://www.googleapis.com/calendar/v3",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  syncDelay: 1500,
};

class GoogleError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createGoogle(db, cfg = {}) {
  if (!cfg.clientId || !cfg.clientSecret || !cfg.secretKey || !cfg.appUrl) {
    return { available: false, schedule() {}, status: () => ({ available: false, connected: false }) };
  }
  const o = { ...DEFAULTS, ...cfg };
  const redirectUri = `${o.appUrl.replace(/\/$/, "")}/api/google/callback`;

  /* Refresh tokens are stored encrypted (AES-256-GCM) with a key derived from SECRET_KEY. */
  const key = crypto.createHash("sha256").update(o.secretKey).digest();
  const seal = s => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
  };
  const unseal = s => {
    const [iv, tag, enc] = s.split(".").map(b => Buffer.from(b, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  };

  const row = userId => db.prepare("SELECT * FROM google WHERE user_id = ?").get(userId);
  const setRow = (userId, values) => {
    const cols = Object.keys(values);
    db.prepare(`UPDATE google SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE user_id = ?`).run(...cols.map(c => values[c]), userId);
  };

  async function tokenRequest(params) {
    const r = await fetch(o.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, ...params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new GoogleError(r.status, j.error || "token_error");
    return j;
  }

  async function accessToken(userId, force = false) {
    const g = row(userId);
    if (!g) throw new GoogleError(0, "not_connected");
    if (!force && g.access_token && g.access_expires > Date.now() + 60e3) return unseal(g.access_token);
    const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: unseal(g.refresh_token) });
    setRow(userId, { access_token: seal(j.access_token), access_expires: Date.now() + (j.expires_in || 3600) * 1000 });
    return j.access_token;
  }

  async function call(userId, method, path, body, retried = false) {
    const r = await fetch(o.apiBase + path, {
      method,
      headers: { Authorization: `Bearer ${await accessToken(userId, retried)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && !retried) return call(userId, method, path, body, true);
    if (!r.ok) throw new GoogleError(r.status, `${method} ${path.split("?")[0]} → ${r.status}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  const userInfo = userId => db.prepare("SELECT tz, lang, currency FROM users WHERE id = ?").get(userId);

  async function createCalendar(userId) {
    const u = userInfo(userId);
    const cal = await call(userId, "POST", "/calendars", {
      summary: "Freelancers Manager",
      description: u.lang === "ar" ? "مواعيد التصوير والتسليم والدفعات من Freelancers Manager." : "Sessions, deadlines and payments from Freelancers Manager.",
      timeZone: u.tz || "UTC",
    });
    db.prepare("DELETE FROM gcal_events WHERE user_id = ?").run(userId);
    setRow(userId, { calendar_id: cal.id });
    return cal.id;
  }

  function toGoogle(e, tz) {
    const base = { summary: e.summary, description: e.description || "", extendedProperties: { private: { fm: e.uid } } };
    if (e.date) return { ...base, start: { date: e.date }, end: { date: addDays(e.date, 1) }, transparency: "transparent" };
    return { ...base, start: { dateTime: `${e.start}:00`, timeZone: tz }, end: { dateTime: `${addHours(e.start, SESSION_HOURS)}:00`, timeZone: tz } };
  }

  async function syncNow(userId, retried = false) {
    const g = row(userId);
    if (!g) return;
    const u = userInfo(userId);
    const cal = encodeURIComponent(g.calendar_id);
    const desired = new Map(calendarEvents(snapshot(db, userId), moneyFormatter(u)).map(e => [e.uid, toGoogle(e, u.tz || "UTC")]));
    const have = new Map(db.prepare("SELECT uid, event_id, hash FROM gcal_events WHERE user_id = ?").all(userId).map(r => [r.uid, r]));
    const save = db.prepare("INSERT INTO gcal_events(user_id, uid, event_id, hash) VALUES(?,?,?,?) ON CONFLICT(user_id, uid) DO UPDATE SET event_id = excluded.event_id, hash = excluded.hash");
    try {
      await call(userId, "GET", `/calendars/${cal}`); // 404 here means the user deleted the calendar in Google
      for (const [uid, body] of desired) {
        const hash = crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex");
        const h = have.get(uid);
        if (h && h.hash === hash) continue;
        let ev = null;
        if (h) {
          try { ev = await call(userId, "PUT", `/calendars/${cal}/events/${encodeURIComponent(h.event_id)}`, body); }
          catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
        }
        if (!ev) ev = await call(userId, "POST", `/calendars/${cal}/events`, body);
        save.run(userId, uid, ev.id, hash);
      }
      for (const [uid, h] of have) {
        if (desired.has(uid)) continue;
        try { await call(userId, "DELETE", `/calendars/${cal}/events/${encodeURIComponent(h.event_id)}`); }
        catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
        db.prepare("DELETE FROM gcal_events WHERE user_id = ? AND uid = ?").run(userId, uid);
      }
      setRow(userId, { last_sync: now(), last_error: "" });
    } catch (e) {
      // The user deleted the calendar in Google: make a new one and start over, once.
      if (e.status === 404 && !retried) {
        await createCalendar(userId);
        return syncNow(userId, true);
      }
      setRow(userId, { last_error: e.message === "invalid_grant" ? "revoked" : "sync_failed" });
      console.error(`Google sync failed for user ${userId}:`, e.message);
    }
  }

  /* One sync at a time per user; edits made while one runs trigger another afterwards. */
  const running = new Map(), timers = new Map();
  function sync(userId) {
    const prev = running.get(userId) || Promise.resolve();
    const next = prev.then(() => syncNow(userId)).catch(e => console.error("Google sync:", e.message));
    running.set(userId, next);
    next.finally(() => { if (running.get(userId) === next) running.delete(userId); });
    return next;
  }

  return {
    available: true,
    authUrl(state) {
      const q = new URLSearchParams({
        client_id: o.clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
      });
      return `${o.authUrl}?${q}`;
    },
    async connect(userId, code) {
      const j = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
      if (!j.refresh_token) throw new GoogleError(400, "no_refresh_token");
      db.prepare("DELETE FROM google WHERE user_id = ?").run(userId);
      db.prepare("INSERT INTO google(user_id, refresh_token, access_token, access_expires, connected_at) VALUES(?,?,?,?,?)")
        .run(userId, seal(j.refresh_token), seal(j.access_token), Date.now() + (j.expires_in || 3600) * 1000, now());
      await createCalendar(userId);
      sync(userId);
    },
    sync,
    schedule(userId) {
      if (!row(userId)) return;
      clearTimeout(timers.get(userId));
      const timer = setTimeout(() => { timers.delete(userId); sync(userId); }, o.syncDelay);
      timer.unref?.();
      timers.set(userId, timer);
    },
    /* Removes the app's calendar from Google, revokes access, and forgets the tokens. Google errors don't block it. */
    async disconnect(userId) {
      const g = row(userId);
      if (!g) return;
      await running.get(userId);
      try { if (g.calendar_id) await call(userId, "DELETE", `/calendars/${encodeURIComponent(g.calendar_id)}`); } catch { /* already gone */ }
      try { await fetch(`${o.revokeUrl}?token=${encodeURIComponent(unseal(g.refresh_token))}`, { method: "POST" }); } catch { /* best effort */ }
      db.prepare("DELETE FROM gcal_events WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM google WHERE user_id = ?").run(userId);
    },
    status(userId) {
      const g = row(userId);
      return g
        ? { available: true, connected: true, connectedAt: g.connected_at, lastSync: g.last_sync, lastError: g.last_error }
        : { available: true, connected: false };
    },
  };
}
