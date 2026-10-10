import { createMemo, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { useApp } from '../app/context';
import { createPreviews } from '../app/previews';
import type { EmailBodyPart } from '../jmap/types';
import { fileSize } from '../mail/format';
import { hasThumbnail, imageType } from '../mail/preview';
import type { EmailRec } from '../sync/engine';
import { Icon } from './icons';
import { ImageViewer } from './ImageViewer';
import { MenuButton } from './MenuButton';

/**
 * A message's attachments as chips. With a Drive, a chip offers a choice; without, it downloads.
 * A picture is a tile showing it, and opens in the viewer.
 */
export function Attachments(props: { email: EmailRec }) {
  const { engine, toast, drive } = useApp();
  const previews = createPreviews((blobId, name, type) => engine.fetchBlob(blobId, name, type));
  onCleanup(previews.dispose);
  // Inline images referenced by the HTML body aren't listed as attachments.
  const list = () => (props.email.attachments ?? []).filter((a) => !(a.disposition === 'inline' && a.cid && a.type.startsWith('image/')));
  const nameOf = (a: EmailBodyPart) => a.name ?? 'attachment';
  const bytes = (a: EmailBodyPart) => engine.fetchBlob(a.blobId!, nameOf(a), a.type);

  const download = async (a: EmailBodyPart) => {
    try {
      const url = URL.createObjectURL(await bytes(a));
      const link = document.createElement('a');
      link.href = url;
      link.download = nameOf(a);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast(`Download failed: ${String(e)}`, 'error');
    }
  };
  /** The bytes are fetched when the save runs, not now: the user may yet cancel. */
  const toDrive = (parts: EmailBodyPart[]) => drive.saveToDrive(parts.map((a) => ({ name: nameOf(a), fetch: () => bytes(a) })));

  const pictures = () => list().filter((a) => a.blobId && imageType(a));
  const [viewing, setViewing] = createSignal<number | null>(null);
  let opener: HTMLElement | undefined;
  const view = (a: EmailBodyPart, from: HTMLElement) => {
    opener = from;
    setViewing(pictures().indexOf(a));
  };
  /** Safari gives a clicked button no focus, so the dialog has none to hand back: put it there. */
  const closeViewer = () => {
    setViewing(null);
    opener?.focus();
  };

  const viewerImages = createMemo(() =>
    pictures().map((a) => ({
      name: nameOf(a),
      size: a.size,
      url: () => previews.url(a),
      download: () => void download(a),
      // The picker is a dialog of its own: the viewer makes way for it.
      save: drive.offered() ? () => { closeViewer(); toDrive([a]); } : undefined,
    })),
  );

  const face = (a: EmailBodyPart) => (
    <>
      <Icon name="file" style={{ width: '20px', height: '20px', flex: 'none' }} />
      <span>{nameOf(a)}</span>
      <small>{fileSize(a.size)}</small>
    </>
  );

  return (
    <Show when={list().length}>
      <div class="attachments">
        <For each={list()}>
          {(a) => (
            <Switch>
              <Match when={pictures().includes(a)}>
                <PictureTile
                  part={a}
                  name={nameOf(a)}
                  url={() => previews.url(a)}
                  face={() => face(a)}
                  onView={(from) => view(a, from)}
                  onDownload={() => void download(a)}
                  onSave={drive.offered() ? () => toDrive([a]) : undefined}
                />
              </Match>
              <Match when={drive.offered()}>
                <MenuButton
                  class="attachment"
                  title={nameOf(a)}
                  menuLabel={`Options for ${nameOf(a)}`}
                  items={[
                    { label: 'Download', run: () => void download(a) },
                    { label: 'Save to Drive', run: () => toDrive([a]) },
                  ]}
                >
                  {face(a)}
                </MenuButton>
              </Match>
              <Match when={true}>
                <button type="button" class="attachment" onClick={() => void download(a)} title={a.name ?? ''}>
                  {face(a)}
                </button>
              </Match>
            </Switch>
          )}
        </For>
        <Show when={drive.offered() && list().length > 1}>
          <button type="button" class="attachment attachment-all" onClick={() => toDrive(list())}>
            Save all to Drive
          </button>
        </Show>
        <Show when={viewing() !== null}>
          <ImageViewer
            images={viewerImages()}
            index={viewing()!}
            onIndex={setViewing}
            onClose={closeViewer}
          />
        </Show>
      </div>
    </Show>
  );
}

/**
 * A picture among the attachments. One small enough to fetch unasked is shown once it scrolls into view;
 * a larger one, or one that would not load, is the plain chip. Either opens the viewer.
 */
function PictureTile(props: {
  part: EmailBodyPart;
  name: string;
  url: () => Promise<string>;
  face: () => JSX.Element;
  onView: (from: HTMLElement) => void;
  onDownload: () => void;
  onSave?: () => void;
}) {
  const [src, setSrc] = createSignal<string>();
  const [failed, setFailed] = createSignal(false);
  let tile: HTMLDivElement | undefined;

  const load = () => props.url().then(setSrc, () => setFailed(true));
  onMount(() => {
    if (!tile) return;
    if (typeof IntersectionObserver === 'undefined') return void load();
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      void load();
    }, { rootMargin: '200px' });
    seen.observe(tile);
    onCleanup(() => seen.disconnect());
  });

  return (
    <Show
      when={hasThumbnail(props.part) && !failed()}
      fallback={
        <button type="button" class="attachment" title={props.name} onClick={(e) => props.onView(e.currentTarget)}>
          {props.face()}
        </button>
      }
    >
      <div class="attachment-tile" ref={tile}>
        <button type="button" class="attachment-thumb" aria-label={`Preview ${props.name}`} title={props.name} onClick={(e) => props.onView(e.currentTarget)}>
          <Show when={src()} fallback={<Icon name="file" />}>
            <img src={src()} alt="" draggable={false} />
          </Show>
        </button>
        <div class="attachment-tile-foot">
          <div class="attachment-tile-name">
            <span title={props.name}>{props.name}</span>
            <small>{fileSize(props.part.size)}</small>
          </div>
          <Switch>
            <Match when={props.onSave}>
              <MenuButton
                class="icon-btn"
                title={`Options for ${props.name}`}
                menuLabel={`Options for ${props.name}`}
                items={[
                  { label: 'Download', run: props.onDownload },
                  { label: 'Save to Drive', run: () => props.onSave?.() },
                ]}
              >
                <Icon name="more" />
              </MenuButton>
            </Match>
            <Match when={true}>
              <button type="button" class="icon-btn" title={`Download ${props.name}`} onClick={props.onDownload}>
                <Icon name="download" />
              </button>
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
}
