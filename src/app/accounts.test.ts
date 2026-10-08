import { describe, expect, it } from 'vitest';
import type { Session } from '../jmap/types';
import { accountForPath, mailAccounts, withinAccount } from './accounts';

const MAIL = 'urn:ietf:params:jmap:mail';
const session = (accounts: Record<string, { name: string; isPersonal: boolean; mail?: boolean }>, primary = 'b') =>
  ({
    primaryAccounts: { [MAIL]: primary },
    accounts: Object.fromEntries(Object.entries(accounts).map(([id, a]) => [id, { name: a.name, isPersonal: a.isPersonal, isReadOnly: false, accountCapabilities: a.mail === false ? {} : { [MAIL]: {} } }])),
  }) as unknown as Session;
const aliceAndSupport = () => mailAccounts(session({ b: { name: 'alice@example.test', isPersonal: true }, s: { name: 'support@example.test', isPersonal: false } }));

describe('mailAccounts', () => {
  it("lists the user's own account first, then shared ones by name", () => {
    const got = mailAccounts(session({ s: { name: 'support@example.test', isPersonal: false }, b: { name: 'alice@example.test', isPersonal: true }, a: { name: 'accounts@example.test', isPersonal: false } }));
    expect(got).toEqual([
      { id: 'b', address: 'alice@example.test', personal: true, label: 'You', base: '' },
      { id: 'a', address: 'accounts@example.test', personal: false, label: 'Accounts', base: '/shared/a' },
      { id: 's', address: 'support@example.test', personal: false, label: 'Support', base: '/shared/s' },
    ]);
  });
  it('leaves out an account without mail', () => {
    expect(mailAccounts(session({ b: { name: 'alice@example.test', isPersonal: true }, c: { name: 'cal@example.test', isPersonal: false, mail: false } })).map((a) => a.id)).toEqual(['b']);
  });
  it('labels a name that is not an address by the name itself', () => {
    expect(mailAccounts(session({ b: { name: 'alice', isPersonal: true }, g: { name: 'front desk', isPersonal: false } }))[1]!.label).toBe('Front desk');
  });
});

describe('accountForPath', () => {
  const list = aliceAndSupport();
  it('finds the shared account in the address', () => {
    expect(accountForPath('/shared/s/inbox/t/t1', list).id).toBe('s');
    expect(accountForPath('/shared/s', list).id).toBe('s');
  });
  it("is the user's own account everywhere else", () => {
    expect(accountForPath('/inbox', list).id).toBe('b');
    expect(accountForPath('/', list).id).toBe('b');
  });
  it("falls back to the user's own account for one they can no longer open", () => {
    expect(accountForPath('/shared/gone/inbox', list).id).toBe('b');
  });
  it('does not mistake a longer id for a shorter one', () => {
    expect(accountForPath('/shared/sx/inbox', list).id).toBe('b');
  });
});

describe('withinAccount', () => {
  const [own, shared] = aliceAndSupport();
  it("drops the account's base from a path", () => {
    expect(withinAccount('/shared/s/inbox/t/t1', shared!)).toBe('/inbox/t/t1');
    expect(withinAccount('/shared/s', shared!)).toBe('/');
    expect(withinAccount('/inbox', own!)).toBe('/inbox');
  });
});
