import { describe, expect, it } from 'vitest';
import { hasThumbnail, imageType, THUMBNAIL_MAX_BYTES } from './preview';

const part = (type: string, name: string | null = null, size = 1000) => ({ type, name, size });

describe('imageType', () => {
  it('knows the image types every browser draws', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']) expect(imageType(part(t))).toBe(t);
  });

  it('reads the type whatever its case or parameters', () => {
    expect(imageType(part('IMAGE/PNG'))).toBe('image/png');
    expect(imageType(part('image/jpeg; name="a.jpg"'))).toBe('image/jpeg');
    expect(imageType(part('image/jpg'))).toBe('image/jpeg');
  });

  it('goes by the file name when the sender gave no real type', () => {
    expect(imageType(part('application/octet-stream', 'Photo.JPG'))).toBe('image/jpeg');
    expect(imageType(part('application/octet-stream', 'scan.png'))).toBe('image/png');
    expect(imageType(part('application/octet-stream', 'data.bin'))).toBeNull();
    expect(imageType(part('application/octet-stream'))).toBeNull();
  });

  it('does not let a file name overrule a real type', () => {
    expect(imageType(part('text/html', 'page.png'))).toBeNull();
    expect(imageType(part('application/pdf', 'scan.jpg'))).toBeNull();
  });

  it('leaves out what a browser cannot draw, and SVG', () => {
    for (const t of ['image/heic', 'image/tiff', 'image/svg+xml', 'application/pdf', 'text/plain']) expect(imageType(part(t))).toBeNull();
    expect(imageType(part('application/octet-stream', 'logo.svg'))).toBeNull();
  });
});

describe('hasThumbnail', () => {
  it('is for images up to the cap', () => {
    expect(hasThumbnail(part('image/png', 'a.png', THUMBNAIL_MAX_BYTES))).toBe(true);
    expect(hasThumbnail(part('image/png', 'a.png', THUMBNAIL_MAX_BYTES + 1))).toBe(false);
    expect(hasThumbnail(part('text/plain', 'a.txt', 10))).toBe(false);
  });
});
