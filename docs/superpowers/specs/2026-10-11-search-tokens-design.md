# Search tokens and the search panel

oinbox already understands Gmail-style search operators (`from:bob has:attachment`), but the search box is a bare text field, so only someone who knows the syntax can use them. This slice makes the operators visible: a recognised operator shows in the box as a removable pill, typing an operator offers its values, and a panel off the search box builds a query from a form.

It is for people who have never learned a search syntax, and it must not slow down those who have.

Success: Alice opens the panel, picks Nora under From, ticks Has attachment and presses Search. The box reads `[from: Nora Quinn] [has: attachment]` and the list shows the matching conversations. She types `invoice`, presses Enter, and the search narrows. She removes the attachment pill with its button and the list widens again. Bob, who types `from:nora OR from:carol` by hand, gets exactly what he gets today.

A later slice, mail rules (Sieve), will reuse the panel's form for "create a rule from this search". Nothing here is built for it beyond keeping the form a separate component.

## What is there today

- `src/mail/search.ts` turns a query string into a JMAP `Email/query` filter. It knows `from`, `to`, `cc`, `bcc`, `subject`, `has`, `is`, `in`, `label`, `before`, `after`, `older`, `newer`, `older_than`, `newer_than`, `larger`, `smaller`, `size`, `deliveredto`, `list` and `filename`, negation with `-`, `OR` (also `|` and `{…}`), and brackets.
- The query lives in the URL: `/search/<query>`. `resolveView` in `src/sync/selectors.ts` parses it; a mailbox named in the query is found by role, by name or by label path.
- `SearchBox` in `src/ui/Shell.tsx` is an `<input type="search">` with the id `search-input`, which the `/` shortcut focuses.
- The recipient field (`src/ui/RecipientField.tsx`) already builds chips, free text and host-fed suggestions on rozie Combobox 0.7 (`multiple`, `chipLayout="inline"`, `chipSlot`).

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Source of truth | The query string. Pills, the panel and the URL are all read from it and written back to it. `/search/…` does not change. | Agreed 2026-10-11. Existing links keep working, and there is one place where a query is read and one where it is written. |
| What gets pills | A *simple* query: terms joined by the implied AND, each optionally negated. | Agreed 2026-10-11 (option 1). It covers what the panel can produce and what most people type. |
| Everything else | A query with `OR`, `\|`, brackets or braces is shown as plain text, as today, and works as today. | A pill for `OR` is a query builder, and reads worse than the text it replaces. |
| Layout in the box | Pills first, plain words after them in the input. `invoice from:bob urgent` shows as `[from: bob] invoice urgent`. | Agreed 2026-10-11 (approach A). It is the shape rozie Combobox has; the order of ANDed terms does not change the result. |
| Suggestions | Only after an operator. Plain words never open a list and never become a pill. | Agreed 2026-10-11 (option 1). Enter must always mean "search for this". |
| Component | rozie Combobox for the box, rozie Popover for the panel, rozie DatePicker for dates. | Dogfooding. If Combobox cannot do one of the three things listed under "First task", the slice stops and the gap goes to the user, not around the component. |
| `to:` | Matches To or Cc. Today it matches To only. | The panel's one "To" field and the typed operator must mean the same thing, and "mail sent to Nora" includes mail she was copied on. `cc:` still matches Cc alone. |
| Scope | The account that is open. In a shared mailbox the box searches that mailbox and suggests from its people and labels. | It is how search works today. |

## The query model

A new module, `src/mail/searchQuery.ts`, sits beside the parser and shares its tokenizer.

```ts
interface Pill {
  /** An operator name, or 'word' for a negated plain word. */
  name: string;
  value: string;
  negated: boolean;
}

interface SimpleQuery {
  pills: Pill[];
  /** The plain words, as typed, quotes kept. */
  words: string;
}

/** The pills and words of a simple query, or null when the query is not simple. */
function readQuery(input: string): SimpleQuery | null;

/** The query string for these pills and words. */
function writeQuery(q: SimpleQuery): string;
```

Rules:

- A query is simple when its tokens are only words, operators and `-`. Any `OR`, `|`, bracket or brace makes it not simple.
- A positive plain word stays in `words`. A negated one (`-draft`) becomes a pill named `word`, shown as `not: draft`.
- An operator with an empty value (`from:` typed and nothing after) is not a pill; it stays in `words` so the user can go on typing.
- `writeQuery` puts the pills first, in order, then the words. A value with white space is quoted. A `"` inside a value is dropped, since the tokenizer has no way to escape one.
- `readQuery(writeQuery(q))` gives back `q`, and `parseSearch(writeQuery(readQuery(s)))` gives the same filter as `parseSearch(s)` for every simple `s`. Both are tested across every operator.

`parseSearch` changes in one place: `to:` yields `{ operator: 'OR', conditions: [{ to }, { cc }] }`.

## The search box

`SearchBox` moves out of `Shell.tsx` into `src/ui/SearchBox.tsx`.

**Showing a query.** The box reads the route's query through `readQuery`. Simple: a Combobox with one chip per pill and the words in its input. Not simple: the plain input of today, with the panel button beside it. The input keeps the id `search-input` in both.

**A pill** reads `name: value`, with `not` in front when negated. Its label is friendlier than the raw text where that is cheap:

| Query | Pill |
|---|---|
| `from:nora@customer.test` | `from: Nora Quinn` when the address book, the directory or mail history knows the address; otherwise the address. The address is in the pill's title. |
| `in:inbox`, `label:Finance/2026` | `in: Inbox`, `label: Finance/2026` |
| `has:attachment`, `is:unread` | `has: attachment`, `is: unread` |
| `newer_than:7d` | `newer than: 7 days` |
| `after:2026/09/01` | `after: 1 Sep 2026` |
| `-from:bob` | `not from: bob` |
| `-draft` | `not: draft` |

A pill whose value the parser refuses (a label that does not exist, a date it cannot read) is drawn in the error style, and the existing error line under the list says why.

**Typing.** When the text before the cursor ends in an operator and a partial value, a list opens:

| Operator | List |
|---|---|
| `from:`, `to:`, `cc:`, `bcc:` | People, from the same sources and in the same order as the recipient field. Picking one writes the address. Groups are not offered. |
| `in:` | Inbox, Sent, Drafts, Archive, Spam, Trash, All mail (`in:anywhere`), then labels. |
| `label:` | Labels, by path. |
| `has:` | `attachment` |
| `is:` | `unread`, `read`, `starred`, `unstarred`, `important` |

Other operators (`subject:`, dates, sizes, `list:`, `filename:`) open no list.

**Keys.**

- Enter with a list open and an option active: that option becomes the pill, and the search does not run yet.
- Enter otherwise: any complete operators in the input become pills, and the search runs.
- Space after an operator's value makes the pill and leaves the cursor in the input.
- Backspace in an empty input turns the last pill back into text (`from:nora@customer.test`) with the cursor at its end.
- Each pill has a remove button, reachable by Tab, labelled "Remove from: Nora Quinn". Removing a pill of a search that is on screen runs the search again.
- Escape closes the list; a second Escape leaves the box, as today.
- The clear button empties pills and words and, on a search route, returns to the Inbox, as today.

**Screen readers.** The box keeps `role="search"`. Adding or removing a pill is announced by Combobox's own live region; if it has none for chips, that is a rozie gap to report.

## The panel

`src/ui/SearchPanel.tsx`: a form in a rozie Popover, opened by a filter button at the end of the search box (label "Search options").

| Field | Writes |
|---|---|
| From | `from:<address>`; people suggestions, free text allowed |
| To | `to:<address>`; the same |
| Subject | `subject:<text>` |
| Has the words | plain words |
| Doesn't have | one `-word` for each word |
| In | `in:<role>` or `label:<path>`; a select with "All mail except Spam and Trash" (writes nothing) first, then "All mail", mailboxes and labels |
| Date | Any time, Last 7 days (`newer_than:7d`), Last month (`newer_than:1m`), Last year (`newer_than:1y`), or Custom: a From and a To date, written as `after:` and `before:` |
| Has attachment | `has:attachment` |
| Unread | `is:unread` |
| Starred | `is:starred` |

- It opens filled in from the current query when that query is simple, and empty when it is not or when no search is open. Pills the form has no field for (`larger:5M`, `cc:`) are kept and written back unchanged.
- Search writes the string with `writeQuery`, navigates and closes the panel. Clear empties the form and leaves the panel open. With nothing filled in, Search is disabled.
- A custom date range with the end before the start is refused in the form, with a message beside the field.
- Focus moves to the first field on opening and back to the button on closing. Escape closes it.
- On a phone-width screen the panel is as wide as the screen, under the search box, and scrolls inside itself.

## A stale note to clear

`e2e/search.spec.ts` still carries a FIXME saying that a query typed into the box is encoded twice. That was fixed long ago (`e2e/README.md`, "Regression tests for fixed bugs", item 2) and the test passes. The comment is removed in this slice, and the test stays as the guard that the new box writes the route the same way.

## Units

| Unit | Does | Depends on |
|---|---|---|
| `src/mail/searchQuery.ts` | `readQuery`, `writeQuery`, pill labels | the tokenizer in `search.ts` |
| `src/mail/search.ts` | as today, with `to:` widened and the tokenizer exported | — |
| `src/app/searchSuggest.ts` | given the text before the cursor, says which list to open and with what | recipients, mailboxes |
| `src/ui/SearchBox.tsx` | the box: pills, input, lists, keys | Combobox, the two above |
| `src/ui/SearchPanel.tsx` | the form; takes a `SimpleQuery`, gives one back | Popover, DatePicker |

`SearchPanel` knows nothing of routes or of the box: it is handed a query and a callback. That is what lets the rules slice use it.

## First task: can Combobox carry it?

Before anything else is built, a throwaway page checks three things on rozie Combobox 0.7:

1. Enter with words in the input and no option active submits the surrounding form and does not make a chip.
2. Backspace in an empty input can hand the last chip back to the host as text (`seedQuery` is the likely way).
3. The list can be kept shut while plain words are typed and opened only when the host says so.

If all three hold, the build goes on. If one does not, work stops and the gap is written up in `docs/rozie-feedback.md` for the user to fix upstream.

## Testing

- **Unit:** the round trip and the same-filter property for every operator, negated and not; the simple/not-simple boundary (`OR`, `|`, each bracket, a stray closer); quoting; empty operator values; pill labels; `to:` matching Cc; `searchSuggest` for each operator and for plain words.
- **Component:** the box shows pills for a simple route query and plain text for a complex one; each key in "Keys"; an error pill; the panel filling itself from a query, keeping pills it has no field for, and refusing a backwards date range.
- **End to end:** typing `from:` and picking a person; typing a query by hand and pressing Enter (the existing test); building a search in the panel; removing a pill; a deep link with `OR` shown as text and still finding its mail; the panel on the phone project; axe on the open panel and on a box with pills.
- The fake JMAP server needs nothing new: the filters sent are ones it already answers, apart from the `OR` of `to` and `cc`, which is checked against it and against Stalwart.

## Not in this slice

- Quick filter chips above ordinary lists (Inbox, a label).
- Saved searches.
- "Create a rule from this search" and everything else about mail rules (Sieve): the next slice.
- Name suggestions for plain words ("From Nora Quinn" offered while typing `nor`).
- A size field in the panel. `larger:` and `smaller:` stay typed-only.
- Pills for queries with `OR` or brackets.
- Searching several accounts at once.
