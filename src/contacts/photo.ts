// A picked picture made small enough to live inside a card: Stalwart keeps a photo as a data: URI
// in the card itself, and a card may be 524,288 bytes at most.

/** The centred square of a picture `width` by `height`. */
export function fitSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

/** `file` cropped square and scaled to `size` pixels, as a JPEG data: URI (about 20 kB at 256). Rejects if it is not a picture. */
export async function photoDataUri(file: Blob, opts: { size?: number; quality?: number } = {}): Promise<string> {
  const size = opts.size ?? 256;
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    // JPEG has no transparency: a cut-out would otherwise come out on black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    const { sx, sy, side } = fitSquare(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', opts.quality ?? 0.85);
  } finally {
    bitmap.close();
  }
}
