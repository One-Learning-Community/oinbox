import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { EmailBodyPart } from '../jmap/types';
import { foldBehindToggle, foldHtmlQuote, splitPlainQuote } from '../mail/quotes';
import { buildFrameDocument, plainTextToHtml, sanitizeEmailHtml } from '../mail/sanitize';
import type { EmailRec } from '../sync/engine';

/** Pick the displayable body: concatenated text/html parts, else text/plain. */
function bodyOf(email: EmailRec): { kind: 'html' | 'text'; value: string } {
  const values = email.bodyValues ?? {};
  const join = (parts: EmailBodyPart[] | undefined, type: string) =>
    (parts ?? [])
      .filter((p) => p.type === type && p.partId && values[p.partId])
      .map((p) => values[p.partId!]!.value)
      .join('\n');
  const html = join(email.htmlBody, 'text/html');
  if (html.trim()) return { kind: 'html', value: html };
  return { kind: 'text', value: join(email.textBody, 'text/plain') || email.preview || '' };
}

export function MessageBody(props: { email: EmailRec }) {
  const { client, images, isDark } = useApp();
  const sender = () => props.email.from?.[0]?.email ?? '';
  const [forceImages, setForceImages] = createSignal(false);
  const allowRemote = () => forceImages() || images.allowed(sender());

  const body = createMemo(() => bodyOf(props.email));

  const rendered = createMemo(() => {
    const b = body();
    if (b.kind === 'text') {
      const { body: main, quote } = splitPlainQuote(b.value);
      const html =
        `<div style="white-space:pre-wrap">${plainTextToHtml(main)}</div>` +
        (quote ? `<div data-oinbox-quote style="white-space:pre-wrap">${plainTextToHtml(quote)}</div>` : '');
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
      foldBehindToggle(doc);
      return { html: doc.body.innerHTML, hasRemoteContent: false, cids: [] as string[], plain: true };
    }
    const clean = sanitizeEmailHtml(b.value, { allowRemote: allowRemote() });
    const doc = new DOMParser().parseFromString(`<body>${clean.html}</body>`, 'text/html');
    foldHtmlQuote(doc);
    foldBehindToggle(doc);
    return { ...clean, html: doc.body.innerHTML, plain: false };
  });

  const srcdoc = createMemo(() =>
    buildFrameDocument(rendered().html, { allowRemote: allowRemote(), dark: rendered().plain && isDark(), padded: !rendered().plain }),
  );

  const objectUrls: string[] = [];
  onCleanup(() => objectUrls.forEach((u) => URL.revokeObjectURL(u)));
  let resizeObserver: ResizeObserver | undefined;
  onCleanup(() => resizeObserver?.disconnect());

  const onLoad = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const fit = () => {
      frame.style.height = `${doc.documentElement.scrollHeight}px`;
    };

    // Inline cid: images, fetched with auth and swapped for blob URLs.
    const parts = [...(props.email.attachments ?? []), ...(props.email.htmlBody ?? [])];
    for (const img of doc.querySelectorAll<HTMLImageElement>('img[data-oinbox-cid]')) {
      const cid = img.dataset.oinboxCid!;
      const part = parts.find((p) => p.cid?.replace(/^<|>$/g, '') === cid && p.blobId);
      if (!part) continue;
      client
        .fetchBlob(part.blobId!, part.name ?? 'image', part.type)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          img.src = url;
        })
        .catch(() => undefined);
    }

    // Keys pressed after clicking into a message still drive Gmail shortcuts.
    doc.addEventListener('keydown', (e) => {
      const forwarded = new KeyboardEvent('keydown', {
        key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true,
      });
      if (!document.dispatchEvent(forwarded)) e.preventDefault();
    });

    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(doc.documentElement);
    fit();
  };

  return (
    <>
      <Show when={rendered().hasRemoteContent && !allowRemote()}>
        <div class="images-banner" role="status">
          <span>Images from this sender are hidden.</span>
          <button type="button" onClick={() => setForceImages(true)}>
            Show images
          </button>
          <Show when={sender()}>
            <button type="button" onClick={() => images.allow(sender())}>
              Always show images from {sender()}
            </button>
          </Show>
        </div>
      </Show>
      <iframe
        title={`Message from ${sender()}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcdoc={srcdoc()}
        style={{ background: rendered().plain ? 'transparent' : '#fff' }}
        onLoad={(e) => onLoad(e.currentTarget)}
      />
    </>
  );
}
