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
