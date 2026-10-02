import { createSignal } from 'solid-js';
import type { Id } from '../jmap/types';
import { planLabel, type LabelLimits, type PlanResult } from '../mail/labels';
import { LabelHasSubLabelsError, type MailEngine } from '../sync/engine';
import { labelPath, subLabelCount } from '../sync/selectors';
import type { ConfirmFn } from '../ui/ConfirmDialog';
import type { ToastFn } from './actions';

/** The confirm text for deleting a label, counted in messages. `orphans` is null while the count isn't known. */
export function deleteMessage(total: number, orphans: number | null): string {
  if (total === 0) return 'This label is empty.';
  const kept = `Its ${total} message${total === 1 ? ' stays' : 's stay'} in your mail.`;
  if (orphans === null) return `${kept} Any that are only in this label move to Archive.`;
  if (orphans === 0) return kept;
  return `${kept} ${orphans} that ${orphans === 1 ? 'is' : 'are'} only in this label move${orphans === 1 ? 's' : ''} to Archive.`;
}

/** Creating, renaming and deleting labels: validation, confirmation and toasts around the engine. */
export function createLabels(engine: MailEngine, toast: ToastFn, confirm: ConfirmFn, limits: () => LabelLimits) {
  const deleted = new Set<Id>();
  const validate = (path: string, renaming?: Id): PlanResult => planLabel(path, engine.state.mailboxes, limits(), renaming);

  return {
    validate,

    /** True for a label deleted in this session: its view closes without the "no longer exists" notice. */
    deletedHere: (id: Id) => deleted.has(id),

    /** Throws the validation or server message. `quiet` skips the toast (the pickers show their own). */
    async create(path: string, opts: { quiet?: boolean } = {}): Promise<Id> {
      const r = validate(path);
      if (!r.ok) throw new Error(r.error);
      const id = await engine.createLabel(r.plan);
      if (!opts.quiet) toast(`Created '${r.path}'.`, 'success');
      return id;
    },

    /** Throws the validation or server message. */
    async rename(id: Id, path: string): Promise<void> {
      const mb = engine.state.mailboxes[id];
      if (!mb) throw new Error('That label no longer exists.');
      if (mb.role) throw new Error(`'${mb.name}' is a system mailbox.`);
      const r = validate(path, id);
      if (!r.ok) throw new Error(r.error);
      if (r.noop) return;
      await engine.updateLabel(id, r.plan);
      toast(`Renamed to '${r.path}'.`, 'success');
    },

    /** Confirm, then delete. Resolves whether the label was deleted. */
    async remove(id: Id): Promise<boolean> {
      const mb = engine.state.mailboxes[id];
      if (!mb || mb.role || subLabelCount(id, engine.state.mailboxes) > 0) return false;
      const path = labelPath(mb, engine.state.mailboxes);
      const total = mb.totalEmails;
      // The count only improves the wording: the dialog opens without it and fills it in.
      const [orphans, setOrphans] = createSignal<number | null>(null);
      let started = false;
      void engine.countOrphans(id).then((n) => !started && setOrphans(n), () => undefined);
      try {
        const ok = await confirm({
          title: `Delete '${path}'?`,
          message: () => deleteMessage(total, orphans()),
          confirmLabel: 'Delete',
          pendingLabel: 'Deleting…',
          run: async () => {
            // From here the count would describe a label that is already being emptied.
            started = true;
            // Before the store drops the mailbox, so its view knows why it disappeared.
            deleted.add(id);
            try {
              await engine.destroyLabel(id);
            } catch (e) {
              deleted.delete(id);
              throw e;
            }
          },
        });
        if (!ok) return false;
      } catch (e) {
        if (e instanceof LabelHasSubLabelsError) toast(`Couldn't delete '${path}': it has sub-labels. Delete those first.`, 'error');
        else toast(`Couldn't finish deleting '${path}'. Some conversations may already have been removed from it; try again. (${(e as Error).message})`, 'error');
        return false;
      }
      toast(`Deleted '${path}'.`, 'success');
      return true;
    },
  };
}

export type Labels = ReturnType<typeof createLabels>;
