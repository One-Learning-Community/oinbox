import type { Id } from '../jmap/types';
import type { EmailRec, MailEngine } from '../sync/engine';
import { archivePatch, keywordPatch, movePatch, trashPatch, type EmailPatch } from '../sync/patch';
import type { View } from '../sync/selectors';

export interface ToastFn {
  (message: string, type?: 'info' | 'success' | 'error', action?: { label: string; run: () => void }): void;
}

/** Thread-level triage actions, Gmail semantics, optimistic with Undo. */
export function createActions(engine: MailEngine, toast: ToastFn) {
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

  const keywords = async (threadIds: Id[], keyword: string, on: boolean, emails?: EmailRec[]) => {
    try {
      await engine.updateEmails(keywordPatch(emails ?? engine.threadEmails(threadIds), keyword, on));
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`, 'error');
    }
  };

  const role = (r: string) => engine.mailboxByRole(r)?.id;

  return {
    async archive(threadIds: Id[]) {
      const inbox = role('inbox');
      if (!inbox || !threadIds.length) return;
      let archive: Id;
      try {
        archive = await engine.ensureMailbox('archive', 'Archive');
      } catch (e) {
        toast((e as Error).message, 'error');
        return;
      }
      const emails = engine.threadEmails(threadIds);
      await moveWithUndo(emails, archivePatch(emails, inbox, archive), `${conversations(threadIds.length)} archived.`);
    },

    trash(threadIds: Id[]) {
      const trash = role('trash');
      if (!trash || !threadIds.length) return;
      const emails = engine.threadEmails(threadIds);
      void moveWithUndo(emails, trashPatch(emails, trash), `${conversations(threadIds.length)} moved to Trash.`);
    },

    spam(threadIds: Id[]) {
      const junk = role('junk');
      if (!junk || !threadIds.length) return;
      const emails = engine.threadEmails(threadIds);
      void moveWithUndo(emails, trashPatch(emails, junk), `${conversations(threadIds.length)} marked as spam.`);
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
