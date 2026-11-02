import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1 };
export const SESSION_DAYS = 60;
export const COOKIE = "fm_sid";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64"), want.length, SCRYPT);
  return crypto.timingSafeEqual(want, got);
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex");

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)").run(sha(token), userId, expires);
  return token;
}

export function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
    return null;
  }
  return row.user_id;
}

export function endSession(db, token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}

export function pruneSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

/* Failed-login throttle: 10 failures per key per 15 minutes. */
const fails = new Map();
const WINDOW = 15 * 60e3, LIMIT = 10;
export function throttled(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.start > WINDOW) { fails.delete(key); return false; }
  return f.n >= LIMIT;
}
export function noteFailure(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.start > WINDOW) fails.set(key, { n: 1, start: Date.now() });
  else f.n++;
}
export function clearFailures(key) { fails.delete(key); }
