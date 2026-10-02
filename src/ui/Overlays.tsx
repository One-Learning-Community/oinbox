import { CommandPalette } from '@rozie-ui/command-palette-solid';
import '@rozie-ui/command-palette-solid/themes/base.css';
import { Dialog } from '@rozie-ui/dialog-solid';
import { useLocation } from '@solidjs/router';
import { createMemo, createSignal, For } from 'solid-js';
import { useApp } from '../app/context';
import type { Id } from '../jmap/types';
import { labelPath, resolveView } from '../sync/selectors';
import { SHORTCUTS } from './keyboard';
import { pickerScore } from './picker';

/** The id of the picker row that creates the typed label. */
const CREATE = '\u0000create';

interface PickerItem {
  id: string;
  label: string;
  group: string;
  /** For the Create row: the path to create. */
  create?: string;
}

/** "Move to" (v) and "Label" (l) pickers, Gmail-style type-to-filter lists. */
export function MailboxPicker() {
  const { engine, nav, actions, labels, toast } = useApp();
  const location = useLocation();
  const [query, setQuery] = createSignal('');

  const current = () => {
    const m = /^\/(label\/[^/]+|[^/]+)/.exec(location.pathname);
    return m ? resolveView(decodeURIComponent(m[1]!), engine.state.mailboxes) : null;
  };

  const items = createMemo<PickerItem[]>(() => {
    const p = nav.picker();
    if (!p) return [];
    const exclude = new Set(['drafts', 'flagged', ...(p.kind === 'label' ? ['inbox', 'sent', 'trash', 'junk', 'archive'] : ['sent'])]);
    const list: PickerItem[] = Object.values(engine.state.mailboxes)
      .filter((m) => !(m.role && exclude.has(m.role)) && m.id !== current()?.mailboxId)
      .map((m) => ({
        id: m.id,
        label: m.role === 'inbox' ? 'Inbox' : labelPath(m, engine.state.mailboxes),
        group: m.role ? 'System' : 'Labels',
      }))
      .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group === 'System' ? -1 : 1));
    // Typed text that is a valid new label (so not an existing path) can be created on the spot.
    const typed = query().trim();
    const plan = typed ? labels.validate(typed) : null;
    if (plan?.ok) list.push({ id: CREATE, label: `Create '${plan.path}'`, group: 'New', create: typed });
    return list;
  });

  const close = () => {
    nav.setPicker(null);
    setQuery('');
  };

  return (
    <CommandPalette
      open={!!nav.picker()}
      onOpenChange={(open) => !open && close()}
      query={query()}
      onQueryChange={setQuery}
      items={items()}
      placeholder={nav.picker()?.kind === 'label' ? 'Label as…' : 'Move to…'}
      ariaLabel={nav.picker()?.kind === 'label' ? 'Label conversation' : 'Move conversation'}
      emptyText="No matching mailboxes"
      score={(...args: unknown[]) => {
        const [item, q] = args as [PickerItem, string];
        return item.id === CREATE ? 0 : pickerScore(item.label, q);
      }}
      onSelect={(...args: unknown[]) => {
        const { item } = args[0] as { item: PickerItem };
        const p = nav.picker();
        const view = current();
        close();
        if (!p || !view) return;
        const apply = (id: Id) => {
          if (p.kind === 'label') actions.addLabel(p.threadIds, id);
          else actions.moveTo(p.threadIds, view, id);
          nav.clearSelection();
        };
        if (item.create === undefined) apply(item.id);
        else labels.create(item.create, { quiet: true }).then(apply, (e) => toast(`Couldn't create the label: ${(e as Error).message}`, 'error'));
      }}
    />
  );
}

export function HelpDialog() {
  const { nav, hasCalendars } = useApp();
  return (
    <Dialog open={nav.helpOpen()} onOpenChange={nav.setHelpOpen} ariaLabelledby="help-title">
      <h2 id="help-title">Keyboard shortcuts</h2>
      <dl class="shortcut-list">
        <For each={SHORTCUTS.filter(([keys]) => keys !== 'g then k' || hasCalendars())}>
          {([keys, what]) => (
            <>
              <dt>{keys}</dt>
              <dd>{what}</dd>
            </>
          )}
        </For>
      </dl>
    </Dialog>
  );
}

