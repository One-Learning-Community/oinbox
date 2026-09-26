import { describe, expect, it } from 'vitest';
import { applyEmailPatch, archivePatch, keywordPatch, movePatch, trashPatch } from './patch';

const email = { id: 'e1', keywords: { $seen: true as const }, mailboxIds: { I: true as const, W: true as const } };

describe('applyEmailPatch', () => {
  it('applies JMAP patch paths to keywords and mailboxIds without mutating', () => {
    const out = applyEmailPatch(email, { 'keywords/$seen': null, 'keywords/$flagged': true, 'mailboxIds/I': null, 'mailboxIds/A': true });
    expect(out).toEqual({ keywords: { $flagged: true }, mailboxIds: { W: true, A: true } });
    expect(email.keywords).toEqual({ $seen: true });
  });

  it('replaces a whole property', () => {
    expect(applyEmailPatch(email, { mailboxIds: { T: true } })).toEqual({ keywords: { $seen: true }, mailboxIds: { T: true } });
  });

  it('decodes JSON pointer escapes in keyword names', () => {
    expect(applyEmailPatch({ id: 'e', keywords: {}, mailboxIds: {} }, { 'keywords/a~1b~0c': true }).keywords).toEqual({ 'a/b~c': true });
  });
});

describe('patch builders', () => {
  it('keywordPatch only touches emails that need it', () => {
    const emails = [email, { id: 'e2', keywords: {}, mailboxIds: { I: true as const } }];
    expect(keywordPatch(emails, '$seen', true)).toEqual({ e2: { 'keywords/$seen': true } });
    expect(keywordPatch(emails, '$seen', false)).toEqual({ e1: { 'keywords/$seen': null } });
  });

  it('archivePatch removes the inbox, filing emails that would have no mailbox in Archive', () => {
    expect(archivePatch([email], 'I', 'A')).toEqual({ e1: { 'mailboxIds/I': null } });
    expect(archivePatch([{ id: 'e2', mailboxIds: { I: true } }], 'I', 'A')).toEqual({ e2: { 'mailboxIds/I': null, 'mailboxIds/A': true } });
  });

  it('movePatch swaps mailboxes, never leaving an email in none', () => {
    expect(movePatch([email], 'W', 'X')).toEqual({ e1: { 'mailboxIds/W': null, 'mailboxIds/X': true } });
    expect(movePatch([{ id: 'e3', keywords: {}, mailboxIds: { W: true } }], null, 'X')).toEqual({ e3: { 'mailboxIds/X': true } });
  });

  it('trashPatch moves everything to Trash', () => {
    expect(trashPatch([email], 'T')).toEqual({ e1: { mailboxIds: { T: true } } });
  });
});
