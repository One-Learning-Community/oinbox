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
      <div class="dialog-actions search-panel-actions">
        <button type="button" onClick={() => setForm(EMPTY_FORM)}>Clear</button>
        <button type="submit" class="primary" disabled={isEmptyForm(form()) || !!error()}>Search</button>
      </div>
    </form>
  );
}
