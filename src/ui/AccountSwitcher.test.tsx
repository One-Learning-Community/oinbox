import { fireEvent, render } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { AccountSpace, Spaces } from '../app/accounts';
import { AccountSwitcher } from './AccountSwitcher';

const space = (id: string, label: string, address: string, drafts = 0): AccountSpace =>
  ({ info: { id, label, address, personal: id === 'b', base: id === 'b' ? '' : `/shared/${id}` }, composers: { list: () => new Array(drafts).fill({}) } }) as never;

function setup(list: AccountSpace[], unread: Record<string, number>, start = 'b') {
  const [cur, setCur] = createSignal(start);
  const spaces: Spaces = {
    list: () => list,
    current: () => list.find((s) => s.info.id === cur())!,
    unread: (s) => unread[s.info.id] ?? 0,
    totalUnread: () => Object.values(unread).reduce((a, b) => a + b, 0),
    show: setCur,
  };
  const switched: string[] = [];
  const view = render(() => <AccountSwitcher spaces={spaces} onSwitch={(s) => switched.push(s.info.id)} />);
  return { ...view, switched };
}

const you = space('b', 'You', 'alice@example.test');
const support = space('s', 'Support', 'support@example.test');

describe('AccountSwitcher', () => {
  it('is not there with a single account', () => {
    const { container } = setup([you], {});
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the open account, and a dot when another has unread mail', () => {
    const { getByRole } = setup([you, support], { b: 4, s: 3 });
    const button = getByRole('button', { name: /^You/ });
    expect(button).toHaveAccessibleName('You, alice@example.test. Unread mail in another mailbox.');
    expect(button.querySelector('.account-dot')).not.toBeNull();
  });
  it('has no dot when only the open account has unread mail', () => {
    const { getByRole } = setup([you, support], { b: 4, s: 0 });
    const button = getByRole('button', { name: /^You/ });
    expect(button).toHaveAccessibleName('You, alice@example.test');
    expect(button.querySelector('.account-dot')).toBeNull();
  });
  it('lists every account with its unread count and switches on choosing one', () => {
    const { getByRole, getAllByRole, switched } = setup([you, support], { b: 0, s: 3 });
    fireEvent.click(getByRole('button', { name: /^You/ }));
    const items = getAllByRole('menuitemradio');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['You, alice@example.test', 'Support, support@example.test, 3 unread']);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(items[1]!);
    expect(switched).toEqual(['s']);
  });
  it('does nothing on choosing the account already open', () => {
    const { getByRole, getAllByRole, queryByRole, switched } = setup([you, support], {});
    fireEvent.click(getByRole('button', { name: /^You/ }));
    fireEvent.click(getAllByRole('menuitemradio')[0]!);
    expect(switched).toEqual([]);
    expect(queryByRole('menu')).toBeNull();
  });
  it('marks an account with a composer open', () => {
    const { getByRole, getAllByRole } = setup([you, space('s', 'Support', 'support@example.test', 1)], { s: 0 });
    fireEvent.click(getByRole('button', { name: /^You/ }));
    expect(getAllByRole('menuitemradio')[1]).toHaveAccessibleName('Support, support@example.test, draft open');
  });
  it('closes on Escape and gives the focus back to the button', () => {
    const { getByRole, queryByRole } = setup([you, support], {});
    const button = getByRole('button', { name: /^You/ });
    fireEvent.click(button);
    fireEvent.keyDown(getByRole('menu'), { key: 'Escape' });
    expect(queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });
});
