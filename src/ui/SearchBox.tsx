import { Combobox, type ComboboxHandle } from '@rozie-ui/combobox-solid';
import { Popover } from '@rozie-ui/popover-solid';
import { useNavigate } from '@solidjs/router';
import { batch, createEffect, createMemo, createSignal, on, onMount, Show, type JSX } from 'solid-js';
import { useApp } from '../app/context';
import { suggesting, suggestions, type Suggestion } from '../app/searchSuggest';
import { pillError, pillLabel, pillText, readQuery, uniquePills, writeQuery, type Pill, type SimpleQuery } from '../mail/searchQuery';
import { labelPath, searchContext, searchSlug } from '../sync/selectors';
import { Icon } from './icons';
import { useAccountPath } from './path';
import { SearchPanel } from './SearchPanel';

interface Option {
  value: string;
  label: string;
  suggestion: Suggestion;
}

/** A bare "in:" should list every label, not only the first few the default limit allows. */
const MAILBOX_SUGGESTIONS = 50;
const NOBODY = new Set<string>();
const BUTTON = { width: '36px', height: '36px' };
/**
 * A press on the clear or the options button leaves the focus where it is until the click lands. On a phone the box
 * has the whole bar, and its clear button, only while the focus is in it: were the press to take the focus, the
 * button would move or go from under the finger.
 */
const keepFocus = (e: MouseEvent) => e.preventDefault();

/**
 * The search box. A search whose terms are simply ANDed shows its operators as pills and its
 * words as text; one with OR or brackets is plain text, as it always was. Either way the query
 * string in the address is what is searched for.
 */
export function SearchBox() {
  const navigate = useNavigate();
  const path = useAccountPath();
  // Mirror the current search route into the box (back/forward, deep links).
  const routeQuery = () => {
    const m = /^\/search\/([^/]+)/.exec(path());
    return m ? decodeURIComponent(m[1]!) : '';
  };
  const simple = createMemo(() => readQuery(routeQuery()));
  const go = (q: string) => navigate(q.trim() ? `/${searchSlug(q)}` : '/inbox');

  const end = (query: () => SimpleQuery | null) => <PanelButton query={query} go={go} />;

  return (
    <Show when={simple()} fallback={<PlainBox query={routeQuery()} go={go} end={end} />}>
      {(q) => <PillBox query={q()} searching={!!routeQuery()} go={go} end={end} />}
    </Show>
  );
}

/** The button at the end of the box, and the form it opens. */
function PanelButton(props: { query: () => SimpleQuery | null; go: (q: string) => void }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  const close = () => {
    setOpen(false);
    button?.focus();
  };

  return (
    <span class="search-panel-anchor">
      <Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="manual"
        placement="bottom-end"
        strategy="fixed"
        offset={8}
        anchorSlot={() => (
          <button ref={button} type="button" class="icon-btn" aria-label="Search options" aria-haspopup="dialog" aria-expanded={open()} style={BUTTON} onMouseDown={keepFocus} onClick={() => (open() ? close() : setOpen(true))}>
            <Icon name="tune" />
          </button>
        )}
      >
        <div
          class="search-panel"
          role="dialog"
          aria-label="Search options"
          onKeyDown={(e) => {
            // A day picker open inside the form takes its own Escape first.
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            e.preventDefault();
            close();
          }}
        >
          {/* Made anew each time it opens, so that it shows the search as it is now. */}
          <Show when={open()}>
            <SearchPanel query={props.query()} onSearch={(q) => { close(); props.go(writeQuery(q)); }} />
          </Show>
        </div>
      </Popover>
    </span>
  );
}

/** A search with OR or brackets: the text field of old. */
function PlainBox(props: { query: string; go: (q: string) => void; end?: (query: () => SimpleQuery | null) => JSX.Element }) {
  const [text, setText] = createSignal(props.query);
  createEffect(on(() => props.query, (q) => setText(q), { defer: true }));

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    props.go(text());
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div class="search-box">
      <form class="search-box-form" role="search" onSubmit={submit}>
        <button class="icon-btn" type="submit" aria-label="Search" style={BUTTON}>
          <Icon name="search" />
        </button>
        <input
          id="search-input"
          type="search"
          placeholder="Search mail"
          aria-label="Search mail"
          autocomplete="off"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
        />
        <Show when={text()}>
          <button class="icon-btn search-clear" type="button" aria-label="Clear search" style={BUTTON} onMouseDown={keepFocus} onClick={() => { setText(''); if (props.query) { props.go(''); (document.activeElement as HTMLElement | null)?.blur(); } }}>
            <Icon name="close" />
          </button>
        </Show>
      </form>
      {props.end?.(() => readQuery(text()))}
    </div>
  );
}

/** A simple search: rozie Combobox holds the pills as chips and the words in its input. */
function PillBox(props: { query: SimpleQuery; searching: boolean; go: (q: string) => void; end?: (query: () => SimpleQuery | null) => JSX.Element }) {
  const { engine, recipients } = useApp();
  const [pills, setPills] = createSignal<Pill[]>(props.query.pills);
  const [text, setText] = createSignal(props.query.words);
  // Where the caret stood when the text last changed: suggestions are for what is in front of it.
  const [caret, setCaret] = createSignal(props.query.words.length);
  let handle: ComboboxHandle | undefined;
  let root: HTMLFormElement | undefined;
  const input = () => root?.querySelector<HTMLInputElement>('input.rozie-combobox-input') ?? null;

  /** Sets the words, here and in Combobox's input (which says nothing when it is written to), with the caret at `at` or at the end. */
  const write = (t: string, at = t.length) => {
    batch(() => {
      setText(t);
      setCaret(at);
    });
    handle?.seedQuery(t);
    if (at < t.length) input()?.setSelectionRange(at, at);
  };
  createEffect(on(() => props.query, (q) => { setPills(q.pills); write(q.words); }, { defer: true }));
  onMount(() => {
    // Combobox takes no id for its input; the "/" shortcut and the tests find the box by this one.
    const el = input();
    if (el) el.id = 'search-input';
  });

  const ctx = createMemo(() => searchContext(engine.state.mailboxes));
  const person = (address: string) => {
    const key = address.toLowerCase();
    return recipients.suggest(address, NOBODY).find((r) => r.email.toLowerCase() === key)?.name || undefined;
  };

  const at = createMemo(() => suggesting(text().slice(0, caret())));
  const options = createMemo<Option[]>(() => {
    const a = at();
    if (!a) return [];
    const have = new Set(pills().map(pillText));
    const mailboxes = Object.values(engine.state.mailboxes);
    const limit = a.name === 'in' || a.name === 'label' ? MAILBOX_SUGGESTIONS : undefined;
    return suggestions(a, { people: (q) => recipients.suggest(q, NOBODY), mailboxes, path: (m) => labelPath(m, engine.state.mailboxes) }, limit)
      // Combobox toggles a value it already holds, so what is already a pill is never offered.
      .filter((s) => !have.has(pillText(s.pill)))
      .map((s) => ({ value: pillText(s.pill), label: s.label, suggestion: s }));
  });

  const add = (more: Pill[]) => setPills(uniquePills([...pills(), ...more]));

  const onSearch = (typed: string) => {
    const el = input();
    const end = el && el.value === typed ? (el.selectionStart ?? typed.length) : typed.length;
    // A space typed at the end of the text ends a value, unless it is inside quotes still open.
    if (end === typed.length && /\s$/.test(typed) && (typed.split('"').length - 1) % 2 === 0) {
      const q = readQuery(typed);
      if (q?.pills.length) {
        add(q.pills);
        return write(q.words ? `${q.words} ` : '');
      }
    }
    batch(() => {
      setText(typed);
      setCaret(end);
    });
  };

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const typed = text().trim();
    const q = readQuery(typed);
    if (q) {
      const all = uniquePills([...pills(), ...q.pills]);
      setPills(all);
      write(q.words);
      props.go(writeQuery({ pills: all, words: q.words }));
    } else {
      // OR or a bracket was typed: the whole search becomes plain text.
      props.go(`${writeQuery({ pills: pills(), words: '' })} ${typed}`);
    }
    input()?.blur();
  };

  // Runs before Combobox's own handler, which would drop the last pill outright.
  const onBackspace = (e: KeyboardEvent) => {
    const el = input();
    if (e.key !== 'Backspace' || e.target !== el || el?.value !== '' || !pills().length) return;
    e.preventDefault();
    e.stopPropagation();
    const last = pills()[pills().length - 1]!;
    setPills(pills().slice(0, -1));
    write(pillText(last));
  };

  const clear = () => {
    setPills([]);
    write('');
    if (props.searching) {
      props.go('');
      input()?.blur();
    } else input()?.focus();
  };

  return (
    <div class="search-box search-pills">
      <form
        ref={(el) => {
          root = el;
          el.addEventListener('keydown', onBackspace, true);
        }}
        class="search-box-form"
        role="search"
        onSubmit={submit}
        // Combobox takes Escape only to close a list that is showing.
        onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && input()?.blur()}
        // The input is one row of the box, and may be clipped away behind the pills: a press anywhere else in the box, but for its buttons and its list, is a press on the input.
        onMouseDown={(e) => {
          if ((e.target as Element).closest('button, input, [role="listbox"]')) return;
          e.preventDefault();
          input()?.focus();
        }}
      >
        <button class="icon-btn" type="submit" aria-label="Search" style={BUTTON}>
          <Icon name="search" />
        </button>
        <Combobox
          // Combobox hands over its handle once it has mounted, which is after this component's onMount.
          ref={(h) => {
            handle = h;
            h.seedQuery(props.query.words);
          }}
          multiple
          disableFilter
          block
          chipLayout="inline"
          disableOpenOnFocus
          hideEmpty
          idBase="search"
          ariaLabel="Search mail"
          placeholder={pills().length ? '' : 'Search mail'}
          value={pills().map(pillText)}
          options={options()}
          onSearch={(e) => onSearch(e.query)}
          onChange={(e) => {
            if (e.selected && e.option) {
              // The pick replaces the operator in front of the caret; the words after it stay.
              const before = at()?.before ?? '';
              const after = text().slice(caret()).trimStart();
              add([(e.option as Option).suggestion.pill]);
              write(before + after, before.length);
            } else {
              const kept = new Set(e.value as string[]);
              const next = pills().filter((p) => kept.has(pillText(p)));
              setPills(next);
              if (props.searching) props.go(writeQuery({ pills: next, words: text() }));
            }
          }}
          chipSlot={(chip) => (
            <Show when={pills()[chip.index]}>
              {(p) => {
                const label = () => pillLabel(p(), { person, locale: navigator.language });
                const bad = () => pillError(p(), ctx());
                const reason = () => `search-pill-reason-${chip.index}`;
                return (
                  <>
                    <span class="search-pill" classList={{ 'search-pill-error': !!bad() }} title={bad() ?? pillText(p())}>{label()}</span>
                    {/* Colour and a title say nothing to a screen reader: the reason is read with the pill's button. */}
                    <Show when={bad()}>{(why) => <span id={reason()} class="sr-only">{why()}</span>}</Show>
                    <button type="button" class="rcpt-chip-remove" aria-label={`Remove ${label()}`} aria-describedby={bad() ? reason() : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => chip.remove()}>
                      ×
                    </button>
                  </>
                );
              }}
            </Show>
          )}
          optionSlot={(o) => {
            const s = () => (o.option as Option).suggestion;
            return (
              <span class="rcpt-option">
                <span class="rcpt-name">{s().label}</span>
                <Show when={s().detail}>
                  <span class="rcpt-email">{s().detail}</span>
                </Show>
              </span>
            );
          }}
        />
        <Show when={pills().length || text()}>
          <button class="icon-btn search-clear" type="button" aria-label="Clear search" style={BUTTON} onMouseDown={keepFocus} onClick={clear}>
            <Icon name="close" />
          </button>
        </Show>
      </form>
      {props.end?.(() => readQuery(writeQuery({ pills: pills(), words: text() })))}
    </div>
  );
}
