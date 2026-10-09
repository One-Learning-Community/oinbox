import { Popover } from '@rozie-ui/popover-solid';
import { createEffect, createMemo, createSignal, on } from 'solid-js';
import { useApp } from '../app/context';
import type { Mailbox } from '../jmap/types';
import { labelPath, subLabelCount } from '../sync/selectors';
import { Icon } from './icons';
import { menuKeys } from './menu';

/** The "⋯" menu of a label row: Rename and Delete. */
export function LabelMenu(props: { mailbox: Mailbox }) {
  const { engine, labels, nav } = useApp();
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const path = () => labelPath(props.mailbox, engine.state.mailboxes);
  const subs = createMemo(() => subLabelCount(props.mailbox.id, engine.state.mailboxes));
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => items()[0]?.focus({ preventScroll: true }));
  }, { defer: true }));

  /** Close with the focus on the button: Escape stays there, Tab moves on from there, a dialog returns there. */
  const close = () => {
    setOpen(false);
    button?.focus();
  };

  const onKeyDown = menuKeys(items, close);

  const choose = (run: () => void) => {
    close();
    run();
  };

  return (
    <span class="nav-menu">
      <Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="manual"
        placement="bottom-end"
        strategy="fixed"
        offset={4}
        anchorSlot={() => (
          <button
            ref={button}
            class="icon-btn nav-more"
            type="button"
            aria-label={`Options for ${path()}`}
            aria-haspopup="menu"
            aria-expanded={open()}
            onClick={() => setOpen(!open())}
          >
            <Icon name="more" />
          </button>
        )}
      >
        <div class="menu" role="menu" aria-label={`Options for ${path()}`} ref={menu} onKeyDown={onKeyDown}>
          <button type="button" role="menuitem" onClick={() => choose(() => nav.setLabelDialog({ kind: 'rename', id: props.mailbox.id }))}>
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            aria-disabled={subs() > 0}
            onClick={() => subs() === 0 && choose(() => void labels.remove(props.mailbox.id))}
          >
            {subs() > 0 ? `Delete (has ${subs()} sub-label${subs() === 1 ? '' : 's'})` : 'Delete'}
          </button>
        </div>
      </Popover>
    </span>
  );
}
