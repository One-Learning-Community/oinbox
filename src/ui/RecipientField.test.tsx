import { Route } from '@solidjs/router';
import { fireEvent, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { EmailAddress } from '../jmap/types';
import { contactsKit } from './contacts-test-kit';
import { RecipientField } from './RecipientField';

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
