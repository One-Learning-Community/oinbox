#!/usr/bin/env bash
# Test helper for the production template: creates one mailbox user so a sign-in can be tried.
# Real accounts are made in Stalwart's WebUI (https://<domain>/admin/); see docs/operating.md.
#   ENV_FILE=ci.env COMPOSE_ARGS="-p oinbox-prod -f docker-compose.yml -f ci.override.yml" ./create-test-user.sh
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${ENV_FILE:-.env}"
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a
export STALWART_ADMIN_USER="${STALWART_RECOVERY_ADMIN%%:*}" STALWART_ADMIN_PASSWORD="${STALWART_RECOVERY_ADMIN#*:}"
NAME="${PROD_TEST_NAME:-prodtest}"
PASSWORD="${PROD_TEST_PASSWORD:-ci-only-user-pass}"

docker compose --env-file "$ENV_FILE" ${COMPOSE_ARGS:-} run --rm -T cli apply --stdin --quiet <<EOF
{"@type":"upsert","object":"Domain","matchOn":["name"],"value":{"dom-mail":{"name":"$MAIL_DOMAIN"}}}
{"@type":"upsert","object":"Account","matchOn":["name","domainId"],"value":{"acct-test":{"@type":"User","name":"$NAME","domainId":"#dom-mail","description":"Template test user","credentials":{"0":{"@type":"Password","secret":"$PASSWORD"}},"roles":{"@type":"User"},"permissions":{"@type":"Inherit"},"encryptionAtRest":{"@type":"Disabled"}}}}
EOF
echo "create-test-user: $NAME@$MAIL_DOMAIN"
