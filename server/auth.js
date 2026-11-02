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

/* In-memory fixed-window rate limiter. Fine for a single instance; counts reset on restart. */
export class Limiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  #entry(key) {
    const e = this.hits.get(key);
    if (e && Date.now() - e.start <= this.windowMs) return e;
    if (this.hits.size > 10000) this.hits.clear();
    return null;
  }
  blocked(key) { return (this.#entry(key)?.n ?? 0) >= this.limit; }
  hit(key) {
    const e = this.#entry(key);
    if (e) e.n++;
    else this.hits.set(key, { n: 1, start: Date.now() });
  }
  clear(key) { this.hits.delete(key); }
}

/* Password reset tokens: random, stored hashed, single use, 1 hour. */
export const RESET_MINUTES = 60;
export function createResetToken(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM reset_tokens WHERE user_id = ? OR expires_at < ?").run(userId, Date.now());
  db.prepare("INSERT INTO reset_tokens(token_hash, user_id, expires_at) VALUES(?,?,?)")
    .run(sha(token), userId, Date.now() + RESET_MINUTES * 60e3);
  return token;
}
export function useResetToken(db, token) {
  if (typeof token !== "string" || token.length > 100) return null;
  const row = db.prepare("SELECT user_id, expires_at FROM reset_tokens WHERE token_hash = ?").get(sha(token));
  if (!row) return null;
  db.prepare("DELETE FROM reset_tokens WHERE user_id = ?").run(row.user_id);
  return row.expires_at < Date.now() ? null : row.user_id;
}
