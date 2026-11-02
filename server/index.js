import http from "node:http";
import path from "node:path";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const db = openDb(path.join(DATA_DIR, "freelancers.db"));
const server = http.createServer(createApp(db, {
  secureCookies: process.env.COOKIE_SECURE === "1",
  trustProxy: process.env.TRUST_PROXY === "1",
  appUrl: process.env.APP_URL || "",
}));

server.listen(PORT, () => console.log(`Freelancers Manager on http://localhost:${PORT} (data: ${DATA_DIR})`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
