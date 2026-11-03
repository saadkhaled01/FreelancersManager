#!/usr/bin/env bash
# Deploys Freelancers Manager to Railway with the Railway CLI.
# Run from the repo root after `railway login`. Safe to run again: it reuses the project, volume and secret key.
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE="${SERVICE:-freelancers-manager}"

command -v railway >/dev/null || { echo "Install the Railway CLI first: npm i -g @railway/cli"; exit 1; }
railway whoami

# Project: link to an existing one, or create it.
if ! railway status >/dev/null 2>&1; then
  railway init --name "$SERVICE"
fi

# Service: create it the first time, then link this folder to it.
railway add --service "$SERVICE" >/dev/null 2>&1 || true
railway service "$SERVICE"

# The SQLite database lives on a volume, so it survives deploys.
if ! railway volume list 2>/dev/null | grep -q "/data"; then
  railway volume add --mount-path /data
fi

# SECRET_KEY encrypts users' Google tokens. Generate it once and never change it.
if ! railway variables --kv 2>/dev/null | grep -q '^SECRET_KEY='; then
  railway variables --skip-deploys --set "SECRET_KEY=$(openssl rand -base64 48 | tr -d '\n')"
fi
railway variables --skip-deploys --set "DATA_DIR=/data" --set "TRUST_PROXY=1"

# Public domain, then APP_URL from it (reset links, shared documents, Google sign-in).
DOMAIN="$(railway domain 2>&1 | grep -Eo '[a-z0-9-]+(\.[a-z0-9-]+)*\.up\.railway\.app' | head -1 || true)"
if [ -n "$DOMAIN" ]; then
  railway variables --skip-deploys --set "APP_URL=https://$DOMAIN"
fi

railway up --detach
echo
echo "Deploying. App address: https://${DOMAIN:-<see railway domain>}"
echo "Health check: https://${DOMAIN:-<domain>}/healthz"
