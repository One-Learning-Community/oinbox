import { Combobox, type ComboboxHandle } from '@rozie-ui/combobox-solid';
import { createEffect, createMemo, createSignal, on, onMount, Show } from 'solid-js';
import { useApp } from '../app/context';
import { expandGroup, groupName } from '../contacts/groups';
import type { EmailAddress } from '../jmap/types';
import { formatAddress, parseAddressList } from '../mail/compose';
import { PersonButton } from './PersonPopover';
import { addUnique, completeAddress, offer, toAddress, type Recipient } from '../mail/recipients';

interface Option {
  value: string;
  label: string;
  recipient: Recipient;
}

const listEscapes = new WeakSet<Event>();
/** Whether this Escape keypress was used up closing a suggestion list. */
export const closedSuggestions = (e: Event): boolean => listEscapes.has(e);

const heldSends = new WeakSet<Event>();
/** Whether this keypress just added a suggestion the user hadn't typed out, so it must not also send. */
export const pickedSuggestion = (e: Event): boolean => heldSends.has(e);

/** Typed text is committed by these keys, as well as by Enter. */
const DELIMITERS = [',', ';'];
/** A field out of use shows this many recipients whole; more are folded to the first and a count. */
const FOLD_OVER = 2;

/**
 * To/Cc/Bcc: chips plus a text input that suggests people from mail history.
 * rozie Combobox renders the chips and the list, picks with Enter and Tab and commits typed
 * text. Pasted address lists and committing on blur are added here (docs/rozie-feedback.md).
 */
export function RecipientField(props: {
  /** Unique on the page: Combobox derives its element ids from it. */
  id: string;
  label: 'To' | 'Cc' | 'Bcc';
  value: EmailAddress[];
  /** The draft's other recipients, which are not offered again. */
  others: EmailAddress[];
  onChange: (v: EmailAddress[]) => void;
}) {
  const { recipients, contacts, toast } = useApp();
  /** With an address book a chip's name is a button, and the one stop for Tab on the chip: Delete there removes it. */
  const named = contacts.available();
  const [text, setText] = createSignal('');
  let handle: ComboboxHandle | undefined;
  let root: HTMLDivElement | undefined;
  /**
   * Gmail's way with a long list: everyone is shown while the field is in use, and the first of them
   * with "N more" once the user has moved on to the message.
   */
  const [active, setActive] = createSignal(false);
  const folded = () => !active() && props.value.length > FOLD_OVER;

  const taken = () => new Set([...props.value, ...props.others].map((a) => a.email.toLowerCase()));
  const found = createMemo(() => offer(recipients.suggest(text(), taken()), text()));
  const options = createMemo<Option[]>(() =>
    // A group's value is never an address: it is not a recipient, only a way to add its members.
    found().map((r) => (r.list ? { value: `list:${r.list.id}`, label: r.name, recipient: r } : { value: r.email, label: r.name ? `${r.name} ${r.email}` : r.email, recipient: r })),
  );

  const addAll = (more: EmailAddress[]) => {
    props.onChange(addUnique(props.value, more));
    setText('');
    handle?.seedQuery('');
  };
  /**
   * A contact group is never a recipient: it becomes its members, one chip each, so that everyone
   * who gets the message can be seen. Those already on the message are not added again.
   */
  const addList = (r: Recipient) => {
    const group = r.list ? contacts.state.cards[r.list.id] : undefined;
    if (!group) return addAll([]);
    const name = groupName(group);
    const { recipients: members, withoutEmail } = expandGroup(group, contacts.people());
    const have = taken();
    const fresh = members.filter((a) => !have.has(a.email.toLowerCase()));
    addAll(fresh);
    if (!fresh.length) toast(members.length ? `Everyone in ${name} is already on this message.` : `Nobody in ${name} has an email address.`, 'info');
    else if (withoutEmail) toast(`${withoutEmail} of ${members.length + withoutEmail} in ${name} ${withoutEmail === 1 ? 'has' : 'have'} no email address.`, 'info');
  };
  const pick = (r: Recipient) => (r.list ? addList(r) : addAll([toAddress(r)]));
  const commitTyped = (): boolean => {
    const typed = completeAddress(text());
    if (typed) addAll([typed]);
    return !!typed;
  };

  // Runs after Combobox's own handler for the same keypress.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Combobox takes Escape only to close a list that is showing.
      if (e.defaultPrevented) listEscapes.add(e);
    } else if (e.defaultPrevented) {
      // Committing an address the field already holds empties the input without an event.
      if (e.target instanceof HTMLInputElement && !e.target.value) setText('');
    } else if (e.key === 'Enter' && !commitTyped()) {
      // Ctrl/Cmd+Enter, which Combobox leaves alone and the composer sends on. Half-typed text
      // would be left behind, so the highlighted suggestion is added and the send held: it
      // would go to someone the user has only just seen added.
      const active = handle?.activeOption() as Option | null | undefined;
      if (active) {
        pick(active.recipient);
        heldSends.add(e);
      }
    }
  };

  // Combobox splits a paste on its delimiters, which breaks `"Roe, Sam" <sam@x>` and replaces
  // half-typed text; this runs first (capture) and keeps the paste from it.
  const onPaste = (e: ClipboardEvent) => {
    e.stopPropagation();
    const pasted = parseAddressList(e.clipboardData?.getData('text/plain') ?? '');
    // A fragment pasted into half-typed text is ordinary text; whole addresses become recipients.
    if (pasted.length > 1 || (pasted.length === 1 && !text())) {
      e.preventDefault();
      addAll(pasted);
    }
  };

  onMount(() => {
    // Combobox takes no attributes for its input. An on-screen keyboard shows "@" for an address, and neither capitalises nor corrects one.
    const el = root?.querySelector('input');
    if (!el) return;
    el.inputMode = 'email';
    el.autocapitalize = 'off';
    el.setAttribute('autocorrect', 'off');
    el.spellcheck = false;
  });
  // A long list scrolls in its row (styles.css): the field for the next recipient stays the part in sight.
  createEffect(
    on([() => props.value.length, active], () => {
      const control = root?.querySelector('.rozie-combobox-control');
      if (control && active()) control.scrollTop = control.scrollHeight;
    }),
  );

  return (
    <div class="compose-field">
      <span class="compose-label">{props.label}</span>
      <div
        ref={(el) => {
          root = el;
          el.addEventListener('paste', onPaste, true);
        }}
        class="recipient-field"
        classList={{ folded: folded() }}
        onFocusIn={() => setActive(true)}
        role="group"
        aria-label={props.label}
        onKeyDown={onKeyDown}
        onFocusOut={(e) => {
          if (root?.contains(e.relatedTarget as Node | null)) return;
          commitTyped();
          setActive(false);
        }}
      >
        <Combobox
          ref={(h) => (handle = h)}
          multiple
          disableFilter
          block
          chipLayout="inline"
          disableOpenOnFocus
          hideEmpty
          selectOnTab
          delimiters={DELIMITERS}
          validate={(t: string) => !!completeAddress(t)}
          idBase={props.id}
          ariaLabel={props.label}
          value={props.value.map((a) => a.email)}
          options={options()}
          onSearch={(e) => setText(e.query)}
          onChange={(e) => {
            if (e.text !== undefined) {
              const typed = completeAddress(e.text);
              if (typed) addAll([typed]);
            } else if (e.selected && e.option) pick((e.option as Option).recipient);
            else props.onChange(props.value.filter((a) => (e.value as string[]).includes(a.email)));
          }}
          chipSlot={(chip) => (
            <Show
              when={!(folded() && chip.index === 1) && props.value[chip.index]}
              fallback={
                // The second chip stands for everyone after the first (styles.css hides the rest).
                <Show when={folded() && chip.index === 1}>
                  <button
                    type="button"
                    class="rcpt-more"
                    aria-label={`${props.value.length - 1} more, show all ${props.value.length} recipients`}
                    // On focus: the field unfolds as the focus arrives, and this button is gone before a click.
                    // On click as well: Safari gives a clicked button no focus.
                    onFocus={() => root?.querySelector('input')?.focus()}
                    onClick={() => root?.querySelector('input')?.focus()}
                  >
                    {props.value.length - 1} more
                  </button>
                </Show>
              }
            >
              {(a) => (
                <>
                  <PersonButton
                    address={a()}
                    label={formatAddress(a())}
                    class="rcpt-chip-label"
                    keys="Delete"
                    onKeyDown={(e) => {
                      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
                      e.preventDefault();
                      e.stopPropagation();
                      chip.remove();
                      root?.querySelector('input')?.focus();
                    }}
                  />
                  <button
                    type="button"
                    class="rcpt-chip-remove"
                    tabIndex={named ? -1 : undefined}
                    aria-label={`Remove ${formatAddress(a())}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chip.remove()}
                  >
                    ×
                  </button>
                </>
              )}
            </Show>
          )}
          optionSlot={(o) => {
            const r = () => (o.option as Option).recipient;
            return (
              <span class="rcpt-option" data-email={r().email} data-list={r().list?.id}>
                <span class="rcpt-name">{r().name || r().email}</span>
                <Show when={r().name && r().email}>
                  <span class="rcpt-email">{r().email}</span>
                </Show>
                <Show when={r().list}>
                  {(list) => <span class="rcpt-group">List · {list().count.toLocaleString()} {list().count === 1 ? 'person' : 'people'}</span>}
                </Show>
                <Show when={r().group}>
                  <span class="rcpt-group">Group</span>
                </Show>
                <Show when={r().saved}>
                  <span class="rcpt-group">Contact</span>
                </Show>
              </span>
            );
          }}
        />
      </div>
    </div>
  );
}
