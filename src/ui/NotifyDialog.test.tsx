import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import { createNotifyDialog } from './NotifyDialog';

const ask = { title: 'Move event?', message: 'Guests are on this event.', confirmLabel: 'Move', guests: true };

describe('NotifyDialog', () => {
  it('answers notify, silent and cancel for an event with guests', async () => {
    const { ask: open, Host } = createNotifyDialog();
    render(() => <Host />);
    for (const [button, answer] of [['Notify guests', 'notify'], ["Don't notify", 'silent'], ['Cancel', 'cancel']] as const) {
      const result = open(ask);
      fireEvent.click(await screen.findByRole('button', { name: button }));
      expect(await result).toBe(answer);
    }
  });

  it('offers only Cancel and the action without guests, and the action answers silent', async () => {
    const { ask: open, Host } = createNotifyDialog();
    render(() => <Host />);
    const result = open({ ...ask, guests: false, message: 'Delete it?', confirmLabel: 'Delete', danger: true });
    const button = await screen.findByRole('button', { name: 'Delete' });
    expect(screen.queryByRole('button', { name: 'Notify guests' })).toBeNull();
    fireEvent.click(button);
    expect(await result).toBe('silent');
  });
});
