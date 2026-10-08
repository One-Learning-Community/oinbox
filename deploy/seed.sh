#!/usr/bin/env bash
# Idempotent bootstrap for the oinbox dev stack.
#   1. applies stalwart/plan.ndjson (domain, OAuth clients, Meilisearch FTS, ...),
#      creates the users from stalwart/accounts.ndjson only if they don't exist yet, and
#      the shared mailbox support@ (stalwart/groups.ndjson) with alice and bob as members
#   2. restarts Stalwart once if the search store had to be switched to Meilisearch
#   3. delivers the seed mail (skipped if already present)
# Requires only docker. Run from anywhere after `docker compose up -d`.
set -euo pipefail
cd "$(dirname "$0")"

NET=oinbox_default
ADMIN_USER=admin
ADMIN_PASS=oinbox-admin-pass
CLI_IMAGE=stalwartlabs/cli:1.0.12
PY_IMAGE=python:3.13.15-alpine

cli() {
  docker run --rm -i --network "$NET" -v "$PWD/stalwart:/work:ro" -w /work \
    -e STALWART_URL=http://stalwart:8080 -e STALWART_USER="$ADMIN_USER" -e STALWART_PASSWORD="$ADMIN_PASS" \
    "$CLI_IMAGE" "$@"
}

wait_healthy() {
  echo "seed: waiting for stalwart to be healthy..."
  for _ in $(seq 1 90); do
    if [ "$(docker compose ps stalwart --format '{{.Health}}' 2>/dev/null)" = "healthy" ] \
       && docker compose exec -T stalwart curl -fsS -o /dev/null http://127.0.0.1:8080/healthz/ready; then
      return 0
    fi
    sleep 2
  done
  echo "seed: stalwart did not become healthy" >&2; exit 1
}

wait_healthy

before=$(cli get SearchStore --json | sed -n 's/.*"@type":"\([A-Za-z]*\)".*/\1/p')
echo "seed: applying stalwart/plan.ndjson (search store before: ${before:-unknown})"
cli apply --file plan.ndjson --quiet

# Accounts are created only when missing. Re-applying an Account re-sets its password,
# and Stalwart derives OAuth token keys from the password hash, so that would revoke
# every open session (e.g. a developer's browser) on each seed / e2e run.
existing=$(cli query Account --json | sed -n 's/.*"emailAddress":"\([^"]*\)".*/\1/p')
missing_ops=""
while IFS= read -r op; do
  [ -z "$op" ] && continue
  name=$(printf '%s' "$op" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  if ! printf '%s\n' "$existing" | grep -qx "$name@example.test"; then
    missing_ops+=$(printf '%s' "$op" | sed 's/"#dom-example"/"#dom-example-acct"/')$'\n'
  fi
done < stalwart/accounts.ndjson
if [ -n "$missing_ops" ]; then
  echo "seed: creating missing accounts"
  { echo '{"@type":"upsert","object":"Domain","matchOn":["name"],"value":{"dom-example-acct":{"name":"example.test"}}}'; printf '%s' "$missing_ops"; } \
    | cli apply --stdin --quiet
else
  echo "seed: accounts already exist (left untouched so existing OAuth sessions stay valid)"
fi
# The shared mailbox: a group, with alice and bob as members. Membership is set with an update that
# carries no credentials, so open sessions survive (re-applying an Account would reset its password).
{ echo '{"@type":"upsert","object":"Domain","matchOn":["name"],"value":{"dom-example-grp":{"name":"example.test"}}}'; cat stalwart/groups.ndjson; } \
  | cli apply --stdin --quiet
accounts_json=$(cli query Account --json)
id_of() { printf '%s\n' "$accounts_json" | grep "\"emailAddress\":\"$1\"" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'; }
group_id=$(id_of support@example.test)
for member in alice bob; do
  # --field adds this group; --json with memberGroupIds would replace the member's other groups.
  cli update Account "$(id_of "$member@example.test")" --field "memberGroupIds/$group_id=true" >/dev/null
done
echo "seed: support@example.test is shared with alice and bob"

# Listener/OAuth/MTA settings are compiled into the running core; rebuild it.
cli create Action/ReloadSettings >/dev/null

if [ "$before" != "Meilisearch" ]; then
  echo "seed: search store changed -> restarting stalwart"
  docker compose restart stalwart >/dev/null
  sleep 3
  wait_healthy
fi

echo "seed: delivering mail"
docker run --rm --network "$NET" -v "$PWD/seed:/seed:ro" "$PY_IMAGE" python3 -u /seed/seed_mail.py

echo "seed: calendar"
docker run --rm --network "$NET" -v "$PWD/seed:/seed:ro" "$PY_IMAGE" python3 -u /seed/seed_calendar.py

echo "seed: done. SPA: http://localhost:8080  users: alice@example.test / bob@example.test  (oinbox-dev-pass)"
