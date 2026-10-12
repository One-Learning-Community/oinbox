import { Route, useNavigate } from '@solidjs/router';
import { fireEvent, screen, waitFor, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '../jmap/types';
import { contactsKit } from './contacts-test-kit';
import { SearchBox } from './SearchBox';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));
// jsdom lays nothing out; the list scrolls its highlighted option into view.
Element.prototype.scrollIntoView = () => {};

const mb = (id: string, name: string, role: string | null = null) => ({ id, name, role, parentId: null }) as unknown as Mailbox;
const labels = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`L${i}`, mb(`L${i}`, `Label ${i}`)]));
const mailboxes = { I: mb('I', 'Inbox', 'inbox'), T: mb('T', 'Trash', 'trash'), F: mb('F', 'Finance'), ...labels };
const nora = { name: 'Nora Quinn', email: 'nora@customer.test', sent: 0, received: 0, last: '' };

/** Test-only: buttons that move the router, beside the one search box. */
function Go(props: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(props.to)}>go</button>;
}
// The router moves a moment after navigate() is called; a search that must not happen is looked for after that moment.
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
const searchPath = (q: string) => '/search/' + encodeURIComponent(q);

function box(path = '/inbox', to = '/inbox') {
  const kit = contactsKit({
    engine: { state: { mailboxes } },
    recipients: { suggest: (q: string) => (q.toLowerCase().startsWith('no') ? [nora] : []) },
  } as never);
  kit.show(path, () => <Route path="*" component={() => <><SearchBox /><Go to={to} /></>} />);
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

  it('searches for typed words on submit, and keeps the route as it was written before', async () => {
    const { type, submit, path } = box();
    type('zeppelin');
    submit();
    await waitFor(() => expect(path()).toBe('/search/zeppelin'));
  });

  it('turns typed operators into pills on submit', async () => {
    const { type, submit, path, pills } = box();
    type('invoice from:bob');
    submit();
    await waitFor(() => expect(path()).toBe('/search/' + encodeURIComponent('from:bob invoice')));
    expect(pills()).toEqual(['from: bob']);
  });

  it('makes a pill when a space ends an operator, and leaves the words', async () => {
    const { type, pills, input, path } = box();
    type('invoice is:unread ');
    expect(pills()).toEqual(['is: unread']);
    expect(input().value).toBe('invoice ');
    await settled();
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
    await settled();
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

  it('removes a pill with its button and searches again', async () => {
    const { path, pills } = box('/search/' + encodeURIComponent('from:bob is:unread'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove is: unread' }));
    expect(pills()).toEqual(['from: bob']);
    await waitFor(() => expect(path()).toBe('/search/' + encodeURIComponent('from:bob')));
  });

  it('goes back to the Inbox when the last pill of a search is removed', async () => {
    const { path } = box('/search/' + encodeURIComponent('is:unread'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove is: unread' }));
    await waitFor(() => expect(path()).toBe('/inbox'));
  });

  it('marks a pill the search cannot use, and says why', () => {
    box('/search/' + encodeURIComponent('label:nowhere'));
    const bad = document.querySelector('.search-pill-error')!;
    expect(bad.textContent).toBe('label: nowhere');
    expect(bad.getAttribute('title')).toBe('No mailbox named "nowhere"');
  });

  it('clears pills and words, and leaves a search', async () => {
    const { path, pills, input } = box('/search/' + encodeURIComponent('from:bob invoice'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(pills()).toEqual([]);
    expect(input().value).toBe('');
    await waitFor(() => expect(path()).toBe('/inbox'));
  });

  it('follows the route: back to a search with OR is plain text again', async () => {
    const { pills, input } = box(searchPath('from:bob'), searchPath('a OR b'));
    expect(pills()).toEqual(['from: bob']);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(input().value).toBe('a OR b'));
    expect(document.querySelectorAll('#search-input')).toHaveLength(1);
    expect(pills()).toEqual([]);
  });

  it('follows the route: from a search with OR to a simple one shows pills again', async () => {
    const { pills, input } = box(searchPath('a OR b'), searchPath('invoice from:bob'));
    expect(pills()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(pills()).toEqual(['from: bob']));
    expect(document.querySelectorAll('#search-input')).toHaveLength(1);
    expect(input().value).toBe('invoice');
  });

  it('offers every label after in:, not only the first few', async () => {
    const { type } = box();
    type('in:');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(10));
    const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    for (let i = 0; i < 10; i++) expect(names.some((n) => n.includes(`Label ${i}`))).toBe(true);
  });
});

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
    // The box has a button of that name too: this is the one in the form.
    fireEvent.click(within(document.querySelector('.search-panel-form') as HTMLElement).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(path()).toBe('/search/' + encodeURIComponent('is:unread')));
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

  it.each([
    ['pills', 'from:bob'],
    ['plain text', 'from:bob OR from:nora'],
  ])('never puts the form inside the search form, with %s', async (_, query) => {
    box('/search/' + encodeURIComponent(query));
    fireEvent.click(screen.getByRole('button', { name: 'Search options' }));
    await screen.findByLabelText('From');
    expect(document.querySelector('.search-panel-form')).not.toBeNull();
    expect(document.querySelectorAll('form form')).toHaveLength(0);
  });
});
