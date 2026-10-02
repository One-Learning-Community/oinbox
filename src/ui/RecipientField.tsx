import { Combobox, type ComboboxHandle } from '@rozie-ui/combobox-solid';
import { createMemo, createSignal, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { EmailAddress } from '../jmap/types';
import { formatAddress, parseAddressList } from '../mail/compose';
import { addUnique, completeAddress, toAddress, type Recipient } from '../mail/recipients';

interface Option {
  value: string;
  label: string;
  recipient: Recipient;
}

const listEscapes = new WeakSet<Event>();
/** Whether this Escape keypress was used up closing a suggestion list. */
export const closedSuggestions = (e: Event): boolean => listEscapes.has(e);

/**
 * To/Cc/Bcc: chips plus a text input that suggests people from mail history.
 * rozie Combobox renders the chips and the list; committing typed or pasted addresses,
 * Tab-to-pick and "no list without suggestions" are added here (docs/rozie-feedback.md).
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
  const [dismissed, setDismissed] = createSignal(false);
  let handle: ComboboxHandle | undefined;
  let root: HTMLDivElement | undefined;

  const taken = () => new Set([...props.value, ...props.others].map((a) => a.email.toLowerCase()));
  const found = createMemo(() => (dismissed() ? [] : recipients.suggest(text(), taken())));
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
  /** Combobox doesn't expose its highlighted option; its input's aria-activedescendant names it. */
  const highlighted = (): Recipient | undefined => {
    const id = root?.querySelector('input')?.getAttribute('aria-activedescendant') ?? '';
    return found()[Number(id.slice(id.lastIndexOf('-') + 1))] ?? found()[0];
  };

  // Runs after Combobox's own handler for the same keypress.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (found().length) {
        setDismissed(true);
        listEscapes.add(e);
      }
    } else if (e.defaultPrevented) {
      // Combobox picked the highlighted suggestion (Enter).
    } else if (e.key === 'Enter') {
      commitTyped();
    } else if (e.key === 'Tab' && !e.shiftKey && found().length) {
      e.preventDefault();
      addAll([toAddress(highlighted()!)]);
    } else if (e.key === ',' || e.key === ';') {
      e.preventDefault();
      commitTyped();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
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
          // paste is not one of Solid's delegated events.
          el.addEventListener('paste', onPaste);
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
          idBase={props.id}
          ariaLabel={props.label}
          value={props.value.map((a) => a.email)}
          options={options()}
          onSearch={(...args: unknown[]) => {
            setText((args[0] as { query: string }).query);
            setDismissed(false);
          }}
          onChange={(...args: unknown[]) => {
            const e = args[0] as { value: string[]; option: Option | null; selected: boolean };
            if (e.selected && e.option) addAll([toAddress(e.option.recipient)]);
            else props.onChange(props.value.filter((a) => e.value.includes(a.email)));
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
          emptySlot={() => null}
        />
      </div>
    </div>
  );
}
