import { A, useNavigate, useParams } from '@solidjs/router';
import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from 'solid-js';
import { useApp } from '../app/context';
import { displayName, emailsOf, organizationOf, phonesOf, photoOf } from '../contacts/card';
import { matchPeople } from '../contacts/search';
import type { ContactCard } from '../jmap/types';
import { Avatar } from './Avatar';
import { ContactCardView } from './ContactCard';
import { Icon } from './icons';
import { createVirtualList } from './virtual';

const ROW_HEIGHT = 48;

/** Route component for /contacts and /contacts/:id: the address book on the left, the open card on the right. */
export function ContactsView() {
  const params = useParams<{ id?: string }>();
  const { contacts, toast } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = createSignal('');
  const [scroller, setScroller] = createSignal<HTMLElement>();
  let body: HTMLTableSectionElement | undefined;

  const people = contacts.people;
  const shown = createMemo(() => matchPeople(people(), query()));
  const open = (): ContactCard | undefined => (params.id ? contacts.state.cards[params.id] : undefined);
  const virtual = createVirtualList({ count: () => shown().length, scrollElement: scroller, rowHeight: () => ROW_HEIGHT });

  // A card that is gone (deleted on another device, or an old address) has nothing to show: back to
  // the list. Only a card that was on screen is worth a word about it.
  let onScreen: string | null = null;
  createEffect(() => {
    const id = params.id;
    if (!id) {
      onScreen = null;
      return;
    }
    if (open()) {
      onScreen = id;
      return;
    }
    if (!contacts.state.loaded) return;
    if (onScreen === id) toast('That contact was deleted.', 'info');
    onScreen = null;
    navigate('/contacts', { replace: true });
  });

  const remove = (id: string) => {
    // Deleted here: the store's own toast, with its Undo, says so.
    onScreen = null;
    void contacts.remove(id);
  };

  const count = () => {
    const total = people().length;
    if (query().trim()) return `${shown().length.toLocaleString()} of ${total.toLocaleString()}`;
    return `${total.toLocaleString()} contact${total === 1 ? '' : 's'}`;
  };

  /** Arrow keys walk the rows; a row beyond those rendered is scrolled to first. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const row = (e.target as Element).closest<HTMLElement>('tr[data-index]');
    if (!row) return;
    const next = Number(row.dataset.index) + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= shown().length) return;
    e.preventDefault();
    const focus = () => body?.querySelector<HTMLElement>(`tr[data-index="${next}"] a`)?.focus();
    if (body?.querySelector(`tr[data-index="${next}"]`)) focus();
    else {
      virtual.virtualizer.scrollToIndex(next);
      requestAnimationFrame(focus);
    }
  };

  const first = () => virtual.items()[0];
  const last = () => virtual.items()[virtual.items().length - 1];

  return (
    <div class="contacts-view" classList={{ 'has-card': !!params.id }}>
      <section class="contacts-list" aria-label="Contact list">
        <div class="contacts-tools">
          <input
            type="search"
            class="contacts-search"
            aria-label="Search contacts"
            placeholder="Search contacts"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <Show when={contacts.state.loaded}>
            <span class="contacts-count" role="status">{count()}</span>
          </Show>
        </div>
        <Switch>
          <Match when={!contacts.state.loaded && contacts.state.failed}>
            <div class="list-empty">
              <p>Couldn't load your contacts.</p>
              <button type="button" class="btn tonal" onClick={() => void contacts.reload()}>Retry</button>
            </div>
          </Match>
          <Match when={!contacts.state.loaded}>
            <div class="list-empty" role="status">Loading contacts…</div>
          </Match>
          <Match when={!people().length}>
            <div class="list-empty">
              <p>No contacts yet.</p>
              <button type="button" class="btn" onClick={() => contacts.openDialog({ kind: 'new' })}>New contact</button>
            </div>
          </Match>
          <Match when={!shown().length}>
            <div class="list-empty">No contacts match “{query().trim()}”.</div>
          </Match>
          <Match when={true}>
            <div class="contacts-scroll" ref={setScroller}>
              <table class="contacts-table" aria-label="Contacts" aria-rowcount={shown().length + 1}>
                <thead>
                  <tr aria-rowindex={1}>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col" class="contacts-extra">Phone</th>
                    <th scope="col" class="contacts-extra">Organisation</th>
                  </tr>
                </thead>
                <tbody ref={body} onKeyDown={onKeyDown}>
                  <Show when={first()?.start}>
                    <tr aria-hidden="true" class="contacts-spacer" style={{ height: `${first()!.start}px` }} />
                  </Show>
                  <For each={virtual.items()}>
                    {(item) => (
                      <Show when={shown()[item.index]}>
                        {(card) => {
                          const name = () => displayName(card());
                          const email = () => emailsOf(card())[0]?.address ?? '';
                          return (
                            <tr
                              data-contact-id={card().id}
                              data-index={item.index}
                              aria-rowindex={item.index + 2}
                              aria-current={card().id === params.id ? 'true' : undefined}
                              onClick={(e) => {
                                if (!(e.target as Element).closest('a')) navigate(`/contacts/${card().id}`);
                              }}
                            >
                              <td>
                                <A href={`/contacts/${card().id}`} class="contacts-name">
                                  <Avatar name={name()} seed={email() || name()} photo={photoOf(card())} size={32} />
                                  <span>{name()}</span>
                                </A>
                              </td>
                              <td>{email() === name() ? '' : email()}</td>
                              <td class="contacts-extra">{phonesOf(card())[0]?.number ?? ''}</td>
                              <td class="contacts-extra">{organizationOf(card()).name}</td>
                            </tr>
                          );
                        }}
                      </Show>
                    )}
                  </For>
                  <Show when={last() && virtual.totalSize() - last()!.end > 0}>
                    <tr aria-hidden="true" class="contacts-spacer" style={{ height: `${virtual.totalSize() - last()!.end}px` }} />
                  </Show>
                </tbody>
              </table>
            </div>
          </Match>
        </Switch>
      </section>
      <section class="contact-pane" aria-label="Contact">
        <Show when={open()} fallback={<div class="list-empty">{params.id ? 'Loading contacts…' : 'Select a contact'}</div>} keyed>
          {(card) => (
            <>
              <A href="/contacts" class="contact-back">
                <Icon name="back" /> Back to contacts
              </A>
              <ContactCardView card={card} onDelete={() => remove(card.id)} />
            </>
          )}
        </Show>
      </section>
    </div>
  );
}
