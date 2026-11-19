#!/usr/bin/env bash
# Sets up and deploys the connected-apps broker (apps/cloudflare/composio-broker) on Metal's own cloudflare account at
# https://composio.dusk.bot. Safe to run again: it creates only what is missing.
#
# Reads ~/.config/duskbot/dusk.env (falls back to cloudflare.env for the cloudflare names):
#   DUSK_COMPOSIO_API_KEY   our Composio project's API key
#   CLOUDFLARE_API_TOKEN    Workers Scripts edit, D1 edit, Workers Routes / custom domains edit on the dusk.bot zone
#   CLOUDFLARE_ACCOUNT_ID
# Adds to dusk.env when missing (mode 600, never printed): DUSK_COMPOSIO_BROKER_GRANT_SECRET,
# DUSK_COMPOSIO_BROKER_STATS_TOKEN, DUSK_COMPOSIO_WEBHOOK_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."
CONF="$HOME/.config/duskbot"
ENV_FILE="$CONF/dusk.env"
CONFIG=apps/cloudflare/composio-broker/wrangler.jsonc
DB=duskbot-composio
URL=https://composio.dusk.bot

umask 077
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
set -a
[ -f "$CONF/cloudflare.env" ] && . "$CONF/cloudflare.env"
. "$ENV_FILE"
set +a
for name in DUSK_COMPOSIO_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [ -n "${!name:-}" ] || { echo "missing $name in $ENV_FILE" >&2; exit 1; }
done

keep() { # name value: append to dusk.env once
  grep -q "^$1=" "$ENV_FILE" || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  export "$1=$2"
}
[ -n "${DUSK_COMPOSIO_BROKER_GRANT_SECRET:-}" ] || keep DUSK_COMPOSIO_BROKER_GRANT_SECRET "$(openssl rand -base64 32)"
[ -n "${DUSK_COMPOSIO_BROKER_STATS_TOKEN:-}" ] || keep DUSK_COMPOSIO_BROKER_STATS_TOKEN "$(openssl rand -hex 32)"

wrangler() { pnpm exec wrangler "$@"; }

echo "1. database"
id=$(wrangler d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(d=>d.name===process.argv[1]);process.stdout.write(r?r.uuid:"")})' "$DB")
if [ -z "$id" ]; then
  wrangler d1 create "$DB" >/dev/null
  id=$(wrangler d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).find(d=>d.name===process.argv[1]).uuid)})' "$DB")
fi
node -e 'const fs=require("fs");const [f,id]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/"database_id": "[^"]*"/,`"database_id": "${id}"`))' "$CONFIG" "$id"
echo "   $DB $id (written to $CONFIG: commit it)"

echo "2. migrations"
wrangler d1 migrations apply "$DB" --remote --config "$CONFIG"

echo "3. Composio webhook subscription"
if [ -z "${DUSK_COMPOSIO_WEBHOOK_SECRET:-}" ]; then
  existing=$(curl -fsS https://backend.composio.dev/api/v3.1/webhook_subscriptions -H "x-api-key: $DUSK_COMPOSIO_API_KEY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String((j.items??j.data??[]).length))})')
  if [ "$existing" = "0" ]; then
    secret=$(curl -fsS -X POST https://backend.composio.dev/api/v3.1/webhook_subscriptions -H "x-api-key: $DUSK_COMPOSIO_API_KEY" -H "content-type: application/json" \
      -d "{\"webhook_url\":\"$URL/v1/composio/webhook\",\"enabled_events\":[\"composio.trigger.message\",\"composio.connected_account.expired\"],\"version\":\"V3\"}" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).secret??"")})')
    [ -n "$secret" ] && keep DUSK_COMPOSIO_WEBHOOK_SECRET "$secret"
  else
    echo "   the project has a subscription already; put its secret in dusk.env as DUSK_COMPOSIO_WEBHOOK_SECRET and run again" >&2
  fi
fi

echo "4. deploy with secrets"
secrets=$(mktemp); trap 'rm -f "$secrets"' EXIT
{
  printf 'COMPOSIO_API_KEY=%s\n' "$DUSK_COMPOSIO_API_KEY"
  printf 'CLOUD_GRANT_SECRET=%s\n' "$DUSK_COMPOSIO_BROKER_GRANT_SECRET"
  printf 'STATS_TOKEN=%s\n' "$DUSK_COMPOSIO_BROKER_STATS_TOKEN"
  [ -n "${DUSK_COMPOSIO_WEBHOOK_SECRET:-}" ] && printf 'COMPOSIO_WEBHOOK_SECRET=%s\n' "$DUSK_COMPOSIO_WEBHOOK_SECRET"
} > "$secrets"
wrangler deploy --config "$CONFIG" --secrets-file "$secrets"

echo "5. check"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "$URL/health" | grep -q '"ready":true'; then echo "   $URL ready"; exit 0; fi
  sleep 6
done
echo "   $URL/health is not ready yet (a new custom domain's certificate can take a few minutes)" >&2
exit 1
