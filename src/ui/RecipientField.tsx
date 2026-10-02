import { Combobox, type ComboboxHandle } from '@rozie-ui/combobox-solid';
import { createMemo, createSignal, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { EmailAddress } from '../jmap/types';
import { formatAddress, parseAddressList } from '../mail/compose';
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
  const { recipients } = useApp();
  const [text, setText] = createSignal('');
  let handle: ComboboxHandle | undefined;
  let root: HTMLDivElement | undefined;

  const taken = () => new Set([...props.value, ...props.others].map((a) => a.email.toLowerCase()));
  const found = createMemo(() => offer(recipients.suggest(text(), taken()), text()));
  const options = createMemo<Option[]>(() =>
    found().map((r) => ({ value: r.email, label: r.name ? `${r.name} ${r.email}` : r.email, recipient: r })),
  );

  const addAll = (more: EmailAddress[]) => {
    props.onChange(addUnique(props.value, more));
    setText('');
    handle?.seedQuery('');
  };
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
        addAll([toAddress(active.recipient)]);
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

  return (
    <div class="compose-field">
      <span class="compose-label">{props.label}</span>
      <div
        ref={(el) => {
          root = el;
          el.addEventListener('paste', onPaste, true);
        }}
        class="recipient-field"
        role="group"
        aria-label={props.label}
        onKeyDown={onKeyDown}
        onFocusOut={(e) => {
          if (!root?.contains(e.relatedTarget as Node | null)) commitTyped();
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
            } else if (e.selected && e.option) addAll([toAddress((e.option as Option).recipient)]);
            else props.onChange(props.value.filter((a) => (e.value as string[]).includes(a.email)));
          }}
          chipSlot={(chip) => (
            <Show when={props.value[chip.index]}>
              {(a) => (
                <>
                  <span class="rcpt-chip-label">{formatAddress(a())}</span>
                  <button
                    type="button"
                    class="rcpt-chip-remove"
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
              <span class="rcpt-option" data-email={r().email}>
                <span class="rcpt-name">{r().name || r().email}</span>
                <Show when={r().name}>
                  <span class="rcpt-email">{r().email}</span>
                </Show>
              </span>
            );
          }}
        />
      </div>
    </div>
  );
}
