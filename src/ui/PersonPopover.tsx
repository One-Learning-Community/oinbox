import { Popover } from '@rozie-ui/popover-solid';
import { A } from '@solidjs/router';
import { Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import { useApp } from '../app/context';
import { displayName, emailsOf, organizationOf, phonesOf, photoOf } from '../contacts/card';
import type { EmailAddress } from '../jmap/types';
import { Avatar } from './Avatar';

/**
 * A name or address in a message or on a recipient chip, as a button that opens a small card of the
 * person: who they are to the user (a contact, a colleague, neither) and what can be done about it.
 * On a server without contacts it is plain text.
 */
export function PersonButton(props: { address: EmailAddress; label: string; class?: string; inMessage?: boolean }) {
  const app = useApp();
  // Read once, as the rest of the app reads the session: a server gains no address book mid-visit.
  if (!app.contacts.available()) return <span class={props.class}>{props.label}</span>;

  const { contacts, composers, directory } = app;
  const personal = app.spaces.current().info.personal;
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;

  const email = () => props.address.email.trim();
  const saved = createMemo(() => (open() ? contacts.byEmail(email()) : undefined));
  const colleague = createMemo(() => {
    if (!open()) return undefined;
    const key = email().toLowerCase();
    return directory.entries().find((d) => d.email.toLowerCase() === key);
  });
  /** What the message itself calls them, unless that is only the address again. */
  const given = () => {
    const name = props.address.name?.trim().replace(/^["']|["']$/g, '') ?? '';
    return name && name.toLowerCase() !== email().toLowerCase() ? name : '';
  };
  const name = () => {
    const card = saved();
    return card ? displayName(card) : colleague()?.name || given() || email();
  };
  const seedName = () => given() || colleague()?.name || '';

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => panel?.querySelector<HTMLElement>('button, a')?.focus({ preventScroll: true }));
  }, { defer: true }));

  /** Close with the focus on the name: Escape stays there, and a dialog opened from here returns there. */
  const close = () => {
    setOpen(false);
    button?.focus();
  };
  const choose = (run: () => void) => {
    close();
    run();
  };

  return (
    // A click here must not also expand or collapse the message it sits in.
    <span class="person-anchor" onClick={(e) => e.stopPropagation()}>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="manual"
        placement="bottom-start"
        strategy="fixed"
        offset={4}
        anchorSlot={() => (
          <button
            ref={button}
            type="button"
            class={`person ${props.class ?? ''}`}
            aria-haspopup="dialog"
            aria-expanded={open()}
            // A chip sits in a text field: taking the focus on the way down would commit what is half typed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen(!open())}
          >
            {props.label}
          </button>
        )}
      >
        <Show when={open()}>
          <div
            ref={panel}
            class="person-card"
            role="dialog"
            aria-label={name()}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
            onFocusOut={(e) => {
              const to = e.relatedTarget as Node | null;
              if (to && !panel?.contains(to) && to !== button) setOpen(false);
            }}
          >
            <div class="person-head">
              <Avatar name={name()} seed={email()} photo={saved() ? photoOf(saved()!) : null} size={40} />
              <div class="person-who">
                <strong>{name()}</strong>
                <span>{email()}</span>
              </div>
            </div>
            <Show when={saved()} keyed>
              {(card) => {
                const org = organizationOf(card);
                const others = emailsOf(card).filter((e) => e.address.trim().toLowerCase() !== email().toLowerCase());
                return (
                  <ul class="person-facts">
                    <Show when={[org.title, org.name].filter(Boolean).join(', ')}>{(line) => <li>{line()}</li>}</Show>
                    <Show when={phonesOf(card)[0]}>{(p) => <li>{p().number}</li>}</Show>
                    <Show when={others[0]}>{(e) => <li>{e().address}</li>}</Show>
                  </ul>
                );
              }}
            </Show>
            <Show when={!saved() && colleague()}>
              <p class="person-note">In your organisation</p>
            </Show>
            <div class="person-actions">
              <Show
                when={saved()}
                keyed
                fallback={
                  <button type="button" onClick={() => choose(() => contacts.openDialog({ kind: 'new', seed: { ...(seedName() ? { name: seedName() } : {}), email: email() } }))}>
                    Add to contacts
                  </button>
                }
              >
                {(card) => (
                  <>
                    <button type="button" onClick={() => choose(() => contacts.openDialog({ kind: 'edit', id: card.id }))}>Edit contact</button>
                    <Show when={personal}>
                      <A href={`/contacts/${card.id}`} onClick={() => setOpen(false)}>Open in Contacts</A>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={props.inMessage}>
                <button type="button" onClick={() => choose(() => composers.open('new').update({ to: [{ name: props.address.name, email: email() }] }))}>
                  New message
                </button>
              </Show>
            </div>
          </div>
        </Show>
      </Popover>
    </span>
  );
}
