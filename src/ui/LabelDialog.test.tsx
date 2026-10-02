import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import { LabelDialog } from './LabelDialog';
import { createNav } from './nav';

function setup(create: (path: string) => Promise<string>) {
  const nav = createNav();
  const labels = { create: vi.fn(create), rename: vi.fn(), validate: vi.fn(() => ({ ok: true })) };
  const app = { engine: { state: { mailboxes: {} } }, labels, nav } as unknown as App;
  render(() => (
    <AppContext.Provider value={app}>
      <button>Outside</button>
      <LabelDialog />
    </AppContext.Provider>
  ));
  return { nav, labels };
}

describe('LabelDialog', () => {
  it('disables Cancel while the label is being saved', async () => {
    let finish!: (id: string) => void;
    const { nav } = setup(() => new Promise<string>((r) => (finish = r)));
    nav.setLabelDialog({ kind: 'create' });
    const field = await screen.findByRole('textbox', { name: 'Label name' });
    fireEvent.input(field, { target: { value: 'Receipts' } });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.submit(field.closest('form')!);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    finish('new');
    await vi.waitFor(() => expect(nav.labelDialog()).toBeNull());
  });
});
