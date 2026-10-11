import { A, useNavigate, useParams } from '@solidjs/router';
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from 'solid-js';
import { useApp } from '../app/context';
import { displayName, emailsOf, isGroup, organizationOf, phonesOf, photoOf } from '../contacts/card';
import { groupName, membersOf } from '../contacts/groups';
import { downloadText } from '../contacts/download';
import { matchPeople } from '../contacts/search';
import { toVcards } from '../contacts/vcard';
import type { ContactCard, Id } from '../jmap/types';
import { Avatar } from './Avatar';
import { ContactCardView } from './ContactCard';
import { GroupPicker } from './GroupPicker';
import { Icon } from './icons';
import { MenuButton } from './MenuButton';
import { createVirtualList } from './virtual';

const ROW_HEIGHT = 48;

/**
 * Route component for /contacts[/:id] and /contacts/group/:gid[/:id]: the address book, or one group
 * of it, on the left and the open card on the right.
 */
export function ContactsView() {
  const params = useParams<{ id?: string; gid?: string }>();
  const { contacts, toast, confirm } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = createSignal('');
  const [scroller, setScroller] = createSignal<HTMLElement>();
  let body: HTMLTableSectionElement | undefined;
  let search: HTMLInputElement | undefined;

  /** The group on screen, when the address names one that exists. */
  const group = (): ContactCard | undefined => {
    const card = params.gid ? contacts.state.cards[params.gid] : undefined;
    return card && isGroup(card) ? card : undefined;
  };
  const members = createMemo(() => {
    const g = group();
    return g ? membersOf(g, contacts.people()) : null;
  });
  /** Where the list on screen lives: cards opened from a group keep the group in their address. */
  const base = () => (params.gid ? `/contacts/group/${encodeURIComponent(params.gid)}` : '/contacts');
  const people = () => (params.gid ? (members()?.people ?? []) : contacts.people());
  const shown = createMemo(() => matchPeople(people(), query()));
  /** The person on screen. A group's card is no person, whatever the address says. */
  const open = (): ContactCard | undefined => {
    const card = params.id ? contacts.state.cards[params.id] : undefined;
    return card && !isGroup(card) ? card : undefined;
  };
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
    // Not before the server has been heard: the card may be newer than the copy kept in the browser.
    if (!contacts.state.loaded || !contacts.state.current) return;
    // Made again under a new id to be given a uid (to join a group): the same person, followed there.
    const now = contacts.movedTo(id);
    if (now) return void navigate(`${base()}/${now}`, { replace: true });
    if (onScreen === id) toast('That contact was deleted.', 'info');
    onScreen = null;
    navigate(base(), { replace: true });
  });

  // The same for a group that is gone.
  let groupOnScreen: string | null = null;
  createEffect(() => {
    const gid = params.gid;
    if (!gid) {
      groupOnScreen = null;
      return;
    }
    if (group()) {
      groupOnScreen = gid;
      return;
    }
    if (!contacts.state.loaded || !contacts.state.current) return;
    if (groupOnScreen === gid) toast('That group was deleted.', 'info');
    groupOnScreen = null;
    navigate('/contacts', { replace: true });
  });

  // The selection: ids, and only ever of people who are on screen. A search, a push that deletes
  // someone, or a card made again under a new id all take people out of it.
  const [picked, setPicked] = createSignal<ReadonlySet<Id>>(new Set());
  const selected = createMemo(() => shown().filter((c) => picked().has(c.id)));
  createEffect(() => {
    if (selected().length !== picked().size) setPicked(new Set(selected().map((c) => c.id)));
  });
  createEffect(on(() => params.gid, () => setPicked(new Set<Id>()), { defer: true }));
  // The toolbar goes when the selection empties, and the button just pressed with it: the focus
  // would fall to the page, so it is put on the search box that takes the toolbar's place.
  createEffect(on(() => selected().length > 0, (has, had) => {
    if (!had || has) return;
    queueMicrotask(() => {
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected) search?.focus();
    });
  }, { defer: true }));
  const toggle = (id: Id) => {
    const next = new Set(picked());
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };
  const allPicked = () => shown().length > 0 && selected().length === shown().length;
  const toggleAll = () => setPicked(allPicked() ? new Set<Id>() : new Set(shown().map((c) => c.id)));
  const clear = () => setPicked(new Set<Id>());
  const selectedIds = () => selected().map((c) => c.id);

  const addTo = async (groupId: Id) => {
    const ids = selectedIds();
    const name = groupName(contacts.state.cards[groupId]!);
    const result = await contacts.addToGroup(groupId, ids);
    if (result.ok) toast(result.added ? `Added ${result.added} to ${name}.` : `They are already in ${name}.`, 'info');
    else toast(`Couldn't add to ${name}: ${result.error}`, 'error');
  };
  const removeFromGroup = async () => {
    const g = group();
    if (!g) return;
    const ids = selectedIds();
    const result = await contacts.removeFromGroup(g.id, ids);
    if (result.ok) toast(`Removed ${ids.length} from ${groupName(g)}.`, 'info');
    else toast(`Couldn't remove from ${groupName(g)}: ${result.error}`, 'error');
  };
  const prune = async () => {
    const g = group();
    if (!g) return;
    const result = await contacts.pruneGroup(g.id);
    if (!result.ok) toast(`Couldn't change ${groupName(g)}: ${result.error}`, 'error');
  };
  /** One vCard file of these cards, saved by the browser. */
  const exportCards = (cards: ContactCard[]) => {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    downloadText(`contacts-${day}.vcf`, 'text/vcard;charset=utf-8', toVcards(cards));
    const people = cards.filter((c) => !isGroup(c)).length;
    const groups = cards.length - people;
    const said = [people || !groups ? `${people.toLocaleString()} contact${people === 1 ? '' : 's'}` : '', groups ? `${groups.toLocaleString()} group${groups === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    toast(`Exported ${said}.`, 'info');
  };
  /** Everything, with the groups; or the group on screen, with its own card so it is a group where it is imported. */
  const exportAll = () => {
    const g = group();
    if (g ? !members()?.people.length : !contacts.people().length && !contacts.groups().length) return void toast('There are no contacts to export.', 'info');
    exportCards(g ? [...(members()?.people ?? []), g] : [...contacts.people(), ...contacts.groups()]);
  };

  const removeSelected = async () => {
    const ids = selectedIds();
    const what = (n: number) => `${n.toLocaleString()} contact${n === 1 ? '' : 's'}`;
    if (!(await confirm({ title: `Delete ${what(ids.length)}?`, message: 'This cannot be undone.', confirmLabel: 'Delete' }))) return;
    // Deleted here: the open card going is no news.
    onScreen = null;
    const result = await contacts.removeMany(ids);
    if (result.removed) toast(`Deleted ${what(result.removed)}.`, 'info');
    if (result.error) toast(`Couldn't delete ${result.removed ? 'the rest' : 'the contacts'}: ${result.error}`, 'error');
  };

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
  const groupCount = () => {
    const m = members();
    const n = m ? m.people.length + m.addresses.length : 0;
    return `${n.toLocaleString()} ${n === 1 ? 'person' : 'people'}`;
  };

  /** Arrow keys walk the rows; a row beyond those rendered is scrolled to first. */
  const onKeyDown = (e: KeyboardEvent) => {
    const row = (e.target as Element).closest<HTMLElement>('tr[data-index]');
    if (!row) return;
    // Space on a person's name selects them; in the box itself the browser does it.
    if (e.key === ' ' && (e.target as Element).closest('a') && row.dataset.contactId) {
      e.preventDefault();
      return toggle(row.dataset.contactId);
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
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
      {/* Always here, and filled when the selection changes: a region that arrives already filled is not read out. */}
      <span class="sr-only" role="status" data-testid="contacts-selection-status">{selected().length ? `${selected().length.toLocaleString()} ${selected().length === 1 ? 'contact' : 'contacts'} selected` : ''}</span>
      <section class="contacts-list" aria-label="Contact list">
        <Show when={group()}>
          {(g) => (
            <div class="contacts-group">
              <h2>{groupName(g())}</h2>
              <span>{groupCount()}</span>
            </div>
          )}
        </Show>
        <Show
          when={!selected().length}
          fallback={
            <div class="contacts-tools contacts-selection" role="group" aria-label="Selected contacts">
              <span class="contacts-count">{selected().length.toLocaleString()} selected</span>
              <GroupPicker label="Add to group" exclude={params.gid ? [params.gid] : []} onPick={(id) => void addTo(id)} onNew={() => contacts.openGroupDialog({ kind: 'create', then: selectedIds() })} />
              <Show when={group()}>
                <button type="button" class="btn tonal" onClick={() => void removeFromGroup()}>Remove from group</button>
              </Show>
              <button type="button" class="btn tonal" onClick={() => exportCards(selected())}>Export</button>
              <button type="button" class="btn tonal" onClick={() => void removeSelected()}>Delete</button>
              <button type="button" class="btn tonal" onClick={clear}>Clear selection</button>
            </div>
          }
        >
        <div class="contacts-tools">
          <input
            ref={search}
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
          <MenuButton
            class="icon-btn"
            title="More contact actions"
            menuLabel="More contact actions"
            items={[
              { label: 'Import…', run: () => contacts.openImport() },
              { label: params.gid ? 'Export this group' : 'Export all', run: exportAll },
            ]}
          >
            <Icon name="more" />
          </MenuButton>
        </div>
        </Show>
        <Show when={members()}>
          {(m) => (
            <Show when={m().addresses.length || m().unknown}>
              <div class="contacts-group-notes">
                <For each={m().addresses}>
                  {(address) => (
                    <p>
                      <span>{address}</span> <span class="contact-tag">Address only</span>
                    </p>
                  )}
                </For>
                <Show when={m().unknown}>
                  <p>
                    {m().unknown === 1 ? '1 member of this group is not in your contacts.' : `${m().unknown.toLocaleString()} members of this group are not in your contacts.`}{' '}
                    <button type="button" class="link-btn" onClick={() => void prune()}>Remove from the group</button>
                  </p>
                </Show>
              </div>
            </Show>
          )}
        </Show>
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
          <Match when={params.gid && !people().length}>
            <div class="list-empty">{members()?.addresses.length ? 'Nobody in this group is in your contacts.' : 'Nobody is in this group yet.'}</div>
          </Match>
          <Match when={!people().length}>
            <div class="list-empty">
              <p>No contacts yet.</p>
              <button type="button" class="btn" onClick={() => contacts.openDialog({ kind: 'new' })}>New contact</button>
              <button type="button" class="btn tonal" onClick={() => contacts.openImport()}>Import…</button>
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
                    <th scope="col" class="contacts-check">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={allPicked()}
                        // A property, not an attribute: there is no markup for "some of them".
                        ref={(el) => createEffect(() => (el.indeterminate = selected().length > 0 && !allPicked()))}
                        onChange={toggleAll}
                      />
                    </th>
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
                                if (!(e.target as Element).closest('a, .contacts-check')) navigate(`${base()}/${card().id}`);
                              }}
                            >
                              <td
                                class="contacts-check"
                                onClick={(e) => {
                                  // The whole cell is the target, not only the box in it.
                                  if (!(e.target instanceof HTMLInputElement)) toggle(card().id);
                                }}
                              >
                                <input type="checkbox" aria-label={`Select ${name()}`} checked={picked().has(card().id)} onChange={() => toggle(card().id)} />
                              </td>
                              <td>
                                <A href={`${base()}/${card().id}`} class="contacts-name">
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
        {/* Not keyed: a save or a push replaces the card object, and the pane (and the focus in it) must stay. */}
        <Show when={open()} fallback={<div class="list-empty">{params.id ? 'Loading contacts…' : 'Select a contact'}</div>}>
          {(card) => (
            <>
              <A href={base()} class="contact-back">
                <Icon name="back" /> Back to contacts
              </A>
              <ContactCardView card={card()} onDelete={() => remove(card().id)} />
            </>
          )}
        </Show>
      </section>
    </div>
  );
}
