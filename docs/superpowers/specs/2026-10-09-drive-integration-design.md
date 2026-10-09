# Drive: OpenCloud beside the mailbox

An installation that runs OpenCloud next to Stalwart gets three things in oinbox: save an attachment to Drive, attach a file from Drive, and send files too large for mail as a Drive link. The user signs in once. An installation without OpenCloud sees none of it.

Success: Alice opens a message with a PDF, chooses "Save to Drive", picks a folder, and the file is there when she opens OpenCloud. Writing to Bob, she attaches a spreadsheet from Drive without downloading it first. She then adds an 80 MB video; oinbox offers to send it as a link, she lets it generate a password, and Bob receives a message with a link and the password that opens the video.

This is one design built in three slices, each with its own plan: **1. Save to Drive**, **2. Attach from Drive**, **3. Send as a link**.

## What the servers give us

Probed on 2026-10-09 with Stalwart 0.16.23 and OpenCloud rolling 8.1.0, by script, on the dev stack. Not yet tried: a real browser, HTTPS, a proxy prefix (see "Not yet known").

### Sign-in

- **Stalwart's access token is opaque** (`sw1.…`), not a JWT, so OpenCloud cannot check it against Stalwart's keys.
- **OpenCloud accepts it all the same** when told to verify by asking: with `PROXY_OIDC_ACCESS_TOKEN_VERIFY_METHOD=none` it calls Stalwart's `/auth/userinfo` with the token and caches the answer. There is no audience check. The token oinbox already holds works unchanged.
- **The account is created on first use**, named after the e-mail address (`GRAPH_USERNAME_MATCH=none` allows the `@`).
- **Stalwart keeps no browser session**: its sign-in sets no cookie. A second OAuth client for Drive would mean a second password prompt, so there is none.
- **Stalwart's user info carries no groups** (id, name, username, e-mail only). OpenCloud cannot learn of a Stalwart group.

### Files and links

| Need | Call | Notes |
|---|---|---|
| The user's drive | `GET /graph/v1.0/me/drive` | The id contains `$` and `!`; encode it in paths. |
| A folder's contents | `GET /graph/v1.0/me/drive/root/children`, `GET /graph/v1.0/drives/{drive}/items/{item}/children` | Items have `id`, `name`, `size`, and `folder` or `file`. The `v1beta1` form of the second is 404. |
| Create a folder | `MKCOL /dav/spaces/{drive}/{path}` | 201; 405 if it exists. No id in the answer. |
| Upload | `PUT /dav/spaces/{drive}/{path}` | 201, with the new item's id in `Oc-Fileid`. |
| Download | `GET /dav/spaces/{drive}/{path}` | Straight after an upload it can answer 425; retry. |
| An item's id from its path | `PROPFIND`, depth 0, `oc:fileid` | Needed for a folder made with `MKCOL`. |
| Sharing rules | `GET /ocs/v1.php/cloud/capabilities?format=json` | `password_policy` and `files_sharing.public.password.enforced_for.read_only`. |
| Public link | `POST /graph/v1beta1/drives/{drive}/items/{item}/createLink` | Works on a file or a folder. Answers with `link.webUrl`. |

- **A public link needs a password by default.** Without one: `400 password protection is enforced`. With one that breaks the policy: 400 with the rules in the message. The default policy is 8 to 72 characters with a lower-case letter, an upper-case letter, a digit and a special character.
- **OpenCloud never gives a link's password back**, only `hasPassword`.
- **An expiry is rounded to the end of its day.** None is required by default.
- **URLs in answers are of no use to us.** `webDavUrl` is absolute on OpenCloud's own host and `PROPFIND` hrefs are absolute paths. Only a link's `webUrl` is used, and that one is meant for the recipient.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Sign-in | Send OpenCloud the token oinbox already has. | It works, and the alternative asks for the password twice. |
| Reaching OpenCloud | Same origin, under `/drive/`, through the proxy that already fronts Stalwart. | The app's policy is `connect-src 'self'`; a second origin would mean loosening it in every installation. `/dav` alone is taken by Stalwart. |
| Turning it on | One operator setting, where OpenCloud is. Unset, the app shows no Drive actions. | oinbox must keep working against plain Stalwart. |
| Finding out it works | On the first Drive action, not at start-up. | A start-up call would create an OpenCloud account for every mail user, and mail must not wait on Drive. |
| Whose drive | The signed-in user's personal drive, also when working in a shared mailbox. | Agreed 2026-10-09. OpenCloud cannot know Stalwart's groups. |
| Build order | Save, attach, link. | Save needs only a folder list and an upload; each slice adds to the same client and picker. |
| Link threshold | 20 MB across the message's attachments, an operator setting. | Agreed 2026-10-09. Encoding adds a third, so 20 MB is about 27 MB on the wire, over the usual 25 MB limit. |
| One link per message | The files go in one folder and the folder is shared. | Agreed 2026-10-09: one link and one password for the recipient. |
| Link password | A step when the link is made: type one or generate one, then choose "put it in the message" or "I'll send it another way". Required when OpenCloud requires it; otherwise optional and off to begin with. | Agreed 2026-10-09. The sender decides how much protection a link needs. |
| Password recall | The password is kept in the tab for 30 minutes, keyed by the link, and shown beside the message with a copy button. | Agreed 2026-10-09: a copied password is easily lost to the next copy. |
| Link expiry | 30 days, changeable in the same step (7, 30, 90 days, none). A limit OpenCloud enforces narrows the choice. | A mailed file should not stay public for ever by accident. |
| The link in the message | A short block of ordinary text in the body, written when the link is made. | The saved draft then says what will be sent, a mail client that strips HTML still shows it, and the sender can edit it like any text. |
| Trust | OpenCloud sees a token that can also read the user's mail. The operator's guide says so. | It is the price of one sign-in; both servers are the operator's own. |

## How it fits together

```
ui    DrivePicker   LinkDialog   attachment chip "Save to Drive"   composer "From Drive"
       │               │
app   src/app/drive.ts          what is offered, the three actions, link passwords
       │
drive src/drive/client.ts       DriveClient: /drive/graph, /drive/dav, /drive/ocs
      src/drive/config.ts       /drive.json
      src/drive/password.ts     a password that meets a policy
```

### Settings (`src/drive/config.ts`)

The app reads `/drive.json` at start-up, as it reads `/branding.json`:

```ts
export interface DriveConfig {
  enabled: boolean;
  /** Offer a link when a message's attachments pass this many megabytes. */
  linkOverMb: number;
}
```

A missing file, a failed fetch or a malformed one means `{ enabled: false, linkOverMb: 20 }`. Unlike branding it is not remembered between visits: a Drive that was switched off must disappear.

Caddy writes the file from two variables and proxies `/drive/*` to OpenCloud with the prefix removed:

| Variable | Default | Meaning |
|---|---|---|
| `OINBOX_DRIVE_UPSTREAM` | none | Where OpenCloud's HTTP listener is. Unset: no Drive. |
| `OINBOX_DRIVE_LINK_OVER_MB` | `20` | The link threshold. |

`deploy/routes.caddy` holds the route, so the dev stack and the production template share it. `deploy/examples/nginx.conf` gets the same route. `/drive` joins the list of prefixes the app's own routes must avoid.

### The client (`src/drive/client.ts`)

`DriveClient` takes the same `getToken` and the same "token was refused" hook as the JMAP client, and a base path (`/drive`). It builds every URL itself from a drive id and a path of names, each segment encoded.

```ts
export interface DriveItem { id: string; name: string; size: number; folder: boolean; modified: string }
export interface SharingRules { passwordRequired: boolean; policy: PasswordPolicy; maxExpiryDays: number | null }

class DriveClient {
  drive(): Promise<{ id: string; name: string }>;            // remembered after the first call
  children(itemId?: string): Promise<DriveItem[]>;           // root when omitted
  createFolder(path: string[]): Promise<void>;               // 405 counts as done
  itemId(path: string[]): Promise<string>;
  upload(path: string[], body: Blob, onProgress?: (sent: number) => void): Promise<string>;  // the item id
  download(path: string[]): Promise<Blob>;                   // retries a 425
  remove(path: string[]): Promise<void>;
  rules(): Promise<SharingRules>;
  createLink(itemId: string, opts: { password?: string; expires?: Date }): Promise<string>;  // the URL
}
```

`upload` uses `XMLHttpRequest`, the only way a browser reports upload progress. It sends `If-None-Match: *`, so an existing file is not overwritten; on that refusal the caller picks another name (see "Save to Drive").

Errors are of one type, `DriveError`, with a kind: `unavailable` (network, 502, 503, 404 on the drive itself), `refused` (401 after a token refresh, 403), `exists`, `tooLarge` (507, 413), `policy` (a link password OpenCloud rejects, with its message) and `other`.

### What is offered (`src/app/drive.ts`)

- `driveOffered()` is `config.enabled`. The Drive actions are shown or not on this alone.
- The first action calls `drive()`. If that fails with `unavailable` or `refused`, the user is told "Drive isn't available right now" and the actions stay visible; the next attempt asks again. Nothing is retried in the background.

### The folder picker (`src/ui/DrivePicker.tsx`)

A dialog, built on the dialog parts oinbox already uses. It shows one folder at a time, with a breadcrumb from the drive's name, folders first.

- **Folder mode** (save): files are listed greyed out, a "New folder" button creates one in the current folder, and "Save here" confirms.
- **File mode** (attach): files can be ticked, several at once, and "Attach" confirms. Sizes are shown.

It opens at the folder last used in this tab, or the root. Keyboard: arrows move, Enter opens a folder, Backspace goes up, Escape closes. Listing is not paged in this version: a folder is shown as OpenCloud returns it.

## Slice 1: Save to Drive

Each attachment chip in the reader gains a menu with "Download" and "Save to Drive"; with Drive off, the chip downloads on a click as today. A message with several attachments also gets "Save all to Drive".

1. The picker opens in folder mode.
2. On "Save here", the app fetches the blob from Stalwart (`engine.fetchBlob`, as download does) and uploads it.
3. If the name is taken, it tries `name (1).ext`, `name (2).ext`, up to 20, as a browser does with downloads.
4. A toast says "Saved to Drive: *folder*", or what went wrong.

The bytes pass through the browser's memory. Attachments are bounded by what Stalwart accepted, so this is no worse than a download.

## Slice 2: Attach from Drive

The composer's paperclip becomes a menu when Drive is on: "From this computer" and "From Drive". The second opens the picker in file mode. Each chosen file is downloaded and handed to the composer's existing `attach`, as if picked from disk, so upload, progress, errors and the draft are unchanged.

## Slice 3: Send as a link

### When

Adding files that would take the message's attachments past `linkOverMb`, or any one file larger than Stalwart's `maxSizeUpload`, opens the link dialog in place of attaching. It names the files and their size and offers "Send as a link" and, unless a file is beyond `maxSizeUpload`, "Attach anyway". Files already attached stay attached.

Files from Drive (slice 2) get the same offer; they are copied inside OpenCloud into the message's folder, not downloaded and uploaded.

### The link dialog (`src/ui/LinkDialog.tsx`)

- **Password.** A field with "Generate" beside it. `rules().passwordRequired` decides whether it may be left empty; the policy is shown as a line of text and checked as the user types. A generated password is 16 characters and meets the policy (`src/drive/password.ts`, from `crypto.getRandomValues`).
- **How the recipient gets it**, shown once there is a password: "Put it in the message" (the default) or "I'll send it another way". The second shows the password with a copy button and says it stays available on the sent message for 30 minutes.
- **Expiry.** 30 days by default.

### Making it

1. Create `Mail attachments/<date> <subject>` in the user's drive, the date as `2026-10-09`, the subject as it stands (or "No subject") with `/` and control characters removed, cut to 80 characters. If it exists, add ` (2)`, ` (3)`.
2. Upload the files into it, straight from the browser to OpenCloud. They never pass through Stalwart, which is what frees them from its upload quota. The composer shows progress per file and "Cancel".
3. Create the folder's link with the password and expiry.
4. Write the link block at the end of what the user has written, above the signature and the quote.

The composer remembers the folder and the link while it is open. More large files added later go into the same folder with no second dialog: the link already covers them.

### The link block

Ordinary HTML the editor keeps, and the same words in the plain-text part:

```
Files for this message: https://files.example.org/s/wJVlzLimJIVEKQs
Password: 7h!Rk2…          (only when "Put it in the message")
Available until 8 November 2026.   (only with an expiry)
```

It lists no file names or counts, so adding a file never makes it wrong. The sender may edit or delete it; a deleted block leaves the folder in Drive and nothing in the mail, which is the sender's choice.

### Discarding

Discarding a draft whose link was made in this composer removes the folder (it goes to OpenCloud's trash), after the usual discard confirmation, which gains the line "The files uploaded to Drive for it will be removed." A draft that is closed and kept keeps its folder. A draft reopened from Drafts has the block in its text and the composer knows nothing more of the folder: large files added then start a new one.

### Recalling the password (`src/app/drive.ts`)

`sessionStorage` holds `{ url, password, until }` entries, written when the link is made, typed or generated alike. An entry is honoured for 30 minutes and removed when read after that; signing out removes all. When the reader shows a message whose text contains a remembered link, a line above the attachments reads "Password for the Drive link: ••••••", with "Show" and "Copy" and the time it will be forgotten.

It is `sessionStorage` on purpose: it ends with the tab, is not shared between tabs, and never reaches the mail store or another device.

## Errors

| Case | What the user sees |
|---|---|
| Drive configured but unreachable or refusing the token | "Drive isn't available right now." Mail carries on. |
| The folder's listing fails in the picker | The message in the picker, with "Try again". |
| Out of space, or a file OpenCloud refuses for size | "Not enough space in Drive" or "Too large for Drive". |
| An upload for a link fails part-way | The failed file is named with "Retry"; the dialog's result is not written into the message until every file is up. |
| `createLink` refuses the password | OpenCloud's own message under the field; the dialog stays open. |
| Send is pressed while link uploads run | Send waits, as it does for attachment uploads. |

## Operator's guide (`docs/operating.md`, a new "Drive" section)

- The two variables above.
- What OpenCloud needs: `OC_OIDC_ISSUER` set to Stalwart's public URL, `OC_EXCLUDE_RUN_SERVICES=idp`, `PROXY_OIDC_ACCESS_TOKEN_VERIFY_METHOD=none`, `PROXY_USER_OIDC_CLAIM=preferred_username`, `PROXY_USER_CS3_CLAIM=username`, `PROXY_AUTOPROVISION_ACCOUNTS=true`, `GRAPH_USERNAME_MATCH=none`, `PROXY_ROLE_ASSIGNMENT_DRIVER=default`.
- An account with no description in Stalwart has no `name` in its user info, and OpenCloud then refuses to create the user (HTTP 500, "missing claim 'name'"). `PROXY_AUTOPROVISION_CLAIM_DISPLAYNAME=preferred_username` avoids it, at the price of the address as display name.
- The choice of key. With the settings above the OpenCloud user is the e-mail address, and a renamed mailbox gets a new, empty drive. `PROXY_USER_OIDC_CLAIM=sub` with `PROXY_AUTOPROVISION_CLAIM_USERNAME=sub` keeps the drive across a rename; the user is then Stalwart's account number. Choose before the first user signs in: changing it later makes new users. oinbox works with either.
- Checked with OpenCloud 7.2.4 (stable) and 8.1.0 (rolling).
- OpenCloud must reach Stalwart at exactly the public URL the browser uses.
- Links in mail point at OpenCloud's own address (`OC_URL`), which therefore has to be public.
- The trust note: OpenCloud receives the user's mail token on every Drive call.
- The README's line on the attachment quota gains "or send larger files as a Drive link".

## Testing

- **Unit.** `DriveClient` against a fake OpenCloud (`src/drive/fake.ts`) that reproduces what was probed: ids with `$` and `!`, 405 on an existing folder, no id from `MKCOL`, 425 once after an upload, the password rule and policy messages, expiry rounded to the day. Config parsing, the password generator against several policies, name clashes, the folder's name, the link block in HTML and text, and password recall with a clock.
- **Components.** The picker in both modes with the keyboard; the link dialog with a password required and not.
- **End to end.** OpenCloud joins the dev stack as a service sharing Caddy's network (`network_mode: service:caddy`), which is what lets it reach Stalwart at `http://localhost:8080`. One spec per slice: save and find the file through the API; attach from Drive and receive it; send an oversize file as a link and open the link with its password. The rest of the suite runs unchanged with Drive on.
- **Without Drive.** One spec starts the app with `/drive.json` saying off and checks that no Drive action exists.

## Not yet known

Each is the first task of the slice that needs it; an answer that breaks a decision above comes back to this document.

1. **The prefix** (slice 1). OpenCloud's API behind `/drive/` with the prefix removed, in a real browser under the app's policy, and what Caddy does with the route when `OINBOX_DRIVE_UPSTREAM` is unset.
2. **`If-None-Match: *` on upload** (slice 1): that OpenCloud refuses with 412 and leaves the file alone.
3. **Large uploads** (slice 3): a 1 GB `PUT` through Caddy. If it fails, slice 3 uses OpenCloud's resumable uploads (TUS, 10 MB chunks by its own account) from the start.
4. **Copy inside OpenCloud** (slice 3): WebDAV `COPY` between two folders of one drive.
5. **A revoked token** (slice 1, for the guide): how long OpenCloud's cached answer keeps a signed-out token working.
6. **A password that is not required** (slice 3): the same calls with OpenCloud's requirement switched off, and what the capabilities then say.

## Not in this version

- OpenCloud's project spaces, and anything shared with the user: the picker shows the personal drive only.
- A drive for a shared mailbox.
- Choosing "Send as a link" for small files.
- Listing, changing or revoking a link from oinbox after it is made; that is done in OpenCloud.
- Previewing Drive files, searching Drive, or opening a mailed link inside oinbox.
- Resumable uploads, unless the large-upload test demands them.
