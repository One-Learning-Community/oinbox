import type { Id } from '../jmap/types';

/** A query result list where unloaded positions are null. */
export type Slots = (Id | null)[];

export interface QueryDelta {
  removed: Id[];
  added: { id: Id; index: number }[];
  total?: number;
}

/** Apply an Email/queryChanges result to a partially loaded list (RFC 8620 §5.6). */
export function applyQueryChanges(slots: Slots, delta: QueryDelta): Slots {
  const removed = new Set(delta.removed);
  const out = slots.filter((id) => id === null || !removed.has(id));
  for (const { id, index } of [...delta.added].sort((a, b) => a.index - b.index)) {
    while (out.length < index) out.push(null);
    out.splice(index, 0, id);
  }
  if (delta.total !== undefined) {
    if (out.length > delta.total) out.length = delta.total;
    while (out.length < delta.total) out.push(null);
  }
  return out;
}

/** Page start offsets (multiples of pageSize) covering [from, to) that contain unloaded slots. */
export function missingPages(slots: Slots, from: number, to: number, pageSize: number): number[] {
  const end = Math.min(to, slots.length);
  const pages: number[] = [];
  for (let p = Math.floor(Math.max(0, from) / pageSize) * pageSize; p < end; p += pageSize) {
    for (let i = p; i < Math.min(p + pageSize, slots.length); i++) {
      if (slots[i] === null) {
        pages.push(p);
        break;
      }
    }
  }
  return pages;
}
