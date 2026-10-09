import type { PutTransport } from './client';

/** Upload with XMLHttpRequest: the only way a browser tells how much of an upload has gone. */
export const xhrPut: PutTransport = (url, body, headers, { signal, onProgress }) =>
  new Promise((resolve, reject) => {
    const stopped = () => new DOMException('The upload was stopped', 'AbortError');
    if (signal?.aborted) return reject(stopped());
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : body.size);
    xhr.onload = () => resolve({ status: xhr.status, fileId: xhr.getResponseHeader('oc-fileid') ?? '' });
    xhr.onerror = () => reject(new TypeError('The upload failed on the network'));
    xhr.onabort = () => reject(stopped());
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
