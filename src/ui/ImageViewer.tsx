import { Dialog } from '@rozie-ui/dialog-solid';
import { createEffect, createSignal, on, Show } from 'solid-js';
import { fileSize } from '../mail/format';
import { Icon } from './icons';

export interface ViewerImage {
  name: string;
  size: number;
  /** An address to show the picture from; asked for when the picture comes up. */
  url: () => Promise<string>;
  download: () => void;
  /** Absent where there is no Drive. */
  save?: () => void;
}

/** One message's pictures, full screen, one at a time. */
export function ImageViewer(props: { images: ViewerImage[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const image = () => props.images[props.index]!;
  const [shown, setShown] = createSignal<{ src: string } | 'loading' | 'failed'>('loading');

  createEffect(on(() => props.index, (index) => {
    setShown('loading');
    // A slower picture must not land on the one the user has since moved to.
    const mine = (state: ReturnType<typeof shown>) => props.index === index && setShown(state);
    image().url().then((src) => mine({ src }), () => mine('failed'));
  }));

  const step = (delta: number) => {
    const next = props.index + delta;
    if (next >= 0 && next < props.images.length) props.onIndex(next);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  };

  return (
    <Dialog open class="image-viewer" ariaLabelledby="image-viewer-title" initialFocus=".image-viewer-close" onOpenChange={(open) => !open && props.onClose()} onKeyDown={onKeyDown}>
      <header class="image-viewer-bar">
        <div class="image-viewer-name" aria-live="polite">
          <h2 id="image-viewer-title">{image().name}</h2>
          <small>
            {fileSize(image().size)}
            <Show when={props.images.length > 1}>{` · ${props.index + 1} of ${props.images.length}`}</Show>
          </small>
        </div>
        <Show when={image().save}>
          {(save) => (
            <button type="button" class="image-viewer-save" onClick={() => save()()}>
              Save to Drive
            </button>
          )}
        </Show>
        <button type="button" class="icon-btn" title="Download" onClick={() => image().download()}>
          <Icon name="download" />
        </button>
        <button type="button" class="icon-btn image-viewer-close" title="Close" onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </header>
      <div class="image-viewer-stage">
        <Show when={props.images.length > 1}>
          <button type="button" class="icon-btn image-viewer-step" title="Previous image" disabled={props.index === 0} onClick={() => step(-1)}>
            <Icon name="previous" />
          </button>
        </Show>
        <div class="image-viewer-frame">
          {(() => {
            const state = shown();
            if (state === 'loading') return <p role="status">Loading…</p>;
            if (state === 'failed') return <p role="alert">This image could not be loaded. You can still download it.</p>;
            return <img src={state.src} alt={image().name} />;
          })()}
        </div>
        <Show when={props.images.length > 1}>
          <button type="button" class="icon-btn image-viewer-step" title="Next image" disabled={props.index === props.images.length - 1} onClick={() => step(1)}>
            <Icon name="next" />
          </button>
        </Show>
      </div>
    </Dialog>
  );
}
