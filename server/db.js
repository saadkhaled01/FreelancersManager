import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  business TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'ar',
  currency TEXT NOT NULL DEFAULT 'EGP',
  instapay TEXT NOT NULL DEFAULT '',
  vcash TEXT NOT NULL DEFAULT '',
  deposit_pct INTEGER NOT NULL DEFAULT 50,
  revisions INTEGER NOT NULL DEFAULT 3,
  templates TEXT NOT NULL DEFAULT '{}',
  next_code INTEGER NOT NULL DEFAULT 1001,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clients(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'ar',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER REFERENCES clients(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  start_date TEXT,
  due_date TEXT,
  fee REAL NOT NULL DEFAULT 0,
  revisions_allowed INTEGER NOT NULL DEFAULT 3,
  revisions_used INTEGER NOT NULL DEFAULT 0,
  links TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  status_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliverables(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'extra',
  label TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  due_date TEXT,
  paid_at TEXT,
  method TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS reset_tokens(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clients_user ON clients(user_id);
CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS deliverables_user ON deliverables(user_id);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, at);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`;

/* Schema changes after the first release. Each runs once, in order; PRAGMA user_version records how many have run. */
const MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN cal_token TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS users_cal_token ON users(cal_token)",
  "ALTER TABLE projects ADD COLUMN session_at TEXT",
  "ALTER TABLE projects ADD COLUMN folder_url TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN tz TEXT NOT NULL DEFAULT ''",
  `CREATE TABLE IF NOT EXISTS google(
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    refresh_token TEXT NOT NULL,
    access_token TEXT NOT NULL DEFAULT '',
    access_expires INTEGER NOT NULL DEFAULT 0,
    calendar_id TEXT NOT NULL DEFAULT '',
    connected_at TEXT NOT NULL,
    last_sync TEXT,
    last_error TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS gcal_events(
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    event_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY(user_id, uid)
  )`,
  "ALTER TABLE users ADD COLUMN brand TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE users ADD COLUMN logo TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE projects ADD COLUMN share_token TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS projects_share_token ON projects(share_token)",
  `CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS items_user ON items(user_id)",
  "ALTER TABLE projects ADD COLUMN discount REAL NOT NULL DEFAULT 0",
  "ALTER TABLE projects ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0",
  "ALTER TABLE projects ADD COLUMN accepted_at TEXT",
  "ALTER TABLE projects ADD COLUMN accepted_by TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE projects ADD COLUMN accepted_ip TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN reminders TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE users ADD COLUMN last_daily TEXT",
  "ALTER TABLE payments ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE payments ADD COLUMN last_reminder TEXT",
  "ALTER TABLE payments ADD COLUMN before_sent INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE projects ADD COLUMN no_reminders INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE projects ADD COLUMN repeat TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE projects ADD COLUMN repeat_next TEXT",
  "ALTER TABLE projects ADD COLUMN repeat_until TEXT",
  "ALTER TABLE projects ADD COLUMN series_id INTEGER",
  `CREATE TABLE IF NOT EXISTS expenses(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    label TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    amount REAL NOT NULL,
    spent_on TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    repeat TEXT NOT NULL DEFAULT '',
    repeat_next TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS expenses_user ON expenses(user_id, spent_on)",
];

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  const done = db.prepare("PRAGMA user_version").get().user_version;
  for (let i = done; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
