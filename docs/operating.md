# Running oinbox

This guide is for the person who runs the mail server. It covers what oinbox needs, how to install it next to Stalwart, and what to do on upgrade day.

oinbox is a set of static files. It has no server of its own and stores nothing on yours: all mail, calendars and settings live in Stalwart, which oinbox talks to over JMAP from the user's browser.

## What you need

- **Stalwart 0.16.23**, the version oinbox is tested against. Later 0.16 releases should work; other series are untested.
- **A full-text search store** in Stalwart. oinbox is tested with Meilisearch 1.54. Without one, search in oinbox returns nothing useful; reading and sending mail still work.
- **A reverse proxy** on the public HTTPS port that serves oinbox's files and forwards Stalwart's paths. The release image contains Caddy set up for this; nginx works too.
- **A host name** for the service (below, `mail.example.com`) whose DNS already points at the machine, and ports 80 and 443 reachable, so a certificate can be issued.
- For calendars: nothing extra. oinbox shows the calendar when the account has JMAP Calendars, which Stalwart provides.

## How it fits together

```
browser ── https://mail.example.com ──► reverse proxy ─┬─► oinbox's files      (everything else)
                                                       └─► Stalwart :8080       (/jmap, /auth/*, /login, /.well-known/*, /api, /admin)
mail apps and other servers ── 25, 465, 993 ──────────────► Stalwart
```

oinbox must be served from **the same origin as Stalwart**. The browser then makes no cross-origin requests and Stalwart's CORS stays off. Serving oinbox from a different host or a CDN is not supported in this release (see "Not supported").

### What the proxy must do

Whatever proxy you use, it has five jobs. `deploy/routes.caddy` is the reference, shared by the development stack and the production template so the two cannot drift apart; `deploy/examples/nginx.conf` does the same in nginx.

1. **Send Stalwart's paths to Stalwart**: `/.well-known/*`, `/jmap`, `/jmap/*`, `/auth/*`, `/login`, `/device`, `/api/*`, `/admin`, `/admin/*`, `/logo`, `/healthz/*`. The one exception is **`/auth/callback`**, which belongs to oinbox: it is where Stalwart sends the browser back after sign-in.
2. **Remove `WWW-Authenticate` from Stalwart's answers.** Stalwart adds a `Basic` challenge to a 401, and a browser that sees one holds the request open behind its own login prompt instead of letting oinbox handle it.
3. **Stream the push connection.** `/jmap/eventsource/` stays open for as long as the tab does: no buffering, no compression, no short read timeout.
4. **Serve the app with its headers**, falling back to `index.html` for any path that is not a file (the app's routes). The Content-Security-Policy matters: message bodies are shown in frames that inherit it. Add `X-Frame-Options: DENY` to what you proxy to Stalwart as well; its sign-in page sends no such header itself.
5. **Compress the app's files** (the main script is 870 kB plain, 265 kB compressed) and cache `/assets/*` for a year; never cache `index.html`.

## Install with Docker Compose

`deploy/production/` is a complete template: Stalwart, Meilisearch, and oinbox behind Caddy with automatic HTTPS.

1. **Copy the template** to the server and enter it:

   ```sh
   git clone https://github.com/One-Learning-Community/oinbox.git
   cd oinbox/deploy/production
   cp .env.example .env
   ```

2. **Fill in `.env`**: the host name (`OINBOX_DOMAIN`), your mail domain (`MAIL_DOMAIN`), a contact address for the certificate authority, the oinbox version, a Meilisearch key (`openssl rand -hex 32`) and Stalwart's recovery admin as `user:password`. Keep this file private.

3. **Start it**:

   ```sh
   docker compose up -d
   ```

   Caddy asks Let's Encrypt for a certificate on first start. That needs DNS for the host name to point here and ports 80 and 443 to be open.

4. **Apply the settings**:

   ```sh
   ./apply.sh
   ```

   This waits for the certificate, then fills your values into `plan.ndjson` and applies it with Stalwart's command line. It is safe to run again. What it sets:

   - your mail domain, and the host name the server announces;
   - Meilisearch as the search store;
   - CORS off, and trust in the proxy's `X-Forwarded-For`;
   - OAuth: client registration required, and the `oinbox` client registered as a public client with the single redirect `https://mail.example.com/auth/callback` (plus Stalwart's own WebUI client, which registration then needs);
   - the certificate for SMTP and IMAP (see "Certificates").

   If you prefer Stalwart's WebUI, make the same settings there; the file is short and readable.

5. **Create accounts** in Stalwart's WebUI at `https://mail.example.com/admin/`, signed in as the recovery admin.

6. **Set up DNS for mail** (MX, SPF, DKIM, DMARC) as Stalwart's documentation describes. oinbox has no part in this, but mail will not flow without it.

### Certificates

Caddy obtains and renews one certificate for the host name. Stalwart needs the same certificate for SMTP (25, with STARTTLS), submission (465) and IMAP (993), and cannot ask for its own while Caddy holds ports 80 and 443. So:

- a small `cert-sync` service copies Caddy's certificate to a volume Stalwart can read (Caddy keeps its own copy readable by root only), at start and twice a day;
- Stalwart's `Certificate` setting points at that copy;
- Stalwart re-reads it only when told. **After a renewal, run `./apply.sh --reload-tls`.** Certificates are renewed about every 60 days, so a monthly cron job covers it:

  ```cron
  0 4 1 * * cd /path/to/oinbox/deploy/production && ./apply.sh --reload-tls
  ```

Check what the mail ports present with:

```sh
openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null | openssl x509 -noout -subject -dates
openssl s_client -connect mail.example.com:25 -starttls smtp -servername mail.example.com </dev/null | openssl x509 -noout -dates
```

This arrangement was tested with Caddy's local certificate authority, not against Let's Encrypt itself; the difference is only where Caddy gets the certificate from.

## Install behind a proxy you already run

1. Download `oinbox-<version>.tar.gz` from the release page and check it against `SHA256SUMS`.
2. Unpack it where your proxy can serve it, for example `/srv/oinbox/dist`.
3. Configure the proxy to do the five jobs above. Start from `deploy/examples/nginx.conf` (with `oinbox-headers.conf` beside it) or from `deploy/routes.caddy`.
4. In Stalwart, make the settings listed under step 4 above. The two that matter most: the `oinbox` OAuth client with redirect `https://<your host>/auth/callback`, and Stalwart's public URL (`STALWART_PUBLIC_URL`) set to `https://<your host>`, since every URL it hands to the browser is built from it.

## First sign-in

Open `https://mail.example.com/`. You should see oinbox's "Sign in" card; the button takes you to Stalwart's sign-in page and back to the inbox.

If it does not work:

| What you see | Likely cause |
|---|---|
| The browser's own username and password box | The proxy is not removing `WWW-Authenticate` (job 2). |
| "Sign-in failed" after Stalwart's page, or Stalwart refuses the request | The `oinbox` client is not registered, or its redirect URI is not exactly `https://<host>/auth/callback`. |
| Sign-in works, then the inbox never loads | `STALWART_PUBLIC_URL` is not the public origin, so the browser is sent to an address it cannot reach or that is a different origin. |
| A blank page | The proxy is sending `/auth/callback` to Stalwart, or is not falling back to `index.html`. |
| New mail appears only after a reload | The proxy is buffering the push connection (job 3). |
| Search finds nothing, or misses recent mail | No search store, or its index is behind: Stalwart indexes shortly after delivery, not at once. |

The version is shown at the bottom of Settings (`oinbox 0.1.0-beta.1 (abc1234)`); quote it in bug reports.

## Upgrading

- **With the image**: change `OINBOX_VERSION` in `.env`, then `docker compose pull oinbox && docker compose up -d oinbox`.
- **With the tarball**: unpack the new release over the old one (or beside it, and switch the proxy's root).

Nothing else changes: there is no database to migrate. Script and style files have new names in every release and `index.html` is never cached, so people get the new version the next time they load the page. A tab left open across an upgrade keeps running the old version; if it then needs a part it had not loaded yet, it says "oinbox was updated. Reload to continue."

Read the changelog before upgrading Stalwart itself: oinbox depends on details of its JMAP behaviour, and a release is tested against one Stalwart version.

## Backup

oinbox has nothing to back up. Back up **Stalwart** (its data volume and settings) as its documentation describes, and the search index if rebuilding it would take long.

In the browser, oinbox keeps: the sign-in tokens, a small cache of the first page of the mailbox for fast start-up, the list of senders whose images you allowed, a few preferences, and, only after being signed out mid-draft, that draft's text for up to seven days. Signing out removes the tokens, the cache and any saved draft.

## Limits worth knowing

These are Stalwart defaults that users of a web client run into:

- **Attachments: 50 MB and 1,000 uploads per account per hour** (`Jmap.uploadQuota`, `Jmap.maxUploadCount`), on top of the 50 MB per file limit. Raise them if people send large files.
- **1,000 requests a minute per account** (`Http.rateLimitAuthenticated`). Ordinary use stays far below it.
- **Inbound mail is throttled** to 25 messages an hour per sender and recipient by default, and Stalwart restores those throttles at start-up when there are none.
- **Large mailboxes are slow to list.** On an account with 50,000 messages, each page of a mail list took Stalwart about 1.4 seconds in our tests (`docs/beta-audit.md`, L2).

## What signs people out

- **Setting an account's password.** Stalwart derives its token keys from the password hash, so every session of that account ends. This includes re-applying an account definition that carries a password.
- **Replacing Stalwart's data** (a new volume): it generates a new signing key.

Restarting Stalwart, reloading its settings, and upgrading oinbox do not sign anyone out. When a session does end, oinbox says so in place and keeps what was being written.

## Not supported in this release

- **A separate origin or a CDN.** Stalwart's CORS setting is all or nothing (`Http.usePermissiveCors` allows every origin), oinbox finds its server at its own origin, and the OAuth redirect and Content-Security-Policy assume one origin. It could be made to work; it has not been tested.
- **More than one Stalwart behind one oinbox**, and accounts on more than one server at once.
- **Anything but Stalwart.** oinbox speaks standard JMAP but leans on Stalwart's behaviour in places.

## Development stack

`deploy/README.md` describes the stack used to build and test oinbox (plain HTTP on `localhost:8080`, seeded test accounts, relaxed settings). It is not a starting point for production.
