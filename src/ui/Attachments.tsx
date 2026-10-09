import { Popover } from '@rozie-ui/popover-solid';
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import { useApp } from '../app/context';
import type { EmailBodyPart } from '../jmap/types';
import { fileSize } from '../mail/format';
import type { EmailRec } from '../sync/engine';
import { Icon } from './icons';
import { menuKeys } from './menu';

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
              <AttachmentMenu name={nameOf(a)} onDownload={() => void download(a)} onSave={() => toDrive([a])}>
                {face(a)}
              </AttachmentMenu>
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

/** A chip that opens a menu: Download, Save to Drive. */
function AttachmentMenu(props: { name: string; onDownload: () => void; onSave: () => void; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => items()[0]?.focus({ preventScroll: true }));
  }, { defer: true }));

  /** Close with the focus back on the chip. */
  const close = () => {
    setOpen(false);
    button?.focus();
  };
  const choose = (run: () => void) => {
    close();
    run();
  };

  return (
    <span class="attachment-menu">
    <Popover
      open={open()}
      onOpenChange={setOpen}
      trigger="manual"
      placement="bottom-start"
      strategy="fixed"
      offset={4}
      anchorSlot={() => (
        <button ref={button} type="button" class="attachment" title={props.name} aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
          {props.children}
        </button>
      )}
    >
      <div class="menu" role="menu" aria-label={`Options for ${props.name}`} ref={menu} onKeyDown={menuKeys(items, close)}>
        <button type="button" role="menuitem" onClick={() => choose(props.onDownload)}>Download</button>
        <button type="button" role="menuitem" onClick={() => choose(props.onSave)}>Save to Drive</button>
      </div>
    </Popover>
    </span>
  );
}
