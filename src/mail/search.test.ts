import { describe, expect, it } from 'vitest';
import { parseSearch, type SearchContext } from './search';

const ctx: SearchContext = {
  mailboxIdByRole: (role) => ({ inbox: 'I', sent: 'S', trash: 'T', junk: 'J', drafts: 'D', archive: 'A' })[role],
  mailboxIdByName: (name) => ({ work: 'W', 'projects/alpha': 'PA' })[name.toLowerCase()],
  now: new Date(2026, 8, 25, 12, 0, 0),
};

const notTrashOrSpam = { inMailboxOtherThan: ['T', 'J'] };
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

describe('parseSearch', () => {
  it('treats bare words as full-text and hides trash/spam by default', () => {
    expect(parseSearch('quarterly report', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ text: 'quarterly' }, { text: 'report' }, notTrashOrSpam],
    });
  });

  it('keeps quoted phrases together', () => {
    expect(parseSearch('"quarterly report"', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ text: 'quarterly report' }, notTrashOrSpam],
    });
  });

  it('maps address and subject operators', () => {
    expect(parseSearch('from:bob to:alice@example.test cc:carol bcc:dan subject:"lunch plans"', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ from: 'bob' }, { to: 'alice@example.test' }, { cc: 'carol' }, { bcc: 'dan' }, { subject: 'lunch plans' }, notTrashOrSpam],
    });
  });

  it('maps has:, is:, and size operators', () => {
    expect(parseSearch('has:attachment is:unread is:starred larger:5M smaller:100k', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [
        { hasAttachment: true },
        { notKeyword: '$seen' },
        { hasKeyword: '$flagged' },
        { minSize: 5 * 1024 * 1024 },
        { maxSize: 100 * 1024 },
        notTrashOrSpam,
      ],
    });
    expect(parseSearch('is:read', ctx).filter).toEqual({ operator: 'AND', conditions: [{ hasKeyword: '$seen' }, notTrashOrSpam] });
  });

  it('parses dates in local time (Gmail semantics)', () => {
    expect(parseSearch('after:2026/09/01 before:2026-09-15', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ after: local(2026, 9, 1) }, { before: local(2026, 9, 15) }, notTrashOrSpam],
    });
  });

  it('parses relative ages', () => {
    const f = parseSearch('newer_than:2d older_than:1y', ctx).filter;
    expect(f).toEqual({
      operator: 'AND',
      conditions: [{ after: new Date(2026, 8, 23, 12).toISOString() }, { before: new Date(2025, 8, 25, 12).toISOString() }, notTrashOrSpam],
    });
  });

  it('in: selects a mailbox and disables the default trash/spam exclusion', () => {
    expect(parseSearch('in:sent lunch', ctx).filter).toEqual({ operator: 'AND', conditions: [{ inMailbox: 'S' }, { text: 'lunch' }] });
    expect(parseSearch('in:spam', ctx).filter).toEqual({ inMailbox: 'J' });
    expect(parseSearch('in:anywhere lunch', ctx).filter).toEqual({ text: 'lunch' });
    expect(parseSearch('label:projects/alpha', ctx).filter).toEqual({ inMailbox: 'PA' });
    expect(parseSearch('in:Work', ctx).filter).toEqual({ inMailbox: 'W' });
  });

  it('reports an unknown mailbox instead of silently matching everything', () => {
    const r = parseSearch('in:nowhere', ctx);
    expect(r.errors).toEqual(['No mailbox named "nowhere"']);
  });

  it('supports negation, OR, braces and parentheses', () => {
    expect(parseSearch('-from:bob', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ operator: 'NOT', conditions: [{ from: 'bob' }] }, notTrashOrSpam],
    });
    expect(parseSearch('from:bob OR from:carol', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [{ operator: 'OR', conditions: [{ from: 'bob' }, { from: 'carol' }] }, notTrashOrSpam],
    });
    expect(parseSearch('{from:bob from:carol} (lunch OR dinner)', ctx).filter).toEqual({
      operator: 'AND',
      conditions: [
        { operator: 'OR', conditions: [{ from: 'bob' }, { from: 'carol' }] },
        { operator: 'OR', conditions: [{ text: 'lunch' }, { text: 'dinner' }] },
        notTrashOrSpam,
      ],
    });
  });

  it('treats unknown operators and stray syntax as text', () => {
    expect(parseSearch('foo:bar (', ctx).filter).toEqual({ operator: 'AND', conditions: [{ text: 'foo:bar' }, notTrashOrSpam] });
  });

  it('returns a null filter for an empty query', () => {
    expect(parseSearch('   ', ctx).filter).toBeNull();
  });

  it('extracts highlightable terms for snippets', () => {
    expect(parseSearch('from:bob "quarterly report" -draft budget', ctx).textTerms).toEqual(['quarterly report', 'budget']);
  });
});
