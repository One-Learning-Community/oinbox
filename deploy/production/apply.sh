#!/usr/bin/env bash
# Apply the settings in plan.ndjson to the running Stalwart, with the values from the environment
# file filled in, and point Stalwart at the certificate Caddy obtained.
#   ./apply.sh               apply the settings (safe to run again)
#   ./apply.sh --reload-tls  only make Stalwart re-read the certificate (run after Caddy renews it)
# Needs only Docker. See docs/operating.md.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${ENV_FILE:-.env}"
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

: "${OINBOX_DOMAIN:?set OINBOX_DOMAIN}" "${MAIL_DOMAIN:?set MAIL_DOMAIN}" "${STALWART_RECOVERY_ADMIN:?set STALWART_RECOVERY_ADMIN}"
export STALWART_ADMIN_USER="${STALWART_RECOVERY_ADMIN%%:*}" STALWART_ADMIN_PASSWORD="${STALWART_RECOVERY_ADMIN#*:}"
# COMPOSE_ARGS: extra `docker compose` arguments, e.g. "-f docker-compose.yml -f ci.override.yml".
compose() { docker compose --env-file "$ENV_FILE" ${COMPOSE_ARGS:-} "$@"; }
cli() { compose run --rm -T cli "$@"; }
# Where browsers reach oinbox. Only a test on a non-standard port needs to set this.
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://$OINBOX_DOMAIN}"
# The name the mail server announces itself by. Only a test on "localhost" needs to set this.
MAIL_HOSTNAME="${MAIL_HOSTNAME:-$OINBOX_DOMAIN}"
render() { sed -e "s#__PUBLIC_ORIGIN__#$PUBLIC_ORIGIN#g" -e "s/__MAIL_HOSTNAME__/$MAIL_HOSTNAME/g" -e "s/__OINBOX_DOMAIN__/$OINBOX_DOMAIN/g" -e "s/__MAIL_DOMAIN__/$MAIL_DOMAIN/g" "$1"; }

if [ "${1:-}" = "--reload-tls" ]; then
  cli create Action/ReloadTlsCertificates >/dev/null
  echo "apply: Stalwart re-read its certificate"
  exit 0
fi

# Where the cert-sync service puts the copy Stalwart reads (docker-compose.yml).
cert="/certs/tls.crt"
echo "apply: waiting for Caddy's certificate for $OINBOX_DOMAIN"
found=""
for _ in $(seq 60); do
  if compose exec -T stalwart test -r "$cert"; then found=1; break; fi
  sleep 5
done
if [ -z "$found" ]; then
  echo "apply: Caddy has no certificate for $OINBOX_DOMAIN yet." >&2
  echo "       Is DNS for $OINBOX_DOMAIN pointing here, and are ports 80 and 443 open? See: docker compose logs oinbox cert-sync" >&2
  exit 1
fi

store_type() { cli get SearchStore --json | sed -n 's/.*"@type":"\([A-Za-z]*\)".*/\1/p' | tail -1; }
store_before=$(store_type)
render plan.ndjson | cli apply --stdin --quiet
# Stalwart's certificate for SMTP and IMAP: the files Caddy keeps renewed. Created once.
if ! cli query Certificate --json | grep -q '"id"'; then
  render certificate.ndjson | cli apply --stdin --quiet
fi
cli create Action/ReloadSettings >/dev/null
cli create Action/ReloadTlsCertificates >/dev/null
# The search store is read when Stalwart starts: a first run, or a move from another store, needs
# a restart, and whatever is already stored has to be put into the new, empty index.
if [ "$store_before" != "$(store_type)" ]; then
  echo "apply: the search store changed (was: ${store_before:-none}); restarting Stalwart"
  compose restart stalwart >/dev/null
  ready=""
  for _ in $(seq 60); do
    if compose exec -T stalwart curl -fsS -o /dev/null http://127.0.0.1:8080/healthz/ready 2>/dev/null; then ready=1; break; fi
    sleep 3
  done
  [ -n "$ready" ] || { echo "apply: Stalwart did not come back after the restart. See: docker compose logs stalwart" >&2; exit 1; }
  cli create Task/StoreMaintenance --field maintenanceType=reindexAccounts >/dev/null
  echo "apply: Stalwart is indexing what it already holds; search finds older mail in a few minutes"
fi
echo "apply: done. Create accounts at $PUBLIC_ORIGIN/admin/ and then open $PUBLIC_ORIGIN/"
