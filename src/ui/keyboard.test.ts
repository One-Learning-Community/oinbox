import { afterEach, describe, expect, it } from 'vitest';
import { shortcutsSuspended } from './keyboard';

afterEach(() => (document.body.innerHTML = ''));

describe('shortcutsSuspended', () => {
  it('is true in a text field and in a menu, false elsewhere', () => {
    document.body.innerHTML =
      '<input id="field"><div role="menu"><button id="item" role="menuitem">Rename</button></div><button id="plain">x</button>';
    const el = (id: string) => document.getElementById(id);
    expect(shortcutsSuspended(el('field'))).toBe(true);
    expect(shortcutsSuspended(el('item'))).toBe(true);
    expect(shortcutsSuspended(el('plain'))).toBe(false);
    expect(shortcutsSuspended(null)).toBe(false);
  });
});

describe('shortcutsSuspended in dialogs', () => {
it('keeps shortcuts quiet inside a dialog and inside the date picker', () => {
  document.body.innerHTML = '<dialog open><button id="a">x</button></dialog><div class="rozie-datepicker"><button id="b">1</button></div><button id="c">y</button>';
  expect(shortcutsSuspended(document.getElementById('a'))).toBe(true);
  expect(shortcutsSuspended(document.getElementById('b'))).toBe(true);
  expect(shortcutsSuspended(document.getElementById('c'))).toBe(false);
});
});
