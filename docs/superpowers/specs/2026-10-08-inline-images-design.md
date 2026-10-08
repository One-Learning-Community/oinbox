# Inline images when composing

Paste, drop or pick an image while writing, and it appears in the text where the cursor is. The message is sent with the image as a real inline part, so Gmail, Outlook, Apple Mail and oinbox's own reader show it in place. A reply or a forward keeps the inline images of the message it quotes, and a forward carries the original's attachments, as other mail clients do.

Success: Alice pastes a screenshot into a new message and sends it; Bob sees it between the two paragraphs she wrote. Bob replies, and the quoted text in his reply still shows the screenshot. Alice forwards a message with a PDF attached, and the PDF goes with it.

## What Stalwart gives us

Probed on 0.16.23, 2026-10-08.

- **The convenience properties are not enough.** An `Email/set` create with `htmlBody` plus an `attachments` entry of `disposition: "inline"` and a `cid` puts the image in `multipart/mixed`, beside the body, not in `multipart/related` with the HTML. It also lists the image in the stored message's `htmlBody`. Some clients show such an image a second time at the end of the message.
- **An explicit `bodyStructure` is stored as given.** `multipart/mixed` › `multipart/alternative` › (`text/plain`, `multipart/related` › (`text/html`, image)) comes back in exactly that shape. The image is listed in `attachments` with its `cid` and `disposition: "inline"`, and `htmlBody` holds the HTML part alone.
- **Every stored message has its own blob ids for its parts**, different from the uploaded blob's id and from any other message's.
- **A part's blob id dies with its message.** After the message is destroyed, creating a message with that blob id fails with `blobNotFound`, and downloading it answers 404. The error carries no list of the missing ids, only a description.
- **A part's blob id of a live message can be used to create another message**, including in a request that destroys the first. This is what lets a reply reuse the original's images without uploading them again.
- **A failed create does not stop the destroy in the same request.** `Email/set` with a `create` that fails and a `destroy` still destroys.

### Two faults this uncovers in today's draft saving

oinbox saves a draft by creating a new message and destroying the previous one in one request, and keeps using the blob ids it started with.

1. A draft reopened from Drafts takes its attachments' blob ids from the stored message. The first save works (the old message is still alive in that request). The second save refers to blob ids of a message that no longer exists and fails with `blobNotFound`.
2. That failed save also destroys the previous version, so the draft is gone from the server while the composer shows "Couldn't save draft".

Inline images would make both far more likely to be met, so this slice fixes them (see "Saving").

## Decisions

| Topic | Decision | Why |
|---|---|---|
| How the draft holds images | `cid:` references in the HTML, plus a list of inline parts. The editor shows them through object URLs; the composer converts at its edge. | Autosave stays small, the stored form is the sent form, and nothing in rozie needs to change. Base64 in the HTML would put megabytes in every autosave and in the rescue store. |
| Inserting | Paste, drop onto the text, or a toolbar button with a file picker. | The three ways people expect. |
| Other drops | An image dropped anywhere else on the composer, and any file that is not an image, is attached as today. The paperclip always attaches. | The text is the only place where "here" has a meaning. |
| Size on screen | No resize handles. An image is shown no wider than the message, in the editor and in the reader. | Agreed 2026-10-08; resizing is a slice of its own. |
| MIME shape | Built explicitly with `bodyStructure`. | See "What Stalwart gives us". |
| Reply and forward | The quoted original keeps its inline images. Forward also carries the original's attachments, as removable chips; reply does not. | Agreed 2026-10-08: it is what Gmail, Outlook and Apple Mail do. |
| Removed images | An image deleted from the text is left out of the saved message. The composer remembers it until it closes, so undo brings it back. | The message must not carry parts nothing refers to. |
| Signatures | No images. | Unchanged from the settings slice: 2047 bytes leaves no room. |

## How it fits together

```
editor HTML  <img src="blob:…">          only inside ComposerView
     ▲  │
     │  ▼   toEditorHtml / fromEditorHtml (object URL ⇄ cid)
Draft        bodyHtml, quoteHtml with <img src="cid:…">;  inline: InlineImage[]
     │
     ▼   buildEmailCreate
Email/set    bodyStructure: mixed › alternative › (text, related › (html, images)), attachments
```

### The draft (`src/mail/compose.ts`)

```ts
export interface InlineImage {
  /** Content-ID without angle brackets; the HTML refers to it as cid:<cid>. */
  cid: string;
  blobId: string;
  type: string;
  name: string;
  size: number;
}
```

`Draft` gains `inline: InlineImage[]`. `bodyHtml` and `quoteHtml` hold `cid:` sources and never an object URL, so a draft can be serialised (the rescue store) and built into a message without knowing about the page it was edited in.

Two pure functions convert for the editor:

- `toEditorHtml(html, urls)` replaces each `cid:` source that has a URL in `urls` (a map from content id to object URL) with that URL. An image with no URL keeps its `cid:` source and shows as a broken image with its alt text.
- `fromEditorHtml(html, urls)` does the reverse for every image whose source is one of the map's URLs.

An image the user pasted as HTML from a web page has an `http(s)` source. It is left as it is: it is a remote image, not an inline one, and recipients' clients will treat it so.

### The composer (`src/app/composer.ts`)

A composer gains:

- `insertImage(file): Promise<string>`: uploads the file, adds an `InlineImage` with a new content id (`<uuid>@oinbox`), makes an object URL for the file, and returns the URL. It counts towards `uploading()`, so Send waits for it as it does for attachments. On failure it toasts "Couldn't add <name>: <reason>" and rejects; nothing is inserted.
- `imageUrls(): Record<string, string>`: content id to object URL, for the conversions above.
- `imagesReady(): boolean`: false while images referenced by `bodyHtml` are still being fetched.
- `loadImages(): Promise<void>`: resolves when every image in `draft.inline` has been fetched or has failed.

When a composer is created with inline images already in its draft (a reopened draft, a rescued composer, a reply or a forward), it fetches each blob through `engine.fetchBlob` and makes object URLs. A fetch that fails is logged and leaves that image without a URL. Object URLs are revoked when the composer is removed.

### The view (`src/ui/ComposerView.tsx`, `src/ui/FormatToolbar.tsx`)

- The editor is given `uploadImage={c.insertImage}`. rozie's TipTap then registers its image extension and handles paste and drop itself.
- The editor's `html` is `toEditorHtml(bodyHtml, imageUrls())`; changes come back through `fromEditorHtml`. The editor is rendered once `imagesReady()` is true, so its content is not replaced under the cursor when images arrive. This only delays a composer whose own text holds images, which is a reopened or rescued one.
- Expanding the quote ("•••") waits for `loadImages()` before putting the quote into the editor.
- The composer's own drop handler ignores a drop the editor has already taken, so an image dropped on the text is not also attached.
- `FormatToolbar` takes an optional `onImage` callback. When given, it shows an "Insert image" button that opens a file picker limited to images; each chosen file goes through `insertImage` and is placed at the cursor. The signature editor does not pass it, so it shows no such button.
- Images in the editor are styled `max-width: 100%; height: auto`.

Known limit, to be recorded in `docs/rozie-feedback.md`: rozie's paste and drop handler takes the first image file only, so pasting or dropping several images at once inserts one. The toolbar button accepts several.

### Building the message (`buildEmailCreate`)

The message is described with `bodyStructure` and `bodyValues`:

- The HTML is `bodyHtml` + signature + `quoteHtml`, as today.
- The inline parts are the entries of `draft.inline` whose content id appears as a `cid:` source in that HTML. Each becomes `{ blobId, type, name, cid, disposition: 'inline' }`.
- The structure nests only as far as it needs to:

| Inline images | Attachments | Structure |
|---|---|---|
| no | no | `alternative` › (text, html) |
| yes | no | `alternative` › (text, `related` › (html, images)) |
| no | yes | `mixed` › (`alternative` › (text, html), attachments) |
| yes | yes | `mixed` › (`alternative` › (text, `related` › (html, images)), attachments) |

- In the plain-text alternative an image reads `[image: <name>]`.

### Saving (`engine.saveDraft`, and the composer's `doSave`)

`saveDraft` changes in two ways.

1. **Create first, destroy after.** The new version is created in one request; the previous version is destroyed in a second request, and only once the create has succeeded. A failed save now leaves the last saved version on the server. A failed destroy is logged and not reported: the draft is saved, and a stale copy in Drafts is the lesser harm. For a moment both versions exist; the Drafts list may show both until the second request lands.
2. **Return the new blob ids.** The create request also reads the new message's `attachments` (a back-reference to the created id), and `saveDraft` returns them.

After a save the composer replaces the blob ids in its draft with the new message's: inline images are matched by content id, attachments by their position among the remaining parts (the order they were sent in). Only the entries that were in the saved snapshot are updated, so an attachment added while the save was in flight keeps its uploaded blob id until the next save.

This fixes both faults described above, for attachments as well as images.

### Reopening a draft (`openDraft`)

- The HTML is taken from the `text/html` parts of `htmlBody` only.
- A part of `attachments` that has a `cid`, is an image, and is referred to by the HTML goes to `draft.inline`. Every other part stays an attachment chip. A draft saved by another client with the image in `multipart/mixed` is read the same way, and oinbox's next save moves it into `multipart/related`.

### Reply and forward (`initialDraft`)

- The sanitiser strips the source from `cid:` images and marks them `data-oinbox-cid`. For the quote, each marked image whose content id matches an image part of the original gets its `cid:` source back; that part is added to `draft.inline` with the original's blob id. Marked images with no matching part are left without a source, as today.
- For a forward, the original's other parts (those not taken as inline images) are added to `draft.attachments`, again by blob id.
- Nothing is uploaded. The first save gives the draft its own copies and its own blob ids.
- Remote images in the quote stay blocked, as today.

The reader needs no change: it already resolves `cid:` images and leaves them out of the attachment list.

### Rescue

A rescued composer's draft now includes `inline`. Reopened, it fetches its images like any other. Drafts stored before this change have no `inline`; reading treats a missing list as empty.

## Errors

| Case | What happens |
|---|---|
| Upload fails (network, upload quota, too large) | Toast with the reason; nothing is inserted. |
| An image's blob cannot be fetched when a composer opens | The image shows as broken with its alt text; the rest of the composer works. Saving keeps the part. |
| Save fails | "Couldn't save draft" and Retry, as today. The last saved version stays on the server. |
| Send while an image is uploading | "Wait for attachments to finish uploading.", as today. |

Stalwart allows an account 50 MB of uploads an hour. Images are uploaded at their original size, so a few phone photos can use it up; the upload error says so. `docs/operating.md` already names the setting.

## The fake server (`src/sync/fake-jmap.ts`)

To behave as Stalwart does:

- `Email/set` create accepts `bodyStructure`, and derives `htmlBody`, `textBody` and `attachments` from it.
- Each created message gets its own blob id for each part.
- Creating with a blob id of a destroyed message fails with `blobNotFound`; a blob id of a live message, or of an upload, works.
- A failed create does not stop a destroy in the same request.

## Tests

Unit:

- `toEditorHtml` / `fromEditorHtml` round trip, including an image with no URL and a remote image.
- `buildEmailCreate`: the four structures; an image removed from the text is left out; `[image: name]` in the plain text.
- `initialDraft`: a reply keeps the original's inline images and no attachments; a forward keeps both; an image the original does not have a part for is left alone.
- `openDraft`: inline parts and attachment chips are told apart, in both MIME shapes.
- Composer: `insertImage` success and failure; blob ids are replaced after a save; a second save of a reopened draft with an attachment succeeds; a failed save leaves the previous version in place.
- Fake server: the four behaviours above.

End to end (`e2e/inline-images.spec.ts`):

1. Alice inserts an image with the toolbar button between two paragraphs and sends. Bob opens the message: the image has loaded, sits between the paragraphs, and no attachment chip is shown.
2. Alice pastes an image into the text; it appears there and is not added as an attachment.
3. Alice saves and closes a draft with an image, reopens it from Drafts, sees the image, edits the text twice with a save between, and sends. Bob gets the image.
4. Bob replies to Alice's message; Alice sees the image in the quoted text of his reply.
5. Alice forwards a message that has an inline image and a file attached; Bob gets both.

## Not in this slice

- Resizing or aligning images, and shrinking large photos before upload.
- Images in signatures.
- Inserting an image by URL.
- Several images from one paste or drop (a rozie limit, noted above).
- A rescued composer whose uploaded blobs have since expired on the server: its save fails as it would today for an attachment, with the text still in the composer.
- Showing an inline image that the HTML does not refer to (some clients send these); the reader's handling of them is unchanged.
