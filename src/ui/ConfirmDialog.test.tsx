import { render, screen } from '@solidjs/testing-library';
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
});
