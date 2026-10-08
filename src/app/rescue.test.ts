import { beforeEach, describe, expect, it } from 'vitest';
import type { RescuedComposer } from './composer';
import { clearRescue, saveRescue, takeRescue } from './rescue';

const item = (subject: string): RescuedComposer => ({
  mode: 'new', draftId: null, identityId: 'i1', threadId: null, replyTo: null, signatureMode: 'auto',
  draft: { mode: 'new', to: [], cc: [], bcc: [], subject, inReplyTo: [], references: [], quoteHtml: '', signatureHtml: '', bodyHtml: '<p>x</p>', attachments: [], inline: [] },
});
const DAY = 24 * 3600_000;

beforeEach(() => localStorage.clear());

describe('rescue', () => {
  it('stores one entry per composer under the account and hands them back once', () => {
    saveRescue(localStorage, 'acc1', [item('a'), item('b')], 1000);
    expect(Object.keys(localStorage).sort()).toEqual(['oinbox.rescue.acc1.0', 'oinbox.rescue.acc1.1']);
    expect(takeRescue(localStorage, 'acc1', 2000).map((r) => r.draft.subject)).toEqual(['a', 'b']);
    expect(takeRescue(localStorage, 'acc1', 2000)).toEqual([]);
  });
  it('rescues and returns the composers of two accounts independently', () => {
    saveRescue(localStorage, 'b', [item('mine')], 0);
    saveRescue(localStorage, 's', [item('support 1'), item('support 2')], 0);
    expect(takeRescue(localStorage, 's', 1).map((r) => r.draft.subject)).toEqual(['support 1', 'support 2']);
    expect(takeRescue(localStorage, 'b', 1).map((r) => r.draft.subject)).toEqual(['mine']);
  });
  it('keeps accounts apart', () => {
    saveRescue(localStorage, 'acc1', [item('mine')], 0);
    expect(takeRescue(localStorage, 'acc2', 0)).toEqual([]);
    expect(takeRescue(localStorage, 'acc1', 0)).toHaveLength(1);
  });
  it('drops entries older than 7 days, for any account', () => {
    saveRescue(localStorage, 'acc1', [item('old')], 0);
    saveRescue(localStorage, 'acc2', [item('old too')], 0);
    expect(takeRescue(localStorage, 'acc1', 7 * DAY + 1)).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
  it('clears everything on request and leaves other keys alone', () => {
    localStorage.setItem('oinbox.theme', 'dark');
    saveRescue(localStorage, 'acc1', [item('a')], 0);
    clearRescue(localStorage);
    expect(Object.keys(localStorage)).toEqual(['oinbox.theme']);
  });
  it('ignores entries it cannot read', () => {
    localStorage.setItem('oinbox.rescue.acc1.0', '{not json');
    expect(takeRescue(localStorage, 'acc1', 0)).toEqual([]);
    expect(localStorage.length).toBe(0);
  });
  it('never throws when storage is full or blocked', () => {
    const blocked = { get length() { return 0; }, key: () => null, getItem: () => { throw new Error('denied'); }, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); }, removeItem: () => { throw new Error('denied'); }, clear: () => {} } as Storage;
    expect(() => saveRescue(blocked, 'a', [item('x')])).not.toThrow();
    expect(takeRescue(blocked, 'a')).toEqual([]);
    expect(() => clearRescue(blocked)).not.toThrow();
  });
});

describe('rescue, saved again', () => {
  it('replaces what was saved before for that account', () => {
    saveRescue(localStorage, 'acc1', [item('a'), item('b')], 0);
    saveRescue(localStorage, 'acc1', [item('c')], 0);
    expect(takeRescue(localStorage, 'acc1', 0).map((r) => r.draft.subject)).toEqual(['c']);
  });
});
