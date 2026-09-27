import { createSignal, type Accessor } from 'solid-js';
import type { JmapClient } from '../jmap/client';
import type { Id, Identity } from '../jmap/types';
import { buildEmailCreate, initialDraft, type ComposeMode, type Draft, type DraftAttachment } from '../mail/compose';
import type { EmailRec, MailEngine } from '../sync/engine';
import type { ConfirmFn } from '../ui/ConfirmDialog';
import type { ToastFn } from './actions';

const AUTOSAVE_MS = 2000;
export const UNDO_SEND_MS = 10_000;

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

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
  draftId: () => Id | null;
}

/** Open composers plus the delayed-send queue. */
export function createComposers(engine: MailEngine, client: JmapClient, toast: ToastFn, confirm: ConfirmFn) {
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
    return (ids.find((i) => addressed.has(i.email.toLowerCase())) ?? ids[0]!).id;
  };

  interface Restore {
    draft: Draft;
    draftId: Id | null;
    identityId: Id | null;
    threadId?: Id | null;
    replyTo?: Id | null;
  }

  const create = (mode: ComposeMode, original: EmailRec | null, restore?: Restore): Composer => {
    const id = ++seq;
    const [draft, setDraft] = createSignal<Draft>(restore?.draft ?? initialDraft(mode, original, engine.myAddresses()));
    const [identityId, setIdentityId] = createSignal<Id | null>(restore?.identityId ?? defaultIdentity(original));
    const [status, setStatus] = createSignal<SaveStatus>(restore ? 'saved' : 'idle');
    const [uploading, setUploading] = createSignal(0);
    let draftId: Id | null = restore?.draftId ?? null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let saving: Promise<void> = Promise.resolve();

    const doSave = async () => {
      const identity = identities().find((i) => i.id === identityId());
      const drafts = engine.mailboxByRole('drafts')?.id;
      if (!identity || !drafts) return;
      setStatus('saving');
      try {
        const saved = await engine.saveDraft(buildEmailCreate(draft(), { name: identity.name || null, email: identity.email }, drafts), draftId);
        draftId = saved.id;
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
      timer = setTimeout(() => void save().catch(() => undefined), AUTOSAVE_MS);
    };

    const composer: Composer & { save: () => Promise<void>; cancelAutosave: () => void } = {
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
        scheduleSave();
      },
      status,
      uploading,
      attach: async (files) => {
        for (const file of [...files]) {
          setUploading((n) => n + 1);
          try {
            const r = await client.upload(file);
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
      draftId: () => draftId,
      save,
      cancelAutosave: () => clearTimeout(timer),
    };
    return composer;
  };

  const internals = (c: Composer) => c as Composer & { save: () => Promise<void>; cancelAutosave: () => void };

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
    remove(c);
    if (c.status() === 'dirty') {
      try {
        await internals(c).save();
        toast('Draft saved.');
      } catch (e) {
        toast(`Couldn't save draft: ${(e as Error).message}`, 'error');
      }
    }
  };

  const discard = async (c: Composer) => {
    const ok = await confirm({ title: 'Discard draft?', message: 'This draft will be permanently deleted.', confirmLabel: 'Discard' });
    if (!ok) return;
    remove(c);
    const id = c.draftId();
    if (id) await engine.destroyEmails([id]).catch(() => undefined);
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
      toast(`Couldn't send: ${(e as Error).message}`, 'error');
      return;
    }
    const draftId = c.draftId()!;
    const snapshot: Restore = { draft: d, draftId, identityId, threadId: c.threadId, replyTo: c.replyTo };
    remove(c);

    let cancelled = false;
    pendingSends.add(c.id);
    const timer = setTimeout(async () => {
      pendingSends.delete(c.id);
      if (cancelled) return;
      try {
        await engine.sendDraft(draftId, identityId);
        toast('Message sent.', 'success');
      } catch (e) {
        toast(`Sending failed: ${(e as Error).message}. The message is in Drafts.`, 'error');
      }
    }, UNDO_SEND_MS);

    toast('Sending…', 'info', {
      label: 'Undo',
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
    const draft: Draft = {
      mode: 'new',
      to: email.to ?? [],
      cc: email.cc ?? [],
      bcc: email.bcc ?? [],
      subject: email.subject ?? '',
      inReplyTo: email.inReplyTo ?? [],
      references: email.references ?? [],
      quoteHtml: '',
      bodyHtml: html || `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`,
      attachments: (email.attachments ?? []).filter((a) => a.blobId).map((a) => ({ blobId: a.blobId!, name: a.name ?? 'attachment', type: a.type, size: a.size })),
    };
    const identity = identities().find((i) => i.email.toLowerCase() === email.from?.[0]?.email.toLowerCase());
    const c = create('new', null, { draft, draftId: email.id, identityId: identity?.id ?? defaultIdentity(null) });
    setList([...list(), c]);
  };

  window.addEventListener('beforeunload', (e) => {
    if (pendingSends.size || list().some((c) => c.status() === 'dirty' || c.status() === 'saving')) e.preventDefault();
  });

  return { list, open, close, discard, send, openDraft, identities };
}

export type Composers = ReturnType<typeof createComposers>;
