import { createSignal, type Accessor } from 'solid-js';
import type { EmailAddress, Id, Identity } from '../jmap/types';
import { buildEmailCreate, initialDraft, splitDraftHtml, type ComposeMode, type Draft, type DraftAttachment } from '../mail/compose';
import { signatureForCompose } from '../mail/settings';
import { logUnexpected } from '../sync/connection';
import type { EmailRec, MailEngine } from '../sync/engine';
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
  }

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
      restore?.draft ?? { ...initialDraft(mode, original, engine.myAddresses()), signatureHtml: signatureOf(startIdentity) },
    );
    const [identityId, setIdentityId] = createSignal<Id | null>(startIdentity);
    const [signatureMode, setSignatureMode] = createSignal<SignatureMode>(restore?.signatureMode ?? 'auto');
    const [status, setStatus] = createSignal<SaveStatus>(restore ? 'saved' : 'idle');
    const [uploading, setUploading] = createSignal(0);
    const [draftId, setDraftId] = createSignal<Id | null>(restore?.draftId ?? null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let saving: Promise<void> = Promise.resolve();
    let unconfirmedSend = restore?.unconfirmedSend ?? false;

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
        const saved = await engine.saveDraft(buildEmailCreate(draft(), { name: identity.name || null, email: identity.email }, drafts), draftId() ? [draftId()!] : []);
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

    const scheduleSave = () => {
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
      draftId,
      save,
      cancelAutosave: () => clearTimeout(timer),
      signatureMode,
      markDirty: scheduleSave,
      wasSent: async () => unconfirmedSend && !!draftId() && (await engine.draftState(draftId()!)) === 'sent',
      snapshot: () => ({ mode, draft: draft(), draftId: draftId(), identityId: identityId(), threadId: composer.threadId, replyTo: composer.replyTo, signatureMode: signatureMode() }),
    };
    return composer;
  };

  const internals = (c: Composer) => c as Internal;

  const remove = (c: Composer) => {
    internals(c).cancelAutosave();
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
    remove(c);
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
    const ok = await confirm({ title: 'Discard draft?', message: 'This draft will be permanently deleted.', confirmLabel: 'Discard' });
    if (!ok) return;
    // After a send that may have gone through, the "draft" can be the copy in Sent: leave it be.
    if (await internals(c).wasSent().catch(() => false)) {
      remove(c);
      toast('Message sent.', 'success');
      return;
    }
    remove(c);
    const id = c.draftId();
    if (id) await engine.destroyEmails([id]).catch(logUnexpected);
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
    const snapshot: Restore = { draft: d, draftId, identityId, threadId: c.threadId, replyTo: c.replyTo, signatureMode: internals(c).signatureMode() };
    remove(c);

    let cancelled = false;
    pendingSends.add(c.id);
    const timer = setTimeout(async () => {
      pendingSends.delete(c.id);
      if (cancelled) return;
      try {
        await engine.sendDraft(draftId, identityId);
        onSent(draftId, [...d.to, ...d.cc, ...d.bcc]);
        toast('Message sent.', 'success');
      } catch {
        // The request may have reached the server even though we saw it fail.
        const state = await engine.draftState(draftId).catch(() => null);
        if (state === 'sent') {
          onSent(draftId, [...d.to, ...d.cc, ...d.bcc]);
          toast('Message sent.', 'success');
          return;
        }
        // Still a draft for now, perhaps: the submission may be in flight yet, so check again before any save.
        const reopened = create(c.mode, null, { ...snapshot, draftId: state === 'gone' ? null : draftId, unconfirmedSend: state !== 'gone' });
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
        setList([...list(), create(c.mode, null, snapshot)]);
        toast('Sending undone.');
      },
    });
  };

  /** Reopen a saved draft from the Drafts mailbox. */
  const openDraft = (email: EmailRec) => {
    const values = email.bodyValues ?? {};
    const html = (email.htmlBody ?? []).filter((p) => p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('');
    const text = (email.textBody ?? []).filter((p) => p.partId && values[p.partId]).map((p) => values[p.partId!]!.value).join('\n');
    const parts = html ? splitDraftHtml(html) : { bodyHtml: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`, signatureHtml: '', quoteHtml: '' };
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
      attachments: (email.attachments ?? []).filter((a) => a.blobId).map((a) => ({ blobId: a.blobId!, name: a.name ?? 'attachment', type: a.type, size: a.size })),
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
