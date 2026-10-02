import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { createConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('shows a message that changes while the dialog is open', async () => {
    const { confirm, Host } = createConfirmDialog();
    render(() => <Host />);
    const [n, setN] = createSignal(1);
    void confirm({ title: 'Sure?', message: () => `count ${n()}` });
    expect(await screen.findByText('count 1')).toBeInTheDocument();
    setN(2);
    expect(screen.getByText('count 2')).toBeInTheDocument();
  });

  it('gives the focus back to where it was when it goes away', async () => {
    const { confirm, Host } = createConfirmDialog();
    render(() => (
      <>
        <button>Outside</button>
        <Host />
      </>
    ));
    const outside = screen.getByText('Outside');
    outside.focus();
    const answer = confirm({ title: 'Sure?', message: 'Really?' });
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    expect(await answer).toBe(false);
    await Promise.resolve();
    expect(outside).toHaveFocus();
  });
});
