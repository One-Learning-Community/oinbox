# Inline Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste, drop or pick an image into the composer and send it as a real inline (`cid:`) part; keep the original's inline images through reply and forward, and its attachments through forward; and make draft saving safe against Stalwart's per-message blob ids.

**Architecture:** A `Draft` holds `cid:` references in its HTML plus a list of inline parts. The composer owns object URLs for them and the view converts between `cid:` and object URL at the editor's edge. `buildEmailCreate` describes the message with an explicit `bodyStructure`. `engine.saveDraft` creates the new version first, then reads its blob ids and destroys the old versions in a second request.

**Tech Stack:** TypeScript, Solid, `@rozie-ui/tiptap-solid` 0.5.2 (its `uploadImage` prop), Vitest + jsdom, Playwright, Stalwart 0.16.23 over JMAP.

**Spec:** `docs/superpowers/specs/2026-10-08-inline-images-design.md`

## Global Constraints

- Branch `inline-images`. Do not push; do not merge into `main`.
- Every commit message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01UMoXfxooT3CRtWKGxJtpLC`
- Unit tests: `pnpm test`. Types: `pnpm typecheck`. End to end: `pnpm e2e` (the dev stack is already running on `localhost:8080`).
- Content ids are stored and compared **without** angle brackets; a new one is `<uuid>@oinbox`.
- The HTML is converted with string replacement on the `src` attribute only, never by re-serialising the document: `toEditorHtml(fromEditorHtml(h, urls), urls)` must return `h` byte for byte, or the editor resets the cursor.
- No new dependencies. No change to rozie packages; a rozie gap is recorded in `docs/rozie-feedback.md`, not worked around.
- Stalwart does **not** resolve a back-reference to `/created/<key>/id` (`invalidResultReference`, probed 2026-10-08). Read a created draft by its id in a second request.
- User-facing copy, exactly: toolbar button `Insert image`; upload failure toast `Couldn't add <name>: <reason>`; placeholder while a reopened draft's images load `Loading images…`; plain-text stand-in `[image: <name>]`.
- Match the surrounding code's comment density and wording: short comments that say why.

## Review Focus

1. An image deleted from the text and brought back with undo must still be sent: the composer keeps the part while it is open (Task 3 test "leaves out an image…", Task 6 test "keeps a removed image…").
2. The same file inserted twice gives two images with two content ids, both shown and both sent (Task 6 test).
3. A quoted original that refers to a content id it has no image part for, or whose part is not an image, is left alone and nothing crashes (Task 4 tests).
4. A draft saved by another client, with the image in `multipart/mixed` and listed in `htmlBody` too, reopens with the image inline and not as a chip (Task 4 `splitParts` test).
5. A content id written with angle brackets or with `&` in it (`a&b@x`, escaped as `&amp;` in HTML) is still matched (Task 3 and Task 4 tests).

## File structure

| File | Change |
|---|---|
| `src/jmap/types.ts` | `EmailBodyStructure`; `Email.bodyStructure?` |
| `src/sync/fake-jmap.ts` | parts with per-message blob ids, `blobNotFound`, `notCreated` |
| `src/sync/engine.ts` | `saveDraft` in two requests, `draftParts`, `DraftSaveError`, `SavedDraft` |
| `src/mail/compose.ts` | `InlineImage`, `Draft.inline`, HTML conversions, `bodyStructure`, `splitParts`, blob-id remapping, reply/forward carry |
| `src/app/composer.ts` | blob-id refresh after saves, stale versions, images (`insertImage`, `imageUrls`, `imagesReady`, `loadImages`), `openDraft` |
| `src/ui/FormatToolbar.tsx`, `src/ui/ComposerView.tsx`, `src/ui/styles.css` | image button, editor wiring, drop handling |
| `e2e/inline-images.spec.ts`, `e2e/support/mail.ts`, `e2e/support/compose.ts` | end-to-end tests and helpers |
| `docs/rozie-feedback.md`, `CHANGELOG.md` | notes |

---

### Task 1: The fake server stores parts as Stalwart does

**Files:**
- Modify: `src/jmap/types.ts` (next to `EmailBodyPart`, and the `Email` interface)
- Modify: `src/sync/fake-jmap.ts` (the `Email/set` case, around line 394; new members near `createdEmails`)
- Test: `src/sync/fake-jmap.test.ts`

**Interfaces:**
- Produces: `EmailBodyStructure` type; `Email.bodyStructure?: EmailBodyStructure`; `FakeJmap.uploads: Set<string>`; `Email/set` answers `notCreated`.

- [ ] **Step 1: Add the type**

In `src/jmap/types.ts`, after `EmailBodyPart`:

```ts
/** A part as given to Email/set create in `bodyStructure` (RFC 8621 §4.1.4). */
export interface EmailBodyStructure {
  type: string;
  partId?: string;
  blobId?: Id;
  name?: string | null;
  cid?: string | null;
  disposition?: string | null;
  subParts?: EmailBodyStructure[];
}
```

In the `Email` interface add: `bodyStructure?: EmailBodyStructure;`

- [ ] **Step 2: Write the failing tests**

Append to `src/sync/fake-jmap.test.ts`:

```ts
describe('FakeJmap message parts (as Stalwart 0.16.23)', () => {
  const eset = (s: FakeJmap, args: Record<string, unknown>) => s.handle('Email/set', { accountId: 'a1', ...args }, ALL)[1] as Record<string, any>;
  const message = (blobId: string) => ({
    subject: 'x',
    bodyValues: { text: { value: 't' }, html: { value: '<img src="cid:c1@oinbox">' } },
    bodyStructure: {
      type: 'multipart/mixed',
      subParts: [
        { type: 'multipart/alternative', subParts: [
          { partId: 'text', type: 'text/plain' },
          { type: 'multipart/related', subParts: [
            { partId: 'html', type: 'text/html' },
            { blobId, type: 'image/png', name: 'a.png', cid: 'c1@oinbox', disposition: 'inline' },
          ] },
        ] },
        { blobId, type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' },
      ],
    },
  });
  const server = () => {
    const s = new FakeJmap();
    s.uploads.add('up1');
    return s;
  };

  it('stores a bodyStructure as body parts and attachments, each with a blob id of its own', () => {
    const s = server();
    const id = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    const e = s.emails.get(id)!;
    expect(e.htmlBody!.map((p) => [p.partId, p.type])).toEqual([['html', 'text/html']]);
    expect(e.textBody!.map((p) => [p.partId, p.type])).toEqual([['text', 'text/plain']]);
    expect(e.attachments!.map((p) => [p.name, p.cid, p.disposition])).toEqual([['a.png', 'c1@oinbox', 'inline'], ['a.pdf', null, 'attachment']]);
    const blobs = e.attachments!.map((p) => p.blobId);
    expect(new Set(blobs).size).toBe(2);
    expect(blobs).not.toContain('up1');
    expect('bodyStructure' in e).toBe(false);
  });

  it('accepts the blob of an upload again, and the part blob of a message that still exists', () => {
    const s = server();
    const first = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    expect(eset(s, { create: { c: message('up1') } }).created.c).toBeTruthy();
    const part = s.emails.get(first)!.attachments![0]!.blobId!;
    expect(eset(s, { create: { c: message(part) } }).created.c).toBeTruthy();
  });

  it('refuses the part blob of a destroyed message, and an unknown blob', () => {
    const s = server();
    const first = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    const part = s.emails.get(first)!.attachments![0]!.blobId!;
    eset(s, { destroy: [first] });
    const r = eset(s, { create: { c: message(part) } });
    expect(r.created.c).toBeUndefined();
    expect(r.notCreated.c.type).toBe('blobNotFound');
    expect(eset(s, { create: { c: message('nope') } }).notCreated.c.type).toBe('blobNotFound');
  });

  it('accepts a part blob in the request that destroys its message', () => {
    const s = server();
    const first = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    const part = s.emails.get(first)!.attachments![0]!.blobId!;
    const r = eset(s, { create: { c: message(part) }, destroy: [first] });
    expect(r.created.c).toBeTruthy();
    expect(r.destroyed).toEqual([first]);
  });

  it('still destroys when the create in the same request fails', () => {
    const s = server();
    const first = eset(s, { create: { c: message('up1') } }).created.c.id as string;
    const r = eset(s, { create: { c: message('nope') }, destroy: [first] });
    expect(r.notCreated.c.type).toBe('blobNotFound');
    expect(s.emails.has(first)).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test src/sync/fake-jmap.test.ts`
Expected: the five new tests FAIL (`uploads` is undefined).

- [ ] **Step 4: Implement**

In `src/sync/fake-jmap.ts`, add `EmailBodyPart` and `EmailBodyStructure` to the type import from `'../jmap/types'`. Next to `private createdEmails = 0;` add:

```ts
  /** Blob ids of uploads (tests add them). Stalwart keeps an upload usable after a message has used it. */
  uploads = new Set<string>();

  /** A blob a new message may refer to: an upload, or a part of a message that still exists. */
  private blobExists(id: string): boolean {
    if (this.uploads.has(id)) return true;
    for (const e of this.emails.values()) if ((e.attachments ?? []).some((p) => p.blobId === id)) return true;
    return false;
  }

  /** A created email's parts as Stalwart stores them: every part gets a blob id of this message's own. Null: a blob is missing. */
  private storeParts(id: string, email: Partial<Rec>): Partial<Rec> | null {
    const textBody: EmailBodyPart[] = [];
    const htmlBody: EmailBodyPart[] = [];
    const attachments: EmailBodyPart[] = [];
    let n = 0;
    let missing = false;
    const leaf = (p: EmailBodyStructure) => {
      const part: EmailBodyPart = { partId: p.partId ?? String(n + 1), blobId: `${id}.p${++n}`, size: 0, type: p.type, name: p.name ?? null, cid: p.cid ?? null, disposition: p.disposition ?? null };
      if (p.partId) (p.type === 'text/html' ? htmlBody : textBody).push(part);
      else {
        if (!p.blobId || !this.blobExists(p.blobId)) missing = true;
        attachments.push(part);
      }
    };
    const walk = (p: EmailBodyStructure): void => (p.subParts ? p.subParts.forEach(walk) : leaf(p));
    if (email.bodyStructure) walk(email.bodyStructure);
    else for (const p of [...(email.textBody ?? []), ...(email.htmlBody ?? []), ...(email.attachments ?? [])]) leaf(p as EmailBodyStructure);
    if (missing) return null;
    const rest = { ...email };
    delete rest.bodyStructure;
    return { ...rest, textBody, htmlBody, attachments };
  }
```

Replace the create loop and the return of the `Email/set` case with:

```ts
        // Drafts: the composer saves by creating a new email, then destroying the ones it replaces.
        const created: Record<string, { id: string; threadId: string }> = {};
        const notCreated: Record<string, { type: string; description: string }> = {};
        for (const [cid, email] of Object.entries((args.create ?? {}) as Record<string, Partial<Rec>>)) {
          const id = `n${this.createdEmails + 1}`;
          const stored = this.storeParts(id, email);
          if (!stored) {
            notCreated[cid] = { type: 'blobNotFound', description: 'blobId does not exist on this server.' };
            continue;
          }
          this.createdEmails++;
          this.addEmail({ receivedAt: new Date().toISOString(), ...stored, id, threadId: `t-${id}` } as Rec);
          created[cid] = { id, threadId: `t-${id}` };
        }
        // As Stalwart: a failed create does not stop the destroy.
        const destroyed = ((args.destroy ?? []) as string[]).filter((id) => this.emails.delete(id));
        if (destroyed.length) this.bump({ destroyed });
        return [name, {
          accountId: 'a1', oldState: null, newState: `e${this.emailState}`, created, destroyed, updated,
          notCreated: Object.keys(notCreated).length ? notCreated : null,
          notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
        }];
```

- [ ] **Step 5: Run the whole unit suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. If an existing test creates an email with an attachment blob the fake does not know, add that blob to `server.uploads` in the test's setup; do not loosen the fake.

- [ ] **Step 6: Commit**

```bash
git add src/jmap/types.ts src/sync/fake-jmap.ts src/sync/fake-jmap.test.ts
git commit -m "Fake server: message parts get their own blob ids, as on Stalwart"
```

---

### Task 2: `saveDraft` creates first, then reads the new blob ids and destroys

**Files:**
- Modify: `src/sync/engine.ts:474-491` (`saveDraft`), plus a new `draftParts`
- Modify: `src/app/composer.ts` (the one call of `saveDraft`, so the build stays green)
- Test: `src/sync/engine.test.ts`

**Interfaces:**
- Consumes: Task 1's fake (`uploads`, `notCreated`).
- Produces, exported from `src/sync/engine.ts`:

```ts
export class DraftSaveError extends Error { readonly type: string }
export interface SavedDraft {
  id: Id;
  threadId: Id;
  /** The new version's attachment parts (inline ones included); null when they could not be read. */
  parts: EmailBodyPart[] | null;
  /** Whether the versions it replaces are gone. */
  replaced: boolean;
}
saveDraft(email: Partial<Email>, replaces: Id[]): Promise<SavedDraft>
draftParts(id: Id): Promise<EmailBodyPart[] | null>   // null: no such message
```

- [ ] **Step 1: Write the failing tests**

Append to `src/sync/engine.test.ts` (add `DraftSaveError` to the import from `./engine`; the file already imports `createRoot`, `vi`, `FakeJmap` and `MailEngine`, add any that are missing):

```ts
describe('saveDraft', () => {
  const setup = async () => {
    const server = new FakeJmap();
    server.addMailbox('D', 'Drafts', 'drafts');
    server.uploads.add('up1');
    const client = server.client();
    const engine = createRoot(() => new MailEngine(client, { settleDelayMs: 0 }));
    await engine.start();
    return { server, client, engine };
  };
  const draft = (blobId: string, subject = 'v') => ({
    mailboxIds: { D: true as const }, subject, bodyValues: { text: { value: 't', isEncodingProblem: false, isTruncated: false } },
    bodyStructure: { type: 'multipart/mixed', subParts: [{ partId: 'text', type: 'text/plain' }, { blobId, type: 'text/plain', name: 'a.txt', disposition: 'attachment' }] },
  });

  it('returns the new version\'s parts and removes the versions it replaces', async () => {
    const { server, engine } = await setup();
    const v1 = await engine.saveDraft(draft('up1'), []);
    expect(v1.parts!.map((p) => p.name)).toEqual(['a.txt']);
    expect(v1.parts![0]!.blobId).not.toBe('up1');
    const v2 = await engine.saveDraft(draft(v1.parts![0]!.blobId!, 'v2'), [v1.id]);
    expect(v2.replaced).toBe(true);
    expect([...server.emails.keys()]).toEqual([v2.id]);
  });

  it('leaves the previous version alone when the new one cannot be created', async () => {
    const { server, engine } = await setup();
    const v1 = await engine.saveDraft(draft('up1'), []);
    const failed = engine.saveDraft(draft('gone'), [v1.id]);
    await expect(failed).rejects.toBeInstanceOf(DraftSaveError);
    await expect(failed).rejects.toMatchObject({ type: 'blobNotFound' });
    expect(server.emails.has(v1.id)).toBe(true);
  });

  it('still reports the save when the follow-up request fails', async () => {
    const { server, client, engine } = await setup();
    const v1 = await engine.saveDraft(draft('up1'), []);
    // The request that would destroy the old version never gets out.
    const real = client.send.bind(client);
    const destroys = (b: Parameters<typeof client.send>[0]) => b.build([]).methodCalls.some(([name, args]) => name === 'Email/set' && !!args.destroy);
    vi.spyOn(client, 'send').mockImplementation((b) => (destroys(b) ? Promise.reject(new TypeError('Failed to fetch')) : real(b)));
    const v2 = await engine.saveDraft(draft('up1', 'v2'), [v1.id]);
    expect(v2).toMatchObject({ parts: null, replaced: false });
    expect(server.emails.has(v1.id)).toBe(true);
    expect(server.emails.has(v2.id)).toBe(true);
  });

  it('reads a draft\'s parts, and null for one that is gone', async () => {
    const { engine } = await setup();
    const v1 = await engine.saveDraft(draft('up1'), []);
    expect((await engine.draftParts(v1.id))!.map((p) => p.blobId)).toEqual(v1.parts!.map((p) => p.blobId));
    expect(await engine.draftParts('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/sync/engine.test.ts -t saveDraft`
Expected: FAIL (`DraftSaveError` is not exported).

- [ ] **Step 3: Implement**

In `src/sync/engine.ts`, add `EmailBodyPart` to the type import from `'../jmap/types'`. Above the `MailEngine` class:

```ts
/** A draft the server would not store. `type` is the JMAP SetError type, e.g. blobNotFound. */
export class DraftSaveError extends Error {
  constructor(readonly type: string, description?: string | null) {
    super(description ?? type);
  }
}

export interface SavedDraft {
  id: Id;
  threadId: Id;
  /** The new version's attachment parts (inline ones included); null when they could not be read. */
  parts: EmailBodyPart[] | null;
  /** Whether the versions it replaces are gone. */
  replaced: boolean;
}
```

Replace `saveDraft` with:

```ts
  /**
   * Save a draft. JMAP emails are immutable, so each save creates a new email. The versions it
   * replaces are destroyed in a second request, once the new one exists: Stalwart destroys even
   * when the create in the same request fails. That request also reads the new version's parts,
   * whose blob ids are its own (the old ones die with the old version).
   */
  async saveDraft(email: Partial<Email>, replaces: Id[]): Promise<SavedDraft> {
    const b = this.client.batch();
    const call = b.call('Email/set', { accountId: this.accountId, create: { draft: email } });
    const r = (await this.client.send(b)).get(call);
    const created = r.created?.draft;
    if (!created) {
      const err = r.notCreated?.draft;
      throw new DraftSaveError(err?.type ?? 'serverFail', err?.description ?? (err ? null : 'Draft was not saved'));
    }
    const saved = { id: created.id!, threadId: created.threadId! };
    try {
      const b2 = this.client.batch();
      const get = b2.call('Email/get', { accountId: this.accountId, ids: [saved.id], properties: ['attachments'] });
      if (replaces.length) b2.call('Email/set', { accountId: this.accountId, destroy: replaces });
      const parts = (await this.client.send(b2)).get(get).list[0]?.attachments ?? null;
      return { ...saved, parts, replaced: true };
    } catch (e) {
      // The draft is saved. The caller passes the old versions again with its next save.
      logUnexpected(e);
      return { ...saved, parts: null, replaced: false };
    }
  }

  /** The attachment parts of a stored draft, with the blob ids that version owns. Null: no such message. */
  async draftParts(id: Id): Promise<EmailBodyPart[] | null> {
    const b = this.client.batch();
    const call = b.call('Email/get', { accountId: this.accountId, ids: [id], properties: ['attachments'] });
    const email = (await this.client.send(b)).get(call).list[0];
    return email ? (email.attachments ?? []) : null;
  }
```

`logUnexpected` comes from `'./connection'`; import it if `engine.ts` does not already.

In `src/app/composer.ts`, change the call in `doSave` so it compiles (Task 5 rewrites this function):

```ts
        const saved = await engine.saveDraft(buildEmailCreate(draft(), { name: identity.name || null, email: identity.email }, drafts), draftId() ? [draftId()!] : []);
```

- [ ] **Step 4: Run**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Existing composer tests that mock `saveDraft` with a resolved value must return the new shape; where one does, change it to `{ id: …, threadId: …, parts: null, replaced: true }`.

- [ ] **Step 5: Commit**

```bash
git add src/sync/engine.ts src/sync/engine.test.ts src/app/composer.ts src/app/composer.test.ts
git commit -m "Saving a draft creates the new version before it removes the old one"
```

---

### Task 3: The draft holds inline images; the message is built with `bodyStructure`

**Files:**
- Modify: `src/mail/compose.ts`
- Modify: `src/app/composer.ts` (`openDraft`'s draft literal: add `inline: []`), `src/app/rescue.test.ts:7` (add `inline: []`)
- Test: `src/mail/compose.test.ts`

**Interfaces:**
- Produces, exported from `src/mail/compose.ts`:

```ts
export interface InlineImage { cid: string; blobId: string; type: string; name: string; size: number }
// Draft gains:  inline: InlineImage[]
export function referencedCids(html: string): Set<string>
export function toEditorHtml(html: string, urls: Record<string, string>): string    // urls: cid -> object URL
export function fromEditorHtml(html: string, urls: Record<string, string>): string
export function draftHtml(draft: Draft): string                                     // body + signature block + quote
export function htmlToText(html: string, images?: InlineImage[]): string
export function buildEmailCreate(draft: Draft, from: EmailAddress, draftsId: string): Partial<Email>  // now with bodyStructure
```

- [ ] **Step 1: Write the failing tests**

In `src/mail/compose.test.ts`, extend the import with `fromEditorHtml, referencedCids, toEditorHtml, type Draft` and `type EmailBodyStructure` from `'../jmap/types'`. In the existing test `'creates a draft with text and html alternatives and attachments'`, add `inline: []` to the draft literal and replace its last three `expect` lines (`htmlBody`, `textBody`, `attachments`) with:

```ts
    expect(e.bodyStructure).toEqual({
      type: 'multipart/mixed',
      subParts: [
        { type: 'multipart/alternative', subParts: [{ partId: 'text', type: 'text/plain' }, { partId: 'html', type: 'text/html' }] },
        { blobId: 'B1', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' },
      ],
    });
    expect(e.htmlBody).toBeUndefined();
    expect(e.attachments).toBeUndefined();
```

Append:

```ts
describe('inline images in the HTML', () => {
  const urls = { 'c1@oinbox': 'blob:http://x/1', 'a&b@x': 'blob:http://x/2' };

  it('swaps cid: sources for object URLs and back, byte for byte', () => {
    const editor = '<p>a</p><img src="blob:http://x/1" alt="x"><p>b</p><img src="https://r.test/i.png"><img src="blob:http://x/2">';
    const stored = fromEditorHtml(editor, urls);
    expect(stored).toBe('<p>a</p><img src="cid:c1@oinbox" alt="x"><p>b</p><img src="https://r.test/i.png"><img src="cid:a&amp;b@x">');
    expect(toEditorHtml(stored, urls)).toBe(editor);
  });

  it('leaves an image it has no URL for, and HTML without images, untouched', () => {
    expect(toEditorHtml('<img src="cid:other@x">', urls)).toBe('<img src="cid:other@x">');
    expect(toEditorHtml('<p>data-src="cid:c1@oinbox"</p>', urls)).toBe('<p>data-src="cid:c1@oinbox"</p>');
  });

  it('finds the content ids referred to, with or without angle brackets', () => {
    expect([...referencedCids('<img src="cid:c1@oinbox"><img alt="" src=\'cid:&lt;c2@x&gt;\'><img src="cid:a&amp;b@x"><img src="x.png">')]).toEqual(['c1@oinbox', 'c2@x', 'a&b@x']);
  });
});

describe('buildEmailCreate with inline images', () => {
  const image = { cid: 'c1@oinbox', blobId: 'I1', type: 'image/png', name: 'chart.png', size: 9 };
  const base: Draft = { ...initialDraft('new', null, me), bodyHtml: '<p>See</p><img src="cid:c1@oinbox"><p>there</p>', inline: [image] };
  const from = { name: null, email: 'alice@example.test' };
  const html = { partId: 'html', type: 'text/html' };
  const text = { partId: 'text', type: 'text/plain' };
  const part = { blobId: 'I1', type: 'image/png', name: 'chart.png', cid: 'c1@oinbox', disposition: 'inline' };

  it('puts the image with the HTML in multipart/related', () => {
    expect(buildEmailCreate(base, from, 'D').bodyStructure).toEqual({ type: 'multipart/alternative', subParts: [text, { type: 'multipart/related', subParts: [html, part] }] });
  });

  it('wraps that in multipart/mixed when there are attachments too', () => {
    const e = buildEmailCreate({ ...base, attachments: [{ blobId: 'B1', name: 'a.pdf', type: 'application/pdf', size: 3 }] }, from, 'D');
    expect(e.bodyStructure).toEqual({
      type: 'multipart/mixed',
      subParts: [
        { type: 'multipart/alternative', subParts: [text, { type: 'multipart/related', subParts: [html, part] }] },
        { blobId: 'B1', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' },
      ],
    });
  });

  it('needs no multipart/related without images', () => {
    expect(buildEmailCreate({ ...base, bodyHtml: '<p>x</p>', inline: [] }, from, 'D').bodyStructure).toEqual({ type: 'multipart/alternative', subParts: [text, html] });
  });

  it('leaves out an image the text no longer refers to, and counts one in the quote', () => {
    const gone = buildEmailCreate({ ...base, bodyHtml: '<p>See</p>' }, from, 'D').bodyStructure as EmailBodyStructure;
    expect(gone.subParts).toEqual([text, html]);
    const quoted = buildEmailCreate({ ...base, bodyHtml: '<p>See</p>', quoteHtml: '<blockquote><img src="cid:c1@oinbox"></blockquote>' }, from, 'D').bodyStructure as EmailBodyStructure;
    expect(quoted.subParts![1]).toEqual({ type: 'multipart/related', subParts: [html, part] });
  });

  it('names the image in the plain-text alternative', () => {
    expect(buildEmailCreate(base, from, 'D').bodyValues!.text!.value).toBe('See\n[image: chart.png]\nthere\n');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/mail/compose.test.ts`
Expected: FAIL (the new exports do not exist).

- [ ] **Step 3: Implement**

In `src/mail/compose.ts`:

Change the type import to `import type { Email, EmailAddress, EmailBodyStructure } from '../jmap/types';`.

After `DraftAttachment`:

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

In `Draft`, after `attachments`:

```ts
  /** Images the HTML refers to by cid:. The HTML never holds an object URL. */
  inline: InlineImage[];
```

In `initialDraft`, add `inline: []` to the `empty` literal.

After `formatAddress`, add:

```ts
// Only the src attribute is rewritten, never the document: the editor must get back exactly what it gave.
const IMG_SRC = /(<img\b[^>]*?\ssrc=)(["'])(.*?)\2/gi;

const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The content id a cid: source names, or null for any other source. */
function cidOf(src: string): string | null {
  const v = unescapeAttr(src).trim();
  return /^cid:/i.test(v) ? v.slice(4).replace(/^<|>$/g, '') : null;
}

/** Content ids of the images this HTML refers to. */
export function referencedCids(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(IMG_SRC)) {
    const cid = cidOf(m[3]!);
    if (cid) out.add(cid);
  }
  return out;
}

/** For the editor: cid: sources become the object URLs in `urls` (content id to URL). An image without one keeps its cid:. */
export function toEditorHtml(html: string, urls: Record<string, string>): string {
  return html.replace(IMG_SRC, (all, pre: string, q: string, src: string) => {
    const cid = cidOf(src);
    const url = cid === null ? undefined : urls[cid];
    return url ? `${pre}${q}${url}${q}` : all;
  });
}

/** From the editor: object URLs become cid: sources again. */
export function fromEditorHtml(html: string, urls: Record<string, string>): string {
  const cids = new Map(Object.entries(urls).map(([cid, url]) => [url, cid]));
  return html.replace(IMG_SRC, (all, pre: string, q: string, src: string) => {
    const cid = cids.get(unescapeAttr(src));
    return cid === undefined ? all : `${pre}${q}cid:${escapeHtml(cid)}${q}`;
  });
}
```

Replace `htmlToText` with:

```ts
/** Plain-text alternative of an HTML body. An inline image reads "[image: name]". */
export function htmlToText(html: string, images: InlineImage[] = []): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of doc.querySelectorAll('img')) {
    const cid = cidOf(img.getAttribute('src') ?? '');
    const name = images.find((i) => i.cid === cid)?.name;
    img.replaceWith(name ? `[image: ${name}]\n` : '');
  }
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');
  for (const el of doc.querySelectorAll('p, div, li, h1, h2, h3, blockquote, tr')) el.append('\n');
  for (const bq of doc.querySelectorAll('blockquote')) {
    bq.textContent = (bq.textContent ?? '').replace(/\n+$/, '').split('\n').map((l) => `> ${l}`).join('\n') + '\n';
  }
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
```

Replace `buildEmailCreate` with:

```ts
/** A draft's whole HTML: the text, the signature block, the quote. */
export function draftHtml(draft: Draft): string {
  const signature = draft.signatureHtml ? `<div class="oinbox-signature">${draft.signatureHtml}</div>` : '';
  return draft.bodyHtml + signature + draft.quoteHtml;
}

/**
 * The Email object for Email/set create (RFC 8621 §4.6), stored as a draft. The structure is
 * spelled out: given htmlBody and attachments, Stalwart puts an inline image beside the body
 * (multipart/mixed) instead of with the HTML (multipart/related), and some clients show it twice.
 */
export function buildEmailCreate(draft: Draft, from: EmailAddress, draftsId: string): Partial<Email> {
  const html = draftHtml(draft);
  // "-- " on its own line is the delimiter mail clients use to recognise a signature.
  const text = [
    htmlToText(draft.bodyHtml, draft.inline).trimEnd(),
    draft.signatureHtml ? `-- \n${htmlToText(draft.signatureHtml).trimEnd()}` : '',
    draft.quoteHtml ? htmlToText(draft.quoteHtml, draft.inline).trim() : '',
  ].filter(Boolean).join('\n\n') + '\n';

  // An image the user deleted from the text stays in the draft (undo brings it back) but not in the message.
  const used = referencedCids(html);
  const images: EmailBodyStructure[] = draft.inline.filter((i) => used.has(i.cid)).map((i) => ({ blobId: i.blobId, type: i.type, name: i.name, cid: i.cid, disposition: 'inline' }));
  const files: EmailBodyStructure[] = draft.attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' }));
  const htmlPart: EmailBodyStructure = { partId: 'html', type: 'text/html' };
  const body: EmailBodyStructure = {
    type: 'multipart/alternative',
    subParts: [{ partId: 'text', type: 'text/plain' }, images.length ? { type: 'multipart/related', subParts: [htmlPart, ...images] } : htmlPart],
  };
  return {
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true, $seen: true },
    from: [from],
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    ...(draft.inReplyTo.length ? { inReplyTo: draft.inReplyTo } : {}),
    ...(draft.references.length ? { references: draft.references } : {}),
    bodyValues: {
      text: { value: text, isEncodingProblem: false, isTruncated: false },
      html: { value: html, isEncodingProblem: false, isTruncated: false },
    },
    bodyStructure: files.length ? { type: 'multipart/mixed', subParts: [body, ...files] } : body,
  };
}
```

In `src/app/composer.ts` `openDraft`, add `inline: [],` to the `draft` literal (Task 6 fills it). In `src/app/rescue.test.ts:7` add `inline: []` to the draft literal.

- [ ] **Step 4: Run**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. The `[image: chart.png]` test pins the exact text; if blank lines differ, fix `htmlToText`, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/mail/compose.ts src/mail/compose.test.ts src/app/composer.ts src/app/rescue.test.ts
git commit -m "Drafts hold inline images by content id; messages are built with an explicit structure"
```

---

### Task 4: Telling stored parts apart, and carrying the original's through reply and forward

**Files:**
- Modify: `src/mail/compose.ts` (`initialDraft`, `originalHtml`; new `splitParts`, `blobIdChanges`, `withBlobIds`)
- Test: `src/mail/compose.test.ts`

**Interfaces:**
- Consumes: Task 3's `referencedCids`, `draftHtml`, `InlineImage`.
- Produces, exported from `src/mail/compose.ts`:

```ts
/** Sort a stored message's attachment parts (never its text parts): an image the HTML refers to by content id is inline, the rest are attachments. */
export function splitParts(html: string, parts: EmailBodyPart[]): { inline: InlineImage[]; attachments: DraftAttachment[] }
/** Old blob id -> new, for a draft's parts as the server stored them. */
export function blobIdChanges(draft: Draft, stored: EmailBodyPart[]): Map<string, string>
export function withBlobIds(draft: Draft, changes: Map<string, string>): Draft
```

- `initialDraft('reply' | 'replyAll', …)` sets `inline`; `initialDraft('forward', …)` sets `inline` and `attachments`.

- [ ] **Step 1: Write the failing tests**

Append to `src/mail/compose.test.ts` (extend the import with `blobIdChanges, splitParts, withBlobIds` and `type EmailBodyPart` from `'../jmap/types'`):

```ts
const bodyPart = (p: Partial<EmailBodyPart>): EmailBodyPart => ({ partId: null, blobId: null, size: 1, type: 'application/octet-stream', name: null, cid: null, disposition: null, ...p });

describe('splitParts', () => {
  const png = bodyPart({ blobId: 'P1', type: 'image/png', name: 'chart.png', cid: '<c1@x>', disposition: 'inline', size: 9 });
  const pdf = bodyPart({ blobId: 'P2', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment', size: 3 });

  it('takes an image the HTML refers to as inline and everything else as an attachment', () => {
    expect(splitParts('<img src="cid:c1@x">', [png, pdf])).toEqual({
      inline: [{ cid: 'c1@x', blobId: 'P1', type: 'image/png', name: 'chart.png', size: 9 }],
      attachments: [{ blobId: 'P2', name: 'a.pdf', type: 'application/pdf', size: 3 }],
    });
  });

  it('keeps an image as an attachment when the HTML does not refer to it, or it is not an image', () => {
    expect(splitParts('<p>x</p>', [png]).attachments.map((a) => a.name)).toEqual(['chart.png']);
    const ics = bodyPart({ blobId: 'P3', type: 'text/calendar', name: 'i.ics', cid: 'c1@x' });
    expect(splitParts('<img src="cid:c1@x">', [ics])).toMatchObject({ inline: [], attachments: [{ name: 'i.ics' }] });
  });

  it('reads a part once when the server lists it twice, and skips parts without a blob', () => {
    // Another client's draft: the image sits in multipart/mixed, and Stalwart lists it in htmlBody as well.
    const r = splitParts('<img src="cid:c1@x">', [png, { ...png }, bodyPart({ type: 'text/html', partId: '1' })]);
    expect(r.inline).toHaveLength(1);
    expect(r.attachments).toEqual([]);
  });
});

describe('blob ids after a save', () => {
  const draft: Draft = {
    ...initialDraft('new', null, me), bodyHtml: '<img src="cid:c1@x">',
    inline: [{ cid: 'c1@x', blobId: 'up1', type: 'image/png', name: 'chart.png', size: 9 }, { cid: 'c2@x', blobId: 'up2', type: 'image/png', name: 'gone.png', size: 9 }],
    attachments: [{ blobId: 'up3', name: 'a.pdf', type: 'application/pdf', size: 3 }, { blobId: 'up4', name: 'a.pdf', type: 'application/pdf', size: 4 }],
  };
  const stored = [
    bodyPart({ blobId: 'n1.p3', type: 'image/png', name: 'chart.png', cid: 'c1@x', disposition: 'inline' }),
    bodyPart({ blobId: 'n1.p4', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' }),
    bodyPart({ blobId: 'n1.p5', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' }),
  ];

  it('matches images by content id and attachments by name and type, in order', () => {
    expect([...blobIdChanges(draft, stored)]).toEqual([['up1', 'n1.p3'], ['up3', 'n1.p4'], ['up4', 'n1.p5']]);
  });

  it('leaves alone what the stored message does not have', () => {
    const later = withBlobIds({ ...draft, attachments: [...draft.attachments, { blobId: 'up9', name: 'new.txt', type: 'text/plain', size: 1 }] }, blobIdChanges(draft, stored));
    expect(later.inline.map((i) => i.blobId)).toEqual(['n1.p3', 'up2']);
    expect(later.attachments.map((a) => a.blobId)).toEqual(['n1.p4', 'n1.p5', 'up9']);
  });
});

describe('the original\'s parts in a reply and a forward', () => {
  const withParts: EmailRec = {
    ...original,
    htmlBody: [{ partId: 'h', type: 'text/html' } as never],
    bodyValues: { h: { value: '<p>Look</p><img src="cid:c1@x"><img src="cid:missing@x"><img src="https://r.test/t.png">', isEncodingProblem: false, isTruncated: false } },
    attachments: [
      bodyPart({ blobId: 'O1', type: 'image/png', name: 'chart.png', cid: 'c1@x', disposition: 'inline', size: 9 }),
      bodyPart({ blobId: 'O2', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment', size: 3 }),
    ],
  };

  it('a reply keeps the inline image and drops the attachment', () => {
    const d = initialDraft('reply', withParts, me);
    expect(d.quoteHtml).toContain('<img src="cid:c1@x">');
    expect(d.inline).toEqual([{ cid: 'c1@x', blobId: 'O1', type: 'image/png', name: 'chart.png', size: 9 }]);
    expect(d.attachments).toEqual([]);
  });

  it('a forward keeps both', () => {
    const d = initialDraft('forward', withParts, me);
    expect(d.quoteHtml).toContain('<img src="cid:c1@x">');
    expect(d.inline.map((i) => i.blobId)).toEqual(['O1']);
    expect(d.attachments).toEqual([{ blobId: 'O2', name: 'a.pdf', type: 'application/pdf', size: 3 }]);
  });

  it('leaves an image the original has no part for without a source, and remote images blocked', () => {
    const d = initialDraft('reply', withParts, me);
    expect(d.quoteHtml).not.toContain('cid:missing@x');
    expect(d.quoteHtml).not.toMatch(/\ssrc="https:\/\/r\.test/);
  });

  it('copes with a plain-text original that has an attachment', () => {
    const d = initialDraft('forward', { ...original, attachments: [bodyPart({ blobId: 'O2', type: 'text/plain', name: 'n.txt' })] }, me);
    expect(d.inline).toEqual([]);
    expect(d.attachments.map((a) => a.name)).toEqual(['n.txt']);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/mail/compose.test.ts`
Expected: FAIL (`splitParts` is not exported).

- [ ] **Step 3: Implement**

In `src/mail/compose.ts`, change the type import to include `EmailBodyPart`. After `fromEditorHtml` add:

```ts
const bareCid = (cid: string | null) => cid?.replace(/^<|>$/g, '') ?? '';

/** Sort a stored message's parts: an image the HTML refers to by content id is inline, the rest are attachments. */
export function splitParts(html: string, parts: EmailBodyPart[]): { inline: InlineImage[]; attachments: DraftAttachment[] } {
  const used = referencedCids(html);
  const inline: InlineImage[] = [];
  const attachments: DraftAttachment[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    // Stalwart can list one image under both htmlBody and attachments.
    if (!p.blobId || seen.has(p.blobId)) continue;
    seen.add(p.blobId);
    const cid = bareCid(p.cid);
    if (cid && p.type.startsWith('image/') && used.has(cid)) {
      if (!inline.some((i) => i.cid === cid)) inline.push({ cid, blobId: p.blobId, type: p.type, name: p.name ?? 'image', size: p.size });
    } else attachments.push({ blobId: p.blobId, name: p.name ?? 'attachment', type: p.type, size: p.size });
  }
  return { inline, attachments };
}

/** Old blob id to new, for a draft's parts as the server stored them: images by content id, attachments by name and type, in order. */
export function blobIdChanges(draft: Draft, stored: EmailBodyPart[]): Map<string, string> {
  const now = splitParts(draftHtml(draft), stored);
  const changes = new Map<string, string>();
  for (const i of draft.inline) {
    const s = now.inline.find((x) => x.cid === i.cid);
    if (s && s.blobId !== i.blobId) changes.set(i.blobId, s.blobId);
  }
  const left = [...now.attachments];
  for (const a of draft.attachments) {
    const at = left.findIndex((s) => s.name === a.name && s.type === a.type);
    if (at < 0) continue;
    const [s] = left.splice(at, 1);
    if (s!.blobId !== a.blobId) changes.set(a.blobId, s!.blobId);
  }
  return changes;
}

export function withBlobIds(draft: Draft, changes: Map<string, string>): Draft {
  const swap = <T extends { blobId: string }>(x: T): T => (changes.has(x.blobId) ? { ...x, blobId: changes.get(x.blobId)! } : x);
  return { ...draft, inline: draft.inline.map(swap), attachments: draft.attachments.map(swap) };
}
```

`draftHtml` is declared further down the file as a function declaration, so it is hoisted; no reordering is needed.

Replace `originalHtml` with:

```ts
const CID_MARK = /<img\b[^>]*?\sdata-oinbox-cid="([^"]*)"[^>]*>/gi;

/** The original's parts a quote can refer to or carry along. */
function originalParts(e: EmailRec): EmailBodyPart[] {
  // Stalwart lists an inline image under htmlBody when the sender put it beside the body.
  return [...(e.attachments ?? []), ...(e.htmlBody ?? []).filter((p) => p.cid && p.type.startsWith('image/'))];
}

function originalHtml(e: EmailRec): string {
  const values = e.bodyValues ?? {};
  const html = (e.htmlBody ?? []).filter((p) => p.type === 'text/html' && p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('');
  if (html.trim()) {
    // The sanitizer takes the source off cid: images and marks them. In a quote, the ones the
    // original has a part for get their cid: back: the new message carries that part.
    const known = new Set(originalParts(e).filter((p) => p.blobId && p.type.startsWith('image/')).map((p) => bareCid(p.cid)));
    return sanitizeEmailHtml(html, { allowRemote: false }).html.replace(CID_MARK, (tag, raw: string) =>
      known.has(unescapeAttr(raw)) ? tag.replace(/\sdata-oinbox-cid="[^"]*"/, ` src="cid:${raw}"`) : tag,
    );
  }
  const text = (e.textBody ?? []).filter((p) => p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('\n');
  return `<div style="white-space:pre-wrap">${plainTextToHtml(text || e.preview || '')}</div>`;
}
```

In `initialDraft`, right after `const subject = original.subject ?? '';`:

```ts
  const quoted = originalHtml(original);
  // Blobs are reused, not uploaded again; the first save gives the draft copies of its own.
  const carried = splitParts(quoted, originalParts(original));
```

In the forward branch, use `quoted` in place of `originalHtml(original)` and return:

```ts
    return { ...empty, subject: prefixed(subject, 'Fwd'), quoteHtml: `<br><div class="gmail_quote">${header}<br><br>${quoted}</div>`, inline: carried.inline, attachments: carried.attachments };
```

In the reply return, use `quoted` in place of `originalHtml(original)` and add `inline: carried.inline,` after `references`.

`originalHtml` and `originalParts` use `bareCid`, `unescapeAttr` and `splitParts`: keep them below those definitions in the file.

- [ ] **Step 4: Run**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. If the reply test fails because the sanitizer wrote the attributes in another order, look at the actual HTML: the requirement is an `<img>` whose only source is `cid:c1@x`; adjust the assertion to `toMatch(/<img[^>]*\ssrc="cid:c1@x"/)` only if that is the difference.

- [ ] **Step 5: Commit**

```bash
git add src/mail/compose.ts src/mail/compose.test.ts
git commit -m "Replies and forwards keep the original's inline images; forwards keep its attachments"
```

---

### Task 5: The composer follows its draft's blob ids

**Files:**
- Modify: `src/app/composer.ts` (`doSave`, `send`)
- Test: `src/app/composer.test.ts`

**Interfaces:**
- Consumes: `engine.saveDraft(email, replaces: Id[]): Promise<SavedDraft>`, `engine.draftParts(id)`, `DraftSaveError` (Task 2); `blobIdChanges`, `withBlobIds` (Task 4); `FakeJmap.uploads` (Task 1).
- Produces: no new public names. Behaviour: after every save the draft's blob ids are those of the stored version.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/composer.test.ts`. If the file's `setup` helper is local to another `describe`, use this one:

```ts
describe('a draft\'s blob ids', () => {
  const start = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = new FakeJmap();
    server.addMailbox('D', 'Drafts', 'drafts');
    server.uploads.add('up1');
    const client = server.client();
    const engine = createRoot(() => new MailEngine(client, { settleDelayMs: 0 }));
    await engine.start();
    const toast = vi.fn();
    const composers = createRoot(() => createComposers(engine, toast, vi.fn(async () => true), vi.fn()));
    return { server, client, engine, composers, toast };
  };
  afterEach(() => vi.useRealTimers());
  const file = { blobId: 'up1', name: 'a.pdf', type: 'application/pdf', size: 3 };
  const autosave = () => vi.advanceTimersByTimeAsync(2000);

  it('are the stored version\'s after each save, so a third save still works', async () => {
    const { server, composers } = await start();
    const c = composers.open('new');
    for (const subject of ['one', 'two', 'three']) {
      c.update({ subject, attachments: c.draft().attachments.length ? c.draft().attachments : [file] });
      await autosave();
      expect(c.status()).toBe('saved');
    }
    expect(server.emails.size).toBe(1);
    const stored = [...server.emails.values()][0]!;
    expect(stored.subject).toBe('three');
    expect(c.draft().attachments[0]!.blobId).toBe(stored.attachments![0]!.blobId);
  });

  it('let a draft reopened from Drafts be saved more than once', async () => {
    const { server, composers } = await start();
    const first = composers.open('new');
    first.update({ subject: 'kept', attachments: [file] });
    await autosave();
    await composers.close(first);
    composers.openDraft(structuredClone([...server.emails.values()][0]!));
    const c = composers.list().at(-1)!;
    expect(c.draft().attachments.map((a) => a.name)).toEqual(['a.pdf']);
    for (const subject of ['again', 'and again']) {
      c.update({ subject });
      await autosave();
      expect(c.status()).toBe('saved');
    }
    expect([...server.emails.values()].map((e) => e.subject)).toEqual(['and again']);
  });

  it('are not touched for an attachment added while the save was on its way', async () => {
    const { server, composers } = await start();
    server.uploads.add('up2');
    const c = composers.open('new');
    c.update({ subject: 's', attachments: [file] });
    let release = () => {};
    server.holds.push(new Promise((r) => (release = r)));
    const saving = autosave();
    await vi.waitFor(() => expect(c.status()).toBe('saving'));
    c.update({ attachments: [...c.draft().attachments, { blobId: 'up2', name: 'b.txt', type: 'text/plain', size: 1 }] });
    release();
    await saving;
    await vi.waitFor(() => expect(c.draft().attachments.map((a) => a.blobId)).toEqual([[...server.emails.values()][0]!.attachments![0]!.blobId, 'up2']));
  });

  it('keep the last saved version on the server when a save fails', async () => {
    const { server, composers } = await start();
    const c = composers.open('new');
    c.update({ subject: 'good' });
    await autosave();
    c.update({ subject: 'bad', attachments: [{ ...file, blobId: 'never-uploaded' }] });
    await autosave();
    expect(c.status()).toBe('error');
    expect([...server.emails.values()].map((e) => e.subject)).toEqual(['good']);
  });

  it('are read again from the server when it says a blob is gone', async () => {
    const { server, client, composers } = await start();
    const c = composers.open('new');
    c.update({ subject: 'one', attachments: [file] });
    await autosave();
    // The next save's follow-up is lost on the way back: the old version is destroyed, but we never learn the new ids.
    const real = client.send.bind(client);
    let lost = false;
    vi.spyOn(client, 'send').mockImplementation(async (b) => {
      const r = await real(b);
      if (!lost && b.build([]).methodCalls.some(([name, args]) => name === 'Email/set' && !!args.destroy)) {
        lost = true;
        throw new TypeError('Failed to fetch');
      }
      return r;
    });
    c.update({ subject: 'two' });
    await autosave();
    expect(c.status()).toBe('saved');
    c.update({ subject: 'three' });
    await autosave();
    expect(c.status()).toBe('saved');
    expect([...server.emails.values()].map((e) => e.subject)).toEqual(['three']);
  });

  it('are current in the composer Undo brings back after Send', async () => {
    const { server, composers, toast } = await start();
    const c = composers.open('new');
    c.update({ to: [{ name: null, email: 'bob@x.test' }], subject: 'undo me', attachments: [file] });
    await composers.send(c);
    const undo = toast.mock.calls.find((call) => call[0] === 'Sending…')![2] as { run: () => void };
    undo.run();
    const back = composers.list().at(-1)!;
    expect(back.draft().attachments[0]!.blobId).toBe([...server.emails.values()][0]!.attachments![0]!.blobId);
    for (const subject of ['x', 'y']) {
      back.update({ subject });
      await autosave();
      expect(back.status()).toBe('saved');
    }
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/app/composer.test.ts -t "blob ids"`
Expected: the first, second, fifth and sixth FAIL with status `error` on a later save; the fourth may already pass after Task 2.

- [ ] **Step 3: Implement**

In `src/app/composer.ts`:

Imports: add `blobIdChanges, withBlobIds` to the import from `'../mail/compose'`, and `DraftSaveError, type SavedDraft` to the import from `'../sync/engine'` (`DraftSaveError` is a value: split it from the `import type`).

In `create`, after `let unconfirmedSend = …`:

```ts
    /** Older versions a save could not confirm as removed; the next save takes them along. */
    let stale: Id[] = [];
```

Replace the body of `doSave`'s `try` block (keep the `unconfirmedSend` check at its top unchanged) from the `const saved = await engine.saveDraft(…)` line to `if (status() === 'saving') setStatus('saved');` with:

```ts
        const from = { name: identity.name || null, email: identity.email };
        const replaces = [...stale, ...(draftId() ? [draftId()!] : [])];
        let sent = draft();
        let saved: SavedDraft;
        try {
          saved = await engine.saveDraft(buildEmailCreate(sent, from, drafts), replaces);
        } catch (e) {
          // A part's blob went with an earlier version: find where its content is now, once.
          const changes = e instanceof DraftSaveError && e.type === 'blobNotFound' ? await recoverBlobs(sent) : null;
          if (!changes?.size) throw e;
          setDraft(withBlobIds(draft(), changes));
          sent = withBlobIds(sent, changes);
          saved = await engine.saveDraft(buildEmailCreate(sent, from, drafts), replaces);
        }
        // The stored version has blob ids of its own, and the old ones die with the old version.
        // Only what was sent is renamed: a part added since keeps its upload's id until the next save.
        const changes = saved.parts ? blobIdChanges(sent, saved.parts) : null;
        if (changes?.size) setDraft(withBlobIds(draft(), changes));
        stale = saved.replaced ? [] : replaces;
        setDraftId(saved.id);
        if (status() === 'saving') setStatus('saved');
```

Above `doSave`, add the recovery it calls (Task 6 extends it for images):

```ts
    /** New blob ids for parts whose blobs are gone: those of the version the server has now. */
    const recoverBlobs = async (sent: Draft): Promise<Map<string, string>> => {
      const parts = draftId() ? await engine.draftParts(draftId()!) : null;
      return parts ? blobIdChanges(sent, parts) : new Map();
    };
```

`Draft` is already imported as a type in this file.

In `send`, the composer's content is captured before the save. Move the capture after it: keep `const d = c.draft();` for the recipient check at the top, and after `const draftId = c.draftId()!;` add

```ts
    // After the save: the draft now names the stored version's blobs.
    const saved = c.draft();
```

then use `saved` instead of `d` in `const snapshot: Restore = { draft: saved, … }` and in the three `[...d.to, ...d.cc, ...d.bcc]` expressions inside the timer.

- [ ] **Step 4: Run**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/composer.ts src/app/composer.test.ts
git commit -m "A draft with attachments can be saved again after it has been reopened"
```

---

### Task 6: The composer inserts, loads and releases images

**Files:**
- Modify: `src/app/composer.ts` (`Composer` interface, `create`, `remove`, `openDraft`)
- Test: `src/app/composer.test.ts`

**Interfaces:**
- Consumes: `InlineImage`, `referencedCids`, `splitParts` (Tasks 3, 4); `engine.upload(blob)`, `engine.fetchBlob(blobId, name, type): Promise<Blob>`.
- Produces, on `Composer`:

```ts
  /** Upload an image and remember it; resolves to the object URL to show it with. Rejects after telling the user. */
  insertImage: (file: File) => Promise<string>;
  /** Content id to object URL, for the images that have been loaded. */
  imageUrls: Accessor<Record<string, string>>;
  /** False while images the text itself refers to are still being fetched. */
  imagesReady: Accessor<boolean>;
  /** Resolves once every image of the draft has been fetched or has failed. */
  loadImages: () => Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

Append to `src/app/composer.test.ts`:

```ts
describe('composer images', () => {
  let made = 0;
  const revoked: string[] = [];
  beforeEach(() => {
    made = 0;
    revoked.length = 0;
    // jsdom has neither.
    URL.createObjectURL = vi.fn(() => `blob:test/${++made}`);
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
  });
  const start = async () => {
    const server = new FakeJmap();
    server.addMailbox('D', 'Drafts', 'drafts');
    const engine = createRoot(() => new MailEngine(server.client(), { settleDelayMs: 0 }));
    await engine.start();
    let n = 0;
    const upload = vi.spyOn(engine, 'upload').mockImplementation(async () => {
      const blobId = `up${++n}`;
      server.uploads.add(blobId);
      return { accountId: 'a1', blobId, type: 'image/png', size: 4 };
    });
    const fetchBlob = vi.spyOn(engine, 'fetchBlob').mockResolvedValue(new Blob(['x']));
    const toast = vi.fn();
    const composers = createRoot(() => createComposers(engine, toast, vi.fn(async () => true), vi.fn()));
    return { server, engine, composers, toast, upload, fetchBlob };
  };
  const png = (name = 'chart.png') => new File(['data'], name, { type: 'image/png' });

  it('uploads an image and hands back a URL for it', async () => {
    const { composers } = await start();
    const c = composers.open('new');
    const url = await c.insertImage(png());
    const [image] = c.draft().inline;
    expect(image).toMatchObject({ blobId: 'up1', type: 'image/png', name: 'chart.png', size: 4 });
    expect(image!.cid).toMatch(/^[0-9a-f-]{36}@oinbox$/);
    expect(c.imageUrls()).toEqual({ [image!.cid]: url });
    expect(c.uploading()).toBe(0);
  });

  it('gives the same file inserted twice two content ids', async () => {
    const { composers } = await start();
    const c = composers.open('new');
    const a = await c.insertImage(png());
    const b = await c.insertImage(png());
    expect(a).not.toBe(b);
    expect(new Set(c.draft().inline.map((i) => i.cid)).size).toBe(2);
  });

  it('says so and inserts nothing when the upload fails', async () => {
    const { composers, toast, upload } = await start();
    upload.mockRejectedValueOnce(new Error('Upload quota exceeded'));
    const c = composers.open('new');
    await expect(c.insertImage(png())).rejects.toThrow('Upload quota exceeded');
    expect(toast).toHaveBeenCalledWith("Couldn't add chart.png: Upload quota exceeded", 'error');
    expect(c.draft().inline).toEqual([]);
    expect(c.uploading()).toBe(0);
  });

  it('keeps a removed image while the composer is open, so undo can bring it back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { server, composers } = await start();
      const c = composers.open('new');
      await c.insertImage(png());
      const cid = c.draft().inline[0]!.cid;
      c.update({ subject: 's', bodyHtml: `<img src="cid:${cid}">` });
      await vi.advanceTimersByTimeAsync(2000);
      c.update({ bodyHtml: '<p>no image</p>' });
      await vi.advanceTimersByTimeAsync(2000);
      expect([...server.emails.values()][0]!.attachments).toEqual([]);
      c.update({ bodyHtml: `<img src="cid:${cid}">` });
      await vi.advanceTimersByTimeAsync(2000);
      expect(c.status()).toBe('saved');
      expect([...server.emails.values()][0]!.attachments!.map((p) => p.cid)).toEqual([cid]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens a draft with its images inline, loaded before the editor shows', async () => {
    const { composers, fetchBlob } = await start();
    composers.openDraft({
      id: 'd1', threadId: 't9', from: [{ name: null, email: 'alice@example.test' }], to: [], receivedAt: '2026-09-01T10:00:00Z',
      htmlBody: [{ partId: 'h', type: 'text/html' } as never],
      bodyValues: { h: { value: '<p>Hi</p><img src="cid:c1@x">', isEncodingProblem: false, isTruncated: false } },
      attachments: [
        { partId: null, blobId: 'P1', size: 9, type: 'image/png', name: 'chart.png', cid: 'c1@x', disposition: 'inline' },
        { partId: null, blobId: 'P2', size: 3, type: 'application/pdf', name: 'a.pdf', cid: null, disposition: 'attachment' },
      ],
    });
    const c = composers.list().at(-1)!;
    expect(c.draft().inline.map((i) => i.blobId)).toEqual(['P1']);
    expect(c.draft().attachments.map((a) => a.name)).toEqual(['a.pdf']);
    expect(c.imagesReady()).toBe(false);
    await c.loadImages();
    expect(fetchBlob).toHaveBeenCalledWith('P1', 'chart.png', 'image/png');
    expect(c.imagesReady()).toBe(true);
    expect(c.imageUrls()).toEqual({ 'c1@x': 'blob:test/1' });
  });

  it('is ready at once when only the quote has images, and loads those too', async () => {
    const { composers } = await start();
    const c = composers.open('reply', {
      id: 'e1', threadId: 't1', subject: 'Hi', from: [{ name: 'Bob', email: 'bob@x.test' }], to: [], receivedAt: '2026-09-01T10:00:00Z',
      htmlBody: [{ partId: 'h', type: 'text/html' } as never],
      bodyValues: { h: { value: '<img src="cid:c1@x">', isEncodingProblem: false, isTruncated: false } },
      attachments: [{ partId: null, blobId: 'O1', size: 9, type: 'image/png', name: 'chart.png', cid: 'c1@x', disposition: 'inline' }],
    });
    expect(c.imagesReady()).toBe(true);
    await c.loadImages();
    expect(c.imageUrls()['c1@x']).toBe('blob:test/1');
  });

  it('carries on when an image cannot be fetched', async () => {
    const { composers, fetchBlob } = await start();
    fetchBlob.mockRejectedValueOnce(new Error('404'));
    composers.restore([{
      mode: 'new', draftId: null, identityId: 'id1', threadId: null, replyTo: null, signatureMode: 'auto',
      draft: { mode: 'new', to: [], cc: [], bcc: [], subject: 's', inReplyTo: [], references: [], quoteHtml: '', signatureHtml: '', bodyHtml: '<img src="cid:c1@x">', attachments: [], inline: [{ cid: 'c1@x', blobId: 'gone', type: 'image/png', name: 'chart.png', size: 9 }] },
    }]);
    const c = composers.list().at(-1)!;
    await c.loadImages();
    expect(c.imagesReady()).toBe(true);
    expect(c.imageUrls()).toEqual({});
  });

  it('reads a composer rescued before images existed', async () => {
    const { composers } = await start();
    const old = { mode: 'new', to: [], cc: [], bcc: [], subject: 's', inReplyTo: [], references: [], quoteHtml: '', signatureHtml: '', bodyHtml: '<p>x</p>', attachments: [] };
    composers.restore([{ mode: 'new', draftId: null, identityId: 'id1', threadId: null, replyTo: null, signatureMode: 'auto', draft: old as never }]);
    expect(composers.list().at(-1)!.draft().inline).toEqual([]);
  });

  it('releases its URLs when the composer goes', async () => {
    const { composers } = await start();
    const c = composers.open('new');
    const url = await c.insertImage(png());
    await composers.close(c);
    expect(revoked).toEqual([url]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/app/composer.test.ts -t "composer images"`
Expected: FAIL (`c.insertImage is not a function`).

- [ ] **Step 3: Implement**

In `src/app/composer.ts`:

Imports from `'../mail/compose'`: add `referencedCids, splitParts, type InlineImage`.

Add the four members from the Interfaces block above to the `Composer` interface, after `removeAttachment`. Add to the `Internal` type: `releaseImages: () => void;`.

In `create`, replace the `createSignal<Draft>(…)` initial value so an old rescued draft is read:

```ts
    const [draft, setDraft] = createSignal<Draft>(
      restore?.draft ? { ...restore.draft, inline: restore.draft.inline ?? [] } : { ...initialDraft(mode, original, engine.myAddresses()), signatureHtml: signatureOf(startIdentity) },
    );
```

After the `stale` declaration add:

```ts
    const [imageUrls, setImageUrls] = createSignal<Record<string, string>>({});
    /** The images' bytes, by content id: enough to upload one again if its blob is lost. */
    const imageBlobs = new Map<string, Blob>();
    const fetching = new Map<string, Promise<void>>();
    /** Fetch one image and make a URL for it. A failure leaves it without one: it shows as broken, the rest works. */
    const fetchImage = (i: InlineImage): Promise<void> => {
      let p = fetching.get(i.cid);
      if (!p) {
        p = engine
          .fetchBlob(i.blobId, i.name, i.type)
          .then((blob) => {
            imageBlobs.set(i.cid, blob);
            setImageUrls({ ...imageUrls(), [i.cid]: URL.createObjectURL(blob) });
          })
          .catch(logUnexpected);
        fetching.set(i.cid, p);
      }
      return p;
    };
    const loadImages = () => Promise.all(draft().inline.map(fetchImage)).then(() => undefined);
    // A reopened or rescued draft has images in its own text: the editor waits for those.
    // A quote's images are only needed once the quote is expanded.
    const inText = referencedCids(draft().bodyHtml);
    const awaited = draft().inline.filter((i) => inText.has(i.cid));
    const [imagesReady, setImagesReady] = createSignal(awaited.length === 0);
    if (awaited.length) void Promise.all(awaited.map(fetchImage)).then(() => setImagesReady(true));
    void loadImages();
```

In the `composer` object, after `removeAttachment`:

```ts
      insertImage: async (file) => {
        const name = file.name || 'image';
        setUploading((n) => n + 1);
        try {
          const r = await engine.upload(file);
          const cid = `${crypto.randomUUID()}@oinbox`;
          const url = URL.createObjectURL(file);
          fetching.set(cid, Promise.resolve());
          imageBlobs.set(cid, file);
          setImageUrls({ ...imageUrls(), [cid]: url });
          // Not saved yet: the editor puts the image in the text, and that change saves.
          setDraft({ ...draft(), inline: [...draft().inline, { cid, blobId: r.blobId, type: file.type || r.type, name, size: file.size }] });
          return url;
        } catch (e) {
          toast(`Couldn't add ${name}: ${(e as Error).message}`, 'error');
          throw e;
        } finally {
          setUploading((n) => n - 1);
        }
      },
      imageUrls,
      imagesReady,
      loadImages,
      releaseImages: () => {
        for (const url of Object.values(imageUrls())) URL.revokeObjectURL(url);
      },
```

Extend `recoverBlobs` (Task 5) so an image that was out of the text when the last version was stored can come back. Its blob went with an older version and the stored one has no part for it, but the composer still holds its bytes:

```ts
    /** New blob ids for parts whose blobs are gone: those of the version the server has now, or a fresh upload of an image it lacks. */
    const recoverBlobs = async (sent: Draft): Promise<Map<string, string>> => {
      const parts = draftId() ? await engine.draftParts(draftId()!) : null;
      const changes = parts ? blobIdChanges(sent, parts) : new Map<string, string>();
      const html = draftHtml(sent);
      const stored = new Set(splitParts(html, parts ?? []).inline.map((i) => i.cid));
      const used = referencedCids(html);
      for (const i of sent.inline) {
        const blob = imageBlobs.get(i.cid);
        if (!blob || stored.has(i.cid) || !used.has(i.cid)) continue;
        changes.set(i.blobId, (await engine.upload(blob)).blobId);
      }
      return changes;
    };
```

Add `draftHtml` to the import from `'../mail/compose'`. `recoverBlobs` must be declared after `imageBlobs`; move it below the image block if needed.

In `remove`, release them:

```ts
  const remove = (c: Composer) => {
    internals(c).cancelAutosave();
    internals(c).releaseImages();
    setList(list().filter((x) => x.id !== c.id));
  };
```

In `openDraft`, take the HTML from `text/html` parts only and sort the stored parts:

```ts
    const html = (email.htmlBody ?? []).filter((p) => p.type === 'text/html' && p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('');
```

and after `const parts = …` add `const stored = splitParts(html, email.attachments ?? []);`, then in the `draft` literal replace the `attachments: …` line and the `inline: []` line with:

```ts
      attachments: stored.attachments,
      inline: stored.inline,
```

- [ ] **Step 4: Run**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. An existing `openDraft` test whose `htmlBody` part has no `type` must give it `type: 'text/html'`; the tests in this file already do.

- [ ] **Step 5: Commit**

```bash
git add src/app/composer.ts src/app/composer.test.ts
git commit -m "The composer uploads inline images and loads the ones a draft already has"
```

---

### Task 7: The editor: paste, drop and a toolbar button

**Files:**
- Modify: `src/ui/FormatToolbar.tsx`, `src/ui/ComposerView.tsx`, `src/ui/styles.css` (after line 328), `docs/rozie-feedback.md` (append)
- Test: `src/ui/FormatToolbar.test.tsx` (new)

**Interfaces:**
- Consumes: `Composer.insertImage`, `imageUrls`, `imagesReady`, `loadImages` (Task 6); `toEditorHtml`, `fromEditorHtml` (Task 3).
- Produces: `FormatToolbar` prop `onImage?: (files: File[]) => void`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/FormatToolbar.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { FormatToolbar } from './FormatToolbar';

describe('FormatToolbar', () => {
  it('has no image button unless it is given somewhere to send images', () => {
    render(() => <FormatToolbar editor={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Insert image' })).toBeNull();
  });

  it('passes on the images chosen, and only images', () => {
    const onImage = vi.fn();
    const { container } = render(() => <FormatToolbar editor={() => undefined} onImage={onImage} />);
    expect(screen.getByRole('button', { name: 'Insert image' })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('image/*');
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [png, pdf] } });
    expect(onImage).toHaveBeenCalledWith([png]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm test src/ui/FormatToolbar.test.tsx`
Expected: FAIL (no `Insert image` button).

- [ ] **Step 3: Implement the toolbar**

Replace `src/ui/FormatToolbar.tsx` with:

```tsx
import type { TipTapHandle } from '@rozie-ui/tiptap-solid';
import { Show } from 'solid-js';

/** Bold, italic, underline, lists and link: the formatting the composer and the signature editor share. The composer adds images. */
export function FormatToolbar(props: { editor: () => TipTapHandle | undefined; onImage?: (files: File[]) => void }) {
  const e = () => props.editor();
  let picker: HTMLInputElement | undefined;
  return (
    <div class="compose-format" role="toolbar" aria-label="Formatting">
      <button type="button" title="Bold (Ctrl+B)" onClick={() => e()?.toggleBold()}><b>B</b></button>
      <button type="button" title="Italic (Ctrl+I)" onClick={() => e()?.toggleItalic()}><i>I</i></button>
      <button type="button" title="Underline (Ctrl+U)" onClick={() => e()?.toggleUnderline()}><u>U</u></button>
      <button type="button" title="Bulleted list" onClick={() => e()?.toggleBulletList()}>•≡</button>
      <button type="button" title="Numbered list" onClick={() => e()?.toggleOrderedList()}>1≡</button>
      <button type="button" title="Link" onClick={() => e()?.openLinkEditor()}>🔗</button>
      <Show when={props.onImage}>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(ev) => {
            // `accept` is advice to the file dialog, not a rule.
            props.onImage?.([...(ev.currentTarget.files ?? [])].filter((f) => f.type.startsWith('image/')));
            ev.currentTarget.value = '';
          }}
        />
        <button type="button" title="Insert image" aria-label="Insert image" onClick={() => picker?.click()}>🖼</button>
      </Show>
    </div>
  );
}
```

Run: `pnpm test src/ui/FormatToolbar.test.tsx` — expected PASS.

- [ ] **Step 4: Wire the composer view**

In `src/ui/ComposerView.tsx`:

Change the compose import to `import { formatAddress, fromEditorHtml, toEditorHtml } from '../mail/compose';`.

After `const d = () => c.draft();` add:

```tsx
  /** The editor's HTML as the draft keeps it: images by content id. */
  const stored = (html: string) => fromEditorHtml(html, c.imageUrls());
  /** The draft's HTML as the editor shows it: images by object URL. */
  const shown = (html: string) => toEditorHtml(html, c.imageUrls());

  const insertImages = async (files: File[]) => {
    for (const file of files) {
      try {
        const src = await c.insertImage(file);
        editor?.chain().focus().setImage({ src, alt: file.name }).run();
      } catch {
        // insertImage has told the user.
      }
    }
  };
```

Replace `expandQuote` and `inlineSignature` with:

```tsx
  const expandQuote = async () => {
    // The quote's images need their URLs before the editor is given them.
    await c.loadImages();
    const html = stored(editor?.getHTML() ?? d().bodyHtml) + d().quoteHtml;
    c.update({ bodyHtml: html, quoteHtml: '' });
    editor?.setContent(shown(html));
  };

  const inlineSignature = () => {
    const html = stored(editor?.getHTML() ?? d().bodyHtml) + d().signatureHtml;
    c.inlineSignature(html);
    editor?.setContent(shown(html));
  };
```

and change the quote button to `onClick={() => void expandQuote()}`.

In the root `div`'s `onDrop`, leave a drop the editor has taken alone:

```tsx
      onDrop={(e) => {
        setDragging(false);
        // An image dropped on the text went inline: the editor has dealt with it.
        if (e.defaultPrevented) return;
        if (e.dataTransfer?.files.length) {
          e.preventDefault();
          void c.attach(e.dataTransfer.files);
        }
      }}
```

Wrap the `<TipTap … />` element in a `Show`, and change three of its props:

```tsx
        <Show when={c.imagesReady()} fallback={<div class="compose-editor compose-loading" role="status">Loading images…</div>}>
          <TipTap
            /* ref: unchanged */
            html={shown(d().bodyHtml)}
            onHtmlChange={(html: string) => {
              const next = stored(html);
              if (next !== d().bodyHtml) c.update({ bodyHtml: next === '<p></p>' ? '' : next });
            }}
            uploadImage={(file: File) => c.insertImage(file)}
            /* placeholder, ariaLabel, editorClass: unchanged */
            toolbarSlot={() => <FormatToolbar editor={() => editor} onImage={(files) => void insertImages(files)} />}
          />
        </Show>
```

Keep the existing `ref`, `placeholder`, `ariaLabel` and `editorClass` props exactly as they are.

In `src/ui/styles.css`, after the `.compose-editor p` rule (line 328):

```css
.compose-editor img { max-width: 100%; height: auto; }
.compose-loading { color: var(--text-3); }
```

- [ ] **Step 5: Record the rozie gap**

Append to `docs/rozie-feedback.md`:

```markdown
## TipTap 0.5.2: paste and drop take one image

Found 2026-10-08 while adding inline images. With `uploadImage` set, the wrapper's `handlePaste` and
`handleDrop` look for the first image file (`findImageFile`) and upload that one. Pasting or dropping
several images inserts only the first; the others are dropped silently. oinbox's toolbar button
inserts several, so the gap shows only on paste and drop.

Also noted: the inserted node gets `src` alone. A way to return `{ src, alt }` from `uploadImage`
would let the image carry its file name as alt text.
```

- [ ] **Step 6: Run everything, and look at it**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

Then check by hand in the running app (`pnpm dev`, sign in as alice, password `oinbox-dev-pass`): Compose, click Insert image and pick a PNG; it appears in the text and no attachment chip appears. Drop a PNG onto the text: inline, no chip. Drop it onto the recipient row: a chip. Type after an image: the cursor stays where it is (the editor is not reset). If the cursor jumps to the start after inserting an image, `toEditorHtml(fromEditorHtml(h))` is not returning `h`: log both strings and fix the conversion, not the view.

- [ ] **Step 7: Commit**

```bash
git add src/ui/FormatToolbar.tsx src/ui/FormatToolbar.test.tsx src/ui/ComposerView.tsx src/ui/styles.css docs/rozie-feedback.md
git commit -m "Compose: paste, drop or pick an image into the text"
```

---

### Task 8: End-to-end tests and the changelog

**Files:**
- Modify: `e2e/support/mail.ts` (`OutgoingMail`, `sendMail`), `e2e/support/compose.ts`
- Create: `e2e/inline-images.spec.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the app as built by Tasks 1–7; existing helpers `composeNew`, `sendAndWait`, `deliveredCopy`, `destroyBySubject`, `addRecipient`, `typeBody`, `bodyEditor`, `floatingComposer`, `inlineComposer`, `saveStatus`, `rows`, `openInbox`, `sendMail`, `emailsBySubject`, `mailboxByRole`, `waitFor`, `jmap`, `accountId`, `uniqueTag`, `ALICE`, `BOB`.
- Produces: `OutgoingMail.mime?`, `messageParts(id, user)`, `PNG`, `inlineImageMail(cid, attachment?)`.

- [ ] **Step 1: Helpers**

In `e2e/support/mail.ts`, add to `OutgoingMail`:

```ts
  /** A ready-made MIME body with its Content-Type, in place of `text` as text/plain. */
  mime?: { contentType: string; body: string };
```

and in `sendMail` replace the two fixed content headers and the `body` line:

```ts
    'MIME-Version: 1.0',
    ...(m.mime ? [`Content-Type: ${m.mime.contentType}`] : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit']),
  ];
  const body = (m.mime?.body ?? m.text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
```

Append to `e2e/support/compose.ts` (import `jmap` and `accountId` from `./mail` if the file does not already):

```ts
/** A 1×1 PNG. */
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const PNG = Buffer.from(PNG_BASE64, 'base64');

/** A message whose HTML shows an inline image, optionally with notes.txt attached, for sendMail's `mime`. */
export function inlineImageMail(cid: string, attachment?: string): { contentType: string; body: string } {
  const related = [
    '--rel', 'Content-Type: text/html; charset=utf-8', '', `<p>Before</p><img src="cid:${cid}"><p>After</p>`,
    '--rel', 'Content-Type: image/png; name="chart.png"', 'Content-Transfer-Encoding: base64', `Content-ID: <${cid}>`, 'Content-Disposition: inline; filename="chart.png"', '', PNG_BASE64,
    '--rel--',
  ];
  if (attachment === undefined) return { contentType: 'multipart/related; boundary="rel"', body: related.join('\n') };
  const mixed = [
    '--mix', 'Content-Type: multipart/related; boundary="rel"', '', ...related,
    '--mix', 'Content-Type: text/plain; name="notes.txt"', 'Content-Disposition: attachment; filename="notes.txt"', '', attachment,
    '--mix--',
  ];
  return { contentType: 'multipart/mixed; boundary="mix"', body: mixed.join('\n') };
}

export interface MessageParts {
  html: string;
  /** Every leaf part, in order, with the multipart types above it. */
  leaves: { type: string; name: string | null; cid: string | null; disposition: string | null; within: string[] }[];
}

/** A stored message's HTML and MIME layout. */
export async function messageParts(id: string, user = ALICE): Promise<MessageParts> {
  const r = await jmap(
    [['Email/get', {
      accountId: await accountId(user), ids: [id], properties: ['bodyStructure', 'bodyValues', 'htmlBody'], fetchHTMLBodyValues: true,
      bodyProperties: ['partId', 'type', 'name', 'cid', 'disposition', 'subParts'],
    }, 'g']],
    user,
  );
  const e = r.g.list[0];
  const leaves: MessageParts['leaves'] = [];
  const walk = (p: any, within: string[]) => {
    if (p.subParts) for (const s of p.subParts) walk(s, [...within, p.type]);
    else leaves.push({ type: p.type, name: p.name ?? null, cid: p.cid ?? null, disposition: p.disposition ?? null, within });
  };
  walk(e.bodyStructure, []);
  const htmlPart = (e.htmlBody as { partId: string; type: string }[]).find((p) => p.type === 'text/html');
  return { html: htmlPart ? e.bodyValues[htmlPart.partId].value : '', leaves };
}
```

- [ ] **Step 2: Write the tests**

Create `e2e/inline-images.spec.ts`:

```ts
import { expect, test, type Locator } from '@playwright/test';
import { ALICE, BOB, emailsBySubject, mailboxByRole, sendMail, uniqueTag, waitFor } from './support/mail';
import { openInbox, rows } from './support/app';
import {
  addRecipient, bodyEditor, composeNew, deliveredCopy, destroyBySubject, floatingComposer, inlineComposer, inlineImageMail, messageParts,
  PNG, PNG_BASE64, saveStatus, sendAndWait, typeBody,
} from './support/compose';

const subjects: string[] = [];
const newSubject = () => {
  const s = `Inline image test ${uniqueTag()}`;
  subjects.push(s);
  return s;
};
test.afterEach(async () => {
  for (const s of subjects.splice(0)) await destroyBySubject(s);
});

const editorImages = (c: Locator) => bodyEditor(c).locator('img');
const loaded = (img: Locator) => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
const insertImage = (c: Locator, name = 'chart.png') =>
  c.locator('.compose-format input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: PNG });
/** The image part of a message that the HTML shows in place. */
const inlineLeaf = (parts: Awaited<ReturnType<typeof messageParts>>) => parts.leaves.find((l) => l.type === 'image/png' && l.cid);

test('an image put between two paragraphs is sent inline and arrives in place', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Before' });
  await bodyEditor(c).press('Enter');
  await bodyEditor(c).pressSequentially('After');
  // Back to the end of the first paragraph: the image goes after it.
  await bodyEditor(c).press('ArrowUp');
  await bodyEditor(c).press('End');
  await insertImage(c);

  await expect(editorImages(c)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(c))).toBe(true);
  await expect(c.locator('.compose-attachments')).toHaveCount(0);
  await sendAndWait(page, c);

  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  const parts = await messageParts(received.id, BOB);
  const image = inlineLeaf(parts)!;
  expect(image).toMatchObject({ name: 'chart.png', disposition: 'inline' });
  expect(image.within).toContain('multipart/related');
  expect(parts.leaves.filter((l) => l.disposition === 'attachment')).toEqual([]);
  const at = (needle: string) => parts.html.indexOf(needle);
  expect(at('Before')).toBeGreaterThanOrEqual(0);
  expect(at(`cid:${image.cid}`)).toBeGreaterThan(at('Before'));
  expect(at('After')).toBeGreaterThan(at(`cid:${image.cid}`));
});

test('a pasted image goes into the text, not the attachments', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'building a paste with a file needs Chromium\'s ClipboardEvent');
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Pasted below.' });
  await bodyEditor(c).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG_BASE64);
  await expect(editorImages(c)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(c))).toBe(true);
  await expect(c.locator('.compose-attachments')).toHaveCount(0);
  await expect(saveStatus(c)).toHaveText('Draft saved');
});

test('a draft with an image reopens with it, saves again twice, and sends it', async ({ page }) => {
  const subject = newSubject();
  await openInbox(page);
  const c = await composeNew(page, { to: BOB, subject, body: 'Draft with a picture.' });
  await insertImage(c);
  await expect(editorImages(c)).toHaveCount(1);
  await expect(saveStatus(c)).toHaveText('Draft saved');

  await page.goto('/drafts');
  await expect(floatingComposer(page)).toHaveCount(0);
  await rows(page).filter({ has: page.locator('.subject', { hasText: subject }) }).click();
  const reopened = floatingComposer(page);
  await expect(editorImages(reopened)).toHaveCount(1);
  await expect.poll(() => loaded(editorImages(reopened))).toBe(true);
  await expect(reopened.locator('.compose-attachments')).toHaveCount(0);

  // Two more saves: each replaces the stored version, and its blob ids with it.
  for (const word of ['first', 'second']) {
    // Into the text, not onto the image: typing over a selected image would replace it.
    await bodyEditor(reopened).locator('p', { hasText: 'Draft with a picture.' }).click();
    await bodyEditor(reopened).press('End');
    await bodyEditor(reopened).pressSequentially(` ${word}`);
    await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.preview?.includes(word)), 15_000, `the draft saved with "${word}"`);
    await expect(saveStatus(reopened)).toHaveText('Draft saved');
  }
  expect(await emailsBySubject(subject)).toHaveLength(1);
  await sendAndWait(page, reopened);

  const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
  expect(inlineLeaf(await messageParts(received.id, BOB))).toMatchObject({ name: 'chart.png', disposition: 'inline' });
});

test('a reply keeps the original\'s inline image in the quote', async ({ page }) => {
  const subject = newSubject();
  const cid = `${uniqueTag('img')}@e2e.test`;
  const messageId = await sendMail({ from: 'Bob Example <bob@example.test>', to: [ALICE], subject, text: '', mime: inlineImageMail(cid) });
  const original = await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.messageId?.includes(messageId)), 15_000, 'the original');

  await page.goto(`/inbox/t/${original.threadId}`);
  await expect(page.locator('article.msg')).toHaveCount(1);
  // The reader shows it first.
  await expect.poll(() => loaded(page.frameLocator('article.msg iframe').locator('img'))).toBe(true);
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply', exact: true }).click();
  const c = inlineComposer(page);
  await typeBody(c, 'Thanks for the chart.');
  await sendAndWait(page, c);

  const reply = await waitFor(
    async () => (await emailsBySubject(subject, BOB)).find((e) => e.from?.[0]?.email === ALICE),
    20_000,
    'the reply in bob\'s mailbox',
  );
  const parts = await messageParts(reply.id, BOB);
  expect(inlineLeaf(parts)).toMatchObject({ cid, disposition: 'inline' });
  expect(parts.html).toContain(`cid:${cid}`);
  expect(parts.leaves.filter((l) => l.disposition === 'attachment')).toEqual([]);
});

test('a forward carries the inline image and the attachment', async ({ page }) => {
  const subject = newSubject();
  const cid = `${uniqueTag('img')}@e2e.test`;
  const messageId = await sendMail({ from: 'Bob Example <bob@example.test>', to: [ALICE], subject, text: '', mime: inlineImageMail(cid, 'notes for the chart') });
  const original = await waitFor(async () => (await emailsBySubject(subject)).find((e) => e.messageId?.includes(messageId)), 15_000, 'the original');

  await page.goto(`/inbox/t/${original.threadId}`);
  await expect(page.locator('article.msg')).toHaveCount(1);
  await page.locator('.reply-bar').getByRole('button', { name: 'Forward', exact: true }).click();
  const c = inlineComposer(page);
  await expect(c.locator('.compose-attachments .attachment', { hasText: 'notes.txt' })).toBeVisible();
  await expect(c.locator('.compose-attachments .attachment')).toHaveCount(1);
  await addRecipient(c, BOB);
  await typeBody(c, 'FYI');
  await sendAndWait(page, c);

  const forwarded = await waitFor(
    async () => (await emailsBySubject(subject, BOB)).find((e) => e.from?.[0]?.email === ALICE),
    20_000,
    'the forward in bob\'s mailbox',
  );
  const parts = await messageParts(forwarded.id, BOB);
  expect(inlineLeaf(parts)).toMatchObject({ cid, disposition: 'inline' });
  expect(parts.leaves.filter((l) => l.disposition === 'attachment').map((l) => l.name)).toEqual(['notes.txt']);
});
```

`emailsBySubject` returns `EmailInfo`; if it lacks `preview` or `from`, add those properties to its `Email/get` and to the `EmailInfo` interface in `e2e/support/mail.ts`. If the conversation's forward control is not a `Forward` button in `.reply-bar`, read `src/ui/Conversation.tsx` (`ReplyBar`) and use the control that is there.

- [ ] **Step 3: Run**

Run: `pnpm e2e e2e/inline-images.spec.ts`
Expected: 5 passed. A failure here is a fault in Tasks 1–7 until shown otherwise: fix the app, not the assertion. Two things to check first if the reply or forward test fails with a `blobNotFound` toast: that the conversation's `Email/get` asks for `attachments` (`FULL_PROPS` in `src/sync/engine.ts` does), and that the quote's `cid:` reached `quoteHtml` (log `c.draft()` in `initialDraft`).

Then the whole suite, since every outgoing message is now built differently:

Run: `pnpm e2e`
Expected: PASS, apart from the calendar tests already known to be flaky after 17:00 New York time.

- [ ] **Step 4: Changelog**

In `CHANGELOG.md`, add above `## 0.1.0-beta.1`:

```markdown
## Unreleased

### Added

- Images in the text of a message: paste one, drop it on the text, or use the toolbar's Insert image. It is sent as a real inline part, so other mail clients show it in place.
- A reply or a forward keeps the inline images of the message it quotes, and a forward carries the original's attachments.

### Fixed

- A draft with attachments that was reopened from Drafts could no longer be saved after its first save, and the failed save removed it from the server. Saving now creates the new version before it removes the old one.

### Known limits

- Pasting or dropping several images at once inserts the first only; the toolbar button takes several.
- Images cannot be resized, and are uploaded at their original size. Stalwart's default allows an account 50 MB of uploads an hour.
```

If the file already has an `## Unreleased` section, add these entries to it instead.

- [ ] **Step 5: Commit**

```bash
git add e2e/inline-images.spec.ts e2e/support/mail.ts e2e/support/compose.ts CHANGELOG.md
git commit -m "Inline images: end-to-end tests and changelog"
```
