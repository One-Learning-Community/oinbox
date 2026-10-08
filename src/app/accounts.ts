import { MAIL, type Id, type Session } from '../jmap/types';

/** A mail account the signed-in user may open: their own, or a shared one (a Stalwart group). */
export interface AccountInfo {
  id: Id;
  address: string;
  personal: boolean;
  /** "You", or the shared mailbox's name: "Support" for support@example.test. */
  label: string;
  /** What its addresses start with: '' for the user's own, /shared/<id> otherwise. */
  base: string;
}

const labelOf = (name: string): string => {
  const local = name.split('@')[0] || name;
  return local.charAt(0).toUpperCase() + local.slice(1);
};

/** The user's own account first, then the shared ones by label. */
export function mailAccounts(session: Session): AccountInfo[] {
  const own = session.primaryAccounts[MAIL];
  return Object.entries(session.accounts)
    .filter(([, a]) => a.accountCapabilities?.[MAIL])
    .map(([id, a]) => {
      const personal = id === own;
      return { id, address: a.name, personal, label: personal ? 'You' : labelOf(a.name), base: personal ? '' : `/shared/${encodeURIComponent(id)}` };
    })
    .sort((x, y) => Number(y.personal) - Number(x.personal) || x.label.localeCompare(y.label));
}

/** The account an address belongs to. An unknown or lost shared account is the user's own. */
export function accountForPath(pathname: string, accounts: AccountInfo[]): AccountInfo {
  return accounts.find((a) => a.base && (pathname === a.base || pathname.startsWith(`${a.base}/`))) ?? accounts[0]!;
}

export function withinAccount(pathname: string, account: AccountInfo): string {
  if (!account.base) return pathname;
  return pathname.slice(account.base.length) || '/';
}
