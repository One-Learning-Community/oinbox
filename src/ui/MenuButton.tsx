import { Popover } from '@rozie-ui/popover-solid';
import { createEffect, createSignal, For, on, type JSX } from 'solid-js';
import { menuKeys } from './menu';

export interface MenuItem {
  label: string;
  run: () => void;
}

/**
 * A button that opens a short menu under (or over) itself. The wrapper's class gives the popover
 * the theme's colours (styles.css, `.menu-anchor`); without it the popover is rozie's white.
 */
export function MenuButton(props: {
  class: string;
  /** The button's title: its name too, when it shows only an icon. */
  title: string;
  menuLabel: string;
  items: MenuItem[];
  placement?: 'bottom-start' | 'top-start';
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => items()[0]?.focus({ preventScroll: true }));
  }, { defer: true }));

  /** Close with the focus back on the button: Escape stays there, Tab moves on from there. */
  const close = () => {
    setOpen(false);
    button?.focus();
  };

  return (
    <span class="menu-anchor">
      <Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="manual"
        placement={props.placement ?? 'bottom-start'}
        strategy="fixed"
        offset={4}
        anchorSlot={() => (
          <button ref={button} type="button" class={props.class} title={props.title} aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
            {props.children}
          </button>
        )}
      >
        <div class="menu" role="menu" aria-label={props.menuLabel} ref={menu} onKeyDown={menuKeys(items, close)}>
          <For each={props.items}>
            {(item) => (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  item.run();
                }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Popover>
    </span>
  );
}
