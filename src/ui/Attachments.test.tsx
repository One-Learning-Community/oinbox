import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import type { SaveFile } from '../app/drive';
import type { EmailRec } from '../sync/engine';
import { Attachments } from './Attachments';

const part = (name: string | null, extra: Record<string, unknown> = {}) => ({ partId: name ?? 'p', blobId: `blob-${name}`, name, type: 'text/plain', size: 1536, disposition: 'attachment', ...extra });

function setup(opts: { offered: boolean; parts?: ReturnType<typeof part>[] }) {
  const fetched = new Blob(['bytes']);
  const fetchBlob = vi.fn(async () => fetched);
  const saveToDrive = vi.fn<(files: SaveFile[]) => void>();
  const app = { engine: { fetchBlob }, toast: vi.fn(), drive: { offered: () => opts.offered, saveToDrive } } as unknown as App;
  const email = { id: 'e1', attachments: opts.parts ?? [part('notes.txt')] } as unknown as EmailRec;
  render(() => (
    <AppContext.Provider value={app}>
      <Attachments email={email} />
    </AppContext.Provider>
  ));
  return { fetchBlob, saveToDrive, fetched };
}

describe('Attachments', () => {
  it('without Drive, a chip downloads on a click and has no menu', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { fetchBlob } = setup({ offered: false });
    const chip = screen.getByRole('button', { name: /notes\.txt/ });
    expect(chip).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(chip);
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalledWith('blob-notes.txt', 'notes.txt', 'text/plain'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save all to Drive' })).toBeNull();
  });

  it('with Drive, a chip opens a menu of Download and Save to Drive', async () => {
    setup({ offered: true });
    const chip = screen.getByRole('button', { name: /notes\.txt/ });
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(chip);
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Download', 'Save to Drive']);
    await vi.waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
  });

  it('Save to Drive hands the app the file, fetched only when asked for', async () => {
    const { fetchBlob, saveToDrive, fetched } = setup({ offered: true });
    fireEvent.click(screen.getByRole('button', { name: /notes\.txt/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Save to Drive' }));
    expect(saveToDrive).toHaveBeenCalledOnce();
    const files = saveToDrive.mock.calls[0]![0];
    expect(files.map((f) => f.name)).toEqual(['notes.txt']);
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(await files[0]!.fetch()).toBe(fetched);
    expect(fetchBlob).toHaveBeenCalledWith('blob-notes.txt', 'notes.txt', 'text/plain');
  });

  it('Download in the menu downloads', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { fetchBlob, saveToDrive } = setup({ offered: true });
    fireEvent.click(screen.getByRole('button', { name: /notes\.txt/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }));
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalled());
    expect(saveToDrive).not.toHaveBeenCalled();
  });

  it('offers Save all to Drive for several attachments, leaving out images shown in the text', () => {
    const { saveToDrive } = setup({
      offered: true,
      parts: [part('a.pdf'), part('chart.png', { type: 'image/png', disposition: 'inline', cid: 'c1' }), part(null)],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save all to Drive' }));
    expect(saveToDrive.mock.calls[0]![0].map((f) => f.name)).toEqual(['a.pdf', 'attachment']);
  });

  it('has no Save all for a single attachment', () => {
    setup({ offered: true });
    expect(screen.queryByRole('button', { name: 'Save all to Drive' })).toBeNull();
  });
});
