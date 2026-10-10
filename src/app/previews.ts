import type { EmailBodyPart } from '../jmap/types';
import { imageType } from '../mail/preview';

type Part = Pick<EmailBodyPart, 'blobId' | 'type' | 'name'>;

export interface Previews {
  /** An address an `<img>` can show the attachment from. The bytes are fetched once, however often it is asked for. */
  url(part: Part): Promise<string>;
  /** Release every address, including those still being fetched. */
  dispose(): void;
}

/** The pictures of one message, held as object URLs for as long as the message is on the page. */
export function createPreviews(fetchBlob: (blobId: string, name: string, type: string) => Promise<Blob>): Previews {
  const urls = new Map<string, Promise<string>>();
  const made = new Set<string>();
  let disposed = false;

  return {
    url(part) {
      const type = imageType(part);
      if (disposed || !type || !part.blobId) return Promise.reject(new Error('No preview for this attachment'));
      const blobId = part.blobId;
      let url = urls.get(blobId);
      if (!url) {
        // The address carries the image type whatever the server answered, so it can never open as a page.
        url = fetchBlob(blobId, part.name ?? 'attachment', type).then((blob) => {
          const address = URL.createObjectURL(new Blob([blob], { type }));
          // Fetched for a message that has since left the page.
          if (disposed) URL.revokeObjectURL(address);
          else made.add(address);
          return address;
        });
        urls.set(blobId, url);
        // A failure is not kept: the next ask fetches again.
        url.catch(() => urls.get(blobId) === url && urls.delete(blobId));
      }
      return url;
    },
    dispose() {
      disposed = true;
      for (const address of made) URL.revokeObjectURL(address);
      made.clear();
      urls.clear();
    },
  };
}
