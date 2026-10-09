import { createSignal, type Accessor } from 'solid-js';
import type { EmailAddress, Id, Identity } from '../jmap/types';
import { blobIdChanges, buildEmailCreate, draftHtml, initialDraft, referencedCids, splitDraftHtml, splitParts, withBlobIds, type ComposeMode, type Draft, type DraftAttachment, type InlineImage } from '../mail/compose';
import { signatureForCompose } from '../mail/settings';
import { logUnexpected } from '../sync/connection';
import { DraftSaveError, type EmailRec, type MailEngine, type SavedDraft } from '../sync/engine';
import type { ConfirmFn } from '../ui/ConfirmDialog';
import type { ToastFn } from './actions';

const AUTOSAVE_MS = 2000;
export const UNDO_SEND_MS = 10_000;

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** auto: follows From. removed / inline: the user took it out, or into the text; From no longer touches it. */
export type SignatureMode = 'auto' | 'removed' | 'inline';

/** A composer's content, enough to open it again: after a failed send, or after signing in again. */
export interface RescuedComposer {
  mode: ComposeMode;
  draft: Draft;
  draftId: Id | null;
  identityId: Id | null;
  threadId: Id | null;
  replyTo: Id | null;
  signatureMode: SignatureMode;
}

/** The draft this composer was about to save has been sent already: there is nothing left to save or send. */
class AlreadySentError extends Error {}

export interface Composer {
  id: number;
  mode: ComposeMode;
  /** Set for inline replies/forwards: the conversation they belong to. */
  threadId: Id | null;
  replyTo: Id | null;
  draft: Accessor<Draft>;
  update: (patch: Partial<Draft>) => void;
  identityId: Accessor<Id | null>;
  setIdentityId: (id: Id) => void;
  status: Accessor<SaveStatus>;
  uploading: Accessor<number>;
  attach: (files: FileList | File[]) => Promise<void>;
  removeAttachment: (blobId: string) => void;
  /** Upload an image and remember it; resolves to the object URL to show it with. Rejects after telling the user. */
  insertImage: (file: File) => Promise<string>;
  /** Content id to object URL, for the images that have been loaded. */
  imageUrls: Accessor<Record<string, string>>;
  /** False while images the text itself refers to are still being fetched. */
  imagesReady: Accessor<boolean>;
  /** Resolves once every image of the draft has been fetched or has failed. */
  loadImages: () => Promise<void>;
  /** Id of the saved draft email, if any. */
  draftId: Accessor<Id | null>;
  removeSignature: () => void;
  /** Put the signature into the text. `bodyHtml` is the editor's HTML with the signature appended. */
  inlineSignature: (bodyHtml: string) => void;
}

/** Open composers plus the delayed-send queue. */
export function createComposers(
  engine: MailEngine,
  toast: ToastFn,
  confirm: ConfirmFn,
  /** Called once a message has been submitted, with everyone it went to. */
  onSent: (emailId: Id, recipients: EmailAddress[]) => void,
  /** Registers a callback for when the server can be reached again. */
  onRecovered?: (fn: () => void) => void,
  /** What discarding a draft means for files it has in Drive (app/driveLinks.ts). */
  drive?: { discardNote: (c: Composer) => string | null; discarded: (c: Composer) => void; reopened?: (from: Composer, to: Composer) => void },
) {
  const [list, setList] = createSignal<Composer[]>([]);
  let seq = 0;
  /** Sends waiting out the undo window, so we can warn before the tab closes. */
  const pendingSends = new Set<number>();

  const identities = (): Identity[] => engine.state.identities;

  const defaultIdentity = (original: EmailRec | null): Id | null => {
    const ids = identities();
    if (!ids.length) return null;
    // Reply from whichever of my addresses the message was sent to.
    const addressed = new Set([...(original?.to ?? []), ...(original?.cc ?? [])].map((a) => a.email.toLowerCase()));
    // Otherwise the mailbox's own address, not whichever identity the server lists first: a member
    // of a group has the group's address as an identity too, and must not write as it by default.
    const own = engine.accountAddress.toLowerCase();
    return (ids.find((i) => addressed.has(i.email.toLowerCase())) ?? ids.find((i) => i.email.toLowerCase() === own) ?? ids[0]!).id;
  };

  const signatureOf = (id: Id | null): string => {
    const identity = identities().find((i) => i.id === id);
    return identity ? signatureForCompose(identity) : '';
  };

  type Internal = Composer & {
    save: () => Promise<void>;
    cancelAutosave: () => void;
    signatureMode: () => SignatureMode;
    markDirty: () => void;
    /** True when an earlier send of this draft turns out to have reached the server. */
    wasSent: () => Promise<boolean>;
    snapshot: () => RescuedComposer;
    /** Older versions of the draft that a save could not confirm as removed. */
    staleIds: () => Id[];
    releaseImages: () => void;
    /** After this, edits no longer schedule a save: a late one would bring the draft back. */
    retire: () => void;
  };

  interface Restore {
    draft: Draft;
    draftId: Id | null;
    identityId: Id | null;
    threadId?: Id | null;
    replyTo?: Id | null;
    signatureMode?: SignatureMode;
    /** A send of `draftId` failed and we could not find out whether it reached the server. */
    unconfirmedSend?: boolean;
    /** Older versions still on the server: the next save removes them. */
    stale?: Id[];
  }

  /** Remove draft versions left behind, best effort: a version that is not found is already gone. */
  const dropStale = (ids: Id[]): Promise<void> => (ids.length ? engine.destroyEmails(ids).catch(logUnexpected) : Promise.resolve());

  /** An autosave found that the message went out after all: edits made since then have nowhere to go. */
  const sentMeanwhile = (c: Composer) => {
    remove(c);
    const d = c.draft();
    if (c.draftId()) onSent(c.draftId()!, [...d.to, ...d.cc, ...d.bcc]);
    toast('This message had already been sent, so your latest changes were not included.', 'info');
  };

  const create = (mode: ComposeMode, original: EmailRec | null, restore?: Restore): Composer => {
    const id = ++seq;
    const startIdentity = restore?.identityId ?? defaultIdentity(original);
    const [draft, setDraft] = createSignal<Draft>(
      restore?.draft ? { ...restore.draft, inline: restore.draft.inline ?? [] } : { ...initialDraft(mode, original, engine.myAddresses()), signatureHtml: signatureOf(startIdentity) },
    );
    const [identityId, setIdentityId] = createSignal<Id | null>(startIdentity);
    const [signatureMode, setSignatureMode] = createSignal<SignatureMode>(restore?.signatureMode ?? 'auto');
    const [status, setStatus] = createSignal<SaveStatus>(restore ? 'saved' : 'idle');
    const [uploading, setUploading] = createSignal(0);
    const [draftId, setDraftId] = createSignal<Id | null>(restore?.draftId ?? null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let saving: Promise<void> = Promise.resolve();
    let unconfirmedSend = restore?.unconfirmedSend ?? false;
    /** Older versions a save could not confirm as removed; the next save takes them along. */
    let stale: Id[] = restore?.stale ?? [];

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

    const doSave = async () => {
      const identity = identities().find((i) => i.id === identityId());
      const drafts = engine.mailboxByRole('drafts')?.id;
      if (!identity || !drafts) return;
      setStatus('saving');
      try {
        if (unconfirmedSend && draftId()) {
          // The last send may have gone through, and saving replaces the draft: that would destroy the sent copy.
          const state = await engine.draftState(draftId()!);
          if (state === 'sent') {
            // Stop here for good: there is no draft left to save to.
            clearTimeout(timer);
            throw new AlreadySentError();
          }
          if (state === 'gone') setDraftId(null);
          unconfirmedSend = false;
        }
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
      } catch (e) {
        setStatus('error');
        throw e;
      }
    };

    /** Serialize saves so versions never race each other. */
    const save = () => {
      clearTimeout(timer);
      saving = saving.catch(() => undefined).then(doSave);
      return saving;
    };

    let retired = false;
    const scheduleSave = () => {
      // An image fetch or upload that was pending when the composer went can still edit it.
      if (retired) return;
      setStatus('dirty');
      clearTimeout(timer);
      timer = setTimeout(() => void save().catch((e) => e instanceof AlreadySentError && sentMeanwhile(composer)), AUTOSAVE_MS);
    };

    const composer: Internal = {
      id,
      mode,
      threadId: restore?.threadId ?? original?.threadId ?? null,
      replyTo: restore?.replyTo ?? original?.id ?? null,
      draft,
      update: (patch) => {
        setDraft({ ...draft(), ...patch });
        scheduleSave();
      },
      identityId,
      setIdentityId: (v) => {
        setIdentityId(v);
        if (signatureMode() === 'auto') setDraft({ ...draft(), signatureHtml: signatureOf(v) });
        scheduleSave();
      },
      removeSignature: () => {
        setSignatureMode('removed');
        setDraft({ ...draft(), signatureHtml: '' });
        scheduleSave();
      },
      inlineSignature: (bodyHtml) => {
        setSignatureMode('inline');
        setDraft({ ...draft(), bodyHtml, signatureHtml: '' });
        scheduleSave();
      },
      status,
      uploading,
      attach: async (files) => {
        for (const file of [...files]) {
          setUploading((n) => n + 1);
          try {
            const r = await engine.upload(file);
            const att: DraftAttachment = { blobId: r.blobId, name: file.name, type: file.type || r.type, size: file.size };
            setDraft({ ...draft(), attachments: [...draft().attachments, att] });
            scheduleSave();
          } catch (e) {
            toast(`Couldn't attach ${file.name}: ${(e as Error).message}`, 'error');
          } finally {
            setUploading((n) => n - 1);
          }
        }
      },
      removeAttachment: (blobId) => {
        setDraft({ ...draft(), attachments: draft().attachments.filter((a) => a.blobId !== blobId) });
        scheduleSave();
      },
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
      draftId,
      save,
      cancelAutosave: () => clearTimeout(timer),
      signatureMode,
      markDirty: scheduleSave,
      retire: () => {
        retired = true;
      },
      staleIds: () => stale.filter((x) => x !== draftId()),
      wasSent: async () => unconfirmedSend && !!draftId() && (await engine.draftState(draftId()!)) === 'sent',
      snapshot: () => ({ mode, draft: draft(), draftId: draftId(), identityId: identityId(), threadId: composer.threadId, replyTo: composer.replyTo, signatureMode: signatureMode() }),
    };
    return composer;
  };

  const internals = (c: Composer) => c as Internal;

  const remove = (c: Composer) => {
    internals(c).retire();
    internals(c).cancelAutosave();
    internals(c).releaseImages();
    setList(list().filter((x) => x.id !== c.id));
  };

  const open = (mode: ComposeMode, original: EmailRec | null = null): Composer => {
    // One inline composer per conversation, like Gmail.
    const existing = original ? list().find((c) => c.threadId === original.threadId && c.mode !== 'new') : undefined;
    if (existing) return existing;
    const c = create(mode, original);
    setList([...list(), c]);
    return c;
  };

  /** Close, keeping the saved draft (Gmail's "Save & close"). */
  const close = async (c: Composer) => {
    if (c.status() === 'dirty' || c.status() === 'error') {
      try {
        await internals(c).save();
      } catch (e) {
        if (!(e instanceof AlreadySentError)) {
          // Closing now would throw the unsaved text away: that is the user's call, not ours.
          const ok = await confirm({ title: 'Close without saving?', message: "The draft couldn't be saved, so your latest changes will be lost.", confirmLabel: 'Close anyway' });
          if (!ok) return;
        }
        remove(c);
        return;
      }
      toast('Draft saved.');
    }
    const stale = internals(c).staleIds();
    remove(c);
    await dropStale(stale);
  };

  /** Try a failed save again (the Retry button, and by itself when the connection returns). */
  const retrySave = (c: Composer) => void internals(c).save().catch(() => undefined);
  onRecovered?.(() => {
    for (const c of list()) if (c.status() === 'error') retrySave(c);
  });

  /** Composers holding text the server doesn't have yet. */
  const snapshot = (): RescuedComposer[] =>
    list().filter((c) => c.status() !== 'idle' && c.status() !== 'saved').map((c) => internals(c).snapshot());

  /** Reopen rescued composers; each saves as soon as it can. */
  const restore = (items: RescuedComposer[]) => {
    const reopened = items.map((r) => create(r.mode, null, r));
    setList([...list(), ...reopened]);
    for (const c of reopened) internals(c).markDirty();
  };

  const discard = async (c: Composer) => {
    const note = drive?.discardNote(c);
    const ok = await confirm({ title: 'Discard draft?', message: `This draft will be permanently deleted.${note ? ` ${note}` : ''}`, confirmLabel: 'Discard' });
    if (!ok) return;
    // After a send that may have gone through, the "draft" can be the copy in Sent: leave it be.
    const stale = internals(c).staleIds();
    if (await internals(c).wasSent().catch(() => false)) {
      remove(c);
      await dropStale(stale);
      toast('Message sent.', 'success');
      return;
    }
    remove(c);
    // Only here: a message that turned out to have been sent keeps its files.
    drive?.discarded(c);
    const id = c.draftId();
    await dropStale(id ? [id, ...stale] : stale);
    toast('Draft discarded.');
  };

  /** Save now, close the composer, send after the undo window. */
  const send = async (c: Composer) => {
    const d = c.draft();
    if (![...d.to, ...d.cc, ...d.bcc].length) {
      toast('Please specify at least one recipient.', 'error');
      return;
    }
    const identityId = c.identityId();
    if (!identityId) {
      toast('No sending identity is configured for this account.', 'error');
      return;
    }
    if (c.uploading() > 0) {
      toast('Wait for attachments to finish uploading.', 'error');
      return;
    }
    try {
      await internals(c).save();
    } catch (e) {
      if (e instanceof AlreadySentError) {
        remove(c);
        toast('Message sent.', 'success');
        return;
      }
      toast("Couldn't send. Your message is still here.", 'error', { label: 'Retry', run: () => void send(c) });
      return;
    }
    const draftId = c.draftId()!;
    // After the save: the draft now names the stored version's blobs.
    const saved = c.draft();
    const stale = internals(c).staleIds();
    const snapshot: Restore = { draft: saved, draftId, identityId, threadId: c.threadId, replyTo: c.replyTo, signatureMode: internals(c).signatureMode(), stale };
    remove(c);

    let cancelled = false;
    pendingSends.add(c.id);
    const timer = setTimeout(async () => {
      pendingSends.delete(c.id);
      if (cancelled) return;
      try {
        await engine.sendDraft(draftId, identityId);
        onSent(draftId, [...saved.to, ...saved.cc, ...saved.bcc]);
        toast('Message sent.', 'success');
      } catch {
        // The request may have reached the server even though we saw it fail.
        const state = await engine.draftState(draftId).catch(() => null);
        if (state === 'sent') {
          onSent(draftId, [...saved.to, ...saved.cc, ...saved.bcc]);
          toast('Message sent.', 'success');
          return;
        }
        // Still a draft for now, perhaps: the submission may be in flight yet, so check again before any save.
        const reopened = create(c.mode, null, { ...snapshot, draftId: state === 'gone' ? null : draftId, unconfirmedSend: state !== 'gone' });
        drive?.reopened?.(c, reopened);
        setList([...list(), reopened]);
        toast("Couldn't send. Your message is still here.", 'error', { label: 'Retry', run: () => void send(reopened) });
      }
    }, UNDO_SEND_MS);

    toast('Sending…', 'info', {
      label: 'Undo',
      forMs: UNDO_SEND_MS,
      run: () => {
        cancelled = true;
        clearTimeout(timer);
        pendingSends.delete(c.id);
        const back = create(c.mode, null, snapshot);
        // The message is the same one: files it has in Drive are still its own.
        drive?.reopened?.(c, back);
        setList([...list(), back]);
        toast('Sending undone.');
      },
    });
    // Older versions would look like unsent copies of this message. If they stay, a restored composer takes them along.
    if (stale.length) {
      const failed = await engine.destroyEmails(stale).then(() => false, (e) => (logUnexpected(e), true));
      if (!failed) snapshot.stale = [];
    }
  };

  /** Reopen a saved draft from the Drafts mailbox. */
  const openDraft = (email: EmailRec) => {
    const values = email.bodyValues ?? {};
    const html = (email.htmlBody ?? []).filter((p) => p.type === 'text/html' && p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('');
    const text = (email.textBody ?? []).filter((p) => p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('\n');
    const parts = html ? splitDraftHtml(html) : { bodyHtml: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`, signatureHtml: '', quoteHtml: '' };
    const stored = splitParts(html, email.attachments ?? []);
    const draft: Draft = {
      mode: 'new',
      to: email.to ?? [],
      cc: email.cc ?? [],
      bcc: email.bcc ?? [],
      subject: email.subject ?? '',
      inReplyTo: email.inReplyTo ?? [],
      references: email.references ?? [],
      quoteHtml: parts.quoteHtml,
      signatureHtml: parts.signatureHtml,
      bodyHtml: parts.bodyHtml,
      attachments: stored.attachments,
      inline: stored.inline,
    };
    const identity = identities().find((i) => i.email.toLowerCase() === email.from?.[0]?.email.toLowerCase());
    const identityId = identity?.id ?? defaultIdentity(null);
    // Without a block there is nothing to say whether it was removed or never there: an identity with a signature means removed.
    const c = create('new', null, { draft, draftId: email.id, identityId, signatureMode: parts.signatureHtml || !signatureOf(identityId) ? 'auto' : 'removed' });
    setList([...list(), c]);
  };

  window.addEventListener('beforeunload', (e) => {
    if (pendingSends.size || list().some((c) => c.status() === 'dirty' || c.status() === 'saving')) e.preventDefault();
  });

  return { list, open, close, discard, send, openDraft, identities, retrySave, snapshot, restore };
}

export type Composers = ReturnType<typeof createComposers>;
