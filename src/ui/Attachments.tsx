import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
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
 * A message's attachments as tiles of one size. A picture shows itself and opens in the viewer; any other
 * file shows its kind and downloads. With a Drive, each tile has a menu that also saves it there.
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

  return (
    <Show when={list().length}>
      <div class="attachments">
        <For each={list()}>
          {(a) => (
            <Tile
              part={a}
              name={nameOf(a)}
              picture={pictures().includes(a) ? () => previews.url(a) : undefined}
              onView={(from) => view(a, from)}
              onDownload={() => void download(a)}
              onSave={drive.offered() ? () => toDrive([a]) : undefined}
            />
          )}
        </For>
        <Show when={drive.offered() && list().length > 1}>
          <span class="attachments-break" />
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

/** The letters after the last dot, when they are few enough to read as a kind of file. */
const extension = (name: string) => /\.([a-z0-9]{1,4})$/i.exec(name)?.[1]?.toUpperCase();

/**
 * One attachment: a tile of one size whatever the file. A picture small enough to fetch unasked is shown
 * once it scrolls into view, and any picture opens the viewer; another file shows its kind and downloads.
 */
function Tile(props: {
  part: EmailBodyPart;
  name: string;
  /** An address to show the picture from; absent for a file that is not a picture. */
  picture?: () => Promise<string>;
  onView: (from: HTMLElement) => void;
  onDownload: () => void;
  onSave?: () => void;
}) {
  const [src, setSrc] = createSignal<string>();
  let tile: HTMLDivElement | undefined;

  onMount(() => {
    const picture = props.picture;
    if (!tile || !picture || !hasThumbnail(props.part)) return;
    // A picture that will not load keeps the icon; the viewer says why when it is opened.
    const load = () => void picture().then(setSrc, () => {});
    if (typeof IntersectionObserver === 'undefined') return load();
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      load();
    }, { rootMargin: '200px' });
    seen.observe(tile);
    onCleanup(() => seen.disconnect());
  });

  return (
    <div class="attachment-tile" ref={tile}>
      <button
        type="button"
        class="attachment-thumb"
        classList={{ 'attachment-picture': !!props.picture }}
        aria-label={`${props.picture ? 'Preview' : 'Download'} ${props.name}`}
        title={props.name}
        onClick={(e) => (props.picture ? props.onView(e.currentTarget) : props.onDownload())}
      >
        <Show when={src()} fallback={<><Icon name="file" /><span>{extension(props.name)}</span></>}>
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
          {/* Without a Drive a file's tile is already its download. */}
          <Match when={props.picture}>
            <button type="button" class="icon-btn" title={`Download ${props.name}`} onClick={props.onDownload}>
              <Icon name="download" />
            </button>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
