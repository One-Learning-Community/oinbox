import { Route } from '@solidjs/router';
import { fireEvent, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { ContactDialogState } from '../app/contacts';
import { ContactDialog } from './ContactDialog';
import { contactsKit } from './contacts-test-kit';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));

async function opened(state: ContactDialogState, seed: (kit: ReturnType<typeof contactsKit>) => string | void = () => {}, at = '/contacts') {
  const kit = contactsKit();
  const id = seed(kit);
  await kit.contacts.start('k');
  kit.show(at, () => <Route path="*" component={ContactDialog} />);
  kit.contacts.openDialog(state.kind === 'edit' && id ? { kind: 'edit', id } : state);
  await screen.findByRole('textbox', { name: 'Given name' });
  return { ...kit, id: id ?? '' };
}
const type = (name: string, value: string) => fireEvent.input(screen.getByRole('textbox', { name }), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
const sets = (kit: { fake: { sent: [string, Record<string, unknown>][] } }) => kit.fake.sent.filter(([n]) => n === 'ContactCard/set').map(([, a]) => a);

describe('ContactDialog', () => {
  it('saves a new person and opens their card', async () => {
    const kit = await opened({ kind: 'new' });
    expect(screen.getByRole('heading', { name: 'New contact' })).toBeInTheDocument();
    type('Given name', 'Nora');
    type('Surname', 'New');
    type('Email 1', 'nora@new.example');
    fireEvent.change(screen.getByRole('combobox', { name: 'Email 1 type' }), { target: { value: 'work' } });
    type('Phone 1', '555 0100');
    save();
    await vi.waitFor(() => expect(kit.contacts.dialog()).toBeNull());
    const card = [...kit.fake.cards.values()][0]!;
    expect(card).toMatchObject({
      uid: 'urn:uuid:test-1', kind: 'individual',
      name: { full: 'Nora New' },
      emails: { e1: { address: 'nora@new.example', contexts: { work: true } } },
      phones: { p1: { number: '555 0100', features: { mobile: true } } },
    });
    expect(kit.path()).toBe(`/contacts/${card.id}`);
    expect(kit.toast).not.toHaveBeenCalled();
  });

  it('says a contact was saved when the Contacts page is not on screen', async () => {
    const kit = await opened({ kind: 'new', seed: { name: 'Nora New', email: 'nora@new.example' } }, () => {}, '/inbox');
    expect(screen.getByRole('textbox', { name: 'Given name' })).toHaveValue('Nora');
    expect(screen.getByRole('textbox', { name: 'Surname' })).toHaveValue('New');
    expect(screen.getByRole('textbox', { name: 'Email 1' })).toHaveValue('nora@new.example');
    save();
    await vi.waitFor(() => expect(kit.contacts.dialog()).toBeNull());
    expect(kit.path()).toBe('/inbox');
    expect(kit.toast).toHaveBeenCalledWith('Saved to contacts.');
  });

  it('refuses a card with nothing to call it by, and sends nothing', async () => {
    const kit = await opened({ kind: 'new' });
    save();
    expect(await screen.findByText('Give a name, an organisation or an email address.')).toBeInTheDocument();
    expect(sets(kit)).toEqual([]);
    expect(kit.contacts.dialog()).not.toBeNull();
  });

  it('points at an address that is not one', async () => {
    const kit = await opened({ kind: 'new' });
    type('Given name', 'A');
    type('Email 1', 'ok@x.example');
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }));
    type('Email 2', 'not an address');
    save();
    const field = screen.getByRole('textbox', { name: 'Email 2' });
    await vi.waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(field).toHaveAccessibleDescription('This is not an email address.');
    expect(field).toHaveFocus();
    expect(sets(kit)).toEqual([]);
  });

  it('opens filled from the card and sends only what was changed', async () => {
    const kit = await opened({ kind: 'edit', id: '' }, (k) =>
      k.fake.addCard({
        name: { components: [{ kind: 'given', value: 'Zoë' }, { kind: 'surname', value: 'Probe' }] },
        emails: { e1: { address: 'zoe@work.example', contexts: { work: true } } },
        phones: { p1: { number: '555 0100', features: { mobile: true } } },
        notes: { n1: { note: 'Likes tea.' } },
      }).id,
    );
    expect(screen.getByRole('heading', { name: 'Edit contact' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Given name' })).toHaveValue('Zoë');
    expect(screen.getByRole('textbox', { name: 'Email 1' })).toHaveValue('zoe@work.example');
    expect(screen.getByRole('combobox', { name: 'Email 1 type' })).toHaveValue('work');
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('Likes tea.');
    type('Phone 1', '555 0200');
    save();
    await vi.waitFor(() => expect(kit.contacts.dialog()).toBeNull());
    expect(sets(kit)).toEqual([{ accountId: 'a1', update: { [kit.id]: { phones: { p1: { number: '555 0200', features: { mobile: true } } }, updated: '2026-10-10T12:00:00Z' } } }]);
  });

  it('marks the address a person prefers', async () => {
    const kit = await opened({ kind: 'new' });
    type('Given name', 'A');
    type('Email 1', 'one@x.example');
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }));
    type('Email 2', 'two@x.example');
    fireEvent.click(screen.getAllByRole('radio', { name: 'Preferred' })[1]!);
    save();
    await vi.waitFor(() => expect(kit.contacts.dialog()).toBeNull());
    expect([...kit.fake.cards.values()][0]!.emails).toEqual({ e1: { address: 'one@x.example' }, e2: { address: 'two@x.example', pref: 1 } });
  });

  it('removes a row', async () => {
    const kit = await opened({ kind: 'edit', id: '' }, (k) => k.fake.addCard({ name: { full: 'A B' }, emails: { e1: { address: 'a@x.example' }, e2: { address: 'b@x.example' } } }).id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove email 1' }));
    save();
    await vi.waitFor(() => expect(kit.contacts.dialog()).toBeNull());
    expect(kit.fake.cards.get(kit.id)!.emails).toEqual({ e2: { address: 'b@x.example' } });
  });

  it('keeps what was typed when the server refuses, and says why', async () => {
    const kit = await opened({ kind: 'new' });
    type('Given name', 'Nora');
    kit.fake.onCall = (name) => {
      if (name === 'ContactCard/set') throw new Error('The server is having a moment');
    };
    save();
    expect(await screen.findByText('The server is having a moment')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Given name' })).toHaveValue('Nora');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('closes at once when nothing was changed, and asks first when something was', async () => {
    const kit = await opened({ kind: 'new' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(kit.contacts.dialog()).toBeNull());
    expect(kit.confirm).not.toHaveBeenCalled();

    kit.contacts.openDialog({ kind: 'new' });
    await screen.findByRole('textbox', { name: 'Given name' });
    type('Given name', 'Half typed');
    kit.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(kit.confirm).toHaveBeenCalledWith({ title: 'Discard changes?', message: 'What you changed in this contact will be lost.', confirmLabel: 'Discard' }));
    expect(kit.contacts.dialog()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(kit.contacts.dialog()).toBeNull());
  });

  it('stops a save of a card that was deleted elsewhere', async () => {
    const kit = await opened({ kind: 'edit', id: '' }, (k) => k.fake.addCard({ name: { full: 'A B' } }).id);
    kit.fake.handle('ContactCard/set', { accountId: 'a1', destroy: [kit.id] }, ['urn:ietf:params:jmap:contacts']);
    kit.contacts.onStateChange({ '@type': 'StateChange', changed: { a1: { ContactCard: `k${kit.fake.cardState}` } } });
    expect(await screen.findByText('This contact was deleted elsewhere.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves a birthday and an address', async () => {
    const kit = await opened({ kind: 'new' });
    type('Given name', 'A');
    type('Birthday day', '14');
    fireEvent.change(screen.getByRole('combobox', { name: 'Birthday month' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add address' }));
    type('Address 1', '12 High St\nLeeds');
    type('Organisation', 'Acme');
    type('Job title', 'Head');
    save();
    await vi.waitFor(() => expect(kit.contacts.dialog()).toBeNull());
    expect([...kit.fake.cards.values()][0]).toMatchObject({
      anniversaries: { b1: { kind: 'birth', date: { month: 3, day: 14 } } },
      addresses: { a1: { full: '12 High St\nLeeds' } },
      organizations: { o1: { name: 'Acme' } },
      titles: { t1: { name: 'Head', kind: 'title' } },
    });
  });
});
