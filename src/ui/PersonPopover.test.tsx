import { Route } from '@solidjs/router';
import { fireEvent, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { App } from '../app/context';
import { contactsKit } from './contacts-test-kit';
import { PersonButton } from './PersonPopover';

vi.mock('../cache/persist', () => ({ loadContacts: vi.fn(async () => undefined), saveContacts: vi.fn(async () => undefined) }));

const nora = { name: 'Nora New', email: 'nora@new.example' };

async function shown(address = nora, opts: { extra?: Partial<App>; inMessage?: boolean; seed?: (kit: ReturnType<typeof contactsKit>) => void } = {}) {
  const kit = contactsKit(opts.extra);
  opts.seed?.(kit);
  await kit.contacts.start('k');
  kit.show('/inbox', () => <Route path="*" component={() => <PersonButton address={address} label={`<${address.email}>`} inMessage={opts.inMessage} />} />);
  return kit;
}
const openIt = async (label = '<nora@new.example>') => {
  const button = screen.getByRole('button', { name: label });
  fireEvent.click(button);
  await screen.findByRole('dialog');
  return button;
};
const saved = (kit: ReturnType<typeof contactsKit>) =>
  kit.fake.addCard({
    name: { components: [{ kind: 'given', value: 'Nora' }, { kind: 'surname', value: 'Saved' }] },
    emails: { e1: { address: 'NORA@new.example' } },
    phones: { p1: { number: '555 0100' } },
    organizations: { o1: { name: 'Acme' } },
  });

describe('PersonButton', () => {
  it('offers to save someone who is not a contact, starting from their name and address', async () => {
    const kit = await shown();
    const button = await openIt();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Nora New' })).toHaveTextContent('nora@new.example');
    expect(screen.queryByRole('button', { name: 'Edit contact' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to contacts' }));
    expect(kit.contacts.dialog()).toEqual({ kind: 'new', seed: { name: 'Nora New', email: 'nora@new.example' } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('seeds no name when all that is known is the address', async () => {
    const kit = await shown({ name: 'bare@x.example', email: 'bare@x.example' });
    await openIt('<bare@x.example>');
    fireEvent.click(screen.getByRole('button', { name: 'Add to contacts' }));
    expect(kit.contacts.dialog()).toEqual({ kind: 'new', seed: { email: 'bare@x.example' } });
  });

  it('shows a saved person as they were saved, to edit or open', async () => {
    let id = '';
    const kit = await shown(nora, { seed: (k) => (id = saved(k).id) });
    await openIt();
    const panel = screen.getByRole('dialog', { name: 'Nora Saved' });
    expect(panel).toHaveTextContent('555 0100');
    expect(panel).toHaveTextContent('Acme');
    expect(screen.queryByRole('button', { name: 'Add to contacts' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open in Contacts' })).toHaveAttribute('href', `/contacts/${id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Edit contact' }));
    expect(kit.contacts.dialog()).toEqual({ kind: 'edit', id });
  });

  it('does not offer the Contacts page inside a shared mailbox', async () => {
    const info = { id: 's', address: 'support@example.test', personal: false, label: 'Support', base: '/shared/s' };
    await shown(nora, { seed: saved, extra: { spaces: { current: () => ({ info }) } } as never });
    await openIt();
    expect(screen.getByRole('button', { name: 'Edit contact' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in Contacts' })).toBeNull();
  });

  it('says when someone is a colleague, under the name the directory gives', async () => {
    await shown({ name: null, email: 'bob@example.test' } as never, { extra: { directory: { entries: () => [{ email: 'Bob@example.test', name: 'Bob Example', group: false }] } } as never });
    await openIt('<bob@example.test>');
    const panel = screen.getByRole('dialog', { name: 'Bob Example' });
    expect(panel).toHaveTextContent('In your organisation');
    expect(screen.getByRole('button', { name: 'Add to contacts' })).toBeInTheDocument();
  });

  it('starts a message from a name in a message, and only there', async () => {
    const kit = await shown(nora, { inMessage: true });
    await openIt();
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    expect(kit.composers.open).toHaveBeenCalledWith('new');
    expect(kit.draft.update).toHaveBeenCalledWith({ to: [nora] });
    await openIt();
    expect(screen.getByRole('button', { name: 'New message' })).toBeInTheDocument();
  });

  it('has no New message on a recipient chip', async () => {
    await shown();
    await openIt();
    expect(screen.queryByRole('button', { name: 'New message' })).toBeNull();
  });

  it('closes on Escape with the focus back on the name', async () => {
    await shown();
    const button = await openIt();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add to contacts' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('is plain text on a server without contacts', async () => {
    const kit = contactsKit();
    kit.fake.contactsSupported = false;
    kit.show('/inbox', () => <Route path="*" component={() => <PersonButton address={nora} label="Nora" />} />);
    expect(screen.getByText('Nora')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
