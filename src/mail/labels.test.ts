import { describe, expect, it } from 'vitest';
import type { Mailbox, Session } from '../jmap/types';
import { DEFAULT_LIMITS, labelLimits, planLabel } from './labels';

const mb = (id: string, name: string, parentId: string | null = null, role: Mailbox['role'] = null): Mailbox => ({
  id, name, role, parentId, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
});

const boxes = {
  I: mb('I', 'Inbox', null, 'inbox'),
  S: mb('S', 'Sent Items', null, 'sent'),
  C: mb('C', 'Clients'),
  A: mb('A', 'Acme', 'C'),
  R: mb('R', 'Receipts'),
  X: mb('X', 'Sub', 'I'), // a label under Inbox, made by another client
};

const plan = (path: string, renaming?: string, limits = DEFAULT_LIMITS) => planLabel(path, boxes, limits, renaming);
const error = (path: string, renaming?: string, limits = DEFAULT_LIMITS) => {
  const r = plan(path, renaming, limits);
  return r.ok ? null : r.error;
};

describe('planLabel', () => {
  it('plans a top-level label', () => {
    expect(plan('Travel')).toEqual({ ok: true, plan: { parentId: null, ancestors: [], name: 'Travel' }, path: 'Travel', noop: false });
  });

  it('reuses an existing parent whatever its letter case', () => {
    expect(plan('clients/New')).toEqual({ ok: true, plan: { parentId: 'C', ancestors: [], name: 'New' }, path: 'Clients/New', noop: false });
  });

  it('lists the missing ancestors, outermost first', () => {
    expect(plan('Projects/2026/Q1')).toEqual({ ok: true, plan: { parentId: null, ancestors: ['Projects', '2026'], name: 'Q1' }, path: 'Projects/2026/Q1', noop: false });
    expect(plan('Clients/Acme/Invoices/Paid')).toEqual({
      ok: true, plan: { parentId: 'A', ancestors: ['Invoices'], name: 'Paid' }, path: 'Clients/Acme/Invoices/Paid', noop: false,
    });
  });

  it('trims segments and collapses inner whitespace', () => {
    expect(plan('  Clients /  New   label ')).toEqual({ ok: true, plan: { parentId: 'C', ancestors: [], name: 'New label' }, path: 'Clients/New label', noop: false });
    expect(plan('a\tb')).toMatchObject({ ok: true, plan: { name: 'a b' } });
  });

  it('refuses empty names and empty segments', () => {
    for (const p of ['', '   ', 'a//b', '/a', 'a/']) expect(error(p)).toBe("A label name can't be empty.");
  });

  it('refuses control characters', () => {
    expect(error('a\u0007b')).toBe("Label names can't contain control characters.");
  });

  it('measures the name limit in UTF-8 bytes', () => {
    expect(plan('x'.repeat(255)).ok).toBe(true);
    expect(error('x'.repeat(256))).toBe(`'${'x'.repeat(30)}…' is too long.`);
    expect(plan('😀'.repeat(63)).ok).toBe(true);
    expect(error('😀'.repeat(64))).toBe(`'${'😀'.repeat(15)}…' is too long.`);
    expect(error('Clients/abcd', undefined, { maxDepth: 10, maxNameBytes: 3 })).toBe("'Clients' is too long.");
  });

  it('refuses system mailboxes anywhere in the path', () => {
    expect(error('Inbox/Foo')).toBe("'Inbox' is a system mailbox.");
    expect(error('sent items')).toBe("'Sent Items' is a system mailbox.");
  });

  it('refuses a path that already exists, comparing case-insensitively', () => {
    expect(error('receipts')).toBe("A label named 'Receipts' already exists.");
    expect(error('clients/acme')).toBe("A label named 'Clients/Acme' already exists.");
  });

  it('refuses paths deeper than the limit', () => {
    expect(plan('a/b/c/d/e/f/g/h/i/j').ok).toBe(true);
    expect(error('a/b/c/d/e/f/g/h/i/j/k')).toBe('Labels can be nested at most 10 deep.');
  });

  describe('renaming', () => {
    it('treats the same parent and exact name as a no-op', () => {
      expect(plan('Receipts', 'R')).toMatchObject({ ok: true, noop: true });
      expect(plan('Clients/Acme', 'A')).toMatchObject({ ok: true, noop: true });
    });

    it('treats a change of case as a real rename, not a duplicate', () => {
      expect(plan('receipts', 'R')).toEqual({ ok: true, plan: { parentId: null, ancestors: [], name: 'receipts' }, path: 'receipts', noop: false });
    });

    it('moves a label when the parent part changes', () => {
      expect(plan('Clients/Receipts', 'R')).toMatchObject({ ok: true, plan: { parentId: 'C', ancestors: [], name: 'Receipts' }, noop: false });
      expect(plan('Sub', 'X')).toMatchObject({ ok: true, plan: { parentId: null, name: 'Sub' } });
    });

    it('still refuses the name of another label', () => {
      expect(error('Receipts', 'C')).toBe("A label named 'Receipts' already exists.");
    });

    it('refuses moving a label inside itself', () => {
      expect(error('Clients/Sub', 'C')).toBe("A label can't be moved inside itself.");
      expect(error('Clients/Acme/Clients', 'C')).toBe("A label can't be moved inside itself.");
    });

    it('counts the label\'s own sub-labels against the depth limit', () => {
      const tight = { maxDepth: 3, maxNameBytes: 255 };
      expect(plan('x/Clients', 'C', tight).ok).toBe(true); // 2 levels + Acme below = 3
      expect(error('x/y/Clients', 'C', tight)).toBe('Labels can be nested at most 3 deep.');
    });
  });
});

describe('labelLimits', () => {
  const session = (mail: Record<string, unknown> | undefined): Session => ({
    capabilities: {}, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' }, username: 'u', apiUrl: '', downloadUrl: '', uploadUrl: '', eventSourceUrl: '', state: 's',
    accounts: { a1: { name: 'u', isPersonal: true, isReadOnly: false, ...(mail ? { accountCapabilities: { 'urn:ietf:params:jmap:mail': mail } } : {}) } },
  });

  it('reads the limits from the mail capability', () => {
    expect(labelLimits(session({ maxMailboxDepth: 4, maxSizeMailboxName: 100 }))).toEqual({ maxDepth: 4, maxNameBytes: 100 });
  });

  it('falls back when the capability or a value is missing', () => {
    expect(labelLimits(session(undefined))).toEqual(DEFAULT_LIMITS);
    expect(labelLimits(session({ maxMailboxDepth: null }))).toEqual(DEFAULT_LIMITS);
  });
});
