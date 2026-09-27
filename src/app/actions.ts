import type { ConfirmFn } from '../ui/ConfirmDialog';
import type { Id } from '../jmap/types';
import type { EmailRec, MailEngine } from '../sync/engine';
import { archivePatch, keywordPatch, movePatch, trashPatch, type EmailPatch } from '../sync/patch';
import type { View } from '../sync/selectors';

export interface ToastFn {
  (message: string, type?: 'info' | 'success' | 'error', action?: { label: string; run: () => void }): void;
}

/** Thread-level triage actions, Gmail semantics. Archive/trash/spam confirm first; the rest are optimistic with Undo. */
export function createActions(engine: MailEngine, toast: ToastFn, confirm: ConfirmFn) {
  const conversations = (n: number) => (n === 1 ? 'Conversation' : `${n} conversations`);

  /** Run a mailbox-changing patch; offer Undo that restores each email's previous mailboxes. */
  const moveWithUndo = async (emails: EmailRec[], patches: Record<Id, EmailPatch>, done: string) => {
    const prev = new Map(emails.map((e) => [e.id, { ...(e.mailboxIds ?? {}) }]));
    try {
      await engine.updateEmails(patches);
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`, 'error');
      return;
    }
    toast(done, 'info', {
      label: 'Undo',
      run: () => {
        const undo: Record<Id, EmailPatch> = {};
        for (const id of Object.keys(patches)) undo[id] = { mailboxIds: prev.get(id) ?? {} };
        engine.updateEmails(undo).catch((e) => toast(`Couldn't undo: ${(e as Error).message}`, 'error'));
      },
    });
  };

  /** Run a mailbox-changing patch after a confirm step; no Undo (confirm is the safety net). Resolves whether it applied. */
  const moveConfirmed = async (patches: Record<Id, EmailPatch>, done: string): Promise<boolean> => {
    try {
      await engine.updateEmails(patches);
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`, 'error');
      return false;
    }
    toast(done, 'success');
    return true;
  };

  const keywords = async (threadIds: Id[], keyword: string, on: boolean, emails?: EmailRec[]) => {
    try {
      await engine.updateEmails(keywordPatch(emails ?? engine.threadEmails(threadIds), keyword, on));
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`, 'error');
    }
  };

  const role = (r: string) => engine.mailboxByRole(r)?.id;

  return {
    /** Resolves `true` once the archive actually applied (`false` if cancelled, blocked, or failed). */
    async archive(threadIds: Id[]): Promise<boolean> {
      const inbox = role('inbox');
      if (!inbox || !threadIds.length) return false;
      const n = conversations(threadIds.length);
      const ok = await confirm({ title: `Archive ${n.toLowerCase()}?`, message: `${n} will be removed from the inbox.`, confirmLabel: 'Archive' });
      if (!ok) return false;
      let archive: Id;
      try {
        archive = await engine.ensureMailbox('archive', 'Archive');
      } catch (e) {
        toast((e as Error).message, 'error');
        return false;
      }
      const emails = engine.threadEmails(threadIds);
      return moveConfirmed(archivePatch(emails, inbox, archive), `${n} archived.`);
    },

    /** Resolves `true` once the move to Trash actually applied (`false` if cancelled, blocked, or failed). */
    async trash(threadIds: Id[]): Promise<boolean> {
      const trash = role('trash');
      if (!trash || !threadIds.length) return false;
      const n = conversations(threadIds.length);
      const ok = await confirm({ title: `Delete ${n.toLowerCase()}?`, message: `${n} will be moved to Trash.`, confirmLabel: 'Delete' });
      if (!ok) return false;
      const emails = engine.threadEmails(threadIds);
      return moveConfirmed(trashPatch(emails, trash), `${n} moved to Trash.`);
    },

    /** Resolves `true` once the spam report actually applied (`false` if cancelled, blocked, or failed). */
    async spam(threadIds: Id[]): Promise<boolean> {
      const junk = role('junk');
      if (!junk || !threadIds.length) return false;
      const n = conversations(threadIds.length);
      const ok = await confirm({ title: `Report ${n.toLowerCase()} as spam?`, message: `${n} will be moved to Spam.`, confirmLabel: 'Report spam' });
      if (!ok) return false;
      const emails = engine.threadEmails(threadIds);
      return moveConfirmed(trashPatch(emails, junk), `${n} marked as spam.`);
    },

    /** Move out of the current view's mailbox (Inbox when the view isn't a mailbox) into `to`. */
    moveTo(threadIds: Id[], view: View, to: Id) {
      if (!threadIds.length) return;
      const from = view.mailboxId ?? role('inbox') ?? null;
      const emails = engine.threadEmails(threadIds);
      const name = engine.state.mailboxes[to]?.name ?? 'mailbox';
      void moveWithUndo(emails, movePatch(emails, from, to), `${conversations(threadIds.length)} moved to "${name}".`);
    },

    addLabel(threadIds: Id[], label: Id) {
      const emails = engine.threadEmails(threadIds);
      const name = engine.state.mailboxes[label]?.name ?? 'label';
      void moveWithUndo(emails, movePatch(emails, null, label), `Labeled "${name}".`);
    },

    markRead: (threadIds: Id[]) => keywords(threadIds, '$seen', true),
    markUnread: (threadIds: Id[]) => keywords(threadIds, '$seen', false),

    /** Gmail: starring a thread stars its latest message; unstarring clears every star. */
    toggleStar(threadIds: Id[]) {
      const emails = engine.threadEmails(threadIds);
      const starred = emails.some((e) => e.keywords?.$flagged);
      if (starred) return keywords(threadIds, '$flagged', false);
      const latest = threadIds
        .map((tid) => engine.threadEmails([tid]).sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))[0])
        .filter((e): e is EmailRec => !!e);
      return keywords(threadIds, '$flagged', true, latest);
    },
  };
}

export type Actions = ReturnType<typeof createActions>;
