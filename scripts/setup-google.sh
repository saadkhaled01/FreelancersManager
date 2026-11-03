#!/usr/bin/env bash
# Prepares a Google Cloud project for Freelancers Manager's Google Calendar sync, with gcloud.
# Run after `gcloud auth login`. Google doesn't let a CLI create OAuth web clients, so the last two steps
# open the console pages to do by hand (about two minutes).
set -euo pipefail
PROJECT_ID="${PROJECT_ID:-freelancers-manager-$(date +%s | tail -c 6)}"
APP_URL="${APP_URL:?Set APP_URL to the deployed address, e.g. APP_URL=https://freelancers-manager.up.railway.app}"

if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --name="Freelancers Manager"
fi
gcloud config set project "$PROJECT_ID"
gcloud services enable calendar-json.googleapis.com

cat <<MSG

Google Cloud project ready: $PROJECT_ID (Calendar API enabled).

1. Consent screen (External), app name "Freelancers Manager", then under Data access add the scope
   https://www.googleapis.com/auth/calendar.app.created
   https://console.cloud.google.com/auth/branding?project=$PROJECT_ID

2. OAuth client: type "Web application", authorised redirect URI:
   ${APP_URL%/}/api/google/callback
   https://console.cloud.google.com/auth/clients/create?project=$PROJECT_ID

3. Put the client's ID and secret on Railway:
   railway variables --set GOOGLE_CLIENT_ID=... --set GOOGLE_CLIENT_SECRET=...

4. Publish the app (Audience → Publish) so access doesn't expire after 7 days.
MSG
