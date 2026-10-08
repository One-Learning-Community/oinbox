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
# The directory Caddy keeps this certificate authority's certificates in (Let's Encrypt by default).
CERT_ISSUER="${CERT_ISSUER:-acme-v02.api.letsencrypt.org-directory}"
export STALWART_ADMIN_USER="${STALWART_RECOVERY_ADMIN%%:*}" STALWART_ADMIN_PASSWORD="${STALWART_RECOVERY_ADMIN#*:}"
# COMPOSE_ARGS: extra `docker compose` arguments, e.g. "-f docker-compose.yml -f ci.override.yml".
compose() { docker compose --env-file "$ENV_FILE" ${COMPOSE_ARGS:-} "$@"; }
cli() { compose run --rm -T cli "$@"; }
# Where browsers reach oinbox. Only a test on a non-standard port needs to set this.
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://$OINBOX_DOMAIN}"
render() { sed -e "s#__PUBLIC_ORIGIN__#$PUBLIC_ORIGIN#g" -e "s/__OINBOX_DOMAIN__/$OINBOX_DOMAIN/g" -e "s/__MAIL_DOMAIN__/$MAIL_DOMAIN/g" -e "s/__CERT_ISSUER__/$CERT_ISSUER/g" "$1"; }

if [ "${1:-}" = "--reload-tls" ]; then
  cli create Action/ReloadTlsCertificates >/dev/null
  echo "apply: Stalwart re-read its certificate"
  exit 0
fi

cert="/caddy-data/caddy/certificates/$CERT_ISSUER/$OINBOX_DOMAIN/$OINBOX_DOMAIN.crt"
echo "apply: waiting for Caddy's certificate for $OINBOX_DOMAIN"
found=""
for _ in $(seq 60); do
  if compose exec -T stalwart test -r "$cert"; then found=1; break; fi
  sleep 5
done
if [ -z "$found" ]; then
  echo "apply: no certificate at $cert." >&2
  echo "       Is DNS for $OINBOX_DOMAIN pointing here, and are ports 80 and 443 open? See: docker compose logs oinbox" >&2
  exit 1
fi

render plan.ndjson | cli apply --stdin --quiet
# Stalwart's certificate for SMTP and IMAP: the files Caddy keeps renewed. Created once.
if ! cli query Certificate --json | grep -q "$OINBOX_DOMAIN"; then
  render certificate.ndjson | cli apply --stdin --quiet
fi
cli create Action/ReloadSettings >/dev/null
cli create Action/ReloadTlsCertificates >/dev/null
echo "apply: done. Create accounts at $PUBLIC_ORIGIN/admin/ and then open $PUBLIC_ORIGIN/"
