import type { PasswordPolicy } from './client';

// No O/0, I/l/1: a password read off one screen is typed into another.
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
// From OpenCloud's own list, without the ones that need escaping in HTML or end a sentence.
const SPECIAL = '!#$%*+-=?@';
/** What OpenCloud counts as a special character. */
const SPECIAL_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

/** The first rule the password breaks, as a sentence, or '' when it breaks none. */
export function checkPassword(password: string, p: PasswordPolicy): string {
  if (password.length < p.min) return `At least ${p.min} characters.`;
  if (password.length > p.max) return `At most ${p.max} characters.`;
  if (count(password, /[a-z]/g) < p.lower) return `At least ${plural(p.lower, 'lower-case letter')}.`;
  if (count(password, /[A-Z]/g) < p.upper) return `At least ${plural(p.upper, 'upper-case letter')}.`;
  if (count(password, /[0-9]/g) < p.digits) return `At least ${plural(p.digits, 'digit')}.`;
  if (count(password, SPECIAL_RE) < p.special) return `At least ${plural(p.special, 'special character')}.`;
  return '';
}

/** The rules as one sentence, or '' when there are none. */
export function policyText(p: PasswordPolicy): string {
  const part = (n: number, one: string, article: string) => (n === 1 ? `${article} ${one}` : `${n} ${one}s`);
  const needs = [
    p.lower ? part(p.lower, 'lower-case letter', 'a') : '',
    p.upper ? part(p.upper, 'upper-case letter', 'an') : '',
    p.digits ? part(p.digits, 'digit', 'a') : '',
    p.special ? part(p.special, 'special character', 'a') : '',
  ].filter(Boolean);
  const list = needs.length > 1 ? `${needs.slice(0, -1).join(', ')} and ${needs.at(-1)}` : (needs[0] ?? '');
  if (!p.min && !list) return '';
  if (!p.min) return `With ${list}.`;
  return list ? `At least ${p.min} characters, with ${list}.` : `At least ${p.min} characters.`;
}

/**
 * A random password that meets the policy: 16 characters, or as many as the policy needs or allows.
 * It always has every kind of character, whether or not the policy asks.
 */
export function generatePassword(p: PasswordPolicy, random: (n: number) => Uint32Array = (n) => crypto.getRandomValues(new Uint32Array(n))): string {
  const classes: [string, number][] = [
    [LOWER, Math.max(1, p.lower)],
    [UPPER, Math.max(1, p.upper)],
    [DIGITS, Math.max(1, p.digits)],
    [SPECIAL, Math.max(1, p.special)],
  ];
  const needed = classes.reduce((n, [, k]) => n + k, 0);
  const length = Math.min(Math.max(16, p.min, needed), Math.max(p.max, needed));
  // One number per character to choose it, and one per character to shuffle.
  const numbers = random(length * 2);
  let at = 0;
  const pick = (from: string) => from[numbers[at++]! % from.length]!;
  const chars: string[] = [];
  for (const [set, k] of classes) for (let i = 0; i < k; i++) chars.push(pick(set));
  const all = LOWER + UPPER + DIGITS + SPECIAL;
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = numbers[at++]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
