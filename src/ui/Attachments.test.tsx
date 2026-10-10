import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
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

describe('Attachments: pictures', () => {
  const photo = (name: string, extra: Record<string, unknown> = {}) => part(name, { type: 'image/jpeg', size: 200_000, ...extra });
  const urls = () => {
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++n}`);
    URL.revokeObjectURL = vi.fn();
  };

  it('shows a picture as a tile, fetched as an image', async () => {
    urls();
    const { fetchBlob } = setup({ offered: false, parts: [photo('beach.jpg'), part('notes.txt')] });
    const tile = screen.getByRole('button', { name: 'Preview beach.jpg' });
    await vi.waitFor(() => expect(tile.querySelector('img')).toHaveAttribute('src', 'blob:1'));
    expect(fetchBlob).toHaveBeenCalledWith('blob-beach.jpg', 'beach.jpg', 'image/jpeg');
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    // The other attachment is the chip it always was.
    expect(screen.getByRole('button', { name: /notes\.txt/ })).toHaveClass('attachment');
  });

  it('leaves a large picture as a chip until it is clicked', async () => {
    urls();
    const { fetchBlob } = setup({ offered: true, parts: [photo('huge.jpg', { size: 9_000_000 })] });
    const chip = screen.getByRole('button', { name: /huge\.jpg/ });
    expect(chip).toHaveClass('attachment');
    await Promise.resolve();
    expect(fetchBlob).not.toHaveBeenCalled();
    fireEvent.click(chip);
    const viewer = await screen.findByRole('dialog');
    await vi.waitFor(() => expect(viewer.querySelector('img')).toHaveAttribute('src', 'blob:1'));
    expect(viewer.querySelector('img')).toHaveAttribute('alt', 'huge.jpg');
  });

  it('falls back to a chip when the picture will not load', async () => {
    urls();
    const failing = vi.fn(async () => Promise.reject(new Error('404')));
    const app = { engine: { fetchBlob: failing }, toast: vi.fn(), drive: { offered: () => false, saveToDrive: vi.fn() } } as unknown as App;
    render(() => (
      <AppContext.Provider value={app}>
        <Attachments email={{ id: 'e2', attachments: [photo('gone.jpg')] } as unknown as EmailRec} />
      </AppContext.Provider>
    ));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /gone\.jpg/ })).toHaveClass('attachment'));
    expect(screen.queryByRole('button', { name: 'Preview gone.jpg' })).toBeNull();
  });

  it('opens the viewer on a click, steps with the arrow keys, and closes with the focus back on the tile', async () => {
    urls();
    const { fetchBlob } = setup({ offered: false, parts: [photo('one.jpg'), part('notes.txt'), photo('two.jpg')] });
    const second = screen.getByRole('button', { name: 'Preview two.jpg' });
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(2));
    fireEvent.click(second);
    const viewer = await screen.findByRole('dialog');
    expect(viewer).toHaveTextContent('two.jpg');
    expect(viewer).toHaveTextContent('2 of 2');
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled();

    fireEvent.keyDown(viewer, { key: 'ArrowLeft' });
    expect(viewer).toHaveTextContent('one.jpg');
    expect(viewer).toHaveTextContent('1 of 2');
    fireEvent.keyDown(viewer, { key: 'ArrowLeft' });
    expect(viewer).toHaveTextContent('1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(viewer).toHaveTextContent('two.jpg');
    await vi.waitFor(() => expect(viewer.querySelector('img')).toHaveAttribute('alt', 'two.jpg'));
    // The viewer shows what the tiles fetched.
    expect(fetchBlob).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(second).toHaveFocus();
  });

  it('without Drive, a tile and the viewer each have a Download and no Save', async () => {
    urls();
    const { fetchBlob } = setup({ offered: false, parts: [photo('one.jpg')] });
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Download one.jpg' }));
    // A download fetches the file under its own type, apart from the picture shown.
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Preview one.jpg' }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Save to Drive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(3));
  });

  it('with Drive, a tile has a menu, and Save to Drive in the viewer closes it first', async () => {
    urls();
    const { saveToDrive } = setup({ offered: true, parts: [photo('one.jpg')] });
    fireEvent.click(screen.getByRole('button', { name: 'Options for one.jpg' }));
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['Download', 'Save to Drive']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Drive' }));
    expect(saveToDrive.mock.calls[0]![0].map((f) => f.name)).toEqual(['one.jpg']);

    fireEvent.click(screen.getByRole('button', { name: 'Preview one.jpg' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save to Drive' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(saveToDrive).toHaveBeenCalledTimes(2);
  });

  it('releases its pictures when the message leaves the page', async () => {
    urls();
    setup({ offered: false, parts: [photo('one.jpg')] });
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    cleanup();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });

  it('keeps a picture shown in the text, and an SVG, out of the tiles', () => {
    urls();
    setup({ offered: false, parts: [part('chart.png', { type: 'image/png', disposition: 'inline', cid: 'c1' }), part('logo.svg', { type: 'image/svg+xml' })] });
    expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull();
    expect(screen.getByRole('button', { name: /logo\.svg/ })).toHaveClass('attachment');
  });
});
