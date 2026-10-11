import { For, Show, createMemo } from 'solid-js';
import { useApp } from '../app/context';
import { addressesOf, birthdayOf, displayName, emailsOf, extrasOf, notesOf, organizationOf, phonesOf, photoOf } from '../contacts/card';
import type { ContactCard } from '../jmap/types';
import { Avatar } from './Avatar';
import { Icon } from './icons';

const EMAIL_LABELS = { work: 'Work', personal: 'Personal', other: '' } as const;
const PHONE_LABELS = { mobile: 'Mobile', work: 'Work', home: 'Home', other: '' } as const;
const ADDRESS_LABELS = { work: 'Work', home: 'Home', other: '' } as const;

/** "14 March", with the year when the card has one. In UTC: a birthday is a date, not a moment. */
function birthdayText(b: { day: number; month: number; year?: number }): string {
  const date = new Date(Date.UTC(b.year ?? 2000, b.month - 1, b.day));
  if (b.year !== undefined) date.setUTCFullYear(b.year);
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC', ...(b.year === undefined ? {} : { year: 'numeric' }) }).format(date);
}

/** Nothing checks what a card holds as an address: one with `?` or `&` in it must not become a link that says more. */
const mailto = (address: string) => `mailto:${encodeURIComponent(address).replace(/%40/g, '@')}`;

/** One saved person, read-only. Editing is the dialog's. */
export function ContactCardView(props: { card: ContactCard; onDelete: () => void }) {
  const { contacts, composers } = useApp();
  const name = () => displayName(props.card);
  const org = createMemo(() => organizationOf(props.card));
  const orgLine = () => {
    const o = org();
    const place = [o.name, o.department].filter(Boolean).join(' · ');
    return [o.title, place].filter(Boolean).join(', ');
  };
  const emails = createMemo(() => emailsOf(props.card));
  const phones = createMemo(() => phonesOf(props.card));
  const addresses = createMemo(() => addressesOf(props.card));
  const birthday = createMemo(() => birthdayOf(props.card));
  const notes = () => notesOf(props.card);

  const write = (e: MouseEvent, email: string) => {
    e.preventDefault();
    const shown = name();
    composers.open('new').update({ to: [{ name: shown === email ? null : shown, email }] });
  };

  return (
    <article class="contact-card" aria-labelledby="contact-card-name">
      <header class="contact-head">
        <Avatar name={name()} seed={emails()[0]?.address ?? name()} photo={photoOf(props.card)} size={64} />
        <div class="contact-title">
          <h1 id="contact-card-name">{name()}</h1>
          <Show when={orgLine()}>
            <p class="contact-org">{orgLine()}</p>
          </Show>
        </div>
        <div class="contact-actions">
          <button type="button" class="btn tonal" onClick={() => contacts.openDialog({ kind: 'edit', id: props.card.id })}>
            <Icon name="edit" /> Edit
          </button>
          <button type="button" class="btn tonal" onClick={() => props.onDelete()}>
            <Icon name="trash" /> Delete
          </button>
        </div>
      </header>
      <dl class="contact-fields">
        <Show when={emails().length}>
          <dt>Email</dt>
          <dd>
            <For each={emails()}>
              {(e) => (
                <div class="contact-row">
                  <a href={mailto(e.address)} onClick={(ev) => write(ev, e.address)}>{e.address}</a>
                  <Show when={EMAIL_LABELS[e.label]}>
                    <span class="contact-tag">{EMAIL_LABELS[e.label]}</span>
                  </Show>
                  <Show when={e.preferred && emails().length > 1}>
                    <span class="contact-tag">Preferred</span>
                  </Show>
                </div>
              )}
            </For>
          </dd>
        </Show>
        <Show when={phones().length}>
          <dt>Phone</dt>
          <dd>
            <For each={phones()}>
              {(p) => (
                <div class="contact-row">
                  <a href={`tel:${p.number.replace(/[^\d+]/g, '')}`}>{p.number}</a>
                  <Show when={PHONE_LABELS[p.label]}>
                    <span class="contact-tag">{PHONE_LABELS[p.label]}</span>
                  </Show>
                </div>
              )}
            </For>
          </dd>
        </Show>
        <Show when={addresses().length}>
          <dt>Address</dt>
          <dd>
            <For each={addresses()}>
              {(a) => (
                <div class="contact-row">
                  <span class="contact-lines">{a.text}</span>
                  <Show when={ADDRESS_LABELS[a.label]}>
                    <span class="contact-tag">{ADDRESS_LABELS[a.label]}</span>
                  </Show>
                </div>
              )}
            </For>
          </dd>
        </Show>
        <Show when={birthday()}>
          {(b) => (
            <>
              <dt>Birthday</dt>
              <dd>{birthdayText(b())}</dd>
            </>
          )}
        </Show>
        <Show when={notes()}>
          <dt>Notes</dt>
          <dd class="contact-lines">{notes()}</dd>
        </Show>
        <For each={extrasOf(props.card)}>
          {(x) => (
            <>
              <dt>{x.label}</dt>
              <dd>
                <For each={x.values}>{(v) => <div class="contact-row">{v}</div>}</For>
              </dd>
            </>
          )}
        </For>
      </dl>
    </article>
  );
}
