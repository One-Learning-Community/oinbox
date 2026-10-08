import { createSignal } from 'solid-js';
import type { Id } from '../jmap/types';
import type { View } from '../sync/selectors';

/** What the thread list exposes to keyboard shortcuts and toolbars. */
export interface ListHandle {
  view: View;
  count: () => number;
  threadIdAt: (index: number) => Id | null;
  indexOfThread: (threadId: Id) => number;
  scrollToIndex: (index: number) => void;
  /** Give the cursor row the keyboard focus, unless the user is in some other control. */
  focusCursor: () => void;
}

export type PickerKind = 'move' | 'label';
export type LabelDialogState = { kind: 'create' } | { kind: 'rename'; id: Id };

/**
 * What a mail route shows while it has no view. A label route never says "not found": on a warm
 * start the label may be newer than the snapshot, and once synced a missing label redirects.
 */
export function missingViewText(labelRoute: boolean, ready: boolean): string {
  return ready && !labelRoute ? 'Mailbox not found.' : 'Loading…';
}

/** Shared UI navigation state: cursor, selection, the open thread, and overlays. */
export function createNav() {
  const [cursor, setCursor] = createSignal(0);
  const [selected, setSelected] = createSignal<ReadonlySet<Id>>(new Set());
  const [list, setList] = createSignal<ListHandle | null>(null);
  const [openThread, setOpenThread] = createSignal<Id | null>(null);
  const [picker, setPicker] = createSignal<{ kind: PickerKind; threadIds: Id[] } | null>(null);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [labelDialog, setLabelDialog] = createSignal<LabelDialogState | null>(null);

  /**
   * A thread list for `key` is on screen. The list component is created again on every route
   * change, so it is the key, not the component, that says whether this is a different list.
   */
  let listKey: string | null = null;
  const enterList = (key: string) => {
    if (key === listKey) return;
    listKey = key;
    setCursor(0);
    setSelected(new Set<Id>());
  };

  const toggleSelected = (id: Id) => {
    const next = new Set(selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  /** Threads an action applies to: the open thread, else the selection, else the cursor row. */
  const targets = (): Id[] => {
    const open = openThread();
    if (open) return [open];
    // A selection only counts while its list is on screen (not, say, on /calendar).
    if (selected().size && list()) return [...selected()];
    const id = list()?.threadIdAt(cursor());
    return id ? [id] : [];
  };

  return {
    cursor,
    setCursor,
    enterList,
    selected,
    setSelected,
    toggleSelected,
    clearSelection: () => setSelected(new Set<Id>()),
    list,
    setList,
    openThread,
    setOpenThread,
    targets,
    picker,
    setPicker,
    helpOpen,
    setHelpOpen,
    labelDialog,
    setLabelDialog,
  };
}

export type Nav = ReturnType<typeof createNav>;
