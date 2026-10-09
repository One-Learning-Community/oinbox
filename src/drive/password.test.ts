import { describe, expect, it } from 'vitest';
import type { PasswordPolicy } from './client';
import { checkPassword, generatePassword, policyText } from './password';

const DEFAULT: PasswordPolicy = { min: 8, max: 72, lower: 1, upper: 1, digits: 1, special: 1 };
const NONE: PasswordPolicy = { min: 0, max: 72, lower: 0, upper: 0, digits: 0, special: 0 };

describe('checkPassword', () => {
  it('passes a password that meets every rule', () => {
    expect(checkPassword('Corr3ct-horse', DEFAULT)).toBe('');
  });
  it('names the first rule a password breaks', () => {
    expect(checkPassword('Ab1!', DEFAULT)).toBe('At least 8 characters.');
    expect(checkPassword('ABCDEFG1!', DEFAULT)).toBe('At least 1 lower-case letter.');
    expect(checkPassword('abcdefg1!', DEFAULT)).toBe('At least 1 upper-case letter.');
    expect(checkPassword('Abcdefgh!', DEFAULT)).toBe('At least 1 digit.');
    expect(checkPassword('Abcdefgh1', DEFAULT)).toBe('At least 1 special character.');
    expect(checkPassword('A1!' + 'a'.repeat(80), DEFAULT)).toBe('At most 72 characters.');
    expect(checkPassword('Abcdefg1!', { ...DEFAULT, digits: 2 })).toBe('At least 2 digits.');
  });
  it('refuses spaces: they do not survive being written into a message', () => {
    for (const pw of ['Corr3ct horse!', ' Corr3ct-horse!', 'Corr3ct-horse! ', 'Corr3ct-\thorse!']) expect(checkPassword(pw, DEFAULT)).toBe('No spaces.');
    expect(checkPassword('a b', NONE)).toBe('No spaces.');
  });
  it('asks nothing of a password when there are no rules', () => {
    expect(checkPassword('a', NONE)).toBe('');
  });
});

describe('generatePassword', () => {
  it('makes 16 characters that meet the usual policy, different each time', () => {
    const a = generatePassword(DEFAULT);
    const b = generatePassword(DEFAULT);
    expect(a).toHaveLength(16);
    expect(checkPassword(a, DEFAULT)).toBe('');
    expect(a).not.toBe(b);
  });
  it('meets stricter and stranger policies', () => {
    const policies: PasswordPolicy[] = [
      { min: 24, max: 72, lower: 3, upper: 3, digits: 3, special: 3 },
      { min: 4, max: 10, lower: 1, upper: 1, digits: 1, special: 1 },
      { min: 0, max: 72, lower: 0, upper: 0, digits: 0, special: 6 },
      NONE,
    ];
    for (const p of policies) {
      for (let i = 0; i < 20; i++) {
        const pw = generatePassword(p);
        expect(checkPassword(pw, p), `${pw} for ${JSON.stringify(p)}`).toBe('');
        expect(pw.length).toBeLessThanOrEqual(p.max);
        expect(pw.length).toBeGreaterThanOrEqual(Math.min(16, p.max));
      }
    }
  });
  it('uses no characters that are mistaken for one another or break when pasted into text', () => {
    for (let i = 0; i < 50; i++) expect(generatePassword(DEFAULT)).not.toMatch(/[O0Il1<>&"'`\\ ]/);
  });
  it('is decided by the random numbers it is given', () => {
    const fixed = (n: number) => Uint32Array.from({ length: n }, (_, i) => i * 7919);
    expect(generatePassword(DEFAULT, fixed)).toBe(generatePassword(DEFAULT, fixed));
  });
});

describe('policyText', () => {
  it('says the rules in a sentence', () => {
    expect(policyText(DEFAULT)).toBe('At least 8 characters, with a lower-case letter, an upper-case letter, a digit and a special character.');
    expect(policyText({ ...NONE, min: 12 })).toBe('At least 12 characters.');
    expect(policyText({ ...NONE, min: 10, digits: 2 })).toBe('At least 10 characters, with 2 digits.');
    expect(policyText(NONE)).toBe('');
  });
});
