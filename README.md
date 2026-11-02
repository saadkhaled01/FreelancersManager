# Freelancers Manager

Projects, clients and payments for freelancers, in Arabic and English. It's a smaller version of Sorah Ops, built on the Sorah Rent design system.

- **Today**: what's due this week, payments to chase, clients who haven't replied, projects past their revision limit.
- **Projects**: status, due date, deliverables checklist, revision rounds, delivery links, notes and an activity log.
- **Payments**: deposit and balance are created from the fee; overdue payments are flagged automatically.
- **WhatsApp**: ready-made quote, delivery, reminder and thank-you messages, sent in each client's language and editable in Settings.
- **Money**: received vs expected per month, a 6-month chart, and every payment filtered by status and method.
- **Invoices and quotes**: in Arabic or English, ready to print or save as PDF.
- **Accounts**: anyone can sign up. Every user's data is private to them. Backup and restore as JSON.
- Installable as an app (PWA). With no connection it shows your last loaded data read-only.

## Run it

Needs Node 22.5 or newer. No dependencies to install.

```sh
npm start          # http://localhost:3000
npm test           # API tests
```

Data is stored in SQLite at `$DATA_DIR/freelancers.db` (default `./data`).

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Folder for the database |
| `COOKIE_SECURE` | unset | Set to `1` to force `Secure` cookies. They are already secure when the proxy sends `X-Forwarded-Proto: https`. |

## Deploy on Railway

1. Create a service from this repo. Railway picks up `railway.json` (start command and `/healthz` health check).
2. Add a **volume** to the service mounted at `/data`, and set `DATA_DIR=/data`. Without a volume the database is wiped on every deploy.
3. Generate a domain. That's it.

## Layout

```
server/   Node HTTP server: auth (scrypt + cookie sessions), JSON API, static files
app/      Front end: vanilla JS, one stylesheet, Arabic/English strings in i18n.js
test/     API tests (node:test)
docs/     The original build plan
```

The front end loads the user's whole dataset once (`GET /api/data`). Every change returns the fresh dataset, so the screen never goes out of sync with the server.
