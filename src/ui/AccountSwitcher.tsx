import { createSignal, For, Show } from 'solid-js';
import type { AccountSpace, Spaces } from '../app/accounts';

/** Which mailbox is open, and the way to another: the user's own and the shared ones they belong to. */
export function AccountSwitcher(props: { spaces: Spaces; onSwitch: (space: AccountSpace) => void }) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  const current = () => props.spaces.current();
  const elsewhere = () => props.spaces.list().some((s) => s !== current() && props.spaces.unread(s) > 0);
  const draftOpen = (s: AccountSpace) => s !== current() && s.composers.list().length > 0;
  const name = (s: AccountSpace) =>
    [s.info.label, s.info.address, props.spaces.unread(s) ? `${props.spaces.unread(s)} unread` : '', draftOpen(s) ? 'draft open' : ''].filter(Boolean).join(', ');
  const close = () => {
    setOpen(false);
    button.focus();
  };
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
  const move = (by: number) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + by + all.length) % all.length]?.focus();
  };

  return (
    <Show when={props.spaces.list().length > 1}>
      <div class="account-switcher">
        <button
          ref={button}
          type="button"
          class="account-button"
          aria-haspopup="menu"
          aria-expanded={open()}
          aria-label={`${current().info.label}, ${current().info.address}${elsewhere() ? '. Unread mail in another mailbox.' : ''}`}
          onClick={() => {
            setOpen(!open());
            if (open()) queueMicrotask(() => items()[0]?.focus());
          }}
        >
          <span class="account-label">{current().info.label}</span>
          <Show when={elsewhere()}>
            <span class="account-dot" />
          </Show>
          <span class="account-caret" aria-hidden="true">▾</span>
        </button>
        <Show when={open()}>
          <div
            ref={menu}
            class="account-menu"
            role="menu"
            aria-label="Mailboxes"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Not the shell's shortcuts: Escape there closes the open conversation.
                e.stopPropagation();
                close();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                move(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1);
              }
            }}
            onFocusOut={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== button) setOpen(false);
            }}
          >
            <For each={props.spaces.list()}>
              {(s) => (
                <button
                  type="button"
                  class="account-item"
                  role="menuitemradio"
                  aria-checked={s === current()}
                  aria-label={name(s)}
                  onClick={() => {
                    setOpen(false);
                    if (s !== current()) props.onSwitch(s);
                  }}
                >
                  <span class="account-item-main">
                    <span class="account-label">{s.info.label}</span>
                    <span class="account-address">{s.info.address}</span>
                  </span>
                  <Show when={draftOpen(s)}>
                    <span class="account-draft">Draft</span>
                  </Show>
                  <Show when={props.spaces.unread(s)}>
                    <span class="count">{props.spaces.unread(s)}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
