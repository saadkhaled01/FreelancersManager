# Freelancers Manager

Projects, clients and payments for freelancers, in Arabic and English. It's a smaller version of Sorah Ops, built on the Sorah Rent design system.

- **Today**: what's due this week, payments to chase, clients who haven't replied, projects past their revision limit.
- **Projects**: laid out like Sorah Ops. Grouped by stage (Brief → Booked → In production → Client review ⇄ Revisions → Delivered → Collecting → Done), with session date and time, due date, days left, an inline stage picker, Drive folder and "Open in Google Calendar" links. Codes look like `FM-2611-003`. Each project has a deliverables checklist, revision rounds, delivery links, notes and an activity log, and can be duplicated for repeat work. A delivered project moves to Done by itself once it's fully paid.
- **Calendar**: a month view of sessions, deadlines, deliverables and payment dates (an agenda list on phones).
- **Google Calendar**: each user can connect their own Google account. The app creates a "Freelancers Manager" calendar and keeps it in sync within seconds of every change. Without that, any user can subscribe to a private calendar link from Google, Apple or Outlook Calendar.
- **Line items**: optionally break a project's price into items (quantity × unit price) with a discount and tax (default rate in Settings, e.g. Egypt's 14% VAT). With items, the fee is calculated.
- **Payments**: deposit and balance are created from the fee; when the fee changes, the unpaid balance absorbs the difference. Overdue payments are flagged automatically.
- **Recurring projects**: a project can repeat weekly, monthly or every 3 months, optionally until a date. On each cycle's date a new project is created (Booked) with the same client, items, deliverables and payments, dates shifted, and the period in its title. "Create next one now" makes the next cycle early. Each cycle links back to its series.
- **Payment reminders**: every morning at 9:00 in the user's time zone, a summary email (overdue, due this week, reminders sent, cycles created) and, if turned on, automatic reminder emails to clients: a heads-up N days before the due date, then from N days late every N days up to a limit. Uses the user's own reminder wording, in the client's language, with a link to the invoice. Projects can opt out. Every unpaid payment also has an "Email reminder" button, and each reminder is logged on the project. Needs email set up.
- **Quote acceptance**: a client opens a shared quote, types their name and ticks "I accept". The project moves from Brief to Booked, the document gets an "Accepted by … on …" stamp, the freelancer is emailed (when email is set up), and it's logged in the project's activity. There's also an "Ask a question on WhatsApp" link to the freelancer.
- **WhatsApp**: ready-made quote, delivery, reminder and thank-you messages, sent in each client's language and editable in Settings.
- **Money**: received vs expected per month, a 6-month chart, and every payment filtered by status and method.
- **Your style**: logo, brand colour, and nine document layouts picked from a gallery of live thumbnails: Classic, Bold header, Minimal, Sidebar, Studio, Corporate (with signature block), Receipt (WhatsApp-screenshot friendly), Letterhead (a letter with subject line and sign-off) and Split. Also an accent style (solid, outline or gradient), a font pairing (Modern, Clean, Elegant), business details, and a client message and footer note in each language. A live preview updates as you edit. The layouts are original to this project (MIT): they share one renderer, so each works in Arabic and English, on phones, in print and in shared links.
- **Branded quotes and invoices**: in Arabic or English, ready to print or save as PDF. **Send** shares a private link (`/d/<token>`) by WhatsApp, by email, or copied. The client sees the document in your branding on any phone, can switch language and save a PDF, and always sees the latest payments. You can stop sharing at any time. With email set up, the server sends a branded email from `MAIL_FROM` with replies going to you; otherwise Send opens your mail app.
- **Accounts**: anyone can sign up. Every user's data is private to them. Password reset by email. Backup and restore as JSON.
- Typography: Alexandria for headings and Readex Pro for text, both drawn for Arabic and Latin together, with IBM Plex Mono for figures. The fonts ship in `app/fonts` (OFL licensed), so nothing loads from Google Fonts and they work offline.
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
| `TRUST_PROXY` | unset | Set to `1` behind a proxy (Railway) so rate limits see each visitor's real IP instead of the proxy's. Don't set it without a proxy, or visitors can fake their IP. |
| `APP_URL` | unset | Public address, e.g. `https://freelancers.example.com`. Reset links are built from it. Required for sending reset emails. |
| `RESEND_API_KEY` | unset | [Resend](https://resend.com) API key for password reset and document emails. |
| `MAIL_FROM` | unset | Sender, e.g. `Freelancers Manager <noreply@yourdomain.com>`. The domain must be verified in Resend. |

| `GOOGLE_CLIENT_ID` | unset | OAuth client for Google Calendar sync (see below). |
| `GOOGLE_CLIENT_SECRET` | unset | Its secret. |
| `SECRET_KEY` | unset | Long random string used to encrypt users' Google tokens. Required for Google sync. If it changes, users must reconnect. |

Without `RESEND_API_KEY` and `MAIL_FROM`, reset emails are printed to the server log instead of sent, so you can pass a link on by hand.

### Limits

Per instance, kept in memory: 10 failed logins per IP and email per 15 minutes, 5 new accounts per IP per hour, 10 reset requests per IP and 3 reset emails per address per hour. Reset links work once and expire after an hour; using one signs the account out everywhere else.

## Clickable demo

`npm run demo:build` writes a static copy of the app to `demo-build/` that runs with no server: `demo/mock-server.js` answers the app's API calls in the browser with the same rules, and keeps data in localStorage. It opens signed in as `demo@example.com` / `demo1234` with example projects. Shared links open an in-app client view; email, Google Calendar, downloads and printing are off.

## Deploy on Railway

1. Create a service from this repo. Railway picks up `railway.json` (start command and `/healthz` health check).
2. Add a **volume** to the service mounted at `/data`, and set `DATA_DIR=/data`. Without a volume the database is wiped on every deploy.
3. Set `TRUST_PROXY=1`.
4. Generate a domain, then set `APP_URL` to it.
5. For password reset emails, add `RESEND_API_KEY` and `MAIL_FROM`.

## Google Calendar sync

Optional. Without it, users still get the calendar link and per-project "Open in Google Calendar" buttons.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. Set up the **OAuth consent screen** (External). Add the scope `https://www.googleapis.com/auth/calendar.app.created`. It only lets the app manage calendars it creates, not the rest of the user's calendar.
3. Under **Credentials**, create an **OAuth client ID** of type *Web application*. Add the redirect URI `<APP_URL>/api/google/callback`.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SECRET_KEY`, plus `APP_URL`.

While the consent screen is in **Testing**, only the test users you list can connect, and Google expires their access after 7 days. Publish the app to remove both limits; Google may ask you to verify it first.

Sync is one-way, app to Google: edits made directly in Google Calendar are overwritten on the next sync. Disconnecting (or deleting the account) removes the calendar from the user's Google account and revokes access.

## Layout

```
server/   Node HTTP server: auth (scrypt + cookie sessions, reset tokens, rate limits), JSON API, email,
          calendar feed (ics.js), Google Calendar sync (google.js), schema migrations (db.js), static files
app/      Front end: vanilla JS, one stylesheet, Arabic/English strings in i18n.js
test/     API tests (node:test)
docs/     The original build plan
```

The front end loads the user's whole dataset once (`GET /api/data`). Every change returns the fresh dataset, so the screen never goes out of sync with the server.
