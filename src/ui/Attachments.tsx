import { For, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { EmailBodyPart } from '../jmap/types';
import { fileSize } from '../mail/format';
import type { EmailRec } from '../sync/engine';
import { Icon } from './icons';
import { MenuButton } from './MenuButton';

/** A message's attachments as chips. With a Drive, a chip offers a choice; without, it downloads. */
export function Attachments(props: { email: EmailRec }) {
  const { engine, toast, drive } = useApp();
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
            <Show
              when={drive.offered()}
              fallback={
                <button type="button" class="attachment" onClick={() => void download(a)} title={a.name ?? ''}>
                  {face(a)}
                </button>
              }
            >
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
            </Show>
          )}
        </For>
        <Show when={drive.offered() && list().length > 1}>
          <button type="button" class="attachment attachment-all" onClick={() => toDrive(list())}>
            Save all to Drive
          </button>
        </Show>
      </div>
    </Show>
  );
}
