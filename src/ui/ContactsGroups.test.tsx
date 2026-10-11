import { Route, useLocation } from '@solidjs/router';
import { fireEvent, screen, within } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { ContactCard } from '../jmap/types';
import { contactsKit } from './contacts-test-kit';
import { ContactsView } from './ContactsView';
import { GroupDialog } from './GroupDialog';
import { GroupNav } from './GroupNav';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));
// jsdom lays nothing out, so the real virtual list would render no rows: this one renders them all.
vi.mock('./virtual', () => ({
  createVirtualList: (opts: { count: () => number }) => ({
    items: () => Array.from({ length: opts.count() }, (_, index) => ({ index, key: index, start: index * 48, end: (index + 1) * 48, size: 48 })),
    totalSize: () => opts.count() * 48,
    virtualizer: { scrollToIndex: () => {} },
  }),
}));

async function seeded() {
  const kit = contactsKit();
  const person = (name: string, more: Partial<ContactCard> = {}) => kit.fake.addCard({ uid: `u-${name.toLowerCase()}`, name: { full: name }, emails: { e1: { address: `${name.toLowerCase()}@x.example` } }, ...more });
  const ann = person('Ann');
  const bob = person('Bob');
  const cy = person('Cy');
  const team = kit.fake.addCard({ kind: 'group', uid: 'g-team', name: { full: 'Team' }, members: { 'u-ann': true, 'u-bob': true, 'mailto:ext@else.example': true, 'u-gone': true } });
  const empty = kit.fake.addCard({ kind: 'group', uid: 'g-empty', name: { full: 'Empty' } });
  await kit.contacts.start('k');
  const Page = () => {
    const location = useLocation();
    return (
      <>
        <nav><GroupNav current={location.pathname} /></nav>
        <ContactsView />
        <GroupDialog />
      </>
    );
  };
  const open = (path: string) =>
    kit.show(path, () => (
      <>
        <Route path="/contacts" component={Page} />
        <Route path="/contacts/group/:gid" component={Page} />
        <Route path="/contacts/group/:gid/:id" component={Page} />
        <Route path="/contacts/:id" component={Page} />
      </>
    ));
  return { ...kit, ann, bob, cy, team, empty, open };
}
const names = () => screen.getAllByRole('row').slice(1).map((r) => r.querySelector('a > span:last-child')?.textContent?.trim());
const tick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name: `Select ${name}` }));
const pick = async (button: string, item: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: button }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
};

describe('groups in the sidebar', () => {
  it('lists the groups with their counts, with a way to make one', async () => {
    const { open, team } = await seeded();
    open('/contacts');
    const nav = within(screen.getByRole('navigation'));
    expect(nav.getByText('Groups')).toBeInTheDocument();
    expect(nav.getByRole('link', { name: /^Team\s*3$/ })).toHaveAttribute('href', `/contacts/group/${team.id}`);
    expect(nav.getByRole('link', { name: 'Empty' })).toBeInTheDocument();
    expect(nav.getByRole('button', { name: 'New group' })).toBeInTheDocument();
  });
  it('is not shown away from the Contacts page', async () => {
    const kit = await seeded();
    kit.show('/inbox', () => <Route path="/inbox" component={() => <nav><GroupNav current="/inbox" /></nav>} />);
    expect(screen.queryByText('Groups')).toBeNull();
  });
  it('makes a group from the plus, refusing a name already taken', async () => {
    const { open, fake } = await seeded();
    open('/contacts');
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    const field = await screen.findByRole('textbox', { name: 'Group name' });
    fireEvent.input(field, { target: { value: 'team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('There is already a group called “Team”.')).toBeInTheDocument();
    fireEvent.input(field, { target: { value: 'Family' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await vi.waitFor(() => expect([...fake.cards.values()].some((c) => c.kind === 'group' && c.name?.full === 'Family')).toBe(true));
    await vi.waitFor(() => expect(screen.queryByRole('textbox', { name: 'Group name' })).toBeNull());
  });
  it('renames a group from its menu', async () => {
    const { open, fake, team } = await seeded();
    open('/contacts');
    await pick('Options for Team', 'Rename');
    const field = await screen.findByRole('textbox', { name: 'Group name' });
    expect(field).toHaveValue('Team');
    expect(screen.getByRole('heading', { name: 'Rename group' })).toBeInTheDocument();
    fireEvent.input(field, { target: { value: 'Crew' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(fake.cards.get(team.id)!.name?.full).toBe('Crew'));
  });
  it('deletes a group after asking, saying its people stay, and leaves its page', async () => {
    const { open, fake, team, confirm, path } = await seeded();
    open(`/contacts/group/${team.id}`);
    await pick('Options for Team', 'Delete');
    await vi.waitFor(() => expect(fake.cards.has(team.id)).toBe(false));
    expect(confirm).toHaveBeenCalledWith({ title: 'Delete “Team”?', message: 'The 3 people in it stay in your contacts.', confirmLabel: 'Delete group' });
    expect(path()).toBe('/contacts');
    expect(fake.cards.size).toBe(4);
  });
  it('says an empty group is empty when asking', async () => {
    const { open, confirm } = await seeded();
    open('/contacts');
    await pick('Options for Empty', 'Delete');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'The group is empty.' })));
  });
});

describe('a group on the Contacts page', () => {
  it('lists its members, its address-only members, and how many are not in the contacts', async () => {
    const { open, team } = await seeded();
    open(`/contacts/group/${team.id}`);
    expect(names()).toEqual(['Ann', 'Bob']);
    expect(screen.getByRole('heading', { name: 'Team' })).toBeInTheDocument();
    expect(screen.getByText('3 people')).toBeInTheDocument();
    expect(screen.getByText('ext@else.example')).toBeInTheDocument();
    expect(screen.getByText('Address only')).toBeInTheDocument();
    expect(screen.getByText('1 member of this group is not in your contacts.')).toBeInTheDocument();
  });
  it('says so when a group has nobody', async () => {
    const { open, empty } = await seeded();
    open(`/contacts/group/${empty.id}`);
    expect(screen.getByText('Nobody is in this group yet.')).toBeInTheDocument();
  });
  it('keeps the group in the address of a card opened from it', async () => {
    const { open, team, ann } = await seeded();
    open(`/contacts/group/${team.id}`);
    expect(screen.getByRole('link', { name: 'Ann' })).toHaveAttribute('href', `/contacts/group/${team.id}/${ann.id}`);
    fireEvent.click(screen.getByRole('link', { name: 'Ann' }));
    expect(await screen.findByRole('heading', { name: 'Ann', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to contacts' })).toHaveAttribute('href', `/contacts/group/${team.id}`);
  });
  it('returns to all contacts, with a word, when the group is deleted elsewhere', async () => {
    const { open, team, fake, contacts, toast, path } = await seeded();
    open(`/contacts/group/${team.id}`);
    fake.cards.delete(team.id);
    fake.bumpCards({ destroyed: [team.id] });
    await contacts.reload();
    await vi.waitFor(() => expect(path()).toBe('/contacts'));
    expect(toast).toHaveBeenCalledWith('That group was deleted.', 'info');
  });
});

describe('a selection in the contact list', () => {
  it('replaces the tools with what can be done to the selected', async () => {
    const { open } = await seeded();
    open('/contacts');
    expect(screen.queryByText(/selected$/)).toBeNull();
    tick('Ann');
    tick('Cy');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove from group' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByRole('searchbox', { name: 'Search contacts' })).toBeInTheDocument();
  });
  it('adds the selected to a group through the picker', async () => {
    const { open, fake, empty, toast } = await seeded();
    open('/contacts');
    tick('Ann');
    tick('Cy');
    await pick('Add to group', 'Empty');
    await vi.waitFor(() => expect(fake.cards.get(empty.id)!.members).toEqual({ 'u-ann': true, 'u-cy': true }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Added 2 to Empty.', 'info'));
  });
  it('makes a new group of the selected from the picker', async () => {
    const { open, fake, toast } = await seeded();
    open('/contacts');
    tick('Bob');
    await pick('Add to group', 'New group…');
    fireEvent.input(await screen.findByRole('textbox', { name: 'Group name' }), { target: { value: 'Solo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await vi.waitFor(() => expect([...fake.cards.values()].find((c) => c.name?.full === 'Solo')?.members).toEqual({ 'u-bob': true }));
    expect(toast).toHaveBeenCalledWith('Added 1 to Solo.', 'info');
  });
  it('selects everyone shown from the header box, which is half set when only some are', async () => {
    const { open } = await seeded();
    open('/contacts');
    const all = screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement;
    tick('Ann');
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    fireEvent.click(all);
    expect(screen.queryByText(/selected$/)).toBeNull();
  });
  it('holds only people who are shown: a search narrows it', async () => {
    const { open } = await seeded();
    open('/contacts');
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search contacts' }), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
  it('lets go of a selected person deleted on another device', async () => {
    const { open, fake, contacts, ann } = await seeded();
    open('/contacts');
    tick('Ann');
    tick('Bob');
    fake.cards.delete(ann.id);
    fake.bumpCards({ destroyed: [ann.id] });
    await contacts.reload();
    await vi.waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument());
  });
  it('is emptied by a change of group', async () => {
    const { open, team } = await seeded();
    open('/contacts');
    tick('Ann');
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('link', { name: /^Team\s*3$/ }));
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Team' })).toBeInTheDocument());
    expect(screen.queryByText(/selected$/)).toBeNull();
    expect(team.id).toBeTruthy();
  });
  it('toggles a row from the keyboard with Space', async () => {
    const { open } = await seeded();
    open('/contacts');
    fireEvent.keyDown(screen.getByRole('link', { name: 'Bob' }), { key: ' ' });
    expect(screen.getByRole('checkbox', { name: 'Select Bob' })).toBeChecked();
    fireEvent.keyDown(screen.getByRole('link', { name: 'Bob' }), { key: ' ' });
    expect(screen.getByRole('checkbox', { name: 'Select Bob' })).not.toBeChecked();
  });
  it('removes the selected from the group on screen', async () => {
    const { open, fake, team, toast } = await seeded();
    open(`/contacts/group/${team.id}`);
    tick('Ann');
    fireEvent.click(screen.getByRole('button', { name: 'Remove from group' }));
    await vi.waitFor(() => expect(fake.cards.get(team.id)!.members).toEqual({ 'u-bob': true, 'mailto:ext@else.example': true, 'u-gone': true }));
    await vi.waitFor(() => expect(names()).toEqual(['Bob']));
    expect(toast).toHaveBeenCalledWith('Removed 1 from Team.', 'info');
  });
  it('deletes the selected after asking', async () => {
    const { open, fake, confirm, toast, ann, cy } = await seeded();
    open('/contacts');
    tick('Ann');
    tick('Cy');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(fake.cards.has(ann.id) || fake.cards.has(cy.id)).toBe(false));
    expect(confirm).toHaveBeenCalledWith({ title: 'Delete 2 contacts?', message: 'This cannot be undone.', confirmLabel: 'Delete' });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Deleted 2 contacts.', 'info'));
    expect(names()).toEqual(['Bob']);
  });
  it('deletes nothing when the answer is no', async () => {
    const { open, fake, confirm } = await seeded();
    confirm.mockResolvedValueOnce(false);
    open('/contacts');
    tick('Ann');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await Promise.resolve();
    expect(fake.cards.size).toBe(5);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

describe('groups on a card', () => {
  it('shows the groups a person is in, and takes them out of one', async () => {
    const { open, fake, team, ann } = await seeded();
    open(`/contacts/${ann.id}`);
    expect(within(screen.getByRole('article')).getByText('Groups')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Team' }));
    await vi.waitFor(() => expect(fake.cards.get(team.id)!.members).not.toHaveProperty('u-ann'));
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Remove from Team' })).toBeNull());
  });
  it('adds the person to a group they are not in', async () => {
    const { open, fake, empty, ann } = await seeded();
    open(`/contacts/${ann.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Add to group' }));
    expect(await screen.findByRole('menuitem', { name: 'Empty' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Team' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Empty' }));
    await vi.waitFor(() => expect(fake.cards.get(empty.id)!.members).toEqual({ 'u-ann': true }));
  });
  it('stays on a person whose card had to be made again to join a group', async () => {
    const { open, fake, empty, path, toast, contacts } = await seeded();
    const dee = fake.addCard({ name: { full: 'Dee' } });
    await contacts.reload();
    open(`/contacts/${dee.id}`);
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Dee', level: 1 })).toBeInTheDocument());
    await pick('Add to group', 'Empty');
    await vi.waitFor(() => expect(Object.keys(fake.cards.get(empty.id)!.members ?? {})).toHaveLength(1));
    const copy = [...fake.cards.values()].find((c) => c.name?.full === 'Dee')!;
    await vi.waitFor(() => expect(path()).toBe(`/contacts/${copy.id}`));
    expect(screen.getByRole('heading', { name: 'Dee', level: 1 })).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith('That contact was deleted.', 'info');
  });
});
