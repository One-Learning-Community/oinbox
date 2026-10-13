import { Route } from '@solidjs/router';
import { fireEvent, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { Recipient } from '../mail/recipients';
import { describe, expect, it, vi } from 'vitest';
import type { EmailAddress } from '../jmap/types';
import { contactsKit } from './contacts-test-kit';
import { RecipientField, pickedSuggestion } from './RecipientField';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));

function field(initial: EmailAddress[], extra: object = {}) {
  const kit = contactsKit({ recipients: { suggest: () => [] }, ...extra } as never);
  const [value, setValue] = createSignal(initial);
  kit.show('/', () => <Route path="/" component={() => <RecipientField id="to" label="To" value={value()} others={[]} onChange={setValue} />} />);
  return { ...kit, value };
}
const bob = { name: 'Bob Example', email: 'bob@example.test' };

describe('RecipientField chips', () => {
  it('is one stop for the Tab key per chip, and Delete on it removes the recipient', () => {
    const { value } = field([bob]);
    const label = screen.getByRole('button', { name: 'Bob Example <bob@example.test>' });
    const remove = screen.getByRole('button', { name: 'Remove Bob Example <bob@example.test>' });
    expect(label.tabIndex).toBe(0);
    expect(remove.tabIndex).toBe(-1);
    fireEvent.keyDown(label, { key: 'Delete' });
    expect(value()).toEqual([]);
  });
  it('removes with Backspace too', () => {
    const { value } = field([bob]);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Bob Example <bob@example.test>' }), { key: 'Backspace' });
    expect(value()).toEqual([]);
  });
  it('keeps the remove button in the Tab order where a name is no button', () => {
    field([bob], { contacts: { available: () => false } });
    expect(screen.getByRole('button', { name: 'Remove Bob Example <bob@example.test>' }).tabIndex).toBe(0);
  });
});

describe('RecipientField out of use', () => {
  const people = ['ann', 'bo', 'cy', 'di'].map((n) => ({ name: null, email: `${n}@example.test` }));
  it('shows two recipients whole', () => {
    field(people.slice(0, 2));
    expect(document.querySelector('.recipient-field')!.classList.contains('folded')).toBe(false);
    expect(screen.getByRole('button', { name: 'bo@example.test' })).toBeTruthy();
  });
  it('folds a longer list to the first and a count, and unfolds when the count or the field takes the focus', () => {
    field(people);
    const root = document.querySelector('.recipient-field')!;
    expect(root.classList.contains('folded')).toBe(true);
    expect(screen.getByRole('button', { name: 'ann@example.test' })).toBeTruthy();
    // The second chip is the count; the rest are hidden by the stylesheet.
    expect(screen.queryByRole('button', { name: 'bo@example.test' })).toBeNull();
    const more = screen.getByRole('button', { name: '3 more, show all 4 recipients' });
    expect(more.textContent).toBe('3 more');

    more.focus();
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
    expect(root.classList.contains('folded')).toBe(false);
    expect(screen.getByRole('button', { name: 'bo@example.test' })).toBeTruthy();

    fireEvent.focusOut(screen.getByRole('combobox'), { relatedTarget: document.body });
    expect(root.classList.contains('folded')).toBe(true);
  });
});

// jsdom lays nothing out; the list scrolls its highlighted option into view.
Element.prototype.scrollIntoView = () => {};

describe('RecipientField with a contact group', () => {
  const team: Recipient = { email: '', name: 'Team', sent: 0, received: 0, last: '', list: { id: '', count: 3 } };
  async function withGroup(initial: EmailAddress[], others: EmailAddress[] = [], members = ['u-ann', 'u-bob', 'u-cy']) {
    const kit = contactsKit({ recipients: { suggest: (q: string) => (q.trim() ? [{ ...team, list: { id: groupId, count: members.length } }] : []) } } as never);
    kit.fake.addCard({ uid: 'u-ann', name: { full: 'Ann' }, emails: { e1: { address: 'ann@home.example' }, e2: { address: 'ann@work.example', pref: 1 } } });
    kit.fake.addCard({ uid: 'u-bob', name: { full: 'Bob' }, emails: { e1: { address: 'bob@example.test' } } });
    kit.fake.addCard({ uid: 'u-cy', name: { full: 'Cy' } });
    const groupId = kit.fake.addCard({ kind: 'group', uid: 'g', name: { full: 'Team' }, members: Object.fromEntries(members.map((m) => [m, true])) }).id;
    await kit.contacts.start('k');
    const [value, setValue] = createSignal(initial);
    kit.show('/', () => <Route path="/" component={() => <RecipientField id="to" label="To" value={value()} others={others} onChange={setValue} />} />);
    const input = screen.getByRole('combobox');
    fireEvent.input(input, { target: { value: 'tea' } });
    return { ...kit, value, input };
  }

  it('offers the group as a list with its count', async () => {
    await withGroup([]);
    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('Team');
    expect(option).toHaveTextContent('List · 3 people');
  });
  it('adds one chip per member by preferred address, and says who has none', async () => {
    const { value, toast, input } = await withGroup([]);
    fireEvent.mouseDown(await screen.findByRole('option'));
    expect(value()).toEqual([{ name: 'Ann', email: 'ann@work.example' }, { name: 'Bob', email: 'bob@example.test' }]);
    expect(toast).toHaveBeenCalledWith('1 of 3 in Team has no email address.', 'info');
    expect(screen.getByRole('button', { name: 'Remove Ann <ann@work.example>' })).toBeInTheDocument();
    expect(screen.queryByText(/^list:/)).toBeNull();
    expect(input).toHaveValue('');
  });
  it('adds nobody who is already on the message, in this field or another', async () => {
    const { value } = await withGroup([bob], [{ name: null, email: 'ANN@work.example' }]);
    fireEvent.mouseDown(await screen.findByRole('option'));
    expect(value()).toEqual([bob]);
  });
  it('says so when everyone is already there, and when nobody has an address', async () => {
    const all = await withGroup([bob, { name: 'Ann', email: 'ann@work.example' }]);
    fireEvent.mouseDown(await screen.findByRole('option'));
    expect(all.toast).toHaveBeenCalledWith('Everyone in Team is already on this message.', 'info');
    expect(all.value()).toHaveLength(2);
  });
  it('says so when nobody in the group has an address', async () => {
    const none = await withGroup([], [], ['u-cy']);
    fireEvent.mouseDown(await screen.findByRole('option'));
    expect(none.toast).toHaveBeenCalledWith('Nobody in Team has an email address.', 'info');
    expect(none.value()).toEqual([]);
  });
  it('holds a send when Ctrl+Enter picks the highlighted group', async () => {
    const { value, input } = await withGroup([]);
    await screen.findByRole('option');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    let held: boolean | null = null;
    document.addEventListener('keydown', (e) => (held = pickedSuggestion(e)), { once: true });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(held).toBe(true);
    expect(value().map((a) => a.email)).toEqual(['ann@work.example', 'bob@example.test']);
  });
});
