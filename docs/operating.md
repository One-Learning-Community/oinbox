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

5. **Create accounts** in Stalwart's WebUI at `https://mail.example.com/admin/`, signed in as the recovery admin. Note that `/admin` and `/api` are reachable from the internet on this host, protected by that password alone: make it a long random one, or restrict those two paths in the proxy to the addresses you administer from.

6. **Set up DNS for mail** (MX, SPF, DKIM, DMARC) as Stalwart's documentation describes. oinbox has no part in this, but mail will not flow without it.

### Certificates

Caddy obtains and renews one certificate for the host name. Stalwart needs the same certificate for SMTP (25, with STARTTLS), submission (465) and IMAP (993), and cannot ask for its own while Caddy holds ports 80 and 443. So:

- a small `cert-sync` service copies Caddy's certificate to a volume Stalwart can read (Caddy keeps its own copy readable by root only), at start and twice a day;
- Stalwart's `Certificate` setting points at that copy;
- Stalwart re-reads it only when told, with `./apply.sh --reload-tls`. Run that every night from cron, so a renewed certificate is never more than a day from being served (it costs nothing when nothing changed):

  ```cron
  0 4 * * * cd /path/to/oinbox/deploy/production && ./apply.sh --reload-tls
  ```

Check what the mail ports present with:

```sh
openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null | openssl x509 -noout -subject -dates
openssl s_client -connect mail.example.com:25 -starttls smtp -servername mail.example.com </dev/null | openssl x509 -noout -dates
```

This arrangement was tested with Caddy's local certificate authority, not against Let's Encrypt itself; the difference is only where Caddy gets the certificate from.

## The image's settings

The release image is configured by environment variables. All are optional.

| Variable | Default | What it sets |
|---|---|---|
| `OINBOX_UPSTREAM` | `stalwart:8080` | Where Caddy finds Stalwart's HTTP listener. |
| `OINBOX_LISTEN` | `:8080` | The address Caddy listens on, in plain HTTP (the image's own configuration; the production template listens on 443 with its own certificate instead). |
| `OINBOX_TRUSTED_PROXIES` | `private_ranges` | The proxies in front of the image whose `X-Forwarded-For` Caddy believes, as addresses or ranges separated by spaces. Only the image's own configuration reads it; in the production template Caddy faces the internet and trusts no one. |
| `OINBOX_BRAND_NAME` | `oinbox` | The name in the top bar, on the sign-in card and in the browser tab. |
| `OINBOX_BRAND_LOGO` | none | A logo shown in place of the name in the top bar and on the sign-in card, and used as the tab's icon. |
| `OINBOX_DRIVE_UPSTREAM` | none | Where an OpenCloud's HTTP listener is, as `host:port`. Set, the app offers Drive; unset, it shows none. See "Drive". |
| `OINBOX_DRIVE_LINK_OVER_MB` | `20` | Past this many megabytes of attachments, a message's files are offered as a Drive link instead. A file larger than Stalwart's own upload limit is always offered as one. A number. |

### Branding

`OINBOX_BRAND_LOGO` is the address of an image: an `https://` URL, a `data:image/...` URL, or a path on the same host (`/my-logo.svg`). It is shown at most 32px high in the top bar, so a wide, short image works best; SVG is ideal. Plain `http://` addresses are refused. Neither value may contain a double quote or a backquote.

Caddy hands the two values to the app as `/branding.json`. Behind your own proxy, edit the `branding.json` that ships with the static files instead (`{ "name": "Example Mail", "logo": "/my-logo.svg" }`) and serve it uncached, as `deploy/examples/nginx.conf` does for everything outside `/assets/`.

The browser remembers the branding it last saw, so a change shows on the second load after it is made, not the first. Error messages and the version line in Settings still say "oinbox".

### Drive

oinbox can use an [OpenCloud](https://opencloud.eu) that runs beside Stalwart as the user's Drive. It does three things: an attachment can be saved into a Drive folder from the message it came in; files can be attached to a message straight from Drive; and files too large for mail are uploaded to Drive and sent as one link, with a password and an expiry the sender chooses. Users sign in once; OpenCloud accepts the sign-in Stalwart gave oinbox.

**What you need**

- OpenCloud 7.2.4 or later, set up to take its users from Stalwart:

  | OpenCloud setting | Value |
  |---|---|
  | `OC_OIDC_ISSUER` | Stalwart's public URL, exactly as the browser uses it |
  | `OC_EXCLUDE_RUN_SERVICES` | `idp` |
  | `PROXY_OIDC_ACCESS_TOKEN_VERIFY_METHOD` | `none` (Stalwart's tokens are opaque; OpenCloud checks one by asking Stalwart) |
  | `PROXY_USER_OIDC_CLAIM` | `preferred_username` |
  | `PROXY_USER_CS3_CLAIM` | `username` |
  | `PROXY_AUTOPROVISION_ACCOUNTS` | `true` |
  | `PROXY_ROLE_ASSIGNMENT_DRIVER` | `default` |
  | `GRAPH_USERNAME_MATCH` | `none` (user names are e-mail addresses) |

- `OINBOX_DRIVE_UPSTREAM` set to OpenCloud's listener. oinbox's Caddy then sends OpenCloud's three APIs, `/drive/graph/*`, `/drive/dav/spaces/*` and `/drive/ocs/*`, to it with the prefix removed, and tells the app Drive is on in `/drive.json`. Nothing else of OpenCloud is reachable through oinbox: its own web UI and its public-link pages stay on its own address.
- OpenCloud able to reach Stalwart at that public URL from where it runs.

OpenCloud need not run beside oinbox. Any `host:port` the oinbox container reaches over plain HTTP on a private network will do: a separate service in the same VPC, for example. (Reaching it through its own public HTTPS address has not been tested.)

Behind your own proxy, do what `deploy/examples/nginx.conf` shows: proxy only `/drive/graph/`, `/drive/dav/spaces/` and `/drive/ocs/` to OpenCloud with the prefix removed, answer 404 for anything else under `/drive/`, send OpenCloud `X-Forwarded-Proto: https`, hide `WWW-Authenticate` on the way back, replace its `Content-Security-Policy` with `sandbox; default-src 'none'` and set `X-Content-Type-Options: nosniff`, do not buffer or limit request bodies, and set `"enabled": true` in the `drive.json` that ships with the static files. The two headers and the 404 matter: OpenCloud serves files its users uploaded, and on the mail origin a file that the browser ran as a page could read the mail sign-in.

**Things to know before the first user signs in**

- *Accounts need a name.* An account with no description in Stalwart has no `name` to give OpenCloud, which then refuses to create the user (the Drive actions answer "Drive isn't available right now", and OpenCloud logs `missing claim 'name'`). Either give every account a description, or set `PROXY_AUTOPROVISION_CLAIM_DISPLAYNAME=preferred_username` and accept the address as the display name.
- *What a user is known by.* With the settings above the OpenCloud user is the e-mail address, so a renamed mailbox gets a new, empty drive. Setting `PROXY_USER_OIDC_CLAIM=sub` and `PROXY_AUTOPROVISION_CLAIM_USERNAME=sub` keeps the drive across a rename; the user is then known by Stalwart's account number. Choose before anyone signs in: changing it afterwards makes new users. oinbox works with either.
- *Links are opened at OpenCloud's own address.* A link in a sent message is whatever OpenCloud makes from its `OC_URL`, so that address has to be reachable by the people your users write to, even though oinbox itself reaches OpenCloud privately.
- *Link passwords.* OpenCloud requires a password on every public link unless `OC_SHARING_PUBLIC_SHARE_MUST_HAVE_PASSWORD=false`. oinbox follows whichever you choose: required, the sender types or generates one; not required, the step is optional. The sender decides whether the password goes in the message or is passed on another way. oinbox never stores it, beyond half an hour in the sender's own browser tab.
- *Where the files go.* Each message's files are in `Mail attachments/<date> <subject>` in the sender's drive, and stay there after sending; discarding the draft removes them. They count against the sender's Drive quota, not Stalwart's.
- *Trust.* Every Drive request carries the user's mail token to OpenCloud. Run only an OpenCloud you would trust with the mail.
- *Signing out.* A token Stalwart has revoked (a changed password, say) stops working in OpenCloud within a second.

**If Drive is set but not working**, the app still shows the Drive actions and answers "Drive isn't available right now" when one is used; mail is unaffected. Check that `https://<your host>/drive/graph/v1.0/me/drive` answers 401 when asked without signing in (not 404, and not the app's page), then OpenCloud's log for `failed to get userinfo`, which means it cannot reach Stalwart at `OC_OIDC_ISSUER`.

Tested with Stalwart 0.16.23 and OpenCloud 7.2.4 and 8.1.0.

### Behind a load balancer (for example AWS ECS)

Run the image as it is: it serves plain HTTP on `OINBOX_LISTEN` and expects whatever is in front to terminate TLS.

- **Finding Stalwart.** In a task with bridge networking, link the oinbox container to the Stalwart container under the name `stalwart` and the default works. In a task with `awsvpc` networking the containers share one network namespace: set `OINBOX_UPSTREAM=localhost:8080` and move `OINBOX_LISTEN` off 8080, which Stalwart already holds.
- **The client's address.** Stalwart bans addresses after failed sign-ins, so it has to see the client's, not the load balancer's. Caddy takes it from `X-Forwarded-For` when the request comes from a trusted proxy, and passes Stalwart that one address. The default trusts private addresses, which covers a load balancer in the same network. If the proxy in front has public addresses (Cloudflare, for example), list its ranges in `OINBOX_TRUSTED_PROXIES`, with `private_ranges` as well if there is also a private hop. Stalwart must be told to read the header: `Http.useXForwarded` set to true, as the production template's `plan.ndjson` does. To check, sign in from outside and look for your own address in Stalwart's log.
- **The push connection** stays open and is quiet between Stalwart's pings, 30 seconds apart. Keep the load balancer's idle timeout above that (an AWS Application Load Balancer's default of 60 seconds is enough).
- **`STALWART_PUBLIC_URL`** must still be the public `https://` origin, as in "Install behind a proxy you already run".
- **Mail ports** (25, 465, 993) do not pass through oinbox; route them to Stalwart yourself, and give Stalwart a certificate for them. The `cert-sync` arrangement below applies only to the Compose template.

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

The version is shown at the bottom of Settings (`oinbox 0.1.0-beta.2 (abc1234)`); quote it in bug reports.

## Upgrading

- **With the image**: change `OINBOX_VERSION` in `.env`, then `docker compose pull oinbox && docker compose up -d oinbox`.
- **With the tarball**: unpack the new release over the old one (or beside it, and switch the proxy's root).

Nothing else changes: there is no database to migrate. Script and style files have new names in every release and `index.html` is never cached, so people get the new version the next time they load the page. A tab left open across an upgrade keeps running the old version; if it then needs a part it had not loaded yet, it says "oinbox was updated. Reload to continue."

Read the changelog before upgrading Stalwart itself: oinbox depends on details of its JMAP behaviour, and a release is tested against one Stalwart version.

## Backup

oinbox has nothing to back up. Back up **Stalwart** (its data volume and settings) as its documentation describes, and the search index if rebuilding it would take long.

In the browser, oinbox keeps: the sign-in tokens, a small cache of the first page of the mailbox for fast start-up, the list of senders whose images you allowed, a few preferences, and, only after being signed out mid-draft, that draft's text for up to seven days. Signing out removes the tokens, the cache and any saved draft.

## Shared mailboxes

A shared mailbox is a Stalwart **group** account. In Stalwart's WebUI, create a group with the address the team shares (`support`, on your mail domain), then add each person to it under their own account's groups. From their next page load, the group appears in oinbox's switcher above Compose.

- Mail to the group's address is delivered to the group's Inbox only, not to each member.
- A reply written there is sent as the group and filed in the group's Sent, where every member sees it. Drafts, labels, signatures and the vacation responder of the shared mailbox are shared too.
- Each member's own account also gains the group's address as an identity, for sending as the group from their own mailbox.
- Nothing stops two people answering the same message; each sees the other's reply arrive in the conversation.

With the command line, add a member with `update Account <user id> --field 'memberGroupIds/<group id>=true'`. (Passing `--json '{"memberGroupIds":{…}}'` instead replaces the user's whole list of groups.) Unlike setting a password, changing membership does not sign the user out.

## Limits worth knowing

These are Stalwart defaults that users of a web client run into:

- **Attachments: 50 MB and 1,000 uploads per account per hour** (`Jmap.uploadQuota`, `Jmap.maxUploadCount`), on top of the 50 MB per file limit. Raise them if people send large files.
- **1,000 requests a minute per account** (`Http.rateLimitAuthenticated`). Ordinary use stays far below it.
- **Inbound mail is throttled** to 25 messages an hour per sender and recipient by default, and Stalwart restores those throttles at start-up when there are none.
- **Large mailboxes are slow to list.** On an account with 50,000 messages, each page of a mail list took Stalwart about 1.4 seconds in our tests (`docs/beta-audit.md`, L2).

## What signs people out

- **Setting an account's password.** Stalwart derives its token keys from the password hash, so every session of that account ends. This includes re-applying an account definition that carries a password.
- **A user changing their own password** in oinbox's Settings, for the same reason. oinbox sends them to the sign-in page; their other devices and mail apps need the new password.
- **Replacing Stalwart's data** (a new volume): it generates a new signing key.

Restarting Stalwart, reloading its settings, and upgrading oinbox do not sign anyone out. When a session does end, oinbox says so in place and keeps what was being written.

## Not supported in this release

- **A separate origin or a CDN.** Stalwart's CORS setting is all or nothing (`Http.usePermissiveCors` allows every origin), oinbox finds its server at its own origin, and the OAuth redirect and Content-Security-Policy assume one origin. It could be made to work; it has not been tested.
- **More than one Stalwart behind one oinbox**, and accounts on more than one server at once.
- **Recovering a forgotten password.** A signed-in user can change their password in Settings; someone who can't sign in needs an administrator to set a new one in Stalwart's WebUI.
- **Anything but Stalwart.** oinbox speaks standard JMAP but leans on Stalwart's behaviour in places.

## Development stack

`deploy/README.md` describes the stack used to build and test oinbox (plain HTTP on `localhost:8080`, seeded test accounts, relaxed settings). It is not a starting point for production.
