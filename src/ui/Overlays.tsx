import { CommandPalette } from '@rozie-ui/command-palette-solid';
import '@rozie-ui/command-palette-solid/themes/base.css';
import { Dialog } from '@rozie-ui/dialog-solid';
import { useLocation } from '@solidjs/router';
import { createMemo, createSignal, For } from 'solid-js';
import { useApp } from '../app/context';
import { labelPath, resolveView } from '../sync/selectors';
import { SHORTCUTS } from './keyboard';

/** "Move to" (v) and "Label" (l) pickers, Gmail-style type-to-filter lists. */
export function MailboxPicker() {
  const { engine, nav, actions } = useApp();
  const location = useLocation();
  const [query, setQuery] = createSignal('');

  const current = () => {
    const m = /^\/(label\/[^/]+|[^/]+)/.exec(location.pathname);
    return m ? resolveView(decodeURIComponent(m[1]!), engine.state.mailboxes) : null;
  };

  const items = createMemo(() => {
    const p = nav.picker();
    if (!p) return [];
    const exclude = new Set(['drafts', 'flagged', ...(p.kind === 'label' ? ['inbox', 'sent', 'trash', 'junk', 'archive'] : ['sent'])]);
    return Object.values(engine.state.mailboxes)
      .filter((m) => !(m.role && exclude.has(m.role)) && m.id !== current()?.mailboxId)
      .map((m) => ({
        id: m.id,
        label: m.role === 'inbox' ? 'Inbox' : labelPath(m, engine.state.mailboxes),
        group: m.role ? 'System' : 'Labels',
      }))
      .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group === 'System' ? -1 : 1));
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
      onSelect={(...args: unknown[]) => {
        const e = args[0] as { item: { id: string } };
        const p = nav.picker();
        const view = current();
        if (p && view) {
          if (p.kind === 'label') actions.addLabel(p.threadIds, e.item.id);
          else actions.moveTo(p.threadIds, view, e.item.id);
          nav.clearSelection();
        }
        close();
      }}
    />
  );
}

export function HelpDialog() {
  const { nav } = useApp();
  return (
    <Dialog open={nav.helpOpen()} onOpenChange={nav.setHelpOpen} ariaLabelledby="help-title">
      <h2 id="help-title">Keyboard shortcuts</h2>
      <dl class="shortcut-list">
        <For each={SHORTCUTS}>
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

