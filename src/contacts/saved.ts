// Saved people as the composer's recipient suggestions see them: one entry per address.
// Pure: no Solid, no JMAP.
import type { ContactCard, Id } from '../jmap/types';
import { displayName, emailsOf, organizationOf } from './card';

export interface SavedEntry {
  email: string;
  /** The name the person was saved under; '' for a card known only by this address. */
  name: string;
  /** The address the person prefers, of those they have. */
  preferred: boolean;
  /** More to find the person by: organisation, department, nicknames. */
  words: string[];
  contactId: Id;
}

/** `people` in list order. An address on two cards belongs to the first. */
export function savedEntries(people: ContactCard[]): SavedEntry[] {
  const seen = new Set<string>();
  const out: SavedEntry[] = [];
  for (const card of people) {
    const emails = emailsOf(card).filter((e) => e.address.trim());
    if (!emails.length) continue;
    const shown = displayName(card);
    const org = organizationOf(card);
    const words = [org.name, org.department, ...Object.values(card.nicknames ?? {}).map((n) => n.name.trim())].filter(Boolean);
    for (const e of emails) {
      const email = e.address.trim();
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // A card with no name and no organisation is "called" by its first address: that is not a name.
      out.push({ email, name: emails.some((x) => x.address.trim() === shown) ? '' : shown, preferred: e.preferred, words, contactId: card.id });
    }
  }
  return out;
}
