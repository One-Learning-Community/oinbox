import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreFocus } from './focus';

const button = () => document.body.appendChild(document.createElement('button'));
const microtask = () => Promise.resolve();

afterEach(() => (document.body.innerHTML = ''));

describe('restoreFocus', () => {
  it('gives the focus back to where it was once the caller is gone', async () => {
    const before = button();
    const inside = button();
    before.focus();
    const dispose = createRoot((d) => (restoreFocus(), d));
    inside.focus();
    inside.remove();
    dispose();
    await microtask();
    expect(document.activeElement).toBe(before);
  });

  it('leaves the focus alone when something else has taken it', async () => {
    const before = button();
    const other = button();
    before.focus();
    const dispose = createRoot((d) => (restoreFocus(), d));
    other.focus();
    dispose();
    await microtask();
    expect(document.activeElement).toBe(other);
  });

  it('does nothing when the element it remembered is gone', async () => {
    const before = button();
    before.focus();
    const dispose = createRoot((d) => (restoreFocus(), d));
    before.remove();
    dispose();
    await microtask();
    expect(document.activeElement).toBe(document.body);
  });
});
