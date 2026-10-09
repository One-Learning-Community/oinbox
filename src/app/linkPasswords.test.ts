import { beforeEach, describe, expect, it } from 'vitest';
import { createLinkPasswords, RECALL_MS } from './linkPasswords';

const A = 'https://files.test/s/aaa';
const B = 'https://files.test/s/bbb';
let now = 1_000_000;
const make = () => createLinkPasswords(sessionStorage, () => now);

beforeEach(() => {
  sessionStorage.clear();
  now = 1_000_000;
});

describe('link passwords', () => {
  it('gives a password back for its link, with the time it will be forgotten', () => {
    const p = make();
    p.remember(A, 'Corr3ct-horse!');
    expect(p.recall(A)).toEqual({ url: A, password: 'Corr3ct-horse!', until: now + RECALL_MS });
    expect(p.recall(B)).toBeNull();
  });
  it('forgets after 30 minutes, and leaves nothing behind in the storage', () => {
    const p = make();
    p.remember(A, 'one');
    now += RECALL_MS - 1;
    expect(p.recall(A)?.password).toBe('one');
    now += 1;
    expect(p.recall(A)).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toContain('one');
  });
  it('finds the remembered links a text mentions', () => {
    const p = make();
    p.remember(A, 'one');
    p.remember(B, 'two');
    expect(p.findIn(`Files for this message: ${B}\nPassword: two`).map((e) => e.password)).toEqual(['two']);
    expect(p.findIn('no links here')).toEqual([]);
  });
  it('keeps the newer password when a link is remembered twice', () => {
    const p = make();
    p.remember(A, 'one');
    p.remember(A, 'two');
    expect(p.recall(A)?.password).toBe('two');
    expect(p.findIn(A)).toHaveLength(1);
  });
  it('is shared by everything in the tab that reads the same storage, and cleared on sign-out', () => {
    make().remember(A, 'one');
    const other = make();
    expect(other.recall(A)?.password).toBe('one');
    other.clear();
    expect(make().recall(A)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
  it('survives storage that holds rubbish or cannot be written', () => {
    sessionStorage.setItem('oinbox.drive.linkPasswords', '{not json');
    expect(make().recall(A)).toBeNull();
    sessionStorage.setItem('oinbox.drive.linkPasswords', JSON.stringify([{ url: 7 }, 'x', null]));
    expect(make().findIn(A)).toEqual([]);
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} } as unknown as Storage;
    const p = createLinkPasswords(full, () => now);
    expect(() => p.remember(A, 'one')).not.toThrow();
    expect(p.recall(A)).toBeNull();
  });
});
