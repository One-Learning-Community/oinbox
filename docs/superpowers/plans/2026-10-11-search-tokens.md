# Search tokens and the search panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search operators show in the search box as removable pills, typing an operator offers its values, and a panel off the box builds a query from a form.

**Architecture:** The query string stays the one source of truth and the URL does not change. A pure module reads a *simple* query (terms ANDed, optional negation) into pills plus words and writes it back; anything with `OR` or brackets stays plain text. The box is a rozie Combobox with the pills as chips and the words in its input; the panel is a form in a rozie Popover that takes a query and hands one back.

**Tech Stack:** SolidJS 1.9, `@solidjs/router`, rozie Combobox 0.7 / Popover 0.3 / DatePicker 0.1, Vitest with `@solidjs/testing-library` (jsdom), Playwright, Stalwart 0.16.23.

**Spec:** `docs/superpowers/specs/2026-10-11-search-tokens-design.md`. Built on the branch `search-tokens`.

## What reading Combobox 0.7's source already showed

Read on 2026-10-11 in `node_modules/@rozie-ui/combobox-solid/src/Combobox.tsx` (`onKeydown`, `onInput`, `seedQuery`). Task 1 pins each of these with a test, so that a rozie upgrade that changes one fails loudly.

- **Enter.** With no highlighted option, and with free text off (no `delimiters`, no `validate`), Combobox does nothing and does not `preventDefault`. The browser then submits the surrounding form. With a highlighted option it picks it and prevents the default. `onInput` sets the active index to 0, so whenever a list is showing its first row is highlighted.
- **Backspace.** In an empty input under `multiple`, Combobox removes the last chip itself. Its key handler is a Solid delegated handler, so a native capture listener on an ancestor that calls `stopPropagation` runs first and keeps the key from it. `seedQuery(text)` writes the input's text without firing `onSearch`.
- **Keeping the list shut.** With `disableFilter` and `hideEmpty`, no options means no popup and `aria-expanded="false"`. The host decides what the options are.
- **Two gaps, neither blocking.** The input takes no `id` (the `/` shortcut focuses `#search-input`), so the box sets it after mount. There is no live region announcing chips added or removed. Both are written up in Task 9.

## Global Constraints

- The URL of a search stays `/search/<encodeURIComponent(query)>`; `searchSlug` in `src/sync/selectors.ts` is the only thing that builds it.
- The search input keeps the id `search-input` in both the pill box and the plain box.
- A query with `OR`, `|`, `(`, `)`, `{` or `}` is never shown as pills and must return what it returns today.
- rozie components only where the spec names one (Combobox, Popover, DatePicker). If one cannot do what a task needs, stop and report; do not work around it.
- No new dependencies.
- Comments and test names follow the house style: plain sentences that say what the user sees.
- Run `pnpm -s typecheck` and `pnpm -s test` before every commit. Commit messages are one plain sentence; end each with the two attribution lines the session gives.
- Do not push. Pushes to `main` are batched by the user.

## Review Focus

1. **A pill value with a space or a quote** (`label:"Client work"`, a subject with `"`). Expected: it survives the round trip quoted, a `"` inside a value is dropped, and the search still finds the label. (Task 3.)
2. **Typing inside open quotes** (`subject:"q3 pl`, then a space). Expected: no pill is made until the quote closes. (Task 6.)
3. **The same pill twice** (picking `is:unread` when it is already there, or `from:bob from:bob` in a link). Expected: one pill; Combobox toggles a value it already holds, so a second copy must never reach it. (Tasks 3 and 6.)
4. **A plain word that looks like syntax** (`"OR"`, `"from:bob"` in quotes, `follow-up`, a lone `-`). Expected: it stays a word, is written back quoted where it was quoted, and the query stays simple. (Task 3.)
5. **A custom date range's last day.** `before:` excludes its day. Expected: "To 30 Sep" finds mail from the 30th, and reopening the panel shows the 30th, not 1 Oct. (Task 7.)

---

## File structure

| File | Responsibility |
|---|---|
| `src/mail/search.ts` (modify) | Parser. Exports its tokenizer; `to:` matches To or Cc. |
| `src/mail/searchQuery.ts` (create) | `Pill`, `SimpleQuery`, `readQuery`, `writeQuery`, `pillText`, `pillLabel`, `pillError`. Pure. |
| `src/mail/searchForm.ts` (create) | The panel's form as data: `SearchForm`, `formFromQuery`, `queryFromForm`, `formError`, `isEmptyForm`. Pure. |
| `src/app/searchSuggest.ts` (create) | `suggesting(text)`, `suggestions(...)`, `places(...)`. Pure. |
| `src/sync/selectors.ts` (modify) | Exports `searchContext(mailboxes, now)`, which `resolveView` and the box both use. |
| `src/ui/DayField.tsx` (create) | The day picker moved out of `VacationForm.tsx`, unchanged apart from an optional `min`. |
| `src/ui/SearchBox.tsx` (create) | The box: plain or pills, lists, keys, the panel button. |
| `src/ui/SearchPanel.tsx` (create) | The form component. |
| `src/ui/Shell.tsx` (modify) | Loses `SearchBox`, imports it. |
| `src/ui/icons.tsx`, `src/ui/styles.css` (modify) | A `tune` icon; styles for pills and panel. |
| `e2e/search.spec.ts`, `e2e/a11y.spec.ts` (modify) | End-to-end and axe checks. |

---

### Task 1: Pin what the box needs from Combobox

**Files:**
- Test: `src/ui/SearchBox.contract.test.tsx`

**Interfaces:**
- Consumes: `Combobox`, `ComboboxHandle` from `@rozie-ui/combobox-solid`.
- Produces: nothing. If any test here fails, **stop**: write the failing behaviour up in `docs/rozie-feedback.md` under a heading `## Combobox 0.7.0 — search box` and report to the user. Do not go on to Task 6.

- [ ] **Step 1: Write the tests**

```tsx
// src/ui/SearchBox.contract.test.tsx
import { Combobox, type ComboboxHandle } from '@rozie-ui/combobox-solid';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

// jsdom lays nothing out; the list scrolls its highlighted option into view.
Element.prototype.scrollIntoView = () => {};

/** What the search box asks of rozie Combobox. A failure here is a rozie change, not an oinbox bug. */
function box(initial: string[], options: { value: string; label: string }[] = []) {
  const [value, setValue] = createSignal(initial);
  const [opts, setOpts] = createSignal(options);
  const onSubmit = vi.fn((e: Event) => e.preventDefault());
  const onChange = vi.fn((e: { value: unknown }) => setValue(e.value as string[]));
  let handle: ComboboxHandle | undefined;
  let root: HTMLFormElement | undefined;
  render(() => (
    <form ref={root} onSubmit={onSubmit}>
      <Combobox ref={(h) => (handle = h)} multiple disableFilter hideEmpty disableOpenOnFocus chipLayout="inline" idBase="t" ariaLabel="Search mail"
        value={value()} options={opts()} onChange={onChange} />
    </form>
  ));
  const input = screen.getByRole('combobox') as HTMLInputElement;
  return { value, setOpts, onChange, onSubmit, input, handle: () => handle!, root: () => root! };
}

describe('Combobox, as the search box uses it', () => {
  it('leaves Enter alone when nothing is highlighted, so the form submits', () => {
    const { input, onChange } = box(['from:bob']);
    fireEvent.input(input, { target: { value: 'invoice' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });
    expect(notPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows no list while there are no options', () => {
    const { input } = box([]);
    fireEvent.input(input, { target: { value: 'invoice' } });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('highlights the first option as soon as there is one, and Enter picks it without submitting', () => {
    const { input, setOpts, onChange } = box([]);
    fireEvent.input(input, { target: { value: 'is:' } });
    setOpts([{ value: 'is:unread', label: 'unread' }]);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });
    expect(notPrevented).toBe(false);
    expect(onChange.mock.calls[0]![0]).toMatchObject({ selected: true, option: { value: 'is:unread' } });
  });

  it('lets a capture listener take Backspace before it removes the last chip', () => {
    const { input, root, value } = box(['from:bob']);
    root().addEventListener('keydown', (e) => { if (e.key === 'Backspace') e.stopPropagation(); }, true);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(value()).toEqual(['from:bob']);
  });

  it('writes the input with seedQuery', () => {
    const { input, handle } = box([]);
    handle().seedQuery('from:bob');
    expect(input.value).toBe('from:bob');
  });

  it('renders a chip for a value that is in no option list', () => {
    box(['from:bob']);
    expect(screen.getByText('from:bob')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm -s exec vitest run src/ui/SearchBox.contract.test.tsx`
Expected: 6 passed. Any failure: stop, as said under Interfaces.

- [ ] **Step 3: Commit**

```bash
git add src/ui/SearchBox.contract.test.tsx
git commit -m "Tests that pin what the search box needs from rozie Combobox"
```

---

### Task 2: The parser shares its tokenizer, and `to:` matches Cc

**Files:**
- Modify: `src/mail/search.ts` (the `Token` type near line 18, `OPERATORS` at 23, `tokenize` at 28, the `to` case at 111)
- Modify: `src/sync/selectors.ts:28-42`
- Test: `src/mail/search.test.ts`, `src/sync/selectors.test.ts`

**Interfaces:**
- Produces:
  - `export type Token` and `export function tokenize(input: string): Token[]` from `src/mail/search.ts`, unchanged in behaviour.
  - `export function searchContext(mailboxes: Record<Id, Mailbox>, now?: Date): SearchContext` from `src/sync/selectors.ts`.

- [ ] **Step 1: Change the existing test and add one**

In `src/mail/search.test.ts`, the test "maps address and subject operators" expects `{ to: 'alice@example.test' }`. Replace that one condition with:

```ts
{ operator: 'OR', conditions: [{ to: 'alice@example.test' }, { cc: 'alice@example.test' }] },
```

and add, inside the same `describe`:

```ts
  it('to: finds mail the person was copied on, and its negation leaves both out', () => {
    expect(parseSearch('to:nora', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ operator: 'OR', conditions: [{ to: 'nora' }, { cc: 'nora' }] }, notTrashOrSpam],
    });
    expect(parseSearch('-to:nora', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ operator: 'NOT', conditions: [{ operator: 'OR', conditions: [{ to: 'nora' }, { cc: 'nora' }] }] }, notTrashOrSpam],
    });
    expect(parseSearch('cc:nora', ctx).filter).toEqual({ operator: 'AND', conditions: [{ cc: 'nora' }, notTrashOrSpam] });
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm -s exec vitest run src/mail/search.test.ts`
Expected: 2 failed (`to:` still yields `{ to: … }`).

- [ ] **Step 3: Change the parser**

In `src/mail/search.ts`: put `export` in front of `type Token` and `function tokenize`. Take `'to'` out of the shared `case` list and give it its own:

```ts
      case 'from':
      case 'cc':
      case 'bcc':
      case 'subject':
        return v ? { [tok.name]: v } : null;
      case 'to':
        // "Mail sent to Nora" includes mail she was copied on; cc: is there for Cc alone.
        return v ? { operator: 'OR', conditions: [{ to: v }, { cc: v }] } : null;
```

- [ ] **Step 4: Move the search context into a function**

In `src/sync/selectors.ts`, above `resolveView`:

```ts
/** What the search parser needs to know about this account's mailboxes. */
export function searchContext(mailboxes: Record<Id, Mailbox>, now = new Date()): SearchContext {
  const all = Object.values(mailboxes);
  return {
    mailboxIdByRole: (role) => all.find((m) => m.role === role)?.id,
    mailboxIdByName: (name) => {
      const lower = name.toLowerCase();
      return all.find((m) => m.name.toLowerCase() === lower || labelPath(m, mailboxes).toLowerCase() === lower)?.id;
    },
    now,
  };
}
```

Change the import to `import { parseSearch, type SearchContext } from '../mail/search';` and, in `resolveView`, replace the inline object with `const parsed = parseSearch(query, searchContext(mailboxes, now));` (the `const all` line there stays only if something below still uses it; delete it otherwise).

- [ ] **Step 5: Run everything**

Run: `pnpm -s typecheck && pnpm -s test`
Expected: clean, all passing. If `src/sync/fake-jmap` has a test that sends `to`, it is unaffected: the fake already answers `OR`.

- [ ] **Step 6: Commit**

```bash
git add src/mail/search.ts src/mail/search.test.ts src/sync/selectors.ts
git commit -m "Search: to: also finds mail the person was copied on"
```

---

### Task 3: Reading a query into pills and writing it back

**Files:**
- Create: `src/mail/searchQuery.ts`
- Test: `src/mail/searchQuery.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `parseSearch`, `SearchContext` from `./search`.
- Produces:

```ts
export interface Pill { name: string; value: string; negated: boolean }   // name is an operator, or 'word' for a negated plain word
export interface SimpleQuery { pills: Pill[]; words: string }
export const EMPTY_QUERY: SimpleQuery;
export function pillText(p: Pill): string;                 // 'from:bob', '-label:"Client work"', '-draft'
export function readQuery(input: string): SimpleQuery | null;
export function writeQuery(q: SimpleQuery): string;
export function uniquePills(pills: Pill[]): Pill[];
export function pillError(p: Pill, ctx: SearchContext): string | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/mail/searchQuery.test.ts
import { describe, expect, it } from 'vitest';
import { parseSearch, type SearchContext } from './search';
import { pillError, pillText, readQuery, uniquePills, writeQuery } from './searchQuery';

const ctx: SearchContext = {
  mailboxIdByRole: (role) => ({ inbox: 'I', sent: 'S', trash: 'T', junk: 'J', drafts: 'D', archive: 'A' })[role],
  mailboxIdByName: (name) => ({ work: 'W', 'client work': 'CW' })[name.toLowerCase()],
  now: new Date(2026, 8, 25, 12, 0, 0),
};
const pill = (name: string, value: string, negated = false) => ({ name, value, negated });

/** The same conditions in any order: the box puts pills before words. */
const conditions = (q: string) => {
  const f = parseSearch(q, ctx).filter;
  const list = f && 'operator' in f && f.operator === 'AND' ? f.conditions : f ? [f] : [];
  return list.map((c) => JSON.stringify(c)).sort();
};

describe('readQuery', () => {
  it('reads operators as pills and leaves plain words as words', () => {
    expect(readQuery('invoice from:bob urgent has:attachment')).toEqual({
      pills: [pill('from', 'bob'), pill('has', 'attachment')],
      words: 'invoice urgent',
    });
  });
  it('reads a negated operator and a negated word as pills', () => {
    expect(readQuery('-from:bob -draft report')).toEqual({ pills: [pill('from', 'bob', true), pill('word', 'draft', true)], words: 'report' });
  });
  it('keeps a quoted phrase quoted, and reads a quoted value without its quotes', () => {
    expect(readQuery('"quarterly report" label:"Client work"')).toEqual({ pills: [pill('label', 'Client work')], words: '"quarterly report"' });
  });
  it('leaves an operator with nothing after it in the words, to go on typing', () => {
    expect(readQuery('invoice from:')).toEqual({ pills: [], words: 'invoice from:' });
    expect(readQuery('-from:')).toEqual({ pills: [], words: '-from:' });
  });
  it('is an empty query for nothing', () => {
    expect(readQuery('   ')).toEqual({ pills: [], words: '' });
  });
  it('keeps one of two pills that say the same', () => {
    expect(readQuery('from:bob from:bob is:unread')!.pills).toEqual([pill('from', 'bob'), pill('is', 'unread')]);
  });
  it.each(['from:bob OR from:nora', 'a | b', '(a b)', '{a b}', 'a )', 'from:bob -(x)'])('says %s is not simple', (q) => {
    expect(readQuery(q)).toBeNull();
  });
  it('keeps words that only look like syntax', () => {
    expect(readQuery('"OR" "from:bob" follow-up -')).toEqual({ pills: [], words: '"OR" "from:bob" follow-up -' });
  });
});

describe('writeQuery', () => {
  it('puts the pills first, then the words', () => {
    expect(writeQuery({ pills: [pill('from', 'bob'), pill('word', 'draft', true)], words: 'invoice urgent' })).toBe('from:bob -draft invoice urgent');
  });
  it('quotes a value with a space and drops a quote inside one', () => {
    expect(pillText(pill('label', 'Client work'))).toBe('label:"Client work"');
    expect(pillText(pill('subject', 'the "big" one'))).toBe('subject:"the big one"');
    expect(pillText(pill('word', 'two words', true))).toBe('-"two words"');
  });
  it('writes nothing for an empty query', () => {
    expect(writeQuery({ pills: [], words: '  ' })).toBe('');
  });
});

describe('round trip', () => {
  const SIMPLE = [
    'from:bob', 'to:nora@customer.test', 'cc:carol', 'bcc:dan', 'subject:"lunch plans"', 'has:attachment', 'is:unread', 'is:starred',
    'in:inbox', 'in:anywhere', 'label:work', 'label:"Client work"', 'before:2026/09/01', 'after:2026/08/01', 'older:2026/09/01', 'newer:2026/08/01',
    'older_than:7d', 'newer_than:1m', 'larger:5M', 'smaller:100K', 'size:1M', 'deliveredto:alice', 'list:announce', 'filename:report.pdf',
    '-from:bob', '-is:unread', '-draft', 'invoice', '"quarterly report"',
    'invoice from:bob urgent -label:work has:attachment "exact phrase" -spam',
  ];
  it.each(SIMPLE)('reads back what it wrote: %s', (q) => {
    const read = readQuery(q)!;
    expect(readQuery(writeQuery(read))).toEqual(read);
  });
  it.each(SIMPLE)('searches for the same thing after the trip: %s', (q) => {
    expect(conditions(writeQuery(readQuery(q)!))).toEqual(conditions(q));
  });
});

describe('uniquePills', () => {
  it('drops a pill that says what an earlier one says', () => {
    expect(uniquePills([pill('is', 'unread'), pill('from', 'bob'), pill('is', 'unread')])).toEqual([pill('is', 'unread'), pill('from', 'bob')]);
  });
});

describe('pillError', () => {
  it('is what the parser says of a value it cannot use', () => {
    expect(pillError(pill('label', 'nowhere'), ctx)).toBe('No mailbox named "nowhere"');
    expect(pillError(pill('after', 'tuesday'), ctx)).toMatch(/Can't read the date/);
    expect(pillError(pill('label', 'nowhere', true), ctx)).toBe('No mailbox named "nowhere"');
  });
  it('is null for a pill the parser accepts', () => {
    expect(pillError(pill('label', 'Client work'), ctx)).toBeNull();
    expect(pillError(pill('word', 'draft', true), ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -s exec vitest run src/mail/searchQuery.test.ts`
Expected: FAIL, cannot resolve `./searchQuery`.

- [ ] **Step 3: Implement**

```ts
// src/mail/searchQuery.ts
import { parseSearch, tokenize, type SearchContext } from './search';

/** One term of a simple search, as the search box shows it. */
export interface Pill {
  /** An operator name, or 'word' for a negated plain word. */
  name: string;
  value: string;
  negated: boolean;
}

/** A search whose terms are all joined by the implied AND. */
export interface SimpleQuery {
  pills: Pill[];
  /** The plain words, as typed, quotes kept. */
  words: string;
}

export const EMPTY_QUERY: SimpleQuery = { pills: [], words: '' };

// The tokenizer has no way to escape a quote, so one inside a value cannot be written.
const quoted = (v: string, always = false): string => {
  const clean = v.replace(/"/g, '');
  return always || clean === '' || /[\s(){}]/.test(clean) ? `"${clean}"` : clean;
};

/** The pill as query text: `from:bob`, `-label:"Client work"`, `-draft`. */
export function pillText(p: Pill): string {
  return (p.negated ? '-' : '') + (p.name === 'word' ? quoted(p.value) : `${p.name}:${quoted(p.value)}`);
}

/** The pills without any that says what an earlier one says. */
export function uniquePills(pills: Pill[]): Pill[] {
  const seen = new Set<string>();
  return pills.filter((p) => {
    const key = pillText(p);
    return !seen.has(key) && !!seen.add(key);
  });
}

/** The pills and words of a simple query, or null when the query uses OR or brackets. */
export function readQuery(input: string): SimpleQuery | null {
  const pills: Pill[] = [];
  const words: string[] = [];
  let negated = false;
  for (const tok of tokenize(input)) {
    if (tok.t === '-') {
      negated = !negated;
      continue;
    }
    if (tok.t === 'op') {
      // Nothing after the colon yet: text the user is still typing.
      if (tok.v) pills.push({ name: tok.name, value: tok.v, negated });
      else words.push(`${negated ? '-' : ''}${tok.name}:`);
    } else if (tok.t === 'word') {
      if (negated) pills.push({ name: 'word', value: tok.v, negated: true });
      // A word that was quoted may be an OR or an operator in disguise: it goes back quoted.
      else if (tok.v) words.push(quoted(tok.v, tok.quoted));
    } else {
      return null;
    }
    negated = false;
  }
  return { pills: uniquePills(pills), words: words.join(' ') };
}

/** The query string for these pills and words: pills first. */
export function writeQuery(q: SimpleQuery): string {
  return [...q.pills.map(pillText), q.words.trim()].filter(Boolean).join(' ');
}

/** Why the search cannot use this pill (a label that does not exist, a date it cannot read), or null. */
export function pillError(p: Pill, ctx: SearchContext): string | null {
  if (p.name === 'word') return null;
  return parseSearch(pillText({ ...p, negated: false }), ctx).errors[0] ?? null;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm -s exec vitest run src/mail/searchQuery.test.ts`
Expected: PASS. If "keeps words that only look like syntax" fails on the lone `-`: the tokenizer reads a `-` followed by white space or the end as a word, which is what the test expects; check `quoted('-', false)` returns `-`.

- [ ] **Step 5: Commit**

```bash
git add src/mail/searchQuery.ts src/mail/searchQuery.test.ts
git commit -m "Search: a simple query read into pills and words, and written back"
```

---

### Task 4: What a pill says

**Files:**
- Modify: `src/mail/searchQuery.ts`
- Test: `src/mail/searchQuery.test.ts`

**Interfaces:**
- Consumes: `Pill`, `pillText` (Task 3).
- Produces: `export function pillLabel(p: Pill, opts?: { person?: (address: string) => string | undefined; locale?: string }): string`

- [ ] **Step 1: Write the failing tests**

Add to `src/mail/searchQuery.test.ts` (and `pillLabel` to its import):

```ts
describe('pillLabel', () => {
  const person = (a: string) => (a === 'nora@customer.test' ? 'Nora Quinn' : undefined);
  const say = (name: string, value: string, negated = false) => pillLabel(pill(name, value, negated), { person, locale: 'en-GB' });

  it('names a person the app knows, and shows the address of one it does not', () => {
    expect(say('from', 'nora@customer.test')).toBe('from: Nora Quinn');
    expect(say('to', 'who@elsewhere.test')).toBe('to: who@elsewhere.test');
    expect(say('cc', 'NORA@customer.test')).toBe('cc: NORA@customer.test');
  });
  it('names the system mailboxes', () => {
    expect(say('in', 'inbox')).toBe('in: Inbox');
    expect(say('in', 'bin')).toBe('in: Trash');
    expect(say('in', 'spam')).toBe('in: Spam');
    expect(say('in', 'anywhere')).toBe('in: All mail');
    expect(say('in', 'Finance/2026')).toBe('in: Finance/2026');
    expect(say('label', 'Finance/2026')).toBe('label: Finance/2026');
  });
  it('spells out an age and a date', () => {
    expect(say('newer_than', '7d')).toBe('newer than: 7 days');
    expect(say('older_than', '1m')).toBe('older than: 1 month');
    expect(say('newer_than', '2y')).toBe('newer than: 2 years');
    expect(say('after', '2026/09/01')).toBe('after: 1 Sept 2026');
    expect(say('before', '2026-9-1')).toBe('before: 1 Sept 2026');
  });
  it('shows a value it cannot read as it was typed', () => {
    expect(say('after', 'tuesday')).toBe('after: tuesday');
    expect(say('newer_than', 'soon')).toBe('newer than: soon');
  });
  it('says not for a negated pill', () => {
    expect(say('from', 'bob', true)).toBe('not from: bob');
    expect(say('word', 'draft', true)).toBe('not: draft');
  });
  it('shows other operators as they are', () => {
    expect(say('has', 'attachment')).toBe('has: attachment');
    expect(say('larger', '5M')).toBe('larger: 5M');
  });
});
```

Node's `en-GB` short month for September is `Sept`. If the installed Node prints `Sep`, change the three expectations to match what `new Date(2026, 8, 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })` prints; the code is right either way.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -s exec vitest run src/mail/searchQuery.test.ts -t pillLabel`
Expected: FAIL, `pillLabel` is not exported.

- [ ] **Step 3: Implement**

Append to `src/mail/searchQuery.ts`:

```ts
const PEOPLE = new Set(['from', 'to', 'cc', 'bcc', 'deliveredto']);
const DATES = new Set(['before', 'after', 'older', 'newer']);
const PLACES: Record<string, string> = {
  inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', draft: 'Drafts', archive: 'Archive', trash: 'Trash', bin: 'Trash', spam: 'Spam', junk: 'Spam',
  anywhere: 'All mail', all: 'All mail',
};
const UNITS: Record<string, string> = { d: 'day', m: 'month', y: 'year' };

function valueLabel(p: Pill, opts: { person?: (address: string) => string | undefined; locale?: string }): string {
  if (PEOPLE.has(p.name)) return opts.person?.(p.value) ?? p.value;
  if (p.name === 'in') return PLACES[p.value.toLowerCase()] ?? p.value;
  if (p.name === 'older_than' || p.name === 'newer_than') {
    const m = /^(\d+)([dmy])$/i.exec(p.value);
    if (!m) return p.value;
    const n = Number(m[1]);
    return `${n} ${UNITS[m[2]!.toLowerCase()]}${n === 1 ? '' : 's'}`;
  }
  if (DATES.has(p.name)) {
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(p.value);
    if (!m) return p.value;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(opts.locale, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return p.value;
}

/** The pill as the box shows it: `from: Nora Quinn`, `not: draft`, `newer than: 7 days`. */
export function pillLabel(p: Pill, opts: { person?: (address: string) => string | undefined; locale?: string } = {}): string {
  const name = p.name === 'word' ? '' : p.name.replace(/_/g, ' ');
  const lead = p.negated ? (name ? `not ${name}` : 'not') : name;
  return `${lead}: ${valueLabel(p, opts)}`;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm -s exec vitest run src/mail/searchQuery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mail/searchQuery.ts src/mail/searchQuery.test.ts
git commit -m "Search: what a pill says for a person, a mailbox, an age and a date"
```

---

### Task 5: What to offer while an operator is being typed

**Files:**
- Create: `src/app/searchSuggest.ts`
- Test: `src/app/searchSuggest.test.ts`

**Interfaces:**
- Consumes: `Pill`, `pillText` from `../mail/searchQuery`; `Recipient` from `../mail/recipients`; `Mailbox` from `../jmap/types`; `isLabel` from `../sync/selectors`.
- Produces:

```ts
export interface Suggesting { before: string; name: string; negated: boolean; partial: string }
export interface Suggestion { pill: Pill; label: string; detail?: string }
export interface Place { pill: Pill; label: string }
export interface SuggestSources { people: (query: string) => Recipient[]; mailboxes: Mailbox[]; path: (m: Mailbox) => string }
export function suggesting(text: string): Suggesting | null;
export function places(mailboxes: Mailbox[], path: (m: Mailbox) => string): Place[];
export function suggestions(at: Suggesting, src: SuggestSources, limit?: number): Suggestion[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/searchSuggest.test.ts
import { describe, expect, it } from 'vitest';
import type { Mailbox } from '../jmap/types';
import type { Recipient } from '../mail/recipients';
import { places, suggesting, suggestions, type SuggestSources } from './searchSuggest';

const mb = (id: string, name: string, role: string | null = null) => ({ id, name, role, parentId: null }) as unknown as Mailbox;
const MAILBOXES = [mb('I', 'Inbox', 'inbox'), mb('S', 'Sent', 'sent'), mb('T', 'Trash', 'trash'), mb('J', 'Junk', 'junk'), mb('F', 'Finance'), mb('C', 'Client work')];
const person = (name: string, email: string): Recipient => ({ name, email, sent: 0, received: 0, last: '' });
const src: SuggestSources = {
  people: (q) => (q.toLowerCase().startsWith('no') ? [person('Nora Quinn', 'nora@customer.test'), { ...person('Team', ''), list: { id: 'g', count: 3 } }] : []),
  mailboxes: MAILBOXES,
  path: (m) => m.name,
};
const pill = (name: string, value: string, negated = false) => ({ name, value, negated });

describe('suggesting', () => {
  it('finds the operator being typed at the end of the text', () => {
    expect(suggesting('invoice from:no')).toEqual({ before: 'invoice ', name: 'from', negated: false, partial: 'no' });
    expect(suggesting('is:')).toEqual({ before: '', name: 'is', negated: false, partial: '' });
    expect(suggesting('a -label:fin')).toEqual({ before: 'a ', name: 'label', negated: true, partial: 'fin' });
    expect(suggesting('label:"Client wo')).toEqual({ before: '', name: 'label', negated: false, partial: 'Client wo' });
    expect(suggesting('FROM:no')).toEqual({ before: '', name: 'from', negated: false, partial: 'no' });
  });
  it('is nothing for plain words, a finished value, or an operator with no list', () => {
    expect(suggesting('invoice')).toBeNull();
    expect(suggesting('from:nora ')).toBeNull();
    expect(suggesting('subject:lun')).toBeNull();
    expect(suggesting('after:2026')).toBeNull();
    expect(suggesting('xfrom:no')).toBeNull();
    expect(suggesting('label:"Client work"')).toBeNull();
  });
});

describe('suggestions', () => {
  it('offers people by address, and no groups', () => {
    expect(suggestions(suggesting('from:no')!, src)).toEqual([{ pill: pill('from', 'nora@customer.test'), label: 'Nora Quinn', detail: 'nora@customer.test' }]);
  });
  it('keeps the negation of what was typed', () => {
    expect(suggestions(suggesting('-to:no')!, src)[0]!.pill).toEqual(pill('to', 'nora@customer.test', true));
  });
  it('offers the mailboxes this account has, then All mail, then labels, for in:', () => {
    expect(suggestions(suggesting('in:')!, src).map((s) => s.label)).toEqual(['Inbox', 'Sent', 'Spam', 'Trash', 'All mail', 'Client work', 'Finance']);
  });
  it('narrows by what was typed, whatever its case', () => {
    expect(suggestions(suggesting('in:FIN')!, src).map((s) => s.pill)).toEqual([pill('label', 'Finance')]);
    expect(suggestions(suggesting('in:tr')!, src).map((s) => s.pill)).toEqual([pill('in', 'trash')]);
  });
  it('offers only labels for label:', () => {
    expect(suggestions(suggesting('label:')!, src).map((s) => s.pill)).toEqual([pill('label', 'Client work'), pill('label', 'Finance')]);
  });
  it('offers the fixed lists for has: and is:', () => {
    expect(suggestions(suggesting('has:')!, src).map((s) => s.pill.value)).toEqual(['attachment']);
    expect(suggestions(suggesting('is:un')!, src).map((s) => s.pill.value)).toEqual(['unread', 'unstarred']);
    expect(suggestions(suggesting('is:')!, src).map((s) => s.pill.value)).toEqual(['unread', 'read', 'starred', 'unstarred', 'important']);
  });
  it('stops at the limit', () => {
    expect(suggestions(suggesting('in:')!, src, 3)).toHaveLength(3);
  });
});

describe('places', () => {
  it('leaves out a system mailbox the account does not have', () => {
    expect(places([mb('I', 'Inbox', 'inbox')], (m) => m.name).map((p) => p.label)).toEqual(['Inbox', 'All mail']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -s exec vitest run src/app/searchSuggest.test.ts`
Expected: FAIL, cannot resolve `./searchSuggest`.

- [ ] **Step 3: Implement**

```ts
// src/app/searchSuggest.ts
import type { Mailbox } from '../jmap/types';
import type { Recipient } from '../mail/recipients';
import type { Pill } from '../mail/searchQuery';
import { isLabel } from '../sync/selectors';

/** The operator being typed at the end of the search box's text. */
export interface Suggesting {
  /** The text in front of the operator, kept when a suggestion replaces the rest. */
  before: string;
  name: string;
  negated: boolean;
  partial: string;
}

export interface Suggestion {
  pill: Pill;
  label: string;
  detail?: string;
}

export interface Place {
  pill: Pill;
  label: string;
}

export interface SuggestSources {
  people: (query: string) => Recipient[];
  mailboxes: Mailbox[];
  path: (m: Mailbox) => string;
}

const PEOPLE = new Set(['from', 'to', 'cc', 'bcc']);
const FIXED: Record<string, string[]> = { has: ['attachment'], is: ['unread', 'read', 'starred', 'unstarred', 'important'] };
const LISTED = new Set([...PEOPLE, 'in', 'label', 'has', 'is']);
// An operator at the end of the text, its value not yet finished: unquoted, or inside quotes still open.
const TAIL = /(?:^|\s)(-?)([a-z_]+):(?:"([^"]*)|([^\s"(){}]*))$/i;

/** Which list the text asks for, or null when it ends in plain words or in an operator that has none. */
export function suggesting(text: string): Suggesting | null {
  const m = TAIL.exec(text);
  if (!m) return null;
  const name = m[2]!.toLowerCase();
  if (!LISTED.has(name)) return null;
  const start = m.index + (/^\s/.test(m[0]) ? 1 : 0);
  return { before: text.slice(0, start), name, negated: m[1] === '-', partial: m[3] ?? m[4] ?? '' };
}

/** In sidebar order; `in:spam` is the junk mailbox. */
const SYSTEM: [value: string, role: string, label: string][] = [
  ['inbox', 'inbox', 'Inbox'], ['sent', 'sent', 'Sent'], ['drafts', 'drafts', 'Drafts'], ['archive', 'archive', 'Archive'], ['spam', 'junk', 'Spam'], ['trash', 'trash', 'Trash'],
];

/** Where a search can look: the system mailboxes this account has, all mail, then its labels by path. */
export function places(mailboxes: Mailbox[], path: (m: Mailbox) => string): Place[] {
  const roles = new Set(mailboxes.map((m) => m.role));
  const system = SYSTEM.filter(([, role]) => roles.has(role)).map(([value, , label]) => ({ pill: { name: 'in', value, negated: false }, label }));
  const labels = mailboxes.filter(isLabel).map((m) => path(m)).sort((a, b) => a.localeCompare(b)).map((p) => ({ pill: { name: 'label', value: p, negated: false }, label: p }));
  return [...system, { pill: { name: 'in', value: 'anywhere', negated: false }, label: 'All mail' }, ...labels];
}

/** What to offer for the operator being typed. Every pill carries the negation that was typed. */
export function suggestions(at: Suggesting, src: SuggestSources, limit = 8): Suggestion[] {
  const { name, negated } = at;
  const typed = at.partial.toLowerCase();
  let found: Suggestion[];
  if (PEOPLE.has(name)) {
    // A group is not an address a message can be from or to.
    found = src.people(at.partial).filter((r) => !r.list && r.email).map((r) => ({ pill: { name, value: r.email, negated }, label: r.name || r.email, ...(r.name ? { detail: r.email } : {}) }));
  } else if (name === 'in' || name === 'label') {
    found = places(src.mailboxes, src.path)
      .filter((p) => (name === 'in' || p.pill.name === 'label') && (p.label.toLowerCase().includes(typed) || p.pill.value.toLowerCase().includes(typed)))
      .map((p) => ({ pill: { ...p.pill, negated }, label: p.label }));
  } else {
    found = (FIXED[name] ?? []).filter((v) => v.startsWith(typed)).map((v) => ({ pill: { name, value: v, negated }, label: v }));
  }
  return found.slice(0, limit);
}
```

Check `isLabel` in `src/sync/selectors.ts:94` takes a `Mailbox` and is true for a mailbox with no role; if the test's bare `mb()` objects need another field for it to say so, add that field to the test's `mb` helper, not a special case here.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm -s exec vitest run src/app/searchSuggest.test.ts && pnpm -s typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/searchSuggest.ts src/app/searchSuggest.test.ts
git commit -m "Search: what to offer while an operator is being typed"
```

---

### Task 6: The search box with pills

**Files:**
- Create: `src/ui/SearchBox.tsx`
- Modify: `src/ui/Shell.tsx:156-196` (delete `SearchBox`; add `import { SearchBox } from './SearchBox';`; drop imports Shell no longer uses, such as `searchSlug` if nothing else there needs it)
- Modify: `src/ui/styles.css` (after the `.search-box` rules at line 110)
- Test: `src/ui/SearchBox.test.tsx`

**Interfaces:**
- Consumes: `readQuery`, `writeQuery`, `pillText`, `pillLabel`, `pillError`, `uniquePills`, `Pill`, `SimpleQuery` (Tasks 3, 4); `suggesting`, `suggestions`, `Suggestion` (Task 5); `searchContext`, `searchSlug`, `labelPath` from `../sync/selectors`; `useAccountPath` from `./path`; `useApp()` giving `engine.state.mailboxes` and `recipients.suggest(query, exclude)`.
- Produces: `export function SearchBox(): JSX.Element`. Task 8 adds the panel button to both boxes through the `end` prop of the two inner components defined here.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/ui/SearchBox.test.tsx
import { Route } from '@solidjs/router';
import { fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '../jmap/types';
import { contactsKit } from './contacts-test-kit';
import { SearchBox } from './SearchBox';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));
// jsdom lays nothing out; the list scrolls its highlighted option into view.
Element.prototype.scrollIntoView = () => {};

const mb = (id: string, name: string, role: string | null = null) => ({ id, name, role, parentId: null }) as unknown as Mailbox;
const mailboxes = { I: mb('I', 'Inbox', 'inbox'), T: mb('T', 'Trash', 'trash'), F: mb('F', 'Finance') };
const nora = { name: 'Nora Quinn', email: 'nora@customer.test', sent: 0, received: 0, last: '' };

function box(path = '/inbox') {
  const kit = contactsKit({
    engine: { state: { mailboxes } },
    recipients: { suggest: (q: string) => (q.toLowerCase().startsWith('no') ? [nora] : []) },
  } as never);
  kit.show(path, () => <Route path="*" component={SearchBox} />);
  const input = () => document.getElementById('search-input') as HTMLInputElement;
  const type = (text: string) => fireEvent.input(input(), { target: { value: text } });
  const submit = () => fireEvent.submit(screen.getByRole('search'));
  const pills = () => [...document.querySelectorAll('.search-pill')].map((el) => el.textContent);
  return { ...kit, input, type, submit, pills };
}

describe('SearchBox', () => {
  it('shows a simple search as pills, with the words in the input', () => {
    const { pills, input } = box('/search/' + encodeURIComponent('invoice from:nora@customer.test has:attachment'));
    expect(pills()).toEqual(['from: Nora Quinn', 'has: attachment']);
    expect(input().value).toBe('invoice');
  });

  it('shows a search with OR as plain text, in an input with the same id', () => {
    const { pills, input } = box('/search/' + encodeURIComponent('from:bob OR from:nora'));
    expect(pills()).toEqual([]);
    expect(input().value).toBe('from:bob OR from:nora');
  });

  it('searches for typed words on submit, and keeps the route as it was written before', () => {
    const { type, submit, path } = box();
    type('zeppelin');
    submit();
    expect(path()).toBe('/search/zeppelin');
  });

  it('turns typed operators into pills on submit', () => {
    const { type, submit, path, pills } = box();
    type('invoice from:bob');
    submit();
    expect(path()).toBe('/search/' + encodeURIComponent('from:bob invoice'));
    expect(pills()).toEqual(['from: bob']);
  });

  it('makes a pill when a space ends an operator, and leaves the words', () => {
    const { type, pills, input, path } = box();
    type('invoice is:unread ');
    expect(pills()).toEqual(['is: unread']);
    expect(input().value).toBe('invoice ');
    expect(path()).toBe('/inbox');
  });

  it('makes no pill from a space inside quotes still open', () => {
    const { type, pills, input } = box();
    type('subject:"q3 ');
    expect(pills()).toEqual([]);
    expect(input().value).toBe('subject:"q3 ');
  });

  it('opens no list for plain words', () => {
    const { type, input } = box();
    type('nora');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('offers people after from:, and Enter makes the pill without searching', async () => {
    const { type, input, pills, path } = box();
    type('invoice from:no');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(pills()).toEqual(['from: Nora Quinn']);
    expect(input().value).toBe('invoice ');
    expect(path()).toBe('/inbox');
  });

  it('does not offer what is already a pill', async () => {
    const { type } = box('/search/' + encodeURIComponent('is:unread'));
    type('is:un');
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['unstarred']));
  });

  it('turns the last pill back into text on Backspace in an empty input', () => {
    const { input, pills } = box('/search/' + encodeURIComponent('from:bob is:unread'));
    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(pills()).toEqual(['from: bob']);
    expect(input().value).toBe('is:unread');
  });

  it('removes a pill with its button and searches again', () => {
    const { path, pills } = box('/search/' + encodeURIComponent('from:bob is:unread'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove is: unread' }));
    expect(pills()).toEqual(['from: bob']);
    expect(path()).toBe('/search/' + encodeURIComponent('from:bob'));
  });

  it('goes back to the Inbox when the last pill of a search is removed', () => {
    const { path } = box('/search/' + encodeURIComponent('is:unread'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove is: unread' }));
    expect(path()).toBe('/inbox');
  });

  it('marks a pill the search cannot use, and says why', () => {
    box('/search/' + encodeURIComponent('label:nowhere'));
    const bad = document.querySelector('.search-pill-error')!;
    expect(bad.textContent).toBe('label: nowhere');
    expect(bad.getAttribute('title')).toBe('No mailbox named "nowhere"');
  });

  it('clears pills and words, and leaves a search', () => {
    const { path, pills, input } = box('/search/' + encodeURIComponent('from:bob invoice'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(pills()).toEqual([]);
    expect(input().value).toBe('');
    expect(path()).toBe('/inbox');
  });

  it('follows the route: back to a search with OR is plain text again', async () => {
    const kit = box('/search/' + encodeURIComponent('from:bob'));
    expect(kit.pills()).toEqual(['from: bob']);
    kit.show('/search/' + encodeURIComponent('a OR b'), () => <Route path="*" component={SearchBox} />);
    await waitFor(() => expect(kit.input().value).toBe('a OR b'));
  });
});
```

`contactsKit` (`src/ui/contacts-test-kit.tsx`) builds the app context from `extra`; `engine` and `recipients` are passed through it as the recipient field's tests do. `useAccountPath` needs `spaces.current().info`, which the kit provides with an empty `base`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -s exec vitest run src/ui/SearchBox.test.tsx`
Expected: FAIL, cannot resolve `./SearchBox`.

- [ ] **Step 3: Write the component**

```tsx
// src/ui/SearchBox.tsx
import { Combobox, type ComboboxHandle } from '@rozie-ui/combobox-solid';
import { useNavigate } from '@solidjs/router';
import { createEffect, createMemo, createSignal, on, onMount, Show, type JSX } from 'solid-js';
import { useApp } from '../app/context';
import { suggesting, suggestions, type Suggestion } from '../app/searchSuggest';
import { pillError, pillLabel, pillText, readQuery, uniquePills, writeQuery, type Pill, type SimpleQuery } from '../mail/searchQuery';
import { labelPath, searchContext, searchSlug } from '../sync/selectors';
import { Icon } from './icons';
import { useAccountPath } from './path';

interface Option {
  value: string;
  label: string;
  suggestion: Suggestion;
}

const NOBODY = new Set<string>();
const BUTTON = { width: '36px', height: '36px' };

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

  return (
    <Show when={simple()} fallback={<PlainBox query={routeQuery()} go={go} />}>
      {(q) => <PillBox query={q()} searching={!!routeQuery()} go={go} />}
    </Show>
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
    <form class="search-box" role="search" onSubmit={submit}>
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
        <button class="icon-btn" type="button" aria-label="Clear search" style={BUTTON} onClick={() => { setText(''); props.go(''); }}>
          <Icon name="close" />
        </button>
      </Show>
      {props.end?.(() => readQuery(text()))}
    </form>
  );
}

/** A simple search: rozie Combobox holds the pills as chips and the words in its input. */
function PillBox(props: { query: SimpleQuery; searching: boolean; go: (q: string) => void; end?: (query: () => SimpleQuery | null) => JSX.Element }) {
  const { engine, recipients } = useApp();
  const [pills, setPills] = createSignal<Pill[]>(props.query.pills);
  const [text, setText] = createSignal(props.query.words);
  let handle: ComboboxHandle | undefined;
  let root: HTMLFormElement | undefined;
  const input = () => root?.querySelector<HTMLInputElement>('input.rozie-combobox-input') ?? null;

  /** Sets the words, here and in Combobox's input (which says nothing when it is written to). */
  const write = (t: string) => {
    setText(t);
    handle?.seedQuery(t);
  };
  createEffect(on(() => props.query, (q) => { setPills(q.pills); write(q.words); }, { defer: true }));
  onMount(() => {
    // Combobox takes no id for its input; the "/" shortcut and the tests find the box by this one.
    const el = input();
    if (el) el.id = 'search-input';
    handle?.seedQuery(props.query.words);
  });

  const ctx = createMemo(() => searchContext(engine.state.mailboxes));
  const person = (address: string) => {
    const key = address.toLowerCase();
    return recipients.suggest(address, NOBODY).find((r) => r.email.toLowerCase() === key)?.name || undefined;
  };

  const at = createMemo(() => suggesting(text()));
  const options = createMemo<Option[]>(() => {
    const a = at();
    if (!a) return [];
    const have = new Set(pills().map(pillText));
    const mailboxes = Object.values(engine.state.mailboxes);
    return suggestions(a, { people: (q) => recipients.suggest(q, NOBODY), mailboxes, path: (m) => labelPath(m, engine.state.mailboxes) })
      // Combobox toggles a value it already holds, so what is already a pill is never offered.
      .filter((s) => !have.has(pillText(s.pill)))
      .map((s) => ({ value: pillText(s.pill), label: s.label, suggestion: s }));
  });

  const add = (more: Pill[]) => setPills(uniquePills([...pills(), ...more]));

  const onSearch = (typed: string) => {
    // A space ends a value, unless it is inside quotes still open.
    if (/\s$/.test(typed) && (typed.split('"').length - 1) % 2 === 0) {
      const q = readQuery(typed);
      if (q?.pills.length) {
        add(q.pills);
        return write(q.words ? `${q.words} ` : '');
      }
    }
    setText(typed);
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
    if (props.searching) props.go('');
    else input()?.focus();
  };

  return (
    <form
      ref={(el) => {
        root = el;
        el.addEventListener('keydown', onBackspace, true);
      }}
      class="search-box search-pills"
      role="search"
      onSubmit={submit}
      // Combobox takes Escape only to close a list that is showing.
      onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && input()?.blur()}
    >
      <button class="icon-btn" type="submit" aria-label="Search" style={BUTTON}>
        <Icon name="search" />
      </button>
      <Combobox
        ref={(h) => (handle = h)}
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
            add([(e.option as Option).suggestion.pill]);
            write(at()?.before ?? '');
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
              return (
                <>
                  <span class="search-pill" classList={{ 'search-pill-error': !!bad() }} title={bad() ?? pillText(p())}>{label()}</span>
                  <button type="button" class="rcpt-chip-remove" aria-label={`Remove ${label()}`} onMouseDown={(e) => e.preventDefault()} onClick={() => chip.remove()}>
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
        <button class="icon-btn" type="button" aria-label="Clear search" style={BUTTON} onClick={clear}>
          <Icon name="close" />
        </button>
      </Show>
      {props.end?.(() => readQuery(writeQuery({ pills: pills(), words: text() })))}
    </form>
  );
}
```

- [ ] **Step 4: Take `SearchBox` out of Shell**

In `src/ui/Shell.tsx` delete the `function SearchBox() { … }` block (lines 156–196), add `import { SearchBox } from './SearchBox';` among the `./` imports in alphabetical place, and remove from Shell's imports whatever `pnpm -s typecheck` now reports as unused.

- [ ] **Step 5: Style the pills**

In `src/ui/styles.css`, after the `.search-box input` rule:

```css
/* The search box with pills: rozie Combobox, drawn to sit inside the rounded box. */
.search-pills { height: auto; min-height: 48px; }
.search-pills .rozie-combobox { flex: 1; min-width: 0; }
.search-pills {
  --rozie-combobox-bg: transparent;
  --rozie-combobox-color: var(--text);
  --rozie-combobox-border-width: 0;
  --rozie-combobox-focus-ring-width: 0;
  --rozie-combobox-font: inherit;
  --rozie-combobox-inline-padding: 6px 0;
  --rozie-combobox-inline-input-padding: 4px 0;
  --rozie-combobox-inline-input-min-width: 100px;
  --rozie-combobox-chip-gap: 4px;
  --rozie-combobox-chip-bg: var(--chip);
  --rozie-combobox-chip-color: var(--text);
  --rozie-combobox-list-bg: var(--surface);
  --rozie-combobox-list-border-color: var(--border);
  --rozie-combobox-list-shadow: var(--shadow);
  --rozie-combobox-option-active-bg: var(--hover);
  --rozie-combobox-option-color: var(--text);
}
/* On a phone the plain box is 44px high (.topbar .search-box); with pills it grows instead. */
.topbar .search-pills { height: auto; min-height: 44px; }
.search-pill { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.search-pill-error { color: var(--danger-text); text-decoration: underline wavy; }
```

The token names are the ones `.recipient-field` sets at `styles.css:361`; if `pnpm dev` shows the list or a chip unstyled in the dark theme, compare with that block and with the tokens set at lines 461–464.

- [ ] **Step 6: Run to verify the tests pass**

Run: `pnpm -s exec vitest run src/ui/SearchBox.test.tsx && pnpm -s typecheck && pnpm -s test`
Expected: PASS, clean, all green.

If "offers people after from:" finds the pill reading `from: nora@customer.test`: the test's `recipients.suggest` answers only queries starting `no`, and the name lookup queries the full address `nora@customer.test`, which does start with `no`; check the `person` function's comparison.

- [ ] **Step 7: Look at it**

Run `pnpm dev` against the dev stack, sign in as alice, and check by hand: `/` focuses the box; typing `from:` then `bo` lists Bob; Enter makes the pill; Enter again searches; the pill's × searches again; Backspace hands the pill back as text; a link to `/search/from:bob%20OR%20from:nora` shows plain text; light and dark themes.

- [ ] **Step 8: Commit**

```bash
git add src/ui/SearchBox.tsx src/ui/SearchBox.test.tsx src/ui/Shell.tsx src/ui/styles.css
git commit -m "Search: operators show as pills in the search box, and typing one offers its values"
```

---

### Task 7: The panel's form, as data and as a component

**Files:**
- Create: `src/mail/searchForm.ts`, `src/ui/SearchPanel.tsx`, `src/ui/DayField.tsx`
- Modify: `src/ui/VacationForm.tsx` (remove `DayField` and `dayLabel`, import them)
- Modify: `src/ui/styles.css`
- Test: `src/mail/searchForm.test.ts`, `src/ui/SearchPanel.test.tsx`

**Interfaces:**
- Consumes: `Pill`, `SimpleQuery`, `pillText`, `uniquePills` (Task 3); `tokenize` (Task 2); `places`, `Place` (Task 5); `addDays(day: string, n: number): string` from `../mail/settings` (days as `YYYY-MM-DD`).
- Produces:

```ts
// src/mail/searchForm.ts
export interface SearchForm {
  from: string; to: string; subject: string; words: string; without: string;
  /** '' for everywhere but Spam and Trash, or a pill's text: 'in:inbox', 'label:"Client work"'. */
  where: string;
  date: 'any' | '7d' | '1m' | '1y' | 'custom';
  /** First and last day of a custom range, YYYY-MM-DD, or '' for open. Both are included. */
  first: string; last: string;
  attachment: boolean; unread: boolean; starred: boolean;
  /** Pills the form has no field for; written back as they are. */
  rest: Pill[];
}
export const EMPTY_FORM: SearchForm;
export function formFromQuery(q: SimpleQuery): SearchForm;
export function queryFromForm(f: SearchForm): SimpleQuery;
export function formError(f: SearchForm): string | null;
export function isEmptyForm(f: SearchForm): boolean;

// src/ui/SearchPanel.tsx
export function SearchPanel(props: { query: SimpleQuery | null; onSearch: (q: SimpleQuery) => void }): JSX.Element;

// src/ui/DayField.tsx
export function DayField(props: { label: string; value: string | null; empty: string; min?: string; onChange: (day: string | null) => void }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests for the data**

```ts
// src/mail/searchForm.test.ts
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, formError, formFromQuery, isEmptyForm, queryFromForm } from './searchForm';
import { readQuery, writeQuery } from './searchQuery';

const form = (q: string) => formFromQuery(readQuery(q)!);
const back = (q: string) => writeQuery(queryFromForm(form(q)));

describe('formFromQuery', () => {
  it('fills each field from its pill', () => {
    expect(form('from:nora@customer.test to:bob subject:"lunch plans" in:inbox has:attachment is:unread is:starred invoice -draft -spam')).toEqual({
      ...EMPTY_FORM,
      from: 'nora@customer.test', to: 'bob', subject: 'lunch plans', words: 'invoice', without: 'draft spam', where: 'in:inbox',
      attachment: true, unread: true, starred: true,
    });
  });
  it('reads the presets and a custom range, whose last day is the day before before:', () => {
    expect(form('newer_than:7d').date).toBe('7d');
    expect(form('newer_than:1m').date).toBe('1m');
    expect(form('newer_than:1y').date).toBe('1y');
    expect(form('after:2026/09/01 before:2026/10/01')).toMatchObject({ date: 'custom', first: '2026-09-01', last: '2026-09-30' });
    expect(form('after:2026/09/01')).toMatchObject({ date: 'custom', first: '2026-09-01', last: '' });
  });
  it('keeps what it has no field for', () => {
    const f = form('larger:5M cc:carol -from:bob newer_than:3d from:a from:b is:read');
    expect(f.from).toBe('a');
    expect(f.rest.map((p) => `${p.negated ? '-' : ''}${p.name}:${p.value}`)).toEqual(['larger:5M', 'cc:carol', '-from:bob', 'newer_than:3d', 'from:b', 'is:read']);
  });
  it('reads a label with a space', () => {
    expect(form('label:"Client work"').where).toBe('label:"Client work"');
  });
});

describe('queryFromForm', () => {
  it.each([
    'from:nora@customer.test', 'to:bob', 'subject:"lunch plans"', 'in:inbox', 'label:"Client work"', 'in:anywhere', 'has:attachment', 'is:unread', 'is:starred',
    'newer_than:7d', 'newer_than:1m', 'newer_than:1y', 'after:2026/09/01 before:2026/10/01', 'after:2026/09/01', 'before:2026/10/01',
    '-draft -spam', 'invoice "exact phrase"',
    'from:a larger:5M cc:carol -from:bob invoice',
  ])('writes back what it was given: %s', (q) => {
    expect(readQuery(back(q))).toEqual(readQuery(q));
  });
  it('writes a name with a space as a quoted value', () => {
    expect(writeQuery(queryFromForm({ ...EMPTY_FORM, from: 'Nora Quinn' }))).toBe('from:"Nora Quinn"');
  });
  it('writes each word of "doesn\'t have" as its own negation, and a quoted phrase as one', () => {
    expect(writeQuery(queryFromForm({ ...EMPTY_FORM, without: 'draft "out of office"' }))).toBe('-draft -"out of office"');
  });
  it('writes nothing for dates when the range is custom but empty', () => {
    expect(writeQuery(queryFromForm({ ...EMPTY_FORM, date: 'custom' }))).toBe('');
  });
  it('trims the fields', () => {
    expect(writeQuery(queryFromForm({ ...EMPTY_FORM, from: '  bob ', words: ' invoice  ' }))).toBe('from:bob invoice');
  });
});

describe('formError and isEmptyForm', () => {
  it('refuses a range that ends before it starts', () => {
    expect(formError({ ...EMPTY_FORM, date: 'custom', first: '2026-09-10', last: '2026-09-01' })).toBe('The last day is before the first.');
    expect(formError({ ...EMPTY_FORM, date: 'custom', first: '2026-09-10', last: '2026-09-10' })).toBeNull();
    expect(formError({ ...EMPTY_FORM, date: '7d', first: '2026-09-10', last: '2026-09-01' })).toBeNull();
  });
  it('knows a form with nothing to search for', () => {
    expect(isEmptyForm(EMPTY_FORM)).toBe(true);
    expect(isEmptyForm({ ...EMPTY_FORM, from: '  ' })).toBe(true);
    expect(isEmptyForm({ ...EMPTY_FORM, date: 'custom' })).toBe(true);
    expect(isEmptyForm({ ...EMPTY_FORM, unread: true })).toBe(false);
    expect(isEmptyForm(form('larger:5M'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -s exec vitest run src/mail/searchForm.test.ts`
Expected: FAIL, cannot resolve `./searchForm`.

- [ ] **Step 3: Implement the data**

```ts
// src/mail/searchForm.ts
import { tokenize } from './search';
import { pillText, uniquePills, type Pill, type SimpleQuery } from './searchQuery';
import { addDays } from './settings';

/** The search panel's form. */
export interface SearchForm {
  from: string;
  to: string;
  subject: string;
  words: string;
  without: string;
  /** '' for everywhere but Spam and Trash, or a pill's text: 'in:inbox', 'label:"Client work"'. */
  where: string;
  date: 'any' | '7d' | '1m' | '1y' | 'custom';
  /** First and last day of a custom range, YYYY-MM-DD, or '' for open. Both are included. */
  first: string;
  last: string;
  attachment: boolean;
  unread: boolean;
  starred: boolean;
  /** Pills the form has no field for; written back as they are. */
  rest: Pill[];
}

export const EMPTY_FORM: SearchForm = {
  from: '', to: '', subject: '', words: '', without: '', where: '', date: 'any', first: '', last: '', attachment: false, unread: false, starred: false, rest: [],
};

const PRESETS = new Set(['7d', '1m', '1y']);
/** `2026/9/1` or `2026-09-01` as `2026-09-01`, or null. */
const day = (v: string): string | null => {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : null;
};
const slashed = (d: string) => d.replace(/-/g, '/');
const phrase = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

/** The form for a simple query. The first pill of a kind fills its field; the rest are kept aside. */
export function formFromQuery(q: SimpleQuery): SearchForm {
  const f: SearchForm = { ...EMPTY_FORM, words: q.words, rest: [] };
  const without: string[] = [];
  for (const p of q.pills) {
    const d = day(p.value);
    if (p.negated) {
      if (p.name === 'word') without.push(phrase(p.value));
      else f.rest.push(p);
    } else if ((p.name === 'from' || p.name === 'to' || p.name === 'subject') && !f[p.name]) f[p.name] = p.value;
    else if ((p.name === 'in' || p.name === 'label') && !f.where) f.where = pillText(p);
    else if (p.name === 'newer_than' && PRESETS.has(p.value) && f.date === 'any') f.date = p.value as SearchForm['date'];
    else if (p.name === 'after' && d && !f.first && (f.date === 'any' || f.date === 'custom')) (f.date = 'custom'), (f.first = d);
    // before: leaves its own day out, so the last day shown is the one before it.
    else if (p.name === 'before' && d && !f.last && (f.date === 'any' || f.date === 'custom')) (f.date = 'custom'), (f.last = addDays(d, -1));
    else if (p.name === 'has' && p.value === 'attachment' && !f.attachment) f.attachment = true;
    else if (p.name === 'is' && p.value === 'unread' && !f.unread) f.unread = true;
    else if (p.name === 'is' && p.value === 'starred' && !f.starred) f.starred = true;
    else f.rest.push(p);
  }
  f.without = without.join(' ');
  return f;
}

/** The query the form asks for. */
export function queryFromForm(f: SearchForm): SimpleQuery {
  const pills: Pill[] = [];
  const add = (name: string, value: string) => value.trim() && pills.push({ name, value: value.trim(), negated: false });
  add('from', f.from);
  add('to', f.to);
  add('subject', f.subject);
  if (f.where) {
    const m = /^(in|label):"?([^"]*)"?$/.exec(f.where);
    if (m) add(m[1]!, m[2]!);
  }
  if (PRESETS.has(f.date)) add('newer_than', f.date);
  if (f.date === 'custom') {
    if (f.first) add('after', slashed(f.first));
    if (f.last) add('before', slashed(addDays(f.last, 1)));
  }
  if (f.attachment) add('has', 'attachment');
  if (f.unread) add('is', 'unread');
  if (f.starred) add('is', 'starred');
  // A minus typed in "doesn't have" changes nothing: the field already negates. OR and brackets there are dropped.
  for (const tok of tokenize(f.without)) {
    if (tok.t === 'word' && tok.v) pills.push({ name: 'word', value: tok.v, negated: true });
    else if (tok.t === 'op' && tok.v) pills.push({ name: tok.name, value: tok.v, negated: true });
  }
  return { pills: uniquePills([...pills, ...f.rest]), words: f.words.trim().replace(/\s+/g, ' ') };
}

/** What is wrong with the form, or null. */
export function formError(f: SearchForm): string | null {
  return f.date === 'custom' && f.first && f.last && f.last < f.first ? 'The last day is before the first.' : null;
}

/** Whether the form asks for nothing. */
export function isEmptyForm(f: SearchForm): boolean {
  const q = queryFromForm(f);
  return !q.pills.length && !q.words;
}
```

`addDays` (`src/mail/settings.ts:92`) takes and returns `YYYY-MM-DD` and works in UTC, so a negative count is fine.

- [ ] **Step 4: Run to verify the data tests pass**

Run: `pnpm -s exec vitest run src/mail/searchForm.test.ts`
Expected: PASS. In "keeps what it has no field for", `-from:bob` sits in `rest` in the order the pills came; if the order differs, the test's expected list is the specification: pills are visited once, in order.

- [ ] **Step 5: Commit the data**

```bash
git add src/mail/searchForm.ts src/mail/searchForm.test.ts
git commit -m "Search: the panel's form read from a query and written back to one"
```

- [ ] **Step 6: Move the day field out of the vacation form**

Create `src/ui/DayField.tsx` holding `dayLabel` (from `VacationForm.tsx:12-13`) and `DayField` (from `VacationForm.tsx:125-185`) exactly as they are, with `export` on `DayField`, `min` made optional (`min?: string`), and the imports they need (`createEffect`, `createSignal`, `on` from `solid-js`; `Popover` and `DatePicker`, `DatePickerHandle` as `VacationForm.tsx` imports them). Delete both from `VacationForm.tsx`, add `import { DayField } from './DayField';` there, and remove the imports it no longer uses.

Run: `pnpm -s typecheck && pnpm -s exec vitest run src/ui/VacationForm`
Expected: clean; the vacation form's tests pass unchanged.

- [ ] **Step 7: Write the failing component tests**

```tsx
// src/ui/SearchPanel.test.tsx
import { Route } from '@solidjs/router';
import { fireEvent, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '../jmap/types';
import { readQuery, writeQuery, type SimpleQuery } from '../mail/searchQuery';
import { contactsKit } from './contacts-test-kit';
import { SearchPanel } from './SearchPanel';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));

const mb = (id: string, name: string, role: string | null = null) => ({ id, name, role, parentId: null }) as unknown as Mailbox;
const mailboxes = { I: mb('I', 'Inbox', 'inbox'), T: mb('T', 'Trash', 'trash'), F: mb('F', 'Finance') };
const nora = { name: 'Nora Quinn', email: 'nora@customer.test', sent: 0, received: 0, last: '' };

function panel(query: string | null) {
  const kit = contactsKit({ engine: { state: { mailboxes } }, recipients: { suggest: (q: string) => (q.toLowerCase().startsWith('no') ? [nora] : []) } } as never);
  const onSearch = vi.fn<(q: SimpleQuery) => void>();
  kit.show('/', () => <Route path="/" component={() => <SearchPanel query={query === null ? null : readQuery(query)} onSearch={onSearch} />} />);
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
  const search = () => fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  const asked = () => writeQuery(onSearch.mock.calls[0]![0]);
  return { field, search, asked, onSearch };
}

describe('SearchPanel', () => {
  it('opens empty with Search disabled, and its first field focused', () => {
    const { field } = panel(null);
    expect((screen.getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(field('From'));
  });

  it('builds a search from its fields', () => {
    const { field, search, asked } = panel(null);
    fireEvent.input(field('From'), { target: { value: 'nora@customer.test' } });
    fireEvent.input(field('Has the words'), { target: { value: 'invoice' } });
    fireEvent.input(field("Doesn't have"), { target: { value: 'draft' } });
    fireEvent.change(field('In'), { target: { value: 'label:Finance' } });
    fireEvent.click(field('Has attachment'));
    search();
    expect(asked()).toBe('from:nora@customer.test label:Finance has:attachment -draft invoice');
  });

  it('opens filled in from the search on screen, and keeps what it has no field for', () => {
    const { field, search, asked } = panel('from:bob larger:5M is:unread invoice');
    expect(field('From').value).toBe('bob');
    expect(field('Has the words').value).toBe('invoice');
    expect(field('Unread').checked).toBe(true);
    fireEvent.input(field('Subject'), { target: { value: 'lunch' } });
    search();
    expect(asked()).toBe('from:bob subject:lunch is:unread larger:5M invoice');
  });

  it('offers people for From and To', () => {
    const { field } = panel(null);
    fireEvent.input(field('From'), { target: { value: 'no' } });
    const list = document.getElementById(field('From').getAttribute('list')!)!;
    expect([...list.querySelectorAll('option')].map((o) => [o.value, o.label])).toEqual([['nora@customer.test', 'Nora Quinn']]);
  });

  it('offers the places this account has', () => {
    const { field } = panel(null);
    expect([...field('In').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['All mail except Spam and Trash', 'Inbox', 'Trash', 'All mail', 'Finance']);
  });

  it('shows a label the account does not have, so that opening the panel does not change the search', () => {
    const { field, search, asked } = panel('label:nowhere');
    expect(field('In').value).toBe('label:nowhere');
    search();
    expect(asked()).toBe('label:nowhere');
  });

  it('writes a preset as an age', () => {
    const { field, search, asked } = panel(null);
    fireEvent.change(field('Date'), { target: { value: '1m' } });
    search();
    expect(asked()).toBe('newer_than:1m');
  });

  it('shows the two days only for a custom range, and refuses one that ends before it starts', () => {
    const { field, search, onSearch } = panel('after:2026/09/10 before:2026/09/02');
    expect(field('Date').value).toBe('custom');
    expect(screen.getByRole('alert').textContent).toBe('The last day is before the first.');
    search();
    expect(onSearch).not.toHaveBeenCalled();
    fireEvent.change(field('Date'), { target: { value: 'any' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('First day')).toBeNull();
  });

  it('empties itself with Clear and stays open', () => {
    const { field, onSearch } = panel('from:bob larger:5M');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(field('From').value).toBe('');
    expect((screen.getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('searches on Enter in a field', () => {
    const { field, asked } = panel(null);
    fireEvent.input(field('Subject'), { target: { value: 'lunch' } });
    fireEvent.submit(field('Subject').form!);
    expect(asked()).toBe('subject:lunch');
  });
});
```

- [ ] **Step 8: Run to verify they fail**

Run: `pnpm -s exec vitest run src/ui/SearchPanel.test.tsx`
Expected: FAIL, cannot resolve `./SearchPanel`.

- [ ] **Step 9: Write the component**

```tsx
// src/ui/SearchPanel.tsx
import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import { useApp } from '../app/context';
import { places } from '../app/searchSuggest';
import { EMPTY_FORM, formError, formFromQuery, isEmptyForm, queryFromForm, type SearchForm } from '../mail/searchForm';
import { EMPTY_QUERY, pillText, type SimpleQuery } from '../mail/searchQuery';
import { labelPath } from '../sync/selectors';
import { DayField } from './DayField';

const NOBODY = new Set<string>();

/**
 * The search form. It is handed the search on screen (null when that one cannot be shown in a
 * form, or there is none) and hands back the one to run; it knows nothing of the box or the address.
 */
export function SearchPanel(props: { query: SimpleQuery | null; onSearch: (q: SimpleQuery) => void }) {
  const { engine, recipients } = useApp();
  const [form, setForm] = createSignal<SearchForm>(formFromQuery(props.query ?? EMPTY_QUERY));
  const set = <K extends keyof SearchForm>(key: K, value: SearchForm[K]) => setForm({ ...form(), [key]: value });
  let first: HTMLInputElement | undefined;
  onMount(() => first?.focus());

  const where = createMemo(() => {
    const list = places(Object.values(engine.state.mailboxes), (m) => labelPath(m, engine.state.mailboxes)).map((p) => ({ value: pillText(p.pill), label: p.label }));
    const now = form().where;
    // A label this account does not have: shown, so that opening the panel does not change the search.
    return now && !list.some((o) => o.value === now) ? [...list, { value: now, label: now.replace(/^(in|label):"?|"$/g, '') }] : list;
  });
  const people = (text: string) => recipients.suggest(text, NOBODY).filter((r) => !r.list && r.email);
  const error = () => formError(form());

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    if (error() || isEmptyForm(form())) return;
    props.onSearch(queryFromForm(form()));
  };

  const person = (key: 'from' | 'to', label: string, ref?: (el: HTMLInputElement) => void) => (
    <label class="search-panel-row">
      <span>{label}</span>
      <input ref={ref} type="text" autocomplete="off" list={`search-panel-${key}`} value={form()[key]} onInput={(e) => set(key, e.currentTarget.value)} />
      <datalist id={`search-panel-${key}`}>
        <For each={people(form()[key])}>{(r) => <option value={r.email} label={r.name || r.email} />}</For>
      </datalist>
    </label>
  );
  const text = (key: 'subject' | 'words' | 'without', label: string) => (
    <label class="search-panel-row">
      <span>{label}</span>
      <input type="text" autocomplete="off" value={form()[key]} onInput={(e) => set(key, e.currentTarget.value)} />
    </label>
  );
  const tick = (key: 'attachment' | 'unread' | 'starred', label: string) => (
    <label class="search-panel-tick">
      <input type="checkbox" checked={form()[key]} onChange={(e) => set(key, e.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );

  return (
    <form class="search-panel-form" onSubmit={submit}>
      {person('from', 'From', (el) => (first = el))}
      {person('to', 'To')}
      {text('subject', 'Subject')}
      {text('words', 'Has the words')}
      {text('without', "Doesn't have")}
      <label class="search-panel-row">
        <span>In</span>
        <select value={form().where} onChange={(e) => set('where', e.currentTarget.value)}>
          <option value="">All mail except Spam and Trash</option>
          <For each={where()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
        </select>
      </label>
      <label class="search-panel-row">
        <span>Date</span>
        <select value={form().date} onChange={(e) => set('date', e.currentTarget.value as SearchForm['date'])}>
          <option value="any">Any time</option>
          <option value="7d">Last 7 days</option>
          <option value="1m">Last month</option>
          <option value="1y">Last year</option>
          <option value="custom">Custom…</option>
        </select>
      </label>
      <Show when={form().date === 'custom'}>
        <div class="search-panel-days">
          <DayField label="First day" value={form().first || null} empty="Any" onChange={(d) => set('first', d ?? '')} />
          <DayField label="Last day" value={form().last || null} empty="Any" min={form().first || undefined} onChange={(d) => set('last', d ?? '')} />
        </div>
        <Show when={error()}>{(message) => <p class="search-panel-error" role="alert">{message()}</p>}</Show>
      </Show>
      <div class="search-panel-ticks">
        {tick('attachment', 'Has attachment')}
        {tick('unread', 'Unread')}
        {tick('starred', 'Starred')}
      </div>
      <div class="search-panel-actions">
        <button type="button" class="btn" onClick={() => setForm(EMPTY_FORM)}>Clear</button>
        <button type="submit" class="btn tonal" disabled={isEmptyForm(form()) || !!error()}>Search</button>
      </div>
    </form>
  );
}
```

`btn` and `btn tonal` are the app's two button styles; check in `src/ui/LabelDialog.tsx` which of them its dialogs give the main action and the cancel, and match that here.

`<select value=…>` in Solid sets the value after the options render; if the "In" test finds the select on its first option, set `selected={o.value === form().where}` on each option instead.

- [ ] **Step 10: Style the panel**

Append to `src/ui/styles.css`, near the search box rules:

```css
.search-panel-form { display: flex; flex-direction: column; gap: 10px; padding: 16px; width: min(480px, 100vw - 32px); font-size: 14px; color: var(--text); }
.search-panel-row { display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 8px; color: var(--text-2); }
.search-panel-row input, .search-panel-row select {
  min-width: 0; height: 36px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit;
}
.search-panel-days { display: flex; gap: 12px; flex-wrap: wrap; padding-left: 128px; }
.search-panel-error { margin: 0; padding-left: 128px; color: var(--danger-text); }
.search-panel-ticks { display: flex; gap: 16px; flex-wrap: wrap; padding-left: 128px; }
.search-panel-tick { display: flex; align-items: center; gap: 6px; }
.search-panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
@media (max-width: 800px) {
  .search-panel-form { width: calc(100vw - 16px); max-height: calc(100dvh - 80px); overflow-y: auto; }
  .search-panel-row { grid-template-columns: 1fr; gap: 2px; }
  .search-panel-days, .search-panel-error, .search-panel-ticks { padding-left: 0; }
}
@media (pointer: coarse) {
  .search-panel-row input, .search-panel-row select { height: 44px; }
  .search-panel-tick { min-height: 44px; }
}
```

- [ ] **Step 11: Run to verify the tests pass**

Run: `pnpm -s exec vitest run src/ui/SearchPanel.test.tsx && pnpm -s typecheck && pnpm -s test`
Expected: PASS, clean, all green.

- [ ] **Step 12: Commit**

```bash
git add src/ui/SearchPanel.tsx src/ui/SearchPanel.test.tsx src/ui/DayField.tsx src/ui/VacationForm.tsx src/ui/styles.css
git commit -m "Search: a form that builds a search, for the panel"
```

---

### Task 8: The panel opens from the search box

**Files:**
- Modify: `src/ui/SearchBox.tsx`, `src/ui/icons.tsx`, `src/ui/styles.css`
- Test: `src/ui/SearchBox.test.tsx`

**Interfaces:**
- Consumes: `SearchPanel` (Task 7); the `end` prop of `PlainBox` and `PillBox` (Task 6), `(query: () => SimpleQuery | null) => JSX.Element`; `Popover` from `@rozie-ui/popover-solid` as `src/ui/PersonPopover.tsx:60` uses it.
- Produces: a "Search options" button in both boxes.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/SearchBox.test.tsx`:

```tsx
describe('SearchBox panel', () => {
  it('opens the form filled in from the pills and the words in the box', async () => {
    const { type } = box('/search/' + encodeURIComponent('from:bob'));
    type('invoice');
    fireEvent.click(screen.getByRole('button', { name: 'Search options' }));
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('bob'));
    expect((screen.getByLabelText('Has the words') as HTMLInputElement).value).toBe('invoice');
  });

  it('runs the search the form asks for and closes', async () => {
    const { path, pills } = box();
    const button = screen.getByRole('button', { name: 'Search options' });
    fireEvent.click(button);
    fireEvent.click(await screen.findByLabelText('Unread'));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(path()).toBe('/search/' + encodeURIComponent('is:unread'));
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'));
    expect(pills()).toEqual(['is: unread']);
  });

  it('opens empty over a search it cannot show as a form', async () => {
    box('/search/' + encodeURIComponent('from:bob OR from:nora'));
    fireEvent.click(screen.getByRole('button', { name: 'Search options' }));
    expect(((await screen.findByLabelText('From')) as HTMLInputElement).value).toBe('');
  });

  it('closes on Escape and gives the focus back to its button', async () => {
    box();
    const button = screen.getByRole('button', { name: 'Search options' });
    fireEvent.click(button);
    fireEvent.keyDown(await screen.findByLabelText('From'), { key: 'Escape' });
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'));
    expect(document.activeElement).toBe(button);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -s exec vitest run src/ui/SearchBox.test.tsx -t panel`
Expected: FAIL, no button named "Search options".

- [ ] **Step 3: Add the icon**

In `src/ui/icons.tsx`, add to the path table (Material "tune"):

```ts
  tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
```

- [ ] **Step 4: Add the button and wire it to both boxes**

In `src/ui/SearchBox.tsx`, add imports (`Popover` from `@rozie-ui/popover-solid`, `SearchPanel` from `./SearchPanel`) and this component:

```tsx
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
          <button ref={button} type="button" class="icon-btn" aria-label="Search options" aria-haspopup="dialog" aria-expanded={open()} style={BUTTON} onClick={() => setOpen(!open())}>
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
```

In `SearchBox`, pass it to both boxes:

```tsx
  const end = (query: () => SimpleQuery | null) => <PanelButton query={query} go={go} />;

  return (
    <Show when={simple()} fallback={<PlainBox query={routeQuery()} go={go} end={end} />}>
      {(q) => <PillBox query={q()} searching={!!routeQuery()} go={go} end={end} />}
    </Show>
  );
```

The panel sits inside the search `<form>`, and a form inside a form is not valid HTML. rozie Popover renders its content where it stands unless told otherwise: check in the browser's inspector where `.search-panel` lands. If it is inside the search form, move `{props.end?.(…)}` out of the `<form>` in both boxes by wrapping each box in `<div class="search-box-wrap">` that holds the form and then the button, and move the `.search-box` layout rules that concern the row (`flex: 1; max-width: 720px; display: flex; align-items: center`) to the wrap so the box looks the same.

- [ ] **Step 5: Style it**

```css
/* A popover takes its colours from its wrapper; without these it is rozie's white in either theme. */
.search-panel-anchor { --rozie-popover-bg: var(--surface); --rozie-popover-color: var(--text); --rozie-popover-border-color: var(--border); --rozie-popover-shadow: var(--shadow); }
```

Use the exact token names from the rule at `src/ui/styles.css:132` (`.nav-menu, .menu-anchor, .person-anchor { … }`); the simplest correct change is to add `.search-panel-anchor` to that selector list and not write this rule at all.

- [ ] **Step 6: Run to verify the tests pass**

Run: `pnpm -s exec vitest run src/ui/SearchBox.test.tsx && pnpm -s typecheck && pnpm -s test`
Expected: PASS, clean, all green.

- [ ] **Step 7: Look at it, and check the day picker inside the panel**

With `pnpm dev`: open the panel, choose Date → Custom, open "First day" and pick a day. The panel must stay open while the day picker is used (the picker is a popover inside a popover). **If picking a day or clicking in the picker closes the panel, stop**: that is a rozie Popover gap (a click inside a nested popover counted as outside the outer one); write it up in `docs/rozie-feedback.md` and report it. Also check: the phone width in the browser's device toolbar (the panel is as wide as the screen and scrolls inside itself), and the dark theme.

- [ ] **Step 8: Commit**

```bash
git add src/ui/SearchBox.tsx src/ui/SearchBox.test.tsx src/ui/icons.tsx src/ui/styles.css
git commit -m "Search: a panel off the search box builds a search from a form"
```

---

### Task 9: End to end, accessibility, and the notes

**Files:**
- Modify: `e2e/search.spec.ts`, `e2e/a11y.spec.ts`, `e2e/README.md` (the `search.spec.ts` row of the coverage table), `CHANGELOG.md`, `README.md:31`, `docs/rozie-feedback.md`

**Interfaces:**
- Consumes: the running dev stack (`deploy/`), alice's seeded mail (Bob's "Lunch Friday?", the "Q3 planning offsite" thread with "zeppelin"), `openInbox` and `rows` from `e2e/support/app.ts`, `check(page, name)` in `e2e/a11y.spec.ts`.

- [ ] **Step 1: Remove the stale note**

In `e2e/search.spec.ts`, delete the comment block that begins `// FIXME(app bug, see e2e/README.md "Known failures")` (five lines above the first test). The test under it stays.

- [ ] **Step 2: Add the end-to-end tests**

Append to `e2e/search.spec.ts`:

```ts
const pills = (page: Page) => page.locator('.search-pill');
const options = (page: Page) => page.getByRole('option');

test('typing from: offers people, and the pick becomes a pill that searches', async ({ page }) => {
  await openInbox(page);
  await page.locator('#search-input').pressSequentially('from:bob');
  await expect(options(page).first()).toContainText('bob@example.test');
  await page.keyboard.press('Enter');
  await expect(pills(page)).toHaveText([/^from: /]);
  await expect(page).toHaveURL(/\/inbox$/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\/from(%3A|:)bob(%40|@)example\.test$/);
  await expectBobsThreads(page);
});

test('plain words open no list, and a pill is removed with its button', async ({ page }) => {
  await page.goto('/search/' + encodeURIComponent('from:bob is:unread'));
  await expect(pills(page)).toHaveText(['from: bob', 'is: unread']);
  await page.locator('#search-input').pressSequentially('lunch');
  await expect(options(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove is: unread' }).click();
  await expect(pills(page)).toHaveText(['from: bob']);
  await expect(page).toHaveURL(/\/search\/from(%3A|:)bob(%20| )lunch$/);
  await expect(rows(page).filter({ has: page.locator('.subject', { hasText: 'Lunch Friday?' }) })).toHaveCount(1);
});

test('Backspace hands the last pill back as text', async ({ page }) => {
  await page.goto('/search/' + encodeURIComponent('from:bob'));
  await page.locator('#search-input').focus();
  await page.keyboard.press('Backspace');
  await expect(pills(page)).toHaveCount(0);
  await expect(page.locator('#search-input')).toHaveValue('from:bob');
});

test('a search with OR is shown as text and still finds its mail', async ({ page }) => {
  await page.goto('/search/' + encodeURIComponent('from:bob OR from:nobody-at-all'));
  await expect(pills(page)).toHaveCount(0);
  await expect(page.locator('#search-input')).toHaveValue('from:bob OR from:nobody-at-all');
  await expectBobsThreads(page);
});

test('to: finds mail the person was only copied on', async ({ page }) => {
  // Arrange a message to bob with alice in Cc, as the other specs arrange theirs (support/mail.ts),
  // with a unique subject, and remove it afterwards.
  const tag = uniqueTag();
  const subject = `Copied ${tag}`;
  await sendMail({ from: BOB, to: [BOB], cc: [ALICE], subject, text: 'cc test' });
  try {
    await page.goto('/search/' + encodeURIComponent(`to:alice subject:${tag}`));
    await expect(rows(page).filter({ has: page.locator('.subject', { hasText: subject }) })).toHaveCount(1);
  } finally {
    await destroyEmails(await emailsBySubject(subject));
  }
});

test('the panel builds a search and opens filled in from it', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Search options' }).click();
  const panel = page.getByRole('dialog', { name: 'Search options' });
  await expect(panel.getByLabel('From')).toBeFocused();
  await panel.getByLabel('From').fill('bob');
  await panel.getByLabel('Has the words').fill('lunch');
  await panel.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/search\/from(%3A|:)bob(%20| )lunch$/);
  await expect(panel).toBeHidden();
  await expect(pills(page)).toHaveText(['from: bob']);
  await expect(rows(page).filter({ has: page.locator('.subject', { hasText: 'Lunch Friday?' }) })).toHaveCount(1);

  await page.getByRole('button', { name: 'Search options' }).click();
  await expect(panel.getByLabel('From')).toHaveValue('bob');
  await expect(panel.getByLabel('Has the words')).toHaveValue('lunch');
});

test('a custom date range keeps the panel open while a day is picked, and includes its last day', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Search options' }).click();
  const panel = page.getByRole('dialog', { name: 'Search options' });
  await panel.getByLabel('Date').selectOption('custom');
  await panel.getByRole('button', { name: /^First day/ }).click();
  await page.getByRole('gridcell', { name: /\b1\b/ }).first().click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /^First day: (?!Any)/ })).toBeVisible();
});

test('the search panel fits a phone and its fields are finger-sized @phone', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('button', { name: 'Search options' }).click();
  const form = page.locator('.search-panel-form');
  await expect(form).toBeVisible();
  const box = (await form.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect((await form.getByLabel('From').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
```

Add to the file's imports: `import { ALICE, BOB, destroyEmails, emailsBySubject, sendMail, uniqueTag, waitFor } from './support/mail';`.

`sendMail` (`e2e/support/mail.ts:169`) has no Cc yet. Add `cc?: string[]` to `OutgoingMail` with the comment `// envelope + Cc header`; in `sendMail` add the header line `...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),` after the `To:` line, and where the function sends one `RCPT TO` for each of `m.to`, send one for each of `[...m.to, ...(m.cc ?? [])]`. Nothing else that calls `sendMail` changes.

The message is delivered asynchronously: in the Cc test, before `page.goto`, wait for it with `await waitFor(async () => (await emailsBySubject(subject)).length > 0, 10_000, 'the copied message');`.

The gridcell locator in the date test depends on the names rozie DatePicker gives its days; run the test headed once (`pnpm -s exec playwright test --project=chromium e2e/search.spec.ts -g "custom date" --headed`) and, if it does not find the day, take the right role and name from the page with Playwright's inspector. What matters in the assertion is the last two lines: the panel is still there and the button no longer says "Any".

On the phone project the search box may be behind a search icon or narrower: if `getByRole('button', { name: 'Search options' })` is not visible at 390 px, see how `e2e/*.spec.ts` tests tagged `@phone` reach the search box today and follow that.

- [ ] **Step 3: Add the axe checks**

In `e2e/a11y.spec.ts`, beside the other tests and in their form (each calls `check(page, name)`; copy how a neighbouring test covers both themes):

```ts
test('the search box with pills and the open search panel have no serious violations', async ({ page }) => {
  await page.goto('/search/' + encodeURIComponent('from:bob label:nowhere is:unread'));
  await expect(page.locator('.search-pill')).toHaveCount(3);
  await check(page, 'search box with pills');
  await page.getByRole('button', { name: 'Search options' }).click();
  await expect(page.getByRole('dialog', { name: 'Search options' })).toBeVisible();
  await check(page, 'search panel');
});
```

- [ ] **Step 4: Run them**

Run: `pnpm -s exec playwright test --project=chromium e2e/search.spec.ts e2e/a11y.spec.ts`
Then: `pnpm -s exec playwright test --project=phone e2e/search.spec.ts`
Then: `pnpm -s exec playwright test --project=firefox --project=webkit e2e/search.spec.ts`
Expected: all pass. An axe contrast failure on `.search-pill-error` means `--danger-text` on the chip background is too weak in one theme: fix the colour pairing in `styles.css`, do not exclude the node.

The Cc test also proves Stalwart answers the `OR` of `to` and `cc`. If it fails with the message present in the mailbox, query Stalwart directly with that filter (as `e2e/support/mail.ts` queries) before changing any code, and report what it returns.

- [ ] **Step 5: Run the whole suite once**

Run: `pnpm -s e2e`
Expected: green apart from the known noise recorded in `e2e/README.md` and the open `push.spec.ts:47` failure on Firefox and WebKit (not Chromium). Anything else that fails and touches the search box or the topbar is this slice's to fix.

- [ ] **Step 6: Write the notes**

- `CHANGELOG.md`, under `## Unreleased`: under `### Added`, add

  ```markdown
  - Search: operators show in the search box as pills that can be removed one at a time; typing `from:`, `to:`, `in:`, `label:`, `has:` or `is:` offers people, mailboxes and the values that exist; and a panel off the search box builds a search from a form (from, to, subject, words, place, date, attachment, unread, starred). Searches with `OR` or brackets are shown as text, as before.
  ```

  and add a `### Changed` section after it with

  ```markdown
  - Search: `to:` now also finds mail the person was copied on. `cc:` still matches Cc alone.
  ```

- `README.md:31`: the sentence listing what is not there yet names "a filter (Sieve) editor". Leave that; add nothing there. In the README's list of what search does (search the file for `from:`), mention the pills and the panel in one sentence, in the surrounding style. If the README has no such passage, leave the README alone.
- `e2e/README.md`: replace the `search.spec.ts` row's description with one that covers the new tests, in that table's style (what the user does and sees, in one paragraph).
- `docs/rozie-feedback.md`: add a section in that file's form:

  ```markdown
  ## Combobox 0.7.0 — as a search box with pills

  Wanted: a search field whose operators are chips and whose plain words stay text (docs/superpowers/specs/2026-10-11-search-tokens-design.md). It works; `src/ui/SearchBox.contract.test.tsx` pins the six behaviours it leans on. Two gaps, both worked with rather than around:

  1. **No id for the input.** The app focuses the box by id (`/` shortcut). `idBase` names the list and options only, so oinbox sets `id` on `input.rozie-combobox-input` after mount. Wanted: an `inputId` prop.
  2. **Nothing announces a chip added or removed.** A screen reader user who picks a suggestion or presses a chip's remove button hears nothing. Wanted: a polite live region saying "<label> added" / "<label> removed", with the wording overridable.
  3. **Backspace on an empty input removes the last chip outright.** A search box wants it handed back as text to edit. oinbox takes the key in a capture listener before Combobox sees it. Wanted: an `onChipBackspace` that can prevent the removal, or a `backspace="edit"` mode that seeds the input with the chip's value.
  ```

  If Task 8 Step 7 found the nested-popover problem, it is already written up there; do not repeat it.

- [ ] **Step 7: Final checks and commit**

Run: `pnpm -s typecheck && pnpm -s test`
Expected: clean, all passing.

```bash
git add e2e/search.spec.ts e2e/a11y.spec.ts e2e/README.md CHANGELOG.md README.md docs/rozie-feedback.md
git commit -m "Search pills and panel: end-to-end tests, axe checks and notes"
```
