import { describe, expect, it } from 'vitest';
import { formatParticipants, type ParticipantMsg } from './participants';

const me = new Set(['alice@example.test']);
const msg = (email: string, name: string | null, unread = false, draft = false): ParticipantMsg => ({
  from: [{ email, name }],
  unread,
  draft,
});

describe('formatParticipants', () => {
  it('uses the first name and "me" for own addresses', () => {
    const p = formatParticipants([msg('bob@x.test', 'Bob Smith'), msg('alice@example.test', 'Alice')], me);
    expect(p.map((x) => x.label)).toEqual(['Bob', 'me']);
  });

  it('uses the full name when only one participant', () => {
    expect(formatParticipants([msg('bob@x.test', 'Bob Smith')], me).map((x) => x.label)).toEqual(['Bob Smith']);
  });

  it('falls back to the address local part', () => {
    expect(formatParticipants([msg('carol@x.test', null)], me).map((x) => x.label)).toEqual(['carol']);
  });

  it('dedupes senders, keeping the latest position and unread if any message is unread', () => {
    const p = formatParticipants(
      [msg('bob@x.test', 'Bob', true), msg('alice@example.test', 'Alice'), msg('bob@x.test', 'Bob')],
      me,
    );
    expect(p.map((x) => [x.label, x.unread])).toEqual([
      ['me', false],
      ['Bob', true],
    ]);
  });

  it('collapses long lists to first, gap, last two', () => {
    const p = formatParticipants(
      ['a', 'b', 'c', 'd', 'e'].map((n) => msg(`${n}@x.test`, n.toUpperCase())),
      me,
    );
    expect(p.map((x) => x.label)).toEqual(['A', '…', 'D', 'E']);
  });

  it('marks drafts', () => {
    const p = formatParticipants([msg('bob@x.test', 'Bob'), msg('alice@example.test', 'Alice', false, true)], me);
    expect(p.map((x) => [x.label, x.draft])).toEqual([
      ['Bob', false],
      ['Draft', true],
    ]);
  });
});
