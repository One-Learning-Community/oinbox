import { describe, expect, it } from 'vitest';
import type { Mailbox } from '../jmap/types';
import type { EmailRec } from './engine';
import { isLabel, resolveView, sidebarMailboxes, subLabelCount, threadRow } from './selectors';

const mb = (id: string, name: string, role: Mailbox['role'] = null, parentId: string | null = null): Mailbox => ({
  id, name, role, parentId, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
});

const mailboxes = {
  I: mb('I', 'Inbox', 'inbox'),
  S: mb('S', 'Sent', 'sent'),
  T: mb('T', 'Trash', 'trash'),
  W: mb('W', 'Work'),
};

const e = (id: string, over: Partial<EmailRec>): EmailRec => ({
  id, threadId: 't1', keywords: { $seen: true }, mailboxIds: { I: true }, receivedAt: '2026-09-01T00:00:00Z', ...over,
});

describe('threadRow', () => {
  const emails = {
    e1: e('e1', { from: [{ name: 'Bob', email: 'bob@x.test' }], receivedAt: '2026-09-01T10:00:00Z' }),
    e2: e('e2', { from: [{ name: 'Alice', email: 'alice@example.test' }], mailboxIds: { S: true }, receivedAt: '2026-09-01T11:00:00Z' }),
    e3: e('e3', {
      from: [{ name: 'Bob', email: 'bob@x.test' }], keywords: {}, mailboxIds: { I: true, W: true }, receivedAt: '2026-09-01T12:00:00Z',
      subject: 'Lunch', preview: 'Noon?', hasAttachment: false,
    }),
    e4: e('e4', { from: [{ name: 'Spam', email: 'x@x.test' }], mailboxIds: { T: true }, receivedAt: '2026-09-01T13:00:00Z' }),
  };
  const threads = { t1: { id: 't1', emailIds: ['e1', 'e2', 'e3', 'e4'] } };
  const me = new Set(['alice@example.test']);

  it('aggregates across the thread including Sent, excluding Trash', () => {
    const row = threadRow({ emails, threads, mailboxes }, 'e3', { viewing: 'I', me })!;
    expect(row.count).toBe(3);
    expect(row.participants.map((p) => p.label)).toEqual(['me', 'Bob']);
    expect(row.unread).toBe(true);
    expect(row.date).toBe('2026-09-01T12:00:00Z');
    expect(row.labels).toEqual([{ id: 'W', name: 'Work' }]);
  });

  it('includes Trash messages when viewing Trash', () => {
    expect(threadRow({ emails, threads, mailboxes }, 'e3', { viewing: 'T', me })!.count).toBe(4);
  });

  it('shows an Inbox chip outside the inbox', () => {
    expect(threadRow({ emails, threads, mailboxes }, 'e3', { viewing: 'W', me })!.labels.map((l) => l.name)).toEqual(['Inbox']);
  });

  it('returns null until the row email is loaded', () => {
    expect(threadRow({ emails, threads, mailboxes }, 'e1', { viewing: 'I', me })).toBeNull();
  });
});

describe('views', () => {
  it('resolves role slugs, label slugs and starred', () => {
    expect(resolveView('inbox', mailboxes)!.spec.filter).toEqual({ inMailbox: 'I' });
    expect(resolveView('label/W', mailboxes)!.title).toBe('Work');
    expect(resolveView('starred', mailboxes)!.spec.filter).toEqual({ hasKeyword: '$flagged' });
    expect(resolveView('nope', mailboxes)).toBeNull();
  });

  it('orders system mailboxes by role', () => {
    const { system, labels } = sidebarMailboxes(mailboxes);
    expect(system.map((m) => m.id)).toEqual(['I', 'S', 'T']);
    expect(labels.map((m) => m.id)).toEqual(['W']);
  });
});

describe('search views', () => {
  it('parses the query into a snippet-enabled spec', () => {
    const v = resolveView('search/' + encodeURIComponent('in:work budget'), mailboxes)!;
    expect(v.spec.filter).toEqual({ operator: 'AND', conditions: [{ inMailbox: 'W' }, { text: 'budget' }] });
    expect(v.spec.snippets).toBe(true);
    expect(v.search).toEqual({ query: 'in:work budget', errors: [] });
  });

  it('scopes the view to a mailbox when the query is only in:', () => {
    expect(resolveView('search/in%3Asent', mailboxes)!.mailboxId).toBe('S');
  });
});

describe('labels', () => {
  const tree = {
    I: mb('I', 'Inbox', 'inbox'),
    C: mb('C', 'Clients'),
    A: mb('A', 'Acme', null, 'C'),
    N: mb('N', 'Invoices', null, 'A'),
    B: mb('B', 'Bolt', null, 'C'),
    R: mb('R', 'Receipts'),
  };

  it('isLabel is true only for mailboxes without a role', () => {
    expect(isLabel(tree.C)).toBe(true);
    expect(isLabel(tree.I)).toBe(false);
  });

  it('subLabelCount counts every descendant', () => {
    expect(subLabelCount('C', tree)).toBe(3);
    expect(subLabelCount('A', tree)).toBe(1);
    expect(subLabelCount('R', tree)).toBe(0);
  });
});
