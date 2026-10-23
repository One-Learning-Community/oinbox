import { createStore } from 'solid-js/store';
import { describe, expect, it, vi } from 'vitest';
import type { App } from '../app/context';
import { parseMailto } from '../app/mailto';
import { openWhenReady } from './ComposeLink';

function fakeApp(ready: boolean) {
  const [state, set] = createStore({ ready });
  const update = vi.fn();
  const open = vi.fn(() => ({ update }));
  const app = { engine: { state }, composers: { open } } as unknown as Pick<App, 'engine' | 'composers'>;
  return { app, open, update, setReady: () => set('ready', true) };
}

describe('openWhenReady', () => {
  it('waits for the account before opening, then opens one filled-in message', async () => {
    const { app, open, update, setReady } = fakeApp(false);
    openWhenReady(app, parseMailto('mailto:bob@x.test?subject=Hi'));
    expect(open).not.toHaveBeenCalled();
    setReady();
    expect(open).toHaveBeenCalledExactlyOnceWith('new');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Hi', to: [{ name: null, email: 'bob@x.test' }] }));
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('opens at once when the account is already loaded, and leaves an empty message untouched', () => {
    const { app, open, update } = fakeApp(true);
    openWhenReady(app, parseMailto(''));
    expect(open).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
