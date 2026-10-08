# oinbox dev stack

> This is the stack oinbox is built and tested on: plain HTTP, seeded test accounts, relaxed mail checks. **For a real installation use `production/` and [docs/operating.md](../docs/operating.md).**

Stalwart 0.16.23 (JMAP + SMTP), Meilisearch 1.54.0 (Stalwart's full-text search store) and the app. The `caddy` service is built from the repo-root `Dockerfile`: `pnpm build` output served by Caddy 2.11.4, which also proxies Stalwart on the same origin, **http://localhost:8080**.

## Run

```sh
cd deploy
docker compose up -d --build   # builds the app image (no local node/pnpm needed)
./seed.sh                      # idempotent; safe to re-run
```

### Serving a local build instead (fast iteration, e2e)

The image bakes in `dist/` at build time. To serve your working copy's `pnpm build` output instead, add the override. It mounts the repo read-only and Caddy serves `/srv/oinbox/dist`:

```sh
pnpm build
docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d
```

After that, each `pnpm build` is live on reload, with no restart needed. The e2e suite (`pnpm e2e`) expects this mode and refuses to run against a stale image. The live `Caddyfile` is bind-mounted in both modes; run `docker compose restart caddy` after editing it.

### Vite dev server

`pnpm dev` (http://localhost:5173) can sign in too:

* `http://localhost:5173/auth/callback` is a registered redirect URI of the `oinbox` client.
* The discovery documents and the session still advertise absolute `http://localhost:8080/...` URLs, so the token exchange, JMAP, EventSource, upload and download are cross-origin from :5173.
* The plan therefore enables Stalwart's permissive CORS (`Http.usePermissiveCors=true`, `Access-Control-Allow-Origin: *`) for dev.

`seed.sh` needs only Docker. It does five things:

1. Applies `stalwart/plan.ndjson` with `stalwartlabs/cli:1.0.12 apply`. The plan sets up the domain, OAuth clients, Meilisearch, permissive CORS, console logging, relaxed dev SMTP checks and no spam filter. It then creates the users from `stalwart/accounts.ndjson`, **but only if they don't exist yet**. Re-applying an Account re-sets its password, and Stalwart derives OAuth token keys from the password hash, so that would revoke every open session. Re-running `seed.sh` (or the e2e suite) therefore leaves a developer's browser session signed in.
2. Runs `ReloadSettings`. When the search store has just been switched to Meilisearch, it also restarts Stalwart once.
3. Runs `seed/seed_mail.py` in `python:3.13.15-alpine` on the compose network. The script sends 30 messages in 7 threads plus single messages. Inbound mail goes over SMTP. Alice's own messages are stored with `Email/import` in her Sent mailbox, and the ones addressed to Bob are sent with `EmailSubmission`. Messages already present are skipped by Message-ID.
4. Runs `seed/seed_calendar.py` in the same image. It creates a "Team" calendar next to Alice's default one and seven events in the current week (starting Sunday). The events include an all-day and a multi-day event, one in `Europe/London`, and a weekly series with one occurrence moved (only `start` overridden) and one cancelled. Every run moves the events back into the current week, matched by fixed `uid`s, so nothing is duplicated. It never sends invitations (`sendSchedulingMessages: false`).
5. Prints the URLs and credentials.

A first run takes about 90 seconds, because messages are spaced 1 second apart so that `receivedAt` order matches the conversation order.

Caddy serves `/srv/oinbox/dist` and falls back to `index.html` for unknown paths.

## URLs and credentials

| What | Value |
|---|---|
| SPA | http://localhost:8080/ |
| JMAP session | http://localhost:8080/.well-known/jmap (307 to `/jmap/session`) |
| OAuth metadata | http://localhost:8080/.well-known/oauth-authorization-server and `/.well-known/openid-configuration` |
| Authorize (login page) | http://localhost:8080/login (the page posts JSON to `/api/auth`) |
| Token | http://localhost:8080/auth/token |
| SMTP for tests | `localhost:2525` (plain MTA, no auth, local delivery to `@example.test`) |
| Stalwart WebUI | http://localhost:8080/admin/ |
| Users | `alice@example.test`, `bob@example.test`, and `carol@example.test` (empty; see "Large mailbox"), password `oinbox-dev-pass` |
| Admin | `admin` / `oinbox-admin-pass` (`STALWART_RECOVERY_ADMIN`, for dev only) |
| OAuth client | `client_id=oinbox`, public (no secret), PKCE S256 required. Redirect URIs: `http://localhost:8080/auth/callback` and `http://localhost:5173/auth/callback` |

### Paths proxied to Stalwart

These paths go to Stalwart: `/.well-known/*`, `/jmap`, `/jmap/*`, `/auth/*`, `/login`, `/device`, `/api/*`, `/admin/*`, `/logo` and `/healthz/*`.

The exception is **`/auth/callback`**, which stays with the SPA. Everything else goes to `dist/`. Keep SPA routes clear of the prefixes above.

EventSource streams unbuffered (`flush_interval -1`, no read timeout).

Caddy also strips `WWW-Authenticate` from Stalwart's responses. Otherwise Stalwart's `Basic` challenge on a 401 makes Chrome hold a `fetch()` open behind a native login prompt.

### Settings that matter

* `STALWART_PUBLIC_URL=http://localhost:8080` controls the base of every URL in the JMAP session and in the OAuth/OIDC discovery documents.
* `stalwart/config.json` names only the datastore (RocksDB). In Stalwart 0.16, every other setting lives in the database and is applied from `plan.ndjson`. There is no TOML and no `/api` REST management API any more.
* `OidcProvider.requireClientRegistration=true`: unregistered `client_id`s and unregistered `redirect_uri`s are rejected. The WebUI's `stalwart-webui` client is registered too.

## Proxy routing

`routes.caddy` holds the routing and headers as a Caddy snippet (`oinbox_routes`). The dev `Caddyfile` and `production/Caddyfile` both import it, so the paths below and the security headers are the same in both. `examples/nginx.conf` is the same thing for nginx, tested in place of this stack's Caddy.

## Testing the production template

`production/` can be started on a machine with no public name: `ci.override.yml` builds the app from this checkout, uses Caddy's local certificate authority, and moves the ports to 8443 (HTTPS), 8081 (HTTP), 2526, 4465 and 4993, clear of this stack. `ci.env` holds throwaway values. From `deploy/production`:

```sh
export ENV_FILE=ci.env COMPOSE_ARGS="-p oinbox-prod -f docker-compose.yml -f ci.override.yml" PUBLIC_ORIGIN=https://localhost:8443
docker compose --env-file ci.env $COMPOSE_ARGS up -d --build --wait
./apply.sh && ./create-test-user.sh
(cd ../.. && pnpm e2e:production)       # sign-in over HTTPS, headers, no CORS, TLS on the mail ports
docker compose --env-file ci.env $COMPOSE_ARGS down -v
```

CI runs exactly this as the "Production template" job.

## Large mailbox (carol)

`carol@example.test` (same password) is an empty third account for the large-mailbox measurements in `e2e/perf.spec.ts`. `seed/seed_bulk.py` fills it with real mail from the CMU Enron corpus through `Email/import`:

1. Download and extract the corpus from https://www.cs.cmu.edu/~enron/ (about 1.7 GB extracted). Keep it outside this repository.
2. Import, from `deploy/`:

   ```sh
   docker run --rm --network oinbox_default -v "$PWD/seed:/seed:ro" -v "/path/to/enron/maildir:/corpus:ro" \
     python:3.13.15-alpine python3 -u /seed/seed_bulk.py --source /corpus --count 50000
   ```

   `--count` is the target size of the mailbox and `--spread-days` (default 730) the span the messages are re-dated across. The script skips Message-IDs carol already has, so it can be stopped and run again. Try `--count 2000` first. Stalwart's default limit of 1000 requests a minute per account sets the pace (the script waits when it gets a 429), so 50,000 messages take about an hour.
3. Measure: `pnpm build && pnpm e2e:perf` (about 15 minutes; `PERF_QUICK=1` shortens the heap test). Results are printed and written to `test-results/perf.json`.

Corpus folders become the Inbox, Sent Items and up to 20 labels. `docker compose down -v` removes the mailbox with everything else.

## Useful commands

```sh
docker compose logs -f stalwart
# run any CLI command against the stack:
docker run --rm --network oinbox_default -e STALWART_URL=http://stalwart:8080 \
  -e STALWART_USER=admin -e STALWART_PASSWORD=oinbox-admin-pass stalwartlabs/cli:1.0.12 query Account
# JMAP with Basic auth (works; handy for e2e tests):
curl -u alice@example.test:oinbox-dev-pass http://localhost:8080/jmap/session
```

## Tear down

```sh
docker compose down        # stop, keep data
docker compose down -v     # stop and wipe mail, config and search index (re-run ./seed.sh afterwards)
```

### What signs you out

Existing OAuth tokens become invalid when:

* **An account's password is set.** Token keys are derived from the password hash. Before this fix, `seed.sh` did this on every run.
* **The OIDC encryption key changes.** This happens with `down -v`, because a fresh install generates a new key.

`ReloadSettings`, re-applying the rest of the plan, and restarting containers do *not* invalidate tokens. I verified each of these.

Account and object ids are server-assigned; after `down -v` Alice is `b` and Bob is `c` again, but don't hard-code them.
