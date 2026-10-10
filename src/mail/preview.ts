import type { EmailBodyPart } from '../jmap/types';

/** A thumbnail is the whole image, since Stalwart makes no smaller one. A larger image waits for a click. */
export const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;

const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
};
const DRAWABLE = new Set(Object.values(BY_EXTENSION));

/**
 * The type to show an attachment as a picture under, or null when it is not one a browser draws.
 * SVG is left out: opened on its own from a blob address it is a document, and would run its script as this page.
 */
export function imageType(part: Pick<EmailBodyPart, 'type' | 'name'>): string | null {
  const given = part.type.split(';')[0]!.trim().toLowerCase();
  const type = given === 'image/jpg' ? 'image/jpeg' : given;
  if (DRAWABLE.has(type)) return type;
  // Some senders name no type at all; a real type is never overruled by the file's name.
  if (type !== 'application/octet-stream') return null;
  const ext = /\.([a-z0-9]+)$/i.exec(part.name ?? '')?.[1]?.toLowerCase();
  return (ext && BY_EXTENSION[ext]) || null;
}

export function hasThumbnail(part: Pick<EmailBodyPart, 'type' | 'name' | 'size'>): boolean {
  return imageType(part) !== null && part.size <= THUMBNAIL_MAX_BYTES;
}
