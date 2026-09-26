import type { EmailAddress } from '../jmap/types';

export interface ParticipantMsg {
  from: EmailAddress[] | null | undefined;
  unread: boolean;
  draft: boolean;
}

export interface Participant {
  label: string;
  unread: boolean;
  draft: boolean;
  /** True for the "…" placeholder between collapsed participants. */
  gap?: boolean;
}

export function displayName(addr: EmailAddress | undefined, short = false): string {
  if (!addr) return '(no sender)';
  const name = addr.name?.trim().replace(/^["']|["']$/g, '');
  if (name) return short ? (name.split(/\s+/)[0] ?? name) : name;
  return addr.email.split('@')[0] ?? addr.email;
}

interface Sender {
  addr: EmailAddress | undefined;
  mine: boolean;
  draft: boolean;
  unread: boolean;
}

/**
 * Gmail-style participant list for a thread row. `msgs` are oldest → newest.
 * Each sender appears once, at the position of their latest message.
 */
export function formatParticipants(msgs: ParticipantMsg[], myAddresses: Set<string>): Participant[] {
  const senders = new Map<string, Sender>();

  for (const m of msgs) {
    const addr = m.from?.[0];
    const email = addr?.email.toLowerCase() ?? '';
    const key = m.draft ? '\u0000draft' : email;
    const prev = senders.get(key);
    senders.delete(key); // re-insert so Map order tracks each sender's latest message
    senders.set(key, {
      addr,
      mine: myAddresses.has(email),
      draft: m.draft,
      unread: (prev?.unread ?? false) || m.unread,
    });
  }

  const short = senders.size > 1;
  const list: Participant[] = [...senders.values()].map((s) => ({
    label: s.draft ? 'Draft' : s.mine ? 'me' : displayName(s.addr, short),
    unread: s.unread,
    draft: s.draft,
  }));

  if (list.length <= 4) return list;
  return [list[0]!, { label: '…', unread: false, draft: false, gap: true }, ...list.slice(-2)];
}
