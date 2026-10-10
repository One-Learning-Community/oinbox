import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreviews } from './previews';

const part = (blobId: string, type = 'image/png') => ({ blobId, type, name: `${blobId}.png` });

describe('createPreviews', () => {
  let made: Blob[];
  beforeEach(() => {
    made = [];
    URL.createObjectURL = vi.fn((b: Blob) => `blob:${made.push(b)}`);
    URL.revokeObjectURL = vi.fn();
  });

  it('fetches an image once and hands every caller the same address', async () => {
    const fetch = vi.fn(async () => new Blob(['x'], { type: 'image/png' }));
    const previews = createPreviews(fetch);
    const [a, b] = await Promise.all([previews.url(part('b1')), previews.url(part('b1'))]);
    expect(a).toBe('blob:1');
    expect(b).toBe('blob:1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('b1', 'b1.png', 'image/png');
  });

  it('gives the address an image type whatever the server called the bytes', async () => {
    const previews = createPreviews(async () => new Blob(['<script>'], { type: 'text/html' }));
    await previews.url({ blobId: 'b1', type: 'application/octet-stream', name: 'photo.jpg' });
    expect(made[0]!.type).toBe('image/jpeg');
  });

  it('refuses what is not an image', async () => {
    const fetch = vi.fn(async () => new Blob(['x']));
    const previews = createPreviews(fetch);
    await expect(previews.url({ blobId: 'b1', type: 'text/html', name: 'a.html' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('tries again after a failure', async () => {
    const fetch = vi.fn<() => Promise<Blob>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Blob(['x']));
    const previews = createPreviews(fetch);
    await expect(previews.url(part('b1'))).rejects.toThrow('offline');
    expect(await previews.url(part('b1'))).toBe('blob:1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('releases every address when disposed, including one still on its way', async () => {
    let finish!: (b: Blob) => void;
    const fetch = vi.fn<() => Promise<Blob>>().mockResolvedValueOnce(new Blob(['x'])).mockReturnValueOnce(new Promise((r) => (finish = r)));
    const previews = createPreviews(fetch);
    await previews.url(part('b1'));
    const late = previews.url(part('b2'));
    previews.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    finish(new Blob(['y']));
    await late;
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:2'));
  });

  it('fetches nothing once disposed', async () => {
    const fetch = vi.fn(async () => new Blob(['x']));
    const previews = createPreviews(fetch);
    previews.dispose();
    await expect(previews.url(part('b1'))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
