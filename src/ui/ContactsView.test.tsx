import { Route } from '@solidjs/router';
import { fireEvent, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { CONTACTS } from '../jmap/types';
import { contactsKit } from './contacts-test-kit';
import { ContactsView } from './ContactsView';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));
// jsdom lays nothing out, so the real virtual list would render no rows: this one renders them all.
vi.mock('./virtual', () => ({
  createVirtualList: (opts: { count: () => number }) => ({
    items: () => Array.from({ length: opts.count() }, (_, index) => ({ index, key: index, start: index * 48, end: (index + 1) * 48, size: 48 })),
    totalSize: () => opts.count() * 48,
    virtualizer: { scrollToIndex: () => {} },
  }),
}));

const routes = () => (
  <>
    <Route path="/contacts" component={ContactsView} />
    <Route path="/contacts/:id" component={ContactsView} />
  </>
);
const person = (given: string, surname: string, more: object = {}) => ({ name: { components: [{ kind: 'given', value: given }, { kind: 'surname', value: surname }] }, ...more });
const names = () => screen.getAllByRole('row').slice(1).map((r) => r.querySelector('a > span:last-child')?.textContent?.trim());

async function seeded() {
  const kit = contactsKit();
  const zoe = kit.fake.addCard(person('Zoë', 'Probe', {
    emails: { e1: { address: 'zoe@work.example', contexts: { work: true } } },
    phones: { p1: { number: '+1 (555) 019-9', features: { mobile: true } } },
    organizations: { o1: { name: 'Acme Ltd', units: [{ name: 'Research' }] } },
    titles: { t1: { name: 'Head of Research', kind: 'title' } },
    anniversaries: { b1: { kind: 'birth', date: { '@type': 'PartialDate', month: 3, day: 14 } } },
    nicknames: { n1: { name: 'Zed' } },
  }));
  const adam = kit.fake.addCard(person('Adam', 'Zeller', { emails: { e1: { address: 'adam@x.example' } } }));
  const mia = kit.fake.addCard(person('Mia', 'Mid'));
  kit.fake.addCard({ kind: 'group', name: { full: 'Aardvarks' } });
  await kit.contacts.start('k');
  return { ...kit, zoe, adam, mia };
}

describe('ContactsView', () => {
  it('lists people by name with a count, leaving group cards out', async () => {
    const { show } = await seeded();
    show('/contacts', routes);
    expect(names()).toEqual(['Adam Zeller', 'Mia Mid', 'Zoë Probe']);
    expect(screen.getByText('3 contacts')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Contacts' })).toBeInTheDocument();
    expect(screen.getByText('Select a contact')).toBeInTheDocument();
  });

  it('filters as you type and says when nothing matches', async () => {
    const { show } = await seeded();
    show('/contacts', routes);
    const box = screen.getByRole('searchbox', { name: 'Search contacts' });
    fireEvent.input(box, { target: { value: 'acm' } });
    expect(names()).toEqual(['Zoë Probe']);
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    fireEvent.input(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No contacts match “zzz”.')).toBeInTheDocument();
  });

  it('says so when there are no contacts, and offers to add one', async () => {
    const { show, contacts } = contactsKit();
    await contacts.start('k');
    show('/contacts', routes);
    expect(screen.getByText('No contacts yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New contact' }));
    expect(contacts.dialog()).toEqual({ kind: 'new' });
  });

  it('shows a failed load with a retry that works', async () => {
    const { show, contacts, fake } = contactsKit();
    fake.addCard(person('Only', 'One'));
    fake.onCall = () => { throw new Error('down'); };
    await contacts.start('k');
    show('/contacts', routes);
    expect(screen.getByText("Couldn't load your contacts.")).toBeInTheDocument();
    fake.onCall = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(names()).toEqual(['Only One']));
  });

  it('says it is loading before the first answer', () => {
    const { show } = contactsKit();
    show('/contacts', routes);
    expect(screen.getByRole('status')).toHaveTextContent('Loading contacts…');
  });

  it('opens a card beside the list and marks its row', async () => {
    const { show, zoe } = await seeded();
    show(`/contacts/${zoe.id}`, routes);
    expect(screen.getByRole('heading', { name: 'Zoë Probe' })).toBeInTheDocument();
    expect(screen.getByText('Head of Research, Acme Ltd · Research')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'zoe@work.example' })).toHaveAttribute('href', 'mailto:zoe@work.example');
    expect(screen.getByRole('link', { name: '+1 (555) 019-9' })).toHaveAttribute('href', 'tel:+15550199');
    expect(screen.getByText(/^(14 March|March 14)$/)).toBeInTheDocument();
    expect(screen.getByText('Zed')).toBeInTheDocument();
    expect(document.querySelector(`tr[data-contact-id="${zoe.id}"]`)).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Back to contacts' })).toHaveAttribute('href', '/contacts');
  });

  it('starts a message to a contact from their address', async () => {
    const { show, zoe, composers, draft } = await seeded();
    show(`/contacts/${zoe.id}`, routes);
    fireEvent.click(screen.getByRole('link', { name: 'zoe@work.example' }));
    expect(composers.open).toHaveBeenCalledWith('new');
    expect(draft.update).toHaveBeenCalledWith({ to: [{ name: 'Zoë Probe', email: 'zoe@work.example' }] });
  });

  it('opens the dialog to edit, and deletes without a second toast', async () => {
    const { show, zoe, contacts, toast, path } = await seeded();
    show(`/contacts/${zoe.id}`, routes);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(contacts.dialog()).toEqual({ kind: 'edit', id: zoe.id });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() => expect(path()).toBe('/contacts'));
    expect(toast.mock.calls.map((c) => c[0])).toEqual(['Contact deleted.']);
    expect(names()).toEqual(['Adam Zeller', 'Mia Mid']);
  });

  it('goes back to the list, saying why, when the open card is deleted elsewhere', async () => {
    const { show, zoe, contacts, fake, toast, path } = await seeded();
    show(`/contacts/${zoe.id}`, routes);
    fake.handle('ContactCard/set', { accountId: 'a1', destroy: [zoe.id] }, [CONTACTS]);
    contacts.onStateChange({ '@type': 'StateChange', changed: { a1: { ContactCard: `k${fake.cardState}` } } });
    await vi.waitFor(() => expect(path()).toBe('/contacts'));
    expect(toast).toHaveBeenCalledWith('That contact was deleted.', 'info');
  });

  it('leaves an address for a card that never was without a word', async () => {
    const { show, toast, path } = await seeded();
    show('/contacts/nope', routes);
    await vi.waitFor(() => expect(path()).toBe('/contacts'));
    expect(toast).not.toHaveBeenCalled();
  });

  it('moves between rows with the arrow keys', async () => {
    const { show } = await seeded();
    show('/contacts', routes);
    const links = screen.getAllByRole('row').slice(1).map((r) => r.querySelector('a')!);
    links[0]!.focus();
    fireEvent.keyDown(links[0]!, { key: 'ArrowDown' });
    expect(links[1]).toHaveFocus();
    fireEvent.keyDown(links[1]!, { key: 'ArrowUp' });
    expect(links[0]).toHaveFocus();
  });
});
