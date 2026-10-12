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

  it('searches for the same thing when opened and sent untouched, with negated words that look like syntax', () => {
    const { field, search, asked } = panel('-"OR" -"from:bob" lunch');
    expect(field("Doesn't have").value).toBe('"OR" "from:bob"');
    search();
    expect(asked()).toBe('-"OR" -"from:bob" lunch');
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
