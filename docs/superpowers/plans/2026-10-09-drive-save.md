# Drive, slice 1: Save to Drive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user whose installation runs OpenCloud can save a message's attachments into a folder of their Drive from oinbox; an installation without OpenCloud sees no change.

**Architecture:** Caddy proxies `/drive/*` to OpenCloud on oinbox's own origin and serves `/drive.json`, which says whether Drive is on. A `DriveClient` (`src/drive/`) talks to OpenCloud with the token the JMAP client already uses. `src/app/drive.ts` holds what is offered and the save action; a folder picker dialog and a menu on each attachment chip are the only new UI.

**Tech Stack:** SolidJS 1.9, `@rozie-ui/dialog-solid`, `@rozie-ui/popover-solid`, Vitest + jsdom, Playwright, Caddy 2.11.4, Stalwart 0.16.23, OpenCloud 7.2.4.

**Spec:** `docs/superpowers/specs/2026-10-09-drive-integration-design.md` (this plan builds "Slice 1: Save to Drive" and the parts of "How it fits together" it needs).

## Global Constraints

- No new dependencies.
- Every Drive request goes to oinbox's own origin under `/drive/`. The Content-Security-Policy is not changed.
- With Drive off (`/drive.json` missing, unreadable or `enabled: false`) nothing on screen differs from today: an attachment chip downloads on a click.
- Drive never delays or breaks mail: `/drive.json` is not awaited at start-up, no Drive request is made before the user's first Drive action, and a Drive failure never reaches the connection banner.
- The Drive is the signed-in user's personal drive, whichever mailbox is on screen.
- Saving never replaces a file: a taken name becomes `name (1).ext`, `name (2).ext`, compared without regard to case.
- OpenCloud image in the dev stack: `opencloudeu/opencloud:7.2.4`, pinned.
- Copy, verbatim: menu items `Download` and `Save to Drive`; button `Save all to Drive`; dialog titles `Save to Drive` and `Save 3 files to Drive`; buttons `New folder`, `Save here`, `Cancel`, `Try again`; toasts `Saved to Drive: <folder>` and `3 files saved to Drive: <folder>`; errors `Drive isn't available right now.`, `That folder is no longer in Drive.`, `Not enough space in Drive.`.
- Narrower than the spec in this slice, on purpose: `DriveClient` has only `drive`, `children`, `createFolder` and `upload`, and `upload` uses `fetch` with no progress callback. The rest arrives with the slices that use it.
- Commit after every task, message prefix `Drive:`, ending with the session's attribution lines (`Co-Authored-By` and `Claude-Session`). Do not push: pushes are batched.

## Review Focus

1. **OpenCloud is down or refuses the token when the user chooses "Save to Drive".** They expect one plain message and working mail, not a spinner or a banner. Pinned in Task 3 (client maps 503, network failure and HTML answers to `unavailable`), Task 5 (picker shows the message with `Try again`) and Task 7 (e2e).
2. **Two attachments with the same name saved together** (`image.png` twice is common). Both must arrive. Pinned in Task 4 (`confirm` counts names it has just written).
3. **An attachment name that is not a safe file name**: empty, `a/b.txt`, `..`, or with `#`, `%`, `?`, `&`. It must be saved under a sane name and the URL must not break. Pinned in Task 3 (path encoding) and Task 4 (`safeName`).
4. **The access token expires while the picker is open.** The next request must renew it once and carry on. Pinned in Task 3.
5. **The folder is deleted in OpenCloud between choosing it and saving, or the remembered folder is gone next time.** Expect a message, or the picker opening at the top, not a blank dialog. Pinned in Task 4 (message) and Task 5 (falls back to the top).

## File Structure

| File | Responsibility |
|---|---|
| `deploy/routes.caddy` (modify) | `/drive.json` and the `/drive/*` proxy. |
| `deploy/docker-compose.yml` (modify) | OpenCloud in the dev stack; Caddy told where it is. |
| `deploy/production/docker-compose.yml`, `deploy/production/.env.example` (modify) | The two variables passed through. |
| `deploy/examples/nginx.conf` (modify) | The same route for operators with their own proxy. |
| `public/drive.json` (create) | The static answer, Drive off, for operators with their own proxy. |
| `vite.config.ts` (modify) | `/drive` proxied to the dev stack for `pnpm dev`. |
| `src/drive/config.ts` (create) | Read and check `/drive.json`. |
| `src/drive/client.ts` (create) | `DriveClient`, `DriveError`, `DriveItem`. |
| `src/drive/fake.ts` (create) | An in-memory OpenCloud that answers as the real one was probed to. |
| `src/app/drive.ts` (create) | What is offered, the open save request, the save itself, names, messages. |
| `src/ui/menu.ts` (create) | Arrow-key handling shared by popover menus. |
| `src/ui/LabelMenu.tsx` (modify) | Uses `menu.ts`. |
| `src/ui/DrivePicker.tsx` (create) | The folder picker dialog. |
| `src/ui/Attachments.tsx` (create) | The reader's attachment chips, moved out of `Conversation.tsx`, with the Drive menu. |
| `src/ui/Conversation.tsx`, `src/ui/Shell.tsx`, `src/app/context.tsx`, `src/index.tsx`, `src/ui/styles.css` (modify) | Wiring and styles. |
| `e2e/support/drive.ts`, `e2e/drive-stack.spec.ts`, `e2e/drive.spec.ts` (create) | End-to-end. |
| `docs/operating.md`, `deploy/README.md`, `README.md`, `CHANGELOG.md` (modify) | Operator and user documentation. |

---

### Task 1: The route and OpenCloud in the dev stack

**Files:**
- Modify: `deploy/routes.caddy`, `deploy/docker-compose.yml`, `deploy/production/docker-compose.yml`, `deploy/production/.env.example`, `deploy/examples/nginx.conf`, `vite.config.ts`
- Create: `public/drive.json`, `e2e/support/drive.ts`, `e2e/drive-stack.spec.ts`

**Interfaces:**
- Produces: `GET /drive.json` → `{"enabled":boolean,"linkOverMb":number}`; `/drive/<path>` → OpenCloud's `/<path>`; e2e helpers `driveToken(page)`, `driveFetch(token, path, init?)`, `driveId(token)`, `driveChildren(token, itemId?)`, `removeFromDrive(token, path)`, `waitForDrive(token)`.

Background the implementer needs (all probed on 2026-10-09):
- OpenCloud accepts Stalwart's access token when `PROXY_OIDC_ACCESS_TOKEN_VERIFY_METHOD=none`; it asks Stalwart's `/auth/userinfo`.
- OpenCloud must reach Stalwart at the issuer URL Stalwart advertises, `http://localhost:8080` in the dev stack. Sharing Caddy's network namespace (`network_mode: "service:caddy"`) makes that address Caddy inside the OpenCloud container too.
- OpenCloud answers `308` to `https://` when a proxy sends `X-Forwarded-Proto: http`, which Caddy does in the dev stack. The route removes the header.
- With the upstream unset, a Caddy `reverse_proxy` with no address does not parse, so the route carries a default it never uses and is guarded by an expression.

- [ ] **Step 1: Write the failing stack test**

Create `e2e/support/drive.ts`:

```ts
// Test-side helpers for OpenCloud behind the dev stack's /drive prefix.
import type { Page } from '@playwright/test';
import { BASE, waitFor } from './mail';

/** The signed-in page's access token: OpenCloud takes no Basic auth, only what Stalwart issued. */
export const driveToken = (page: Page): Promise<string> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('oinbox.tokens') ?? '{}') as { accessToken: string }).accessToken);

export const driveFetch = (token: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}/drive${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });

export interface DriveEntry {
  id: string;
  name: string;
  size: number;
  folder?: object;
}

export async function driveId(token: string): Promise<string> {
  const res = await driveFetch(token, '/graph/v1.0/me/drive');
  if (!res.ok) throw new Error(`drive: HTTP ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** A folder's entries; the top folder when no id is given. */
export async function driveChildren(token: string, itemId?: string): Promise<DriveEntry[]> {
  const path = itemId
    ? `/graph/v1.0/drives/${encodeURIComponent(await driveId(token))}/items/${encodeURIComponent(itemId)}/children`
    : '/graph/v1.0/me/drive/root/children';
  const res = await driveFetch(token, path);
  if (!res.ok) throw new Error(`children: HTTP ${res.status}`);
  return ((await res.json()) as { value: DriveEntry[] }).value;
}

export async function removeFromDrive(token: string, path: string[]): Promise<void> {
  const res = await driveFetch(token, `/dav/spaces/${encodeURIComponent(await driveId(token))}/${path.map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`delete ${path.join('/')}: HTTP ${res.status}`);
}

/** OpenCloud starts after Caddy and takes a while the first time. */
export const waitForDrive = (token: string): Promise<boolean> =>
  waitFor(() => driveFetch(token, '/graph/v1.0/me/drive').then((r) => r.ok, () => false), 120_000, 'OpenCloud to answer');
```

Create `e2e/drive-stack.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { openInbox } from './support/app';
import { driveFetch, driveToken, waitForDrive } from './support/drive';
import { BASE } from './support/mail';

// The dev stack runs OpenCloud behind /drive (deploy/routes.caddy). These check the route itself.
test('the stack says Drive is on, as JSON, never cached', async ({ request }) => {
  const res = await request.get('/drive.json');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(res.headers()['cache-control']).toBe('no-cache');
  expect(await res.json()).toEqual({ enabled: true, linkOverMb: 20 });
});

test("OpenCloud answers under /drive with the mail token and creates the user's drive", async ({ page }) => {
  test.setTimeout(180_000);
  await openInbox(page);
  const token = await driveToken(page);
  await waitForDrive(token);
  const res = await driveFetch(token, '/graph/v1.0/me/drive');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ driveType: 'personal', driveAlias: 'personal/alice@example.test' });
});

test('without a token OpenCloud answers 401 and no browser login prompt', async () => {
  const res = await fetch(`${BASE}/drive/graph/v1.0/me/drive`, { redirect: 'manual' });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBeNull();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm build && pnpm e2e e2e/drive-stack.spec.ts`
Expected: FAIL. The first test gets HTML (the app's `index.html`) where it expects JSON; the others get 200 with HTML or time out.

- [ ] **Step 3: Add the route**

In `deploy/routes.caddy`, change the header comment's list to six things by adding after item 5:

```
#   6. if there is an OpenCloud, send /drive/* to it with the prefix removed, and say so in /drive.json.
```

and change "has to do these five things" to "has to do these things". Then insert this block between the "Branding" block and the "SPA" block:

```
	# --- Drive (OpenCloud), optional -------------------------------------------
	# OINBOX_DRIVE_UPSTREAM is where OpenCloud's HTTP listener is. Unset: no Drive, and the app shows
	# none (src/drive/config.ts). The values are put in as text, so the expressions below compare constants.
	handle /drive.json {
		header {
			Content-Type "application/json"
			Cache-Control "no-cache"
			X-Content-Type-Options "nosniff"
		}
		@drive_on expression `"{$OINBOX_DRIVE_UPSTREAM:}" != ""`
		respond @drive_on `{"enabled":true,"linkOverMb":{$OINBOX_DRIVE_LINK_OVER_MB:20}}`
		respond `{"enabled":false,"linkOverMb":{$OINBOX_DRIVE_LINK_OVER_MB:20}}`
	}
	@drive {
		path /drive/*
		expression `"{$OINBOX_DRIVE_UPSTREAM:}" != ""`
	}
	handle @drive {
		uri strip_prefix /drive
		# The address after the colon is never used: the matcher above is false when the variable is
		# unset. It is there because a proxy with no upstream does not parse.
		reverse_proxy {$OINBOX_DRIVE_UPSTREAM:localhost:9} {
			# OpenCloud redirects to https:// when told the request came by http, as it does in the dev stack.
			header_up -X-Forwarded-Proto
			# As for Stalwart: a Basic challenge would put a browser login prompt over the app.
			header_down -Www-Authenticate
			# Uploads and downloads are streamed, not buffered.
			flush_interval -1
		}
	}
	# No OpenCloud: a Drive request must not be answered with index.html.
	handle /drive/* {
		respond 404
	}
```

- [ ] **Step 4: Add OpenCloud to the dev stack**

In `deploy/docker-compose.yml`, add to the `caddy` service's `environment`:

```yaml
      # OpenCloud shares this container's network (see the opencloud service), so it is on localhost.
      OINBOX_DRIVE_UPSTREAM: "localhost:9200"
```

Add this service after `caddy`:

```yaml
  opencloud:
    # Drive. It shares Caddy's network namespace so that Stalwart's public URL (http://localhost:8080,
    # which OpenCloud must reach to check a token) means the same inside this container as in the
    # browser. It publishes no port: the app reaches it through Caddy's /drive route.
    # After `docker compose restart caddy`, restart this service too: it loses its network with Caddy's.
    image: opencloudeu/opencloud:7.2.4
    restart: unless-stopped
    network_mode: "service:caddy"
    entrypoint: ["/bin/sh", "-c", "opencloud init --insecure true >/dev/null 2>&1 || true; exec opencloud server"]
    environment:
      OC_URL: "http://localhost:9200"
      OC_INSECURE: "true"          # dev only: plain HTTP
      PROXY_TLS: "false"           # dev only
      PROXY_HTTP_ADDR: "0.0.0.0:9200"
      IDM_CREATE_DEMO_USERS: "false"
      # Stalwart signs users in; OpenCloud's own identity provider stays off.
      OC_EXCLUDE_RUN_SERVICES: "idp"
      OC_OIDC_ISSUER: "http://localhost:8080"
      # Stalwart's access tokens are opaque: OpenCloud checks one by asking Stalwart's userinfo.
      PROXY_OIDC_ACCESS_TOKEN_VERIFY_METHOD: "none"
      PROXY_USER_OIDC_CLAIM: "preferred_username"
      PROXY_USER_CS3_CLAIM: "username"
      PROXY_AUTOPROVISION_ACCOUNTS: "true"
      PROXY_ROLE_ASSIGNMENT_DRIVER: "default"
      # User names are e-mail addresses.
      GRAPH_USERNAME_MATCH: "none"
    volumes:
      - opencloud-config:/etc/opencloud
      - opencloud-data:/var/lib/opencloud
    depends_on:
      stalwart:
        condition: service_healthy
```

and to the top-level `volumes:` add `opencloud-config:` and `opencloud-data:`.

- [ ] **Step 5: Pass the variables through elsewhere**

In `deploy/production/docker-compose.yml`, in the oinbox service's `environment` (the block that has `OINBOX_BRAND_NAME`), add:

```yaml
      OINBOX_DRIVE_UPSTREAM: "${OINBOX_DRIVE_UPSTREAM:-}"
      OINBOX_DRIVE_LINK_OVER_MB: "${OINBOX_DRIVE_LINK_OVER_MB:-20}"
```

In `deploy/production/.env.example`, after the branding lines, add:

```
# Optional: an OpenCloud beside Stalwart, used as Drive (docs/operating.md, "Drive").
# Where its HTTP listener is, as host:port reachable from the oinbox container.
#OINBOX_DRIVE_UPSTREAM=opencloud:9200
```

Create `public/drive.json` (served only where no proxy generates it):

```json
{ "enabled": false, "linkOverMb": 20 }
```

In `deploy/examples/nginx.conf`, extend the comment that mentions `branding.json` with a line `# Drive: edit /srv/oinbox/dist/drive.json and uncomment the /drive/ location below (docs/operating.md, "Drive").`, and add before `location / {`:

```nginx
    # Drive (optional): OpenCloud under /drive/, prefix removed. Uncomment with drive.json's "enabled": true.
    # location /drive/ {
    #     proxy_pass http://opencloud:9200/;
    #     proxy_set_header Host $host;
    #     proxy_set_header X-Forwarded-Proto https;
    #     proxy_hide_header WWW-Authenticate;
    #     proxy_request_buffering off;
    #     proxy_buffering off;
    #     client_max_body_size 0;
    # }
```

In `vite.config.ts`, add `'/drive'` to the proxied prefixes array (it covers `/drive.json` too) and extend the comment above it with `Drive (OpenCloud) is at /drive.`

- [ ] **Step 6: Bring the stack up and run the test**

Run:
```sh
(cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d)
pnpm e2e e2e/drive-stack.spec.ts
```
Expected: 3 passed. The second test can take up to two minutes on OpenCloud's first start.

If the second test times out, read `docker compose logs opencloud | tail -50` in `deploy/`. A line with `failed to get userinfo` means OpenCloud cannot reach `http://localhost:8080`: check `network_mode`.

- [ ] **Step 7: Check the rest of the suite still starts**

Run: `pnpm e2e e2e/branding.spec.ts e2e/login.spec.ts`
Expected: all pass (the route change must not disturb the others).

- [ ] **Step 8: Commit**

```bash
git add deploy/routes.caddy deploy/docker-compose.yml deploy/production/docker-compose.yml deploy/production/.env.example deploy/examples/nginx.conf public/drive.json vite.config.ts e2e/support/drive.ts e2e/drive-stack.spec.ts
git commit -m "Drive: OpenCloud behind /drive on the app's origin, and /drive.json to say it is there"
```

---

### Task 2: Reading `/drive.json`

**Files:**
- Create: `src/drive/config.ts`
- Test: `src/drive/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DriveConfig { enabled: boolean; linkOverMb: number }
  export const NO_DRIVE: DriveConfig;                       // { enabled: false, linkOverMb: 20 }
  export function parseDriveConfig(raw: unknown): DriveConfig;
  export function loadDriveConfig(fetcher: (url: string) => Promise<Response>): Promise<DriveConfig>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/drive/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadDriveConfig, NO_DRIVE, parseDriveConfig } from './config';

const answer = (body: string, status = 200) => () => Promise.resolve(new Response(body, { status }));

describe('parseDriveConfig', () => {
  it('takes enabled and the link threshold', () => {
    expect(parseDriveConfig({ enabled: true, linkOverMb: 35 })).toEqual({ enabled: true, linkOverMb: 35 });
  });
  it('is on only for a true boolean', () => {
    for (const enabled of ['true', 1, {}, null, undefined]) expect(parseDriveConfig({ enabled }).enabled).toBe(false);
  });
  it('keeps 20 MB for a threshold that is not a positive number', () => {
    for (const linkOverMb of [0, -5, '35', NaN, Infinity, null]) expect(parseDriveConfig({ enabled: true, linkOverMb }).linkOverMb).toBe(20);
  });
  it('is off for anything that is not an object', () => {
    for (const raw of [null, 'on', 7, []]) expect(parseDriveConfig(raw)).toEqual(NO_DRIVE);
  });
});

describe('loadDriveConfig', () => {
  it('reads /drive.json', async () => {
    let asked = '';
    const config = await loadDriveConfig((url) => {
      asked = url;
      return Promise.resolve(new Response('{"enabled":true,"linkOverMb":20}'));
    });
    expect(asked).toBe('/drive.json');
    expect(config).toEqual({ enabled: true, linkOverMb: 20 });
  });
  it('is off when the file is missing', async () => {
    expect(await loadDriveConfig(answer('not found', 404))).toEqual(NO_DRIVE);
  });
  it('is off when the answer is the app page, as behind a proxy that knows no such file', async () => {
    expect(await loadDriveConfig(answer('<!doctype html><title>oinbox</title>'))).toEqual(NO_DRIVE);
  });
  it('is off when the request fails', async () => {
    expect(await loadDriveConfig(() => Promise.reject(new TypeError('offline')))).toEqual(NO_DRIVE);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/drive/config.test.ts`
Expected: FAIL, cannot resolve `./config`.

- [ ] **Step 3: Implement**

Create `src/drive/config.ts`:

```ts
/** Whether this installation has a Drive (an OpenCloud behind /drive), as the operator set it (docs/operating.md, "Drive"). */
export interface DriveConfig {
  enabled: boolean;
  /** Offer a link when a message's attachments pass this many megabytes. */
  linkOverMb: number;
}

export const NO_DRIVE: DriveConfig = { enabled: false, linkOverMb: 20 };

type Fetcher = (url: string) => Promise<Response>;

export function parseDriveConfig(raw: unknown): DriveConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_DRIVE;
  const o = raw as Record<string, unknown>;
  const mb = o.linkOverMb;
  return {
    enabled: o.enabled === true,
    linkOverMb: typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : NO_DRIVE.linkOverMb,
  };
}

/**
 * Read /drive.json. Anything but a readable answer means no Drive. Unlike the branding it is not
 * remembered between visits: a Drive that was switched off must disappear.
 */
export async function loadDriveConfig(fetcher: Fetcher): Promise<DriveConfig> {
  try {
    const res = await fetcher('/drive.json');
    return res.ok ? parseDriveConfig(await res.json()) : NO_DRIVE;
  } catch {
    return NO_DRIVE;
  }
}
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test src/drive/config.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/drive/config.ts src/drive/config.test.ts
git commit -m "Drive: read /drive.json; anything unreadable means no Drive"
```

---

### Task 3: `DriveClient` and the fake OpenCloud

**Files:**
- Create: `src/drive/client.ts`, `src/drive/fake.ts`
- Test: `src/drive/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DriveErrorKind = 'unavailable' | 'refused' | 'missing' | 'tooLarge' | 'other';
  export class DriveError extends Error { readonly kind: DriveErrorKind; readonly status: number }
  export interface DriveItem { id: string; name: string; size: number; folder: boolean; modified: string }
  export interface DriveClientOptions {
    base?: string;                               // default '/drive'
    getToken: () => Promise<string>;
    onUnauthorized?: () => Promise<boolean>;     // true: the token was renewed, try once more
    fetch?: typeof fetch;
    timeoutMs?: number;                          // default 30_000; uploads have none
  }
  export class DriveClient {
    constructor(opts: DriveClientOptions);
    drive(): Promise<{ id: string; name: string }>;
    children(itemId?: string): Promise<DriveItem[]>;
    createFolder(path: string[]): Promise<void>;
    upload(path: string[], body: Blob): Promise<string>;   // the new item's id
  }
  ```
  and, for tests in later tasks:
  ```ts
  export class FakeDrive {
    readonly driveId: string;        // contains '$'
    driveName: string;               // 'Alice Example'
    validToken: string;              // 't'
    down: boolean;                   // true: every request answers 503
    full: boolean;                   // true: uploads answer 507
    requests: { method: string; path: string }[];
    mkdir(path: string[]): string;                      // arrange a folder (parents too); its id
    put(path: string[], data: Blob): string;            // arrange a file; its id
    names(path: string[]): string[];                    // what a folder holds, in insertion order
    read(path: string[]): Blob | undefined;
    remove(path: string[]): void;
    fetch: typeof fetch;
    client(opts?: Partial<DriveClientOptions>): DriveClient;
  }
  ```

What OpenCloud does, which the fake must copy (probed 2026-10-09, OpenCloud 7.2.4 and 8.1.0):
- `GET /graph/v1.0/me/drive` → `{ id, name, driveType: 'personal' }`. The id contains `$`.
- `GET /graph/v1.0/me/drive/root/children` and `GET /graph/v1.0/drives/{drive}/items/{item}/children` → `{ value: [{ id, name, size, lastModifiedDateTime, folder?: {} , file?: { mimeType } }] }`. An unknown item: 404.
- `MKCOL /dav/spaces/{drive}/{path}` → 201; 405 if it exists; 409 if the parent is missing.
- `PUT /dav/spaces/{drive}/{path}` → 201 with `Oc-Fileid`; onto an existing file 204 and the file is replaced; 409 if the parent is missing; 507 when out of space.
- No or a wrong token → 401.

- [ ] **Step 1: Write the fake**

Create `src/drive/fake.ts`:

```ts
import { DriveClient, type DriveClientOptions } from './client';

interface Node {
  id: string;
  name: string;
  modified: string;
  /** Present on a folder. */
  children?: Map<string, Node>;
  /** Present on a file. */
  data?: Blob;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

/**
 * An in-memory OpenCloud that answers as the real one was probed to (2026-10-09, 7.2.4 and 8.1.0):
 * ids with `$` and `!`, 405 for a folder that exists, 409 under a missing parent, a silent replace
 * on a second PUT, 401 without the token.
 */
export class FakeDrive {
  readonly driveId = 'store-1$space-1';
  driveName = 'Alice Example';
  validToken = 't';
  /** Every request answers 503. */
  down = false;
  /** Uploads answer 507. */
  full = false;
  requests: { method: string; path: string }[] = [];
  private seq = 0;
  private root: Node = { id: `${this.driveId}!root`, name: '', modified: '2026-10-09T12:00:00Z', children: new Map() };

  private newNode(name: string, folder: boolean, data?: Blob): Node {
    return { id: `${this.driveId}!n${++this.seq}`, name, modified: '2026-10-09T12:00:00Z', ...(folder ? { children: new Map() } : { data }) };
  }

  private at(path: string[]): Node | undefined {
    let node: Node | undefined = this.root;
    for (const name of path) node = node?.children?.get(name);
    return node;
  }

  private byId(id: string, from: Node = this.root): Node | undefined {
    if (from.id === id) return from;
    for (const child of from.children?.values() ?? []) {
      const found = this.byId(id, child);
      if (found) return found;
    }
    return undefined;
  }

  mkdir(path: string[]): string {
    let node = this.root;
    for (const name of path) {
      let next = node.children!.get(name);
      if (!next) node.children!.set(name, (next = this.newNode(name, true)));
      node = next;
    }
    return node.id;
  }

  put(path: string[], data: Blob): string {
    const parent = this.at(path.slice(0, -1));
    if (!parent?.children) throw new Error(`FakeDrive.put: no folder ${path.slice(0, -1).join('/')}`);
    const node = this.newNode(path.at(-1)!, false, data);
    parent.children.set(node.name, node);
    return node.id;
  }

  names(path: string[]): string[] {
    return [...(this.at(path)?.children?.keys() ?? [])];
  }

  read(path: string[]): Blob | undefined {
    return this.at(path)?.data;
  }

  remove(path: string[]): void {
    this.at(path.slice(0, -1))?.children?.delete(path.at(-1)!);
  }

  private listing(node: Node) {
    return {
      value: [...node.children!.values()].map((n) => ({
        id: n.id,
        name: n.name,
        size: n.data?.size ?? 0,
        lastModifiedDateTime: n.modified,
        ...(n.children ? { folder: {} } : { file: { mimeType: n.data?.type || 'application/octet-stream' } }),
      })),
    };
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://fake');
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/drive/, '');
    this.requests.push({ method, path });
    if (this.down) return empty(503);
    if (new Headers(init.headers).get('authorization') !== `Bearer ${this.validToken}`) return empty(401);

    if (method === 'GET' && path === '/graph/v1.0/me/drive') return json({ id: this.driveId, name: this.driveName, driveType: 'personal' });
    if (method === 'GET' && path === '/graph/v1.0/me/drive/root/children') return json(this.listing(this.root));
    const items = /^\/graph\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)\/children$/.exec(path);
    if (method === 'GET' && items) {
      const node = decodeURIComponent(items[1]!) === this.driveId ? this.byId(decodeURIComponent(items[2]!)) : undefined;
      return node?.children ? json(this.listing(node)) : json({ error: { code: 'itemNotFound' } }, 404);
    }
    const dav = /^\/dav\/spaces\/([^/]+)\/(.+)$/.exec(path);
    if (dav && decodeURIComponent(dav[1]!) === this.driveId) {
      const names = dav[2]!.split('/').map(decodeURIComponent);
      const parent = this.at(names.slice(0, -1));
      const name = names.at(-1)!;
      if (method === 'MKCOL') {
        if (!parent?.children) return empty(409);
        if (parent.children.has(name)) return empty(405);
        parent.children.set(name, this.newNode(name, true));
        return empty(201);
      }
      if (method === 'PUT') {
        if (!parent?.children) return empty(409);
        if (this.full) return empty(507);
        const old = parent.children.get(name);
        const node = this.newNode(name, false, init.body as Blob);
        if (old) node.id = old.id;
        parent.children.set(name, node);
        return empty(old ? 204 : 201, { 'oc-fileid': node.id });
      }
    }
    return empty(404);
  };

  client(opts: Partial<DriveClientOptions> = {}): DriveClient {
    return new DriveClient({ base: 'http://fake/drive', getToken: async () => this.validToken, fetch: this.fetch, ...opts });
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/drive/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { DriveClient, DriveError } from './client';
import { FakeDrive } from './fake';

const blob = (text: string) => new Blob([text], { type: 'text/plain' });
const kindOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e instanceof DriveError ? e.kind : `not a DriveError: ${String(e)}`));

describe('DriveClient', () => {
  it("finds the user's drive once and remembers it", async () => {
    const server = new FakeDrive();
    const c = server.client();
    expect(await c.drive()).toEqual({ id: server.driveId, name: 'Alice Example' });
    await c.drive();
    expect(server.requests.filter((r) => r.path === '/graph/v1.0/me/drive')).toHaveLength(1);
  });

  it('asks again after a failed first attempt', async () => {
    const server = new FakeDrive();
    const c = server.client();
    server.down = true;
    expect(await kindOf(c.drive())).toBe('unavailable');
    server.down = false;
    expect((await c.drive()).id).toBe(server.driveId);
  });

  it('lists the top folder and a folder inside it', async () => {
    const server = new FakeDrive();
    const reports = server.mkdir(['Reports']);
    server.put(['Reports', 'q3.pdf'], blob('pdf!'));
    server.put(['notes.txt'], blob('hello'));
    const c = server.client();
    expect(await c.children()).toEqual([
      { id: reports, name: 'Reports', size: 0, folder: true, modified: '2026-10-09T12:00:00Z' },
      { id: expect.any(String), name: 'notes.txt', size: 5, folder: false, modified: '2026-10-09T12:00:00Z' },
    ]);
    expect((await c.children(reports)).map((i) => i.name)).toEqual(['q3.pdf']);
    // The drive's id has a `$`, a folder's a `!`: both travel encoded.
    expect(server.requests.at(-1)!.path).toBe(`/graph/v1.0/drives/${encodeURIComponent(server.driveId)}/items/${encodeURIComponent(reports)}/children`);
  });

  it('says a folder that is gone is missing', async () => {
    const server = new FakeDrive();
    expect(await kindOf(server.client().children(`${server.driveId}!nope`))).toBe('missing');
  });

  it('creates a folder, and is content if it is already there', async () => {
    const server = new FakeDrive();
    const c = server.client();
    await c.createFolder(['Reports']);
    await c.createFolder(['Reports']);
    await c.createFolder(['Reports', '2026']);
    expect(server.names([])).toEqual(['Reports']);
    expect(server.names(['Reports'])).toEqual(['2026']);
  });

  it('uploads a file and returns its id', async () => {
    const server = new FakeDrive();
    server.mkdir(['Reports']);
    const body = blob('pdf!');
    const id = await server.client().upload(['Reports', 'q3.pdf'], body);
    expect(id).toMatch(/^store-1\$space-1!n\d+$/);
    expect(server.read(['Reports', 'q3.pdf'])).toBe(body);
  });

  it('encodes each part of a path, so a name with # % ? & or a space arrives whole', async () => {
    const server = new FakeDrive();
    server.mkdir(['R & D']);
    const name = 'a #1 100% why?.txt';
    await server.client().upload(['R & D', name], blob('x'));
    expect(server.names(['R & D'])).toEqual([name]);
    expect(server.requests.at(-1)!.path).toBe(`/dav/spaces/${encodeURIComponent(server.driveId)}/R%20%26%20D/a%20%231%20100%25%20why%3F.txt`);
  });

  it('says so when the folder is gone, the drive is full, or the server is down', async () => {
    const server = new FakeDrive();
    const c = server.client();
    expect(await kindOf(c.upload(['Gone', 'a.txt'], blob('x')))).toBe('missing');
    server.full = true;
    expect(await kindOf(c.upload(['a.txt'], blob('x')))).toBe('tooLarge');
    server.down = true;
    expect(await kindOf(c.children())).toBe('unavailable');
  });

  it('counts a network failure and a time-out as unavailable', async () => {
    const offline = new DriveClient({ getToken: async () => 't', fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(await kindOf(offline.children())).toBe('unavailable');
    const slow = new DriveClient({ getToken: async () => 't', timeoutMs: 5, fetch: (_u, init) => new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason))) });
    expect(await kindOf(slow.children())).toBe('unavailable');
  });

  it('counts an HTML answer as unavailable: a proxy with no Drive route serves the app page', async () => {
    const c = new DriveClient({ getToken: async () => 't', fetch: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
    expect(await kindOf(c.drive())).toBe('unavailable');
    expect(await kindOf(c.children())).toBe('unavailable');
  });

  it('counts a 404 for the drive itself as unavailable, not as a missing folder', async () => {
    const c = new DriveClient({ getToken: async () => 't', fetch: async () => new Response(null, { status: 404 }) });
    expect(await kindOf(c.drive())).toBe('unavailable');
  });

  it('renews an expired token once and carries on', async () => {
    const server = new FakeDrive();
    let token = 'old';
    const onUnauthorized = vi.fn(async () => {
      token = 't';
      return true;
    });
    const c = server.client({ getToken: async () => token, onUnauthorized });
    expect((await c.children()).length).toBe(0);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('is refused when the token cannot be renewed, without asking twice', async () => {
    const server = new FakeDrive();
    const onUnauthorized = vi.fn(async () => true);
    const c = server.client({ getToken: async () => 'still-wrong', onUnauthorized });
    expect(await kindOf(c.children())).toBe('refused');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(await kindOf(server.client({ getToken: async () => 'wrong' }).children())).toBe('refused');
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `pnpm test src/drive/client.test.ts`
Expected: FAIL, cannot resolve `./client`.

- [ ] **Step 4: Implement the client**

Create `src/drive/client.ts`:

```ts
// OpenCloud as Drive, reached on this origin under /drive (deploy/routes.caddy). It takes the token
// Stalwart issued to oinbox; see docs/superpowers/specs/2026-10-09-drive-integration-design.md.

export type DriveErrorKind =
  /** OpenCloud cannot be reached, is not there, or is not answering as OpenCloud. */
  | 'unavailable'
  /** It will not have this user: 401 after one renewal, or 403. */
  | 'refused'
  /** The file or its folder is gone. */
  | 'missing'
  /** No room for it. */
  | 'tooLarge'
  | 'other';

export class DriveError extends Error {
  constructor(
    readonly kind: DriveErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface DriveItem {
  id: string;
  name: string;
  size: number;
  folder: boolean;
  /** ISO 8601. */
  modified: string;
}

export interface DriveClientOptions {
  /** Where OpenCloud is on this origin. */
  base?: string;
  getToken: () => Promise<string>;
  /** The token was refused. Resolves true if it was renewed and the request is worth one more try. */
  onUnauthorized?: () => Promise<boolean>;
  fetch?: typeof fetch;
  /** For everything but uploads, which take as long as they take. */
  timeoutMs?: number;
}

const kindOf = (status: number): DriveErrorKind => {
  if (status === 401 || status === 403) return 'refused';
  if (status === 404 || status === 409) return 'missing';
  if (status === 413 || status === 507) return 'tooLarge';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'other';
};

/** A drive or item id (they contain `$` and `!`), or one name of a path, as a URL segment. */
const seg = encodeURIComponent;

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: object;
}

export class DriveClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private found: Promise<{ id: string; name: string }> | null = null;

  constructor(private opts: DriveClientOptions) {
    this.base = opts.base ?? '/drive';
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  /** An authenticated request. Resolves with any answer but a 401; rejects with a DriveError when there is none. */
  private async request(path: string, init: RequestInit = {}, noTimeout = false, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await this.opts.getToken()}`);
    const signal = noTimeout ? undefined : AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw new DriveError('unavailable', 0, (e as Error).name === 'TimeoutError' ? 'Drive did not respond in time' : 'Drive could not be reached');
    }
    if (res.status === 401) {
      if (!retried && (await this.opts.onUnauthorized?.())) return this.request(path, init, noTimeout, true);
      throw new DriveError('refused', 401, 'Drive refused the sign-in');
    }
    return res;
  }

  private fail(res: Response, what: string): never {
    throw new DriveError(kindOf(res.status), res.status, `${what}: HTTP ${res.status}`);
  }

  /** A JSON answer. HTML with a 200 is some proxy's fallback page, not OpenCloud. */
  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) this.fail(res, what);
    try {
      return (await res.json()) as T;
    } catch {
      throw new DriveError('unavailable', res.status, `${what}: not an answer from Drive`);
    }
  }

  /** The user's personal drive. Asked for once; a failure is not remembered. */
  drive(): Promise<{ id: string; name: string }> {
    this.found ??= (async () => {
      const res = await this.request('/graph/v1.0/me/drive');
      // No drive at this address at all: that is Drive being absent, not a folder being gone.
      if (res.status === 404) throw new DriveError('unavailable', 404, 'There is no Drive at /drive');
      const d = await this.json<{ id?: string; name?: string }>(res, 'Finding the drive');
      if (typeof d.id !== 'string') throw new DriveError('unavailable', res.status, 'Finding the drive: not an answer from Drive');
      return { id: d.id, name: d.name ?? 'Drive' };
    })().catch((e) => {
      this.found = null;
      throw e;
    });
    return this.found;
  }

  /** What a folder holds, as OpenCloud lists it; the top folder when no id is given. */
  async children(itemId?: string): Promise<DriveItem[]> {
    const path = itemId
      ? `/graph/v1.0/drives/${seg((await this.drive()).id)}/items/${seg(itemId)}/children`
      : '/graph/v1.0/me/drive/root/children';
    const body = await this.json<{ value?: GraphItem[] }>(await this.request(path), 'Listing the folder');
    if (!Array.isArray(body.value)) throw new DriveError('unavailable', 200, 'Listing the folder: not an answer from Drive');
    return body.value.map((i) => ({ id: i.id, name: i.name, size: i.size ?? 0, folder: !!i.folder, modified: i.lastModifiedDateTime ?? '' }));
  }

  private async dav(path: string[]): Promise<string> {
    return `/dav/spaces/${seg((await this.drive()).id)}/${path.map(seg).join('/')}`;
  }

  /** Create one folder; its parent must exist. A folder that is already there is fine. */
  async createFolder(path: string[]): Promise<void> {
    const res = await this.request(await this.dav(path), { method: 'MKCOL' });
    if (!res.ok && res.status !== 405) this.fail(res, 'Creating the folder');
  }

  /**
   * Store a file and return its id. A file of the same name is replaced: OpenCloud ignores
   * If-None-Match, so a caller that must not overwrite lists the folder first.
   */
  async upload(path: string[], body: Blob): Promise<string> {
    const res = await this.request(await this.dav(path), { method: 'PUT', headers: { 'content-type': body.type || 'application/octet-stream' }, body }, true);
    if (!res.ok) this.fail(res, 'Uploading');
    return res.headers.get('oc-fileid') ?? '';
  }
}
```

- [ ] **Step 5: Run to see them pass**

Run: `pnpm test src/drive/client.test.ts && pnpm typecheck`
Expected: PASS, 13 tests; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/drive/client.ts src/drive/fake.ts src/drive/client.test.ts
git commit -m "Drive: a client for OpenCloud's folders and uploads, and a fake that answers as it does"
```

---

### Task 4: What is offered, and the save itself

**Files:**
- Create: `src/app/drive.ts`
- Test: `src/app/drive.test.ts`

**Interfaces:**
- Consumes: `DriveClient`, `DriveError` (`src/drive/client.ts`); `DriveConfig`, `NO_DRIVE` (`src/drive/config.ts`); `ToastFn` (`src/app/actions.ts`): `(message: string, type?: 'info' | 'success' | 'error') => void`.
- Produces:
  ```ts
  export interface Crumb { id?: string; name: string }
  /** A folder as the way to it from the top: the first crumb is the drive itself and has no id. */
  export type Trail = Crumb[];
  export interface SaveFile { name: string; fetch: () => Promise<Blob> }
  export interface SaveRequest { files: SaveFile[] }
  export function safeName(name: string | null | undefined): string;
  export function freeName(name: string, taken: Set<string>): string;   // `taken` holds lower-case names
  export function driveMessage(e: unknown): string;
  export function createDrive(deps: { client: DriveClient; toast: ToastFn }): Drive;
  export interface Drive {
    client: DriveClient;
    offered: () => boolean;                       // reactive
    setConfig: (c: DriveConfig) => void;
    request: () => SaveRequest | null;            // reactive: what the picker is open for
    saveToDrive: (files: SaveFile[]) => void;     // opens the picker
    cancel: () => void;
    lastTrail: () => Trail;                       // where the picker opens
    confirm: (trail: Trail) => Promise<boolean>;  // saves; true closes the picker
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/app/drive.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { DriveError } from '../drive/client';
import { FakeDrive } from '../drive/fake';
import { createDrive, driveMessage, freeName, safeName, type SaveFile, type Trail } from './drive';

const blob = (text: string) => new Blob([text], { type: 'text/plain' });
const file = (name: string, text = name): SaveFile => ({ name, fetch: async () => blob(text) });
const TOP: Trail = [{ name: 'Drive' }];

const setup = () => {
  const server = new FakeDrive();
  const toast = vi.fn();
  const drive = createDrive({ client: server.client(), toast });
  drive.setConfig({ enabled: true, linkOverMb: 20 });
  return { server, toast, drive };
};

describe('safeName', () => {
  it('keeps an ordinary name', () => {
    expect(safeName('Q3 report (final).pdf')).toBe('Q3 report (final).pdf');
  });
  it('takes the slashes and control characters out of a name', () => {
    expect(safeName('a/b\\c\u0000d.txt')).toBe('a_b_c_d.txt');
  });
  it('calls a nameless or dot-only attachment "attachment"', () => {
    for (const name of [null, undefined, '', '   ', '.', '..']) expect(safeName(name)).toBe('attachment');
  });
});

describe('freeName', () => {
  it('keeps a name nobody has', () => {
    expect(freeName('notes.txt', new Set(['other.txt']))).toBe('notes.txt');
  });
  it('numbers a taken name before its extension', () => {
    expect(freeName('notes.txt', new Set(['notes.txt']))).toBe('notes (1).txt');
    expect(freeName('notes.txt', new Set(['notes.txt', 'notes (1).txt']))).toBe('notes (2).txt');
  });
  it('compares without regard to case', () => {
    expect(freeName('Notes.TXT', new Set(['notes.txt']))).toBe('Notes (1).TXT');
  });
  it('numbers a name with no extension, and a dotfile, at the end', () => {
    expect(freeName('README', new Set(['readme']))).toBe('README (1)');
    expect(freeName('.env', new Set(['.env']))).toBe('.env (1)');
  });
});

describe('driveMessage', () => {
  it('has a plain sentence for each kind of failure', () => {
    expect(driveMessage(new DriveError('unavailable', 503, 'x'))).toBe("Drive isn't available right now.");
    expect(driveMessage(new DriveError('refused', 401, 'x'))).toBe("Drive isn't available right now.");
    expect(driveMessage(new DriveError('missing', 409, 'x'))).toBe('That folder is no longer in Drive.');
    expect(driveMessage(new DriveError('tooLarge', 507, 'x'))).toBe('Not enough space in Drive.');
    expect(driveMessage(new DriveError('other', 500, 'Uploading: HTTP 500'))).toBe("Couldn't save to Drive: Uploading: HTTP 500");
    expect(driveMessage(new Error('blob gone'))).toBe("Couldn't save to Drive: blob gone");
  });
});

describe('createDrive', () => {
  it('is not offered until the configuration says so', () => {
    const drive = createDrive({ client: new FakeDrive().client(), toast: vi.fn() });
    expect(drive.offered()).toBe(false);
    drive.setConfig({ enabled: true, linkOverMb: 20 });
    expect(drive.offered()).toBe(true);
  });

  it('asks nothing of OpenCloud until a folder is confirmed', () => {
    const { server, drive } = setup();
    drive.saveToDrive([file('notes.txt')]);
    expect(drive.request()?.files).toHaveLength(1);
    expect(server.requests).toEqual([]);
  });

  it('saves into the chosen folder, says where, closes, and remembers the folder', async () => {
    const { server, toast, drive } = setup();
    const id = server.mkdir(['Reports']);
    const trail: Trail = [{ name: 'Drive' }, { id, name: 'Reports' }];
    drive.saveToDrive([file('q3.pdf', 'pdf!')]);
    expect(await drive.confirm(trail)).toBe(true);
    expect(server.names(['Reports'])).toEqual(['q3.pdf']);
    expect(server.read(['Reports', 'q3.pdf'])!.size).toBe(4);
    expect(toast).toHaveBeenCalledWith('Saved to Drive: Reports', 'success');
    expect(drive.request()).toBeNull();
    expect(drive.lastTrail()).toEqual(trail);
  });

  it("names the drive when saving to its top folder, and counts several files", async () => {
    const { server, toast, drive } = setup();
    drive.saveToDrive([file('a.txt'), file('b.txt'), file('c.txt')]);
    await drive.confirm(TOP);
    expect(server.names([])).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(toast).toHaveBeenCalledWith('3 files saved to Drive: Alice Example', 'success');
  });

  it('never replaces a file: a taken name gets a number', async () => {
    const { server, drive } = setup();
    server.put(['Notes.txt'], blob('the old one'));
    drive.saveToDrive([file('notes.txt', 'new')]);
    await drive.confirm(TOP);
    expect(server.names([])).toEqual(['Notes.txt', 'notes (1).txt']);
    expect(server.read(['Notes.txt'])!.size).toBe('the old one'.length);
  });

  it('keeps two attachments of the same name apart', async () => {
    const { server, drive } = setup();
    drive.saveToDrive([file('image.png', 'one'), file('image.png', 'second')]);
    await drive.confirm(TOP);
    expect(server.names([])).toEqual(['image.png', 'image (1).png']);
    expect(server.read(['image (1).png'])!.size).toBe(6);
  });

  it('saves a nameless attachment, and one named like a path, under a sane name', async () => {
    const { server, drive } = setup();
    drive.saveToDrive([file(''), file('../../etc/passwd')]);
    await drive.confirm(TOP);
    expect(server.names([])).toEqual(['attachment', '.._.._etc_passwd']);
  });

  it('says Drive is unavailable and keeps the request open', async () => {
    const { server, toast, drive } = setup();
    server.down = true;
    drive.saveToDrive([file('a.txt')]);
    expect(await drive.confirm(TOP)).toBe(false);
    expect(toast).toHaveBeenCalledWith("Drive isn't available right now.", 'error');
    expect(drive.request()).not.toBeNull();
  });

  it('says so when the folder has gone since it was chosen', async () => {
    const { server, toast, drive } = setup();
    const id = server.mkdir(['Reports']);
    server.remove(['Reports']);
    drive.saveToDrive([file('a.txt')]);
    expect(await drive.confirm([{ name: 'Drive' }, { id, name: 'Reports' }])).toBe(false);
    expect(toast).toHaveBeenCalledWith('That folder is no longer in Drive.', 'error');
  });

  it('says how far it got when a later file fails', async () => {
    const { server, toast, drive } = setup();
    const broken: SaveFile = { name: 'b.txt', fetch: () => Promise.reject(new Error('blob gone')) };
    drive.saveToDrive([file('a.txt'), broken, file('c.txt')]);
    expect(await drive.confirm(TOP)).toBe(false);
    expect(server.names([])).toEqual(['a.txt']);
    expect(toast).toHaveBeenCalledWith("Couldn't save to Drive: blob gone 1 of 3 saved.", 'error');
  });

  it('does nothing on confirm when nothing is waiting', async () => {
    const { server, drive } = setup();
    expect(await drive.confirm(TOP)).toBe(false);
    expect(server.requests).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/app/drive.test.ts`
Expected: FAIL, cannot resolve `./drive`.

- [ ] **Step 3: Implement**

Create `src/app/drive.ts`:

```ts
import { createSignal } from 'solid-js';
import { DriveError, type DriveClient } from '../drive/client';
import { NO_DRIVE, type DriveConfig } from '../drive/config';
import type { ToastFn } from './actions';

export interface Crumb {
  id?: string;
  name: string;
}
/** A folder as the way to it from the top: the first crumb is the drive itself and has no id. */
export type Trail = Crumb[];

/** Something to save: its name, and how to get its bytes when the time comes. */
export interface SaveFile {
  name: string;
  fetch: () => Promise<Blob>;
}
export interface SaveRequest {
  files: SaveFile[];
}

/** A name a folder can hold: no slashes or control characters, and never empty or a dot name. */
export function safeName(name: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  const clean = (name ?? '').replace(/[/\\\u0000-\u001f\u007f]/g, '_').trim();
  return clean === '' || clean === '.' || clean === '..' ? 'attachment' : clean;
}

/** `name`, or `name (1).ext`, `name (2).ext`… if it is among `taken` (lower-case names), as a browser numbers downloads. */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function driveMessage(e: unknown): string {
  if (e instanceof DriveError) {
    if (e.kind === 'unavailable' || e.kind === 'refused') return "Drive isn't available right now.";
    if (e.kind === 'missing') return 'That folder is no longer in Drive.';
    if (e.kind === 'tooLarge') return 'Not enough space in Drive.';
  }
  return `Couldn't save to Drive: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Drive as the app sees it: whether it is offered, the save the picker is open for, and the save.
 * It is the signed-in user's own drive, whichever mailbox is on screen.
 */
export function createDrive(deps: { client: DriveClient; toast: ToastFn }) {
  const { client, toast } = deps;
  const [config, setConfig] = createSignal<DriveConfig>(NO_DRIVE);
  const [request, setRequest] = createSignal<SaveRequest | null>(null);
  let last: Trail = [{ name: 'Drive' }];

  /** Save the waiting files into the folder. True when all are there; the picker then closes. */
  const confirm = async (trail: Trail): Promise<boolean> => {
    const req = request();
    if (!req) return false;
    const path = trail.slice(1).map((c) => c.name);
    let saved = 0;
    try {
      // OpenCloud replaces a file of the same name without a word, so look first.
      const taken = new Set((await client.children(trail.at(-1)!.id)).map((i) => i.name.toLowerCase()));
      for (const f of req.files) {
        const name = freeName(safeName(f.name), taken);
        await client.upload([...path, name], await f.fetch());
        taken.add(name.toLowerCase());
        saved++;
      }
      const where = path.at(-1) ?? (await client.drive()).name;
      toast(req.files.length === 1 ? `Saved to Drive: ${where}` : `${req.files.length} files saved to Drive: ${where}`, 'success');
      last = trail;
      setRequest(null);
      return true;
    } catch (e) {
      toast(`${driveMessage(e)}${saved ? ` ${saved} of ${req.files.length} saved.` : ''}`, 'error');
      return false;
    }
  };

  return {
    client,
    /** Whether this installation has a Drive at all. Nothing is asked of it until it is used. */
    offered: () => config().enabled,
    setConfig,
    /** What the folder picker is open for, or null. */
    request,
    /** Open the folder picker for these files. */
    saveToDrive: (files: SaveFile[]) => {
      if (files.length) setRequest({ files });
    },
    cancel: () => setRequest(null),
    /** Where the picker opens: the folder last saved to in this tab, or the top. */
    lastTrail: (): Trail => last,
    confirm,
  };
}

export type Drive = ReturnType<typeof createDrive>;
```

If the project's lint has no `no-control-regex` rule, leave the `eslint-disable` comment out.

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test src/app/drive.test.ts && pnpm typecheck`
Expected: PASS, 19 tests; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/drive.ts src/app/drive.test.ts
git commit -m "Drive: saving files into a folder without ever replacing one"
```

---

### Task 5: The folder picker

**Files:**
- Create: `src/ui/DrivePicker.tsx`
- Modify: `src/ui/styles.css` (append)
- Test: `src/ui/DrivePicker.test.tsx`

**Interfaces:**
- Consumes: `useApp().drive` of type `Drive` (Task 4): `request()`, `cancel()`, `lastTrail()`, `confirm(trail)`, `client.children(id?)`, `client.createFolder(path)`, `client.drive()`; `driveMessage`, `Trail` from `src/app/drive.ts`; `DriveError`, `DriveItem` from `src/drive/client.ts`; `Dialog` from `@rozie-ui/dialog-solid` (props `open`, `onOpenChange`, `ariaLabelledby`, as `src/ui/LabelDialog.tsx` uses it); `Icon` from `src/ui/icons.tsx` (names used: `file`, `label`, `add`); `fileSize` from `src/mail/format.ts`.
- Produces: `export function DrivePicker(): JSX.Element`, which renders nothing while `drive.request()` is null. `App` does not have a `drive` field until Task 6; this task's test supplies one through a stub.

Behaviour:
- One folder at a time. Folders first, then files, each group by name. Files are shown greyed and cannot be chosen.
- A breadcrumb: the drive's name, then each folder; every crumb but the last is a button.
- `New folder` shows a name field in place of the button. A valid name creates the folder and opens it.
- `Save here` saves into the folder on screen. It and `New folder` are disabled while a listing or a save is running.
- Keys, when the focus is on a folder row: Down, Up, Home, End move; Enter opens (it is a button); Backspace goes up a level. Escape closes (the dialog does that).
- A listing that fails shows the message and `Try again`. If the folder remembered from last time is gone, the picker starts again from the top.

- [ ] **Step 1: Write the failing tests**

Create `src/ui/DrivePicker.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import { createDrive } from '../app/drive';
import { FakeDrive } from '../drive/fake';
import { DrivePicker } from './DrivePicker';

const blob = (text: string) => new Blob([text], { type: 'text/plain' });

function setup(arrange: (server: FakeDrive) => void = () => {}, files = 1) {
  const server = new FakeDrive();
  arrange(server);
  const toast = vi.fn();
  const drive = createDrive({ client: server.client(), toast });
  drive.setConfig({ enabled: true, linkOverMb: 20 });
  render(() => (
    <AppContext.Provider value={{ drive } as unknown as App}>
      <DrivePicker />
    </AppContext.Provider>
  ));
  const open = () => drive.saveToDrive(Array.from({ length: files }, (_, i) => ({ name: `file-${i + 1}.txt`, fetch: async () => blob('data') })));
  return { server, drive, toast, open };
}

const folderRow = (name: string) => screen.findByRole('button', { name: `Open ${name}` });
/** The folder on screen, by the breadcrumb's last entry. (The list itself is absent while a folder is empty.) */
const showsFolder = (name: string) =>
  waitFor(() => expect(screen.getByRole('navigation', { name: 'Folder path' }).querySelector('[aria-current]')).toHaveTextContent(name));

describe('DrivePicker', () => {
  it('shows nothing until there is something to save', () => {
    setup();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists folders first, then files that cannot be chosen', async () => {
    const { open } = setup((s) => {
      s.put(['zeta.txt'], blob('z'));
      s.mkdir(['Reports']);
      s.mkdir(['Archive']);
    });
    open();
    expect(await screen.findByRole('heading', { name: 'Save to Drive' })).toBeInTheDocument();
    await folderRow('Archive');
    // The drive's name arrives a moment after the first listing.
    const rows = within(await screen.findByRole('list', { name: 'Alice Example' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Archive', 'Reports', expect.stringContaining('zeta.txt')]);
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
  });

  it('counts the files in its title when there are several', async () => {
    const { open } = setup(() => {}, 3);
    open();
    expect(await screen.findByRole('heading', { name: 'Save 3 files to Drive' })).toBeInTheDocument();
  });

  it('says so when a folder is empty', async () => {
    const { open } = setup();
    open();
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument();
  });

  it('opens a folder and goes back by the breadcrumb', async () => {
    const { open } = setup((s) => {
      s.mkdir(['Reports', '2026']);
    });
    open();
    fireEvent.click(await folderRow('Reports'));
    await folderRow('2026');
    expect(screen.getByRole('list', { name: 'Reports' })).toBeInTheDocument();
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Folder path' })).findByRole('button', { name: 'Alice Example' }));
    await folderRow('Reports');
  });

  it('saves into the folder on screen and closes', async () => {
    const { server, toast, open } = setup((s) => {
      s.mkdir(['Reports']);
    });
    open();
    fireEvent.click(await folderRow('Reports'));
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'Save here' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.names(['Reports'])).toEqual(['file-1.txt']);
    expect(toast).toHaveBeenCalledWith('Saved to Drive: Reports', 'success');
  });

  it('saves once however often Save here is pressed', async () => {
    const { server, open } = setup();
    open();
    await screen.findByText('This folder is empty.');
    const save = screen.getByRole('button', { name: 'Save here' });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.names([])).toEqual(['file-1.txt']);
  });

  it('creates a folder and opens it', async () => {
    const { server, open } = setup();
    open();
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const field = screen.getByLabelText('Folder name');
    fireEvent.input(field, { target: { value: 'Invoices' } });
    fireEvent.submit(field.closest('form')!);
    await showsFolder('Invoices');
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument();
    expect(server.names([])).toEqual(['Invoices']);
  });

  it('refuses a folder name that is empty, has a slash, or is already there', async () => {
    const { server, open } = setup((s) => {
      s.mkdir(['Reports']);
    });
    open();
    await folderRow('Reports');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const field = screen.getByLabelText('Folder name');
    const submit = (value: string) => {
      fireEvent.input(field, { target: { value } });
      fireEvent.submit(field.closest('form')!);
    };
    submit('  ');
    expect(await screen.findByText('Give the folder a name.')).toBeInTheDocument();
    submit('a/b');
    expect(await screen.findByText("A folder name can't contain a slash.")).toBeInTheDocument();
    submit('reports');
    expect(await screen.findByText('A folder or file with that name is already here.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(server.names([])).toEqual(['Reports']);
  });

  it('shows why a listing failed and tries again', async () => {
    const { server, open } = setup((s) => {
      s.mkdir(['Reports']);
      s.down = true;
    });
    open();
    expect(await screen.findByText("Drive isn't available right now.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save here' })).toBeDisabled();
    server.down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await folderRow('Reports');
    expect(screen.getByRole('button', { name: 'Save here' })).toBeEnabled();
  });

  it('opens where the last save went, and at the top if that folder has gone', async () => {
    const { server, drive, open } = setup((s) => {
      s.mkdir(['Reports']);
    });
    open();
    fireEvent.click(await folderRow('Reports'));
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'Save here' }));
    await waitFor(() => expect(drive.request()).toBeNull());
    open();
    await showsFolder('Reports');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    server.remove(['Reports']);
    open();
    await showsFolder('Alice Example');
    expect(await screen.findByText('This folder is empty.')).toBeInTheDocument();
  });

  it('moves between folders with the arrow keys and goes up with Backspace', async () => {
    const { open } = setup((s) => {
      s.mkdir(['Archive']);
      s.mkdir(['Reports', '2026']);
    });
    open();
    const archive = await folderRow('Archive');
    const reports = await folderRow('Reports');
    archive.focus();
    fireEvent.keyDown(archive, { key: 'ArrowDown' });
    expect(reports).toHaveFocus();
    fireEvent.keyDown(reports, { key: 'ArrowDown' });
    expect(archive).toHaveFocus();
    fireEvent.keyDown(archive, { key: 'End' });
    expect(reports).toHaveFocus();
    fireEvent.click(reports);
    const inner = await folderRow('2026');
    fireEvent.keyDown(inner, { key: 'Backspace' });
    await folderRow('Archive');
  });

  it('closes on Cancel without saving', async () => {
    const { server, drive, open } = setup();
    open();
    await screen.findByText('This folder is empty.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(drive.request()).toBeNull();
    expect(server.names([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/ui/DrivePicker.test.tsx`
Expected: FAIL, cannot resolve `./DrivePicker`.

- [ ] **Step 3: Implement the picker**

Create `src/ui/DrivePicker.tsx`:

```tsx
import { Dialog } from '@rozie-ui/dialog-solid';
import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { useApp } from '../app/context';
import { driveMessage, type Trail } from '../app/drive';
import { DriveError, type DriveItem } from '../drive/client';
import { fileSize } from '../mail/format';
import { Icon } from './icons';

/** Choose the Drive folder to save into. Open while the app has a save waiting. */
export function DrivePicker() {
  const { drive } = useApp();
  return (
    <Show when={drive.request()} keyed>
      {(req) => <Picker count={req.files.length} />}
    </Show>
  );
}

function Picker(props: { count: number }) {
  const { drive } = useApp();
  const [trail, setTrail] = createSignal<Trail>(drive.lastTrail());
  /** null while the folder is being listed. */
  const [items, setItems] = createSignal<DriveItem[] | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [naming, setNaming] = createSignal(false);
  const [nameError, setNameError] = createSignal('');
  const [rootName, setRootName] = createSignal(trail()[0]!.name);
  let list: HTMLUListElement | undefined;
  let nameField: HTMLInputElement | undefined;
  /** Only the latest listing counts: a slow answer for a folder already left is dropped. */
  let asked = 0;

  const here = () => trail().at(-1)!;
  const path = () => trail().slice(1).map((c) => c.name);
  const label = (i: number) => (i === 0 ? rootName() : trail()[i]!.name);

  const load = async () => {
    const mine = ++asked;
    setItems(null);
    setError('');
    try {
      const found = await drive.client.children(here().id);
      if (mine !== asked) return;
      setItems([...found].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)));
    } catch (e) {
      if (mine !== asked) return;
      // The folder remembered from last time has gone: start again from the top.
      if (e instanceof DriveError && e.kind === 'missing' && trail().length > 1) return void setTrail([trail()[0]!]);
      setError(driveMessage(e));
    }
  };
  createEffect(on(trail, () => void load()));
  void drive.client.drive().then((d) => setRootName(d.name), () => {});

  const enter = (item: DriveItem) => setTrail([...trail(), { id: item.id, name: item.name }]);
  const up = () => trail().length > 1 && setTrail(trail().slice(0, -1));
  const ready = () => items() !== null && !busy();

  const onListKey = (e: KeyboardEvent) => {
    const rows = [...(list?.querySelectorAll<HTMLElement>('button[data-folder]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Backspace') {
      e.preventDefault();
      return void up();
    }
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 };
    const to = moves[e.key];
    if (to === undefined || !rows.length) return;
    e.preventDefault();
    rows[(to + rows.length) % rows.length]?.focus();
  };

  const save = async () => {
    if (!ready()) return;
    setBusy(true);
    try {
      // On success the app drops the request and this dialog goes with it.
      await drive.confirm(trail());
    } finally {
      setBusy(false);
    }
  };

  const checkName = (raw: string): string => {
    const name = raw.trim();
    if (!name || name === '.' || name === '..') return 'Give the folder a name.';
    if (/[/\\]/.test(name)) return "A folder name can't contain a slash.";
    if ((items() ?? []).some((i) => i.name.toLowerCase() === name.toLowerCase())) return 'A folder or file with that name is already here.';
    return '';
  };

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!ready() || !nameField) return;
    const name = nameField.value.trim();
    const problem = checkName(name);
    setNameError(problem);
    if (problem) return;
    setBusy(true);
    try {
      await drive.client.createFolder([...path(), name]);
      const made = (await drive.client.children(here().id)).find((i) => i.folder && i.name === name);
      setNaming(false);
      if (made) enter(made);
      else void load();
    } catch (err) {
      setNameError(driveMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy() && drive.cancel()} ariaLabelledby="drive-picker-title">
      <div class="drive-picker">
        <h2 id="drive-picker-title">{props.count === 1 ? 'Save to Drive' : `Save ${props.count} files to Drive`}</h2>
        <nav class="drive-crumbs" aria-label="Folder path">
          <For each={trail()}>
            {(_, i) => (
              <Show when={i() < trail().length - 1} fallback={<span aria-current="location">{label(i())}</span>}>
                <button type="button" onClick={() => setTrail(trail().slice(0, i() + 1))}>{label(i())}</button>
                <span aria-hidden="true">›</span>
              </Show>
            )}
          </For>
        </nav>
        <div class="drive-list">
          <Show when={!error()} fallback={
            <div class="drive-note" role="alert">
              <span>{error()}</span>
              <button type="button" onClick={() => void load()}>Try again</button>
            </div>
          }>
            <Show when={items()} fallback={<div class="drive-note" role="status">Loading…</div>}>
              {(found) => (
                <Show when={found().length} fallback={<div class="drive-note">This folder is empty.</div>}>
                  <ul ref={list} aria-label={label(trail().length - 1)} onKeyDown={onListKey}>
                    <For each={found()}>
                      {(item) => (
                        <li>
                          <Show when={item.folder} fallback={
                            <span class="drive-file">
                              <Icon name="file" />
                              <span>{item.name}</span>
                              <small>{fileSize(item.size)}</small>
                            </span>
                          }>
                            <button type="button" data-folder aria-label={`Open ${item.name}`} onClick={() => enter(item)}>
                              <Icon name="label" />
                              <span>{item.name}</span>
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              )}
            </Show>
          </Show>
        </div>
        <Show when={naming()}>
          <form class="label-form drive-new" onSubmit={create}>
            <input
              ref={(el) => {
                nameField = el;
                queueMicrotask(() => el.focus());
              }}
              type="text"
              aria-label="Folder name"
              aria-invalid={nameError() ? 'true' : undefined}
              aria-describedby={nameError() ? 'drive-new-error' : undefined}
              onInput={(e) => nameError() && setNameError(checkName(e.currentTarget.value))}
            />
            <Show when={nameError()}>
              <p class="field-error" id="drive-new-error" role="alert">{nameError()}</p>
            </Show>
            <div class="dialog-actions">
              <button type="button" onClick={() => { setNaming(false); setNameError(''); }}>Cancel</button>
              <button type="submit" class="primary" disabled={!ready()}>Create</button>
            </div>
          </form>
        </Show>
        <Show when={!naming()}>
          <div class="dialog-actions drive-actions">
            <button type="button" class="drive-add" disabled={!ready()} onClick={() => setNaming(true)}>
              <Icon name="add" /> New folder
            </button>
            <button type="button" disabled={busy()} onClick={() => drive.cancel()}>Cancel</button>
            <button type="button" class="primary" disabled={!ready()} onClick={() => void save()}>
              {busy() ? 'Saving…' : 'Save here'}
            </button>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}
```

The tests find the dialog by `role="dialog"`. Confirm that is what rozie's `Dialog` renders (`pnpm test src/ui/ConfirmDialog.test.tsx` with a `screen.debug()` added for a moment, or read `node_modules/@rozie-ui/dialog-solid/dist/index.d.mts`); if it renders another role, change the tests' queries to match and nothing else.

Note for the test "refuses a folder name…": the name form has its own `Cancel`, and it replaces the dialog's action row while it is open, so there is one `Cancel` button on screen at a time.

Check the existing class for a field's error text first: `grep -n "field-error\|\.error" src/ui/styles.css`. If the stylesheet names it differently (the label dialog shows one), use that class instead of `field-error`.

- [ ] **Step 4: Add the styles**

Append to `src/ui/styles.css`:

```css
/* Drive folder picker */
.drive-picker { display: flex; flex-direction: column; gap: 12px; width: min(480px, 86vw); }
.drive-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--text-3); }
.drive-crumbs button { border: 0; background: none; padding: 2px 4px; border-radius: 4px; color: var(--accent); cursor: pointer; font: inherit; }
.drive-crumbs button:hover, .drive-crumbs button:focus-visible { background: var(--hover); outline: none; }
.drive-crumbs [aria-current] { color: var(--text); font-weight: 600; padding: 2px 4px; }
.drive-list { height: min(320px, 45vh); overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
.drive-list ul { list-style: none; margin: 0; padding: 4px; }
.drive-list li > button, .drive-file { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 6px; background: none; color: var(--text); font: inherit; text-align: left; }
.drive-list li > button { cursor: pointer; }
.drive-list li > button:hover, .drive-list li > button:focus-visible { background: var(--hover); outline: none; }
.drive-list svg { width: 18px; height: 18px; flex: none; }
.drive-list li span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.drive-file { color: var(--text-3); }
.drive-file small { margin-left: auto; flex: none; }
.drive-note { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; color: var(--text-3); text-align: center; padding: 16px; }
.drive-note button { border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 8px; padding: 6px 14px; cursor: pointer; font: inherit; }
.drive-actions .drive-add { display: inline-flex; align-items: center; gap: 6px; margin-right: auto; }
.drive-actions .drive-add svg { width: 16px; height: 16px; }
.drive-new { display: flex; flex-direction: column; gap: 8px; }
```

- [ ] **Step 5: Run to see them pass**

Run: `pnpm test src/ui/DrivePicker.test.tsx && pnpm typecheck`
Expected: PASS, 13 tests. `pnpm typecheck` reports no error in `DrivePicker.tsx` other than `Property 'drive' does not exist on type 'App'`, which Task 6 fixes. If you prefer a clean typecheck at this commit, do Task 6 Step 3 (the `App.drive` field) now and commit it with this task.

- [ ] **Step 6: Commit**

```bash
git add src/ui/DrivePicker.tsx src/ui/DrivePicker.test.tsx src/ui/styles.css
git commit -m "Drive: a folder picker, one folder at a time, with New folder and the keyboard"
```

---

### Task 6: The attachment menu, and wiring it all in

**Files:**
- Create: `src/ui/menu.ts`, `src/ui/Attachments.tsx`
- Modify: `src/ui/LabelMenu.tsx`, `src/ui/Conversation.tsx:363-398` (the `Attachments` function moves out), `src/ui/Shell.tsx:129`, `src/app/context.tsx`, `src/index.tsx`, `src/ui/styles.css`
- Test: `src/ui/Attachments.test.tsx`

**Interfaces:**
- Consumes: `createDrive`, `Drive`, `SaveFile` (Task 4); `DriveClient` (Task 3); `loadDriveConfig` (Task 2); `DrivePicker` (Task 5); `engine.fetchBlob(blobId, name, type): Promise<Blob>`; `Popover` from `@rozie-ui/popover-solid` as `src/ui/LabelMenu.tsx` uses it.
- Produces: `App.drive: Drive`; `export function Attachments(props: { email: EmailRec }): JSX.Element`; `export function menuKeys(items: () => HTMLElement[], close: () => void): (e: KeyboardEvent) => void`.

- [ ] **Step 1: Share the menu's keyboard handling**

Create `src/ui/menu.ts`:

```ts
/**
 * Keys for a popover menu of `[role="menuitem"]` buttons: the arrows wrap, Home and End jump,
 * Escape and Tab close. Tab is not prevented, so the browser carries it on from the menu's button.
 */
export function menuKeys(items: () => HTMLElement[], close: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') return close();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    list[(to + list.length) % list.length]?.focus();
  };
}
```

In `src/ui/LabelMenu.tsx`, add `import { menuKeys } from './menu';`, delete the whole `const onKeyDown = (e: KeyboardEvent) => { … };` block, and add in its place, after `close` is defined:

```ts
  const onKeyDown = menuKeys(items, close);
```

Run: `pnpm test src/ui/LabelMenu.test.tsx`
Expected: PASS, unchanged count. This is a move, not a change of behaviour.

- [ ] **Step 2: Write the failing tests for the chips**

Create `src/ui/Attachments.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import type { SaveFile } from '../app/drive';
import type { EmailRec } from '../sync/engine';
import { Attachments } from './Attachments';

const part = (name: string | null, extra: Record<string, unknown> = {}) => ({ partId: name ?? 'p', blobId: `blob-${name}`, name, type: 'text/plain', size: 1536, disposition: 'attachment', ...extra });

function setup(opts: { offered: boolean; parts?: ReturnType<typeof part>[] }) {
  const fetched = new Blob(['bytes']);
  const fetchBlob = vi.fn(async () => fetched);
  const saveToDrive = vi.fn<(files: SaveFile[]) => void>();
  const app = { engine: { fetchBlob }, toast: vi.fn(), drive: { offered: () => opts.offered, saveToDrive } } as unknown as App;
  const email = { id: 'e1', attachments: opts.parts ?? [part('notes.txt')] } as unknown as EmailRec;
  render(() => (
    <AppContext.Provider value={app}>
      <Attachments email={email} />
    </AppContext.Provider>
  ));
  return { fetchBlob, saveToDrive, fetched };
}

describe('Attachments', () => {
  it('without Drive, a chip downloads on a click and has no menu', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { fetchBlob } = setup({ offered: false });
    const chip = screen.getByRole('button', { name: /notes\.txt/ });
    expect(chip).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(chip);
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalledWith('blob-notes.txt', 'notes.txt', 'text/plain'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save all to Drive' })).toBeNull();
  });

  it('with Drive, a chip opens a menu of Download and Save to Drive', async () => {
    setup({ offered: true });
    const chip = screen.getByRole('button', { name: /notes\.txt/ });
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(chip);
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Download', 'Save to Drive']);
    await vi.waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
  });

  it('Save to Drive hands the app the file, fetched only when asked for', async () => {
    const { fetchBlob, saveToDrive, fetched } = setup({ offered: true });
    fireEvent.click(screen.getByRole('button', { name: /notes\.txt/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Save to Drive' }));
    expect(saveToDrive).toHaveBeenCalledOnce();
    const files = saveToDrive.mock.calls[0]![0];
    expect(files.map((f) => f.name)).toEqual(['notes.txt']);
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(await files[0]!.fetch()).toBe(fetched);
    expect(fetchBlob).toHaveBeenCalledWith('blob-notes.txt', 'notes.txt', 'text/plain');
  });

  it('Download in the menu downloads', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { fetchBlob, saveToDrive } = setup({ offered: true });
    fireEvent.click(screen.getByRole('button', { name: /notes\.txt/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalled());
    expect(saveToDrive).not.toHaveBeenCalled();
  });

  it('offers Save all to Drive for several attachments, leaving out images shown in the text', () => {
    const { saveToDrive } = setup({
      offered: true,
      parts: [part('a.pdf'), part('chart.png', { type: 'image/png', disposition: 'inline', cid: 'c1' }), part(null)],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save all to Drive' }));
    expect(saveToDrive.mock.calls[0]![0].map((f) => f.name)).toEqual(['a.pdf', 'attachment']);
  });

  it('has no Save all for a single attachment', () => {
    setup({ offered: true });
    expect(screen.queryByRole('button', { name: 'Save all to Drive' })).toBeNull();
  });
});
```

Run: `pnpm test src/ui/Attachments.test.tsx`
Expected: FAIL, cannot resolve `./Attachments`.

- [ ] **Step 3: Give the app a Drive**

In `src/app/context.tsx`, add `import type { Drive } from './drive';` and, in `interface App` after `password: Password;`:

```ts
  /** OpenCloud as Drive, if this installation has one. The user's own, whichever mailbox is on screen. */
  drive: Drive;
```

In `src/index.tsx`:

1. Add the imports:
   ```ts
   import { createDrive } from './app/drive';
   import { DriveClient } from './drive/client';
   import { loadDriveConfig } from './drive/config';
   ```
2. The JMAP client's `getToken` and `onUnauthorized` are written inline in `new JmapClient({ … })`. Lift them into two constants just above it, unchanged (keep their comments), and pass them by name:
   ```ts
   // A token refresh can fail on the network too, before any request is made.
   const getToken = () =>
     auth.getToken().catch((e) => {
       // … the existing body, unchanged …
     });
   const renewSession = async () => {
     // … the existing onUnauthorized body, unchanged …
   };
   const client = new JmapClient({
     sessionUrl: `${origin}/.well-known/jmap`,
     getToken,
     onUnauthorized: renewSession,
     onOutcome: (e) => (e === null ? connection.reportSuccess('request') : connection.reportFailure('request', e)),
   });
   ```
3. After `const errors = createErrorReporter(toasts.toast);` add:
   ```ts
   // Drive shares the mail token. Its failures are its own: they never reach the connection banner.
   const drive = createDrive({ client: new DriveClient({ getToken, onUnauthorized: renewSession }), toast: toasts.toast });
   // Not awaited: mail does not wait to learn whether there is a Drive.
   void loadDriveConfig((url) => fetch(url, { cache: 'no-cache' })).then(drive.setConfig);
   ```
4. In the `const app: App = { … }` literal, after the `password:` line, add `drive,`.

In `src/ui/Shell.tsx`, add `import { DrivePicker } from './DrivePicker';` and render `<DrivePicker />` on the line after `<LabelDialog />`.

- [ ] **Step 4: Move the chips into their own file, with the menu**

Create `src/ui/Attachments.tsx`:

```tsx
import { Popover } from '@rozie-ui/popover-solid';
import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { EmailBodyPart } from '../jmap/types';
import { fileSize } from '../mail/format';
import type { EmailRec } from '../sync/engine';
import { Icon } from './icons';
import { menuKeys } from './menu';

/** A message's attachments as chips. With a Drive, a chip offers a choice; without, it downloads. */
export function Attachments(props: { email: EmailRec }) {
  const { engine, toast, drive } = useApp();
  // Inline images referenced by the HTML body aren't listed as attachments.
  const list = () => (props.email.attachments ?? []).filter((a) => !(a.disposition === 'inline' && a.cid && a.type.startsWith('image/')));
  const nameOf = (a: EmailBodyPart) => a.name ?? 'attachment';
  const bytes = (a: EmailBodyPart) => engine.fetchBlob(a.blobId!, nameOf(a), a.type);

  const download = async (a: EmailBodyPart) => {
    try {
      const url = URL.createObjectURL(await bytes(a));
      const link = document.createElement('a');
      link.href = url;
      link.download = nameOf(a);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast(`Download failed: ${String(e)}`, 'error');
    }
  };
  /** The bytes are fetched when the save runs, not now: the user may yet cancel. */
  const toDrive = (parts: EmailBodyPart[]) => drive.saveToDrive(parts.map((a) => ({ name: nameOf(a), fetch: () => bytes(a) })));

  const face = (a: EmailBodyPart) => (
    <>
      <Icon name="file" style={{ width: '20px', height: '20px', flex: 'none' }} />
      <span>{nameOf(a)}</span>
      <small>{fileSize(a.size)}</small>
    </>
  );

  return (
    <Show when={list().length}>
      <div class="attachments">
        <For each={list()}>
          {(a) => (
            <Show
              when={drive.offered()}
              fallback={
                <button type="button" class="attachment" onClick={() => void download(a)} title={a.name ?? ''}>
                  {face(a)}
                </button>
              }
            >
              <AttachmentMenu name={nameOf(a)} onDownload={() => void download(a)} onSave={() => toDrive([a])}>
                {face(a)}
              </AttachmentMenu>
            </Show>
          )}
        </For>
        <Show when={drive.offered() && list().length > 1}>
          <button type="button" class="attachment attachment-all" onClick={() => toDrive(list())}>
            Save all to Drive
          </button>
        </Show>
      </div>
    </Show>
  );
}

/** A chip that opens a menu: Download, Save to Drive. */
function AttachmentMenu(props: { name: string; onDownload: () => void; onSave: () => void; children: unknown }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => items()[0]?.focus({ preventScroll: true }));
  }, { defer: true }));

  /** Close with the focus back on the chip. */
  const close = () => {
    setOpen(false);
    button?.focus();
  };
  const choose = (run: () => void) => {
    close();
    run();
  };

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      trigger="manual"
      placement="bottom-start"
      strategy="fixed"
      offset={4}
      anchorSlot={() => (
        <button ref={button} type="button" class="attachment" title={props.name} aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
          {props.children as never}
        </button>
      )}
    >
      <div class="menu" role="menu" aria-label={`Options for ${props.name}`} ref={menu} onKeyDown={menuKeys(items, close)}>
        <button type="button" role="menuitem" onClick={() => choose(props.onDownload)}>Download</button>
        <button type="button" role="menuitem" onClick={() => choose(props.onSave)}>Save to Drive</button>
      </div>
    </Popover>
  );
}
```

`props.children as never` satisfies the JSX typing with `children: unknown`; if the project's other components type children as `JSX.Element` (`import type { JSX } from 'solid-js'`), do that instead and drop the cast.

In `src/ui/Conversation.tsx`: delete the whole `function Attachments(props: { email: EmailRec }) { … }` (lines 363 to the end of the file's last component), add `import { Attachments } from './Attachments';`, and remove any import that is now unused there (`EmailBodyPart`, `fileSize`, if nothing else in the file uses them; `pnpm typecheck` will say).

Append to `src/ui/styles.css`:

```css
.attachment-all { color: var(--accent); }
```

- [ ] **Step 5: Run everything**

Run: `pnpm test && pnpm typecheck`
Expected: every test passes, including the 6 new ones in `Attachments.test.tsx`; no type errors. A test elsewhere that renders `Shell` or `Conversation` with a stub `App` and now fails for want of `app.drive` gets `drive: { offered: () => false, request: () => null }` added to its stub.

- [ ] **Step 6: Look at it**

Run:
```sh
pnpm build
(cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d)
```
Open `http://localhost:8080`, sign in as `alice@example.test` / `oinbox-dev-pass`, open a message with an attachment (send one to yourself with a file if the seed has none), and check by hand: the chip opens a menu; `Save to Drive` opens the picker; `New folder` then `Save here` shows the toast; the picker reopens in that folder. Check in dark theme too (the theme button in the top bar).

- [ ] **Step 7: Commit**

```bash
git add src/ui/menu.ts src/ui/LabelMenu.tsx src/ui/Attachments.tsx src/ui/Attachments.test.tsx src/ui/Conversation.tsx src/ui/Shell.tsx src/app/context.tsx src/index.tsx src/ui/styles.css
git commit -m "Drive: an attachment chip offers Save to Drive when there is one"
```

---

### Task 7: End to end, and the documentation

**Files:**
- Create: `e2e/drive.spec.ts`
- Modify: `docs/operating.md`, `deploy/README.md`, `README.md`, `CHANGELOG.md`, `docs/rozie-feedback.md` (only if Step 5 applies)

**Interfaces:**
- Consumes: e2e helpers from Task 1 (`driveToken`, `driveChildren`, `removeFromDrive`, `waitForDrive`); from `e2e/support/mail.ts`: `deliverToAlice(m: Omit<OutgoingMail, 'to'>): Promise<EmailInfo>` (`EmailInfo` has `threadId`), `uniqueTag(prefix?)`; from `e2e/support/compose.ts`: `inlineImageMail(cid, attachment?)` (a message with `notes.txt` attached), `toast(page, text)`; from `e2e/support/app.ts`: `openInbox(page)`, `rowFor(page, threadId)`.

- [ ] **Step 1: Write the end-to-end tests**

Create `e2e/drive.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { openInbox, rowFor } from './support/app';
import { inlineImageMail, toast } from './support/compose';
import { driveChildren, driveToken, removeFromDrive, waitForDrive } from './support/drive';
import { deliverToAlice, destroyEmails, uniqueTag, type EmailInfo } from './support/mail';

// Save to Drive against the dev stack's OpenCloud (deploy/docker-compose.yml, behind /drive).
const NOTES = 'notes for the chart';
let mail: EmailInfo;

test.beforeAll(async () => {
  mail = await deliverToAlice({ from: 'Bob Example <bob@example.test>', subject: `Drive ${uniqueTag()}`, text: '', mime: inlineImageMail(uniqueTag('cid'), NOTES) });
});
test.afterAll(async () => {
  await destroyEmails([mail.id]);
});

async function openMessage(page: Page) {
  await openInbox(page);
  await rowFor(page, mail.threadId).click();
  await expect(page.locator('.attachments .attachment', { hasText: 'notes.txt' })).toBeVisible();
}

const chip = (page: Page) => page.locator('.attachments').getByRole('button', { name: /notes\.txt/ });

test('an attachment is saved into a new Drive folder, and a second save keeps both', async ({ page }) => {
  test.setTimeout(240_000);
  const folder = uniqueTag('e2e-drive');
  await openMessage(page);
  const token = await driveToken(page);
  await waitForDrive(token);
  try {
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'Save to Drive' }).click();
    const picker = page.getByRole('dialog');
    await expect(picker.getByRole('heading', { name: 'Save to Drive' })).toBeVisible();
    await picker.getByRole('button', { name: 'New folder' }).click();
    await picker.getByLabel('Folder name').fill(folder);
    await picker.getByLabel('Folder name').press('Enter');
    await expect(picker.getByRole('navigation', { name: 'Folder path' })).toContainText(folder);
    await picker.getByRole('button', { name: 'Save here' }).click();
    await expect(toast(page, `Saved to Drive: ${folder}`)).toBeVisible();
    await expect(picker).toBeHidden();

    const made = (await driveChildren(token)).find((e) => e.name === folder);
    expect(made?.folder).toBeTruthy();
    const saved = await driveChildren(token, made!.id);
    expect(saved.map((e) => e.name)).toEqual(['notes.txt']);
    // The exact size depends on how the mail's line endings were stored; it must only not be empty.
    expect(saved[0]!.size).toBeGreaterThanOrEqual(NOTES.length);

    // Again: the picker opens where the last save went, and nothing is replaced.
    await chip(page).click();
    await page.getByRole('menuitem', { name: 'Save to Drive' }).click();
    await expect(picker.getByRole('navigation', { name: 'Folder path' })).toContainText(folder);
    await expect(picker.locator('.drive-file', { hasText: 'notes.txt' })).toBeVisible();
    await picker.getByRole('button', { name: 'Save here' }).click();
    await expect(toast(page, `Saved to Drive: ${folder}`).last()).toBeVisible();
    await expect.poll(async () => (await driveChildren(token, made!.id)).map((e) => e.name).sort()).toEqual(['notes (1).txt', 'notes.txt']);
  } finally {
    await removeFromDrive(token, [folder]);
  }
});

test('without a Drive the chip downloads, as it always did', async ({ page }) => {
  await page.route('**/drive.json', (route) => route.fulfill({ json: { enabled: false, linkOverMb: 20 } }));
  const driveRequests: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/drive/')) driveRequests.push(r.url());
  });
  await openMessage(page);
  await expect(chip(page)).not.toHaveAttribute('aria-haspopup', 'menu');
  const download = page.waitForEvent('download');
  await chip(page).click();
  expect((await download).suggestedFilename()).toBe('notes.txt');
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(driveRequests).toEqual([]);
});

test('a Drive that is down says so and leaves mail alone', async ({ page }) => {
  await page.route('**/drive/graph/**', (route) => route.fulfill({ status: 503, body: '' }));
  await openMessage(page);
  // Nothing was asked of Drive just by opening the app and a message.
  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Save to Drive' }).click();
  const picker = page.getByRole('dialog');
  await expect(picker.getByText("Drive isn't available right now.")).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Save here' })).toBeDisabled();
  await expect(page.locator('.connection-banner')).toHaveCount(0);
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await expect(picker).toBeHidden();
  // Download still works from the same menu.
  const download = page.waitForEvent('download');
  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe('notes.txt');
});
```

Before running, check two names this file assumes and correct them to what the code has:
- `grep -n "class=" src/ui/ConnectionBanner.tsx | head -3` for the banner's class (written above as `.connection-banner`).
- `grep -n "destroyEmails\|deliverToAlice" e2e/support/mail.ts` for the two helpers' exact signatures.

The seed's `inlineImageMail(cid, attachment)` gives the message one inline image and `notes.txt`; only `notes.txt` is listed as a chip, so `Save all to Drive` does not appear, which is what the first test relies on.

- [ ] **Step 2: Run them**

Run: `pnpm build && pnpm e2e e2e/drive.spec.ts e2e/drive-stack.spec.ts`
Expected: 6 passed.

- [ ] **Step 3: Run the whole suite in the three engines once**

Run: `pnpm test && pnpm e2e:all`
Expected: everything passes. Drive is now on in the dev stack for every spec, so a spec that clicks an attachment chip expecting a download (search with `grep -rn "\.attachment" e2e/*.spec.ts`) must choose `Download` from the menu instead; fix any that fail for that reason, and no other.

- [ ] **Step 4: Write the documentation**

In `docs/operating.md`, add two rows to the table under "The image's settings", after `OINBOX_BRAND_LOGO`:

```markdown
| `OINBOX_DRIVE_UPSTREAM` | none | Where an OpenCloud's HTTP listener is, as `host:port`. Set, the app offers Drive; unset, it shows none. See "Drive". |
| `OINBOX_DRIVE_LINK_OVER_MB` | `20` | Reserved for sending large files as Drive links, which this version does not yet do. A whole number. |
```

and add a section after "Branding":

```markdown
### Drive

oinbox can use an [OpenCloud](https://opencloud.eu) that runs beside Stalwart as the user's Drive. In this version that means one thing: an attachment can be saved into a Drive folder from the message it came in. Users sign in once; OpenCloud accepts the sign-in Stalwart gave oinbox.

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

- `OINBOX_DRIVE_UPSTREAM` set to OpenCloud's listener. oinbox's Caddy then sends `/drive/*` to it with the prefix removed, and tells the app Drive is on in `/drive.json`.
- OpenCloud able to reach Stalwart at that public URL from where it runs.

Behind your own proxy, do what `deploy/examples/nginx.conf` shows: proxy `/drive/` to OpenCloud with the prefix removed, send it `X-Forwarded-Proto: https`, hide `WWW-Authenticate` on the way back, do not buffer or limit request bodies, and set `"enabled": true` in the `drive.json` that ships with the static files.

**Things to know before the first user signs in**

- *Accounts need a name.* An account with no description in Stalwart has no `name` to give OpenCloud, which then refuses to create the user (the Drive actions answer "Drive isn't available right now", and OpenCloud logs `missing claim 'name'`). Either give every account a description, or set `PROXY_AUTOPROVISION_CLAIM_DISPLAYNAME=preferred_username` and accept the address as the display name.
- *What a user is known by.* With the settings above the OpenCloud user is the e-mail address, so a renamed mailbox gets a new, empty drive. Setting `PROXY_USER_OIDC_CLAIM=sub` and `PROXY_AUTOPROVISION_CLAIM_USERNAME=sub` keeps the drive across a rename; the user is then known by Stalwart's account number. Choose before anyone signs in: changing it afterwards makes new users. oinbox works with either.
- *Trust.* Every Drive request carries the user's mail token to OpenCloud. Run only an OpenCloud you would trust with the mail.
- *Signing out.* A token Stalwart has revoked (a changed password, say) stops working in OpenCloud within a second.

**If Drive is set but not working**, the app still shows the Drive actions and answers "Drive isn't available right now" when one is used; mail is unaffected. Check that `https://<your host>/drive/graph/v1.0/me/drive` answers 401 (not 404, and not the app's page), then OpenCloud's log for `failed to get userinfo`, which means it cannot reach Stalwart at `OC_OIDC_ISSUER`.

Tested with Stalwart 0.16.23 and OpenCloud 7.2.4 and 8.1.0.
```

In `deploy/README.md`: add "OpenCloud 7.2.4 (Drive)" to the first paragraph's list of what the stack runs; add `/drive.json` and `/drive/*` (to OpenCloud, prefix removed) under "Paths proxied to Stalwart" as a short separate paragraph headed "Paths proxied to OpenCloud", with the sentence "Keep SPA routes clear of `/drive` too."; and add a note: "OpenCloud shares Caddy's network namespace, which is how it reaches Stalwart at `http://localhost:8080`. It publishes no port and its own web UI is not reachable. After `docker compose restart caddy`, run `docker compose restart opencloud` as well."

In `README.md`, add to the feature list (in the list's own style): "Save attachments to Drive, where an OpenCloud runs beside Stalwart."

In `CHANGELOG.md`, add above `## 0.1.0-beta.2`:

```markdown
## Unreleased

### Added

- Drive: where an OpenCloud runs beside Stalwart, an attachment can be saved into one of its folders from the message, with no second sign-in. Operators turn it on with `OINBOX_DRIVE_UPSTREAM` (docs/operating.md, "Drive"). Tested against OpenCloud 7.2.4 and 8.1.0.
```

- [ ] **Step 5: Record anything rozie made harder**

If building the picker or the chip menu needed a workaround in a rozie component (the dialog's focus handling, the popover inside a flex row), add an entry to `docs/rozie-feedback.md` in that file's existing format. If nothing did, change nothing.

- [ ] **Step 6: Commit**

```bash
git add e2e/drive.spec.ts docs/operating.md deploy/README.md README.md CHANGELOG.md
git add -u e2e docs/rozie-feedback.md
git commit -m "Drive: end-to-end tests for saving, for no Drive and for a Drive that is down; the operator's guide"
```

- [ ] **Step 7: Note for whoever pushes**

Each of the four end-to-end jobs in `.github/workflows/ci.yml` now pulls and starts OpenCloud as part of `docker compose up --wait`. After the first push, compare the jobs' duration with the previous run and report the difference; nothing in the workflow needs changing for it to work.
