import type { CommandProps } from '@tiptap/core';
import { TipTap, type TipTapHandle } from '@rozie-ui/tiptap-solid';
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { Composer } from '../app/composer';
import { useApp } from '../app/context';
import { editorTakesDrop, formatAddress, fromEditorHtml, toEditorHtml } from '../mail/compose';
import { fileSize } from '../mail/format';
import { FormatToolbar } from './FormatToolbar';
import { Icon } from './icons';
import { closedSuggestions, pickedSuggestion, RecipientField } from './RecipientField';

export function ComposerView(props: { composer: Composer; inline: boolean }) {
  const { composers } = useApp();
  const c = props.composer;
  const [showCc, setShowCc] = createSignal(c.draft().cc.length > 0 || c.draft().bcc.length > 0);
  const [dragging, setDragging] = createSignal(false);
  let editor: TipTapHandle | undefined;
  let root: HTMLDivElement | undefined;
  // Closing gives the keyboard back to whatever opened the composer, if that is still on the page.
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  onCleanup(() => {
    const lost = !document.activeElement || document.activeElement === document.body || root?.contains(document.activeElement);
    if (opener?.isConnected && lost) queueMicrotask(() => opener.focus());
  });
  // The editor takes the images of a drop and ignores the other files: oinbox decides, before the editor sees it,
  // that a drop holding anything but images is attached whole (docs/rozie-feedback.md, "a mixed drop loses the other files").
  const attachWhole = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length || editorTakesDrop(files)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    void c.attach(files);
  };
  onMount(() => {
    root?.addEventListener('drop', attachWhole, true);
    onCleanup(() => root?.removeEventListener('drop', attachWhole, true));
  });
  let fileInput: HTMLInputElement | undefined;
  const d = () => c.draft();

  /** The editor's HTML as the draft keeps it: images by content id. */
  const stored = (html: string) => fromEditorHtml(html, c.imageUrls());
  /** The draft's HTML as the editor shows it: images by object URL. */
  const shown = (html: string) => toEditorHtml(html, c.imageUrls());

  const insertImages = async (files: File[]) => {
    for (const file of files) {
      try {
        const src = await c.insertImage(file);
        // setImage leaves the image selected, and typing would replace it: put the caret after it.
        editor?.chain().focus().setImage({ src, alt: file.name }).command(({ state, commands }: CommandProps) => commands.setTextSelection(state.selection.to)).run();
      } catch {
        // insertImage has told the user.
      }
    }
  };

  const statusText = () =>
    ({ idle: '', dirty: '', saving: 'Saving…', saved: 'Draft saved', error: 'Couldn’t save draft' })[c.status()];

  const expandQuote = async () => {
    // The quote's images need their URLs before the editor is given them.
    await c.loadImages();
    const html = stored(editor?.getHTML() ?? d().bodyHtml) + d().quoteHtml;
    c.update({ bodyHtml: html, quoteHtml: '' });
    editor?.setContent(shown(html));
  };

  const inlineSignature = () => {
    const html = stored(editor?.getHTML() ?? d().bodyHtml) + d().signatureHtml;
    c.inlineSignature(html);
    editor?.setContent(shown(html));
  };

  return (
    <div
      ref={root}
      class="composer"
      classList={{ inline: props.inline, dragging: dragging() }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          if (!pickedSuggestion(e)) void composers.send(c);
        } else if (e.key === 'Escape' && !props.inline && !closedSuggestions(e)) {
          void composers.close(c);
        }
        e.stopPropagation(); // keep Gmail shortcuts out of the composer
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        // An image dropped on the text went inline: the editor has dealt with it.
        if (e.defaultPrevented) return;
        if (e.dataTransfer?.files.length) {
          e.preventDefault();
          void c.attach(e.dataTransfer.files);
        }
      }}
    >
      <Show when={!props.inline}>
        <div class="composer-title">
          <span>{d().subject || 'New Message'}</span>
          <button class="icon-btn" aria-label="Save & close" title="Save & close (Esc)" onClick={() => void composers.close(c)}>
            <Icon name="close" />
          </button>
        </div>
      </Show>

      <Show when={composers.identities().length > 1}>
        <div class="compose-field">
          <span class="compose-label">From</span>
          <select value={c.identityId() ?? ''} onChange={(e) => c.setIdentityId(e.currentTarget.value)} aria-label="From">
            <For each={composers.identities()}>{(i) => <option value={i.id}>{formatAddress({ name: i.name || null, email: i.email })}</option>}</For>
          </select>
        </div>
      </Show>

      <RecipientField id={`rcpt-${c.id}-to`} label="To" value={d().to} others={[...d().cc, ...d().bcc]} onChange={(to) => c.update({ to })} />
      <Show
        when={showCc()}
        fallback={
          <button type="button" class="link-btn compose-cc-toggle" onClick={() => setShowCc(true)}>
            Cc/Bcc
          </button>
        }
      >
        <RecipientField id={`rcpt-${c.id}-cc`} label="Cc" value={d().cc} others={[...d().to, ...d().bcc]} onChange={(cc) => c.update({ cc })} />
        <RecipientField id={`rcpt-${c.id}-bcc`} label="Bcc" value={d().bcc} others={[...d().to, ...d().cc]} onChange={(bcc) => c.update({ bcc })} />
      </Show>
      <Show when={c.mode === 'new' || c.mode === 'forward'}>
        <div class="compose-field">
          <input class="compose-subject" placeholder="Subject" aria-label="Subject" value={d().subject} onInput={(e) => c.update({ subject: e.currentTarget.value })} />
        </div>
      </Show>

      <div class="compose-body">
        <Show when={c.imagesReady()} fallback={<div class="compose-editor compose-loading" role="status">Loading images…</div>}>
          <TipTap
            ref={(h) => {
              editor = h;
              // TipTap's autofocus prop doesn't take (docs/rozie-feedback.md); focus once the editor exists.
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  // The editor arrives a moment after the composer: by then the user may be typing in a field.
                  if (root?.contains(document.activeElement)) return;
                  // A reply starts in the text; a new message starts with who it is for.
                  if (c.mode === 'new' && !d().to.length) {
                    root?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
                    return;
                  }
                  h.focusEditor();
                  if (!root?.contains(document.activeElement)) root?.querySelector<HTMLElement>('[contenteditable]')?.focus();
                }),
              );
            }}
            html={shown(d().bodyHtml)}
            onHtmlChange={(html: string) => {
              const next = stored(html);
              if (next !== d().bodyHtml) c.update({ bodyHtml: next === '<p></p>' ? '' : next });
            }}
            uploadImage={async (file: File) => ({ src: await c.insertImage(file), alt: file.name })}
            placeholder={c.mode === 'new' ? '' : 'Write your reply…'}
            ariaLabel="Message body"
            editorClass="compose-editor"
            toolbarSlot={() => <FormatToolbar editor={() => editor} onImage={(files) => void insertImages(files)} />}
          />
        </Show>
        <Show when={d().signatureHtml}>
          <div class="compose-signature">
            {/* Sanitized by signatureForCompose; contained so its styles can't reach the page. */}
            <div class="compose-signature-body" innerHTML={d().signatureHtml} />
            <div class="compose-signature-actions">
              <button type="button" class="icon-btn" aria-label="Edit signature in this message" title="Edit signature in this message" onClick={inlineSignature}>
                <Icon name="edit" />
              </button>
              <button type="button" class="icon-btn" aria-label="Remove signature" title="Remove signature" onClick={() => c.removeSignature()}>
                <Icon name="close" />
              </button>
            </div>
          </div>
        </Show>
        <Show when={d().quoteHtml}>
          <button type="button" class="quote-toggle" title="Show trimmed content" onClick={() => void expandQuote()}>
            •••
          </button>
        </Show>
      </div>

      <Show when={d().attachments.length || c.uploading()}>
        <div class="attachments compose-attachments">
          <For each={d().attachments}>
            {(a) => (
              <div class="attachment">
                <Icon name="file" style={{ width: '18px', height: '18px', flex: 'none' }} />
                <span>{a.name}</span>
                <small>{fileSize(a.size)}</small>
                <button type="button" class="icon-btn" style={{ width: '24px', height: '24px' }} aria-label={`Remove ${a.name}`} onClick={() => c.removeAttachment(a.blobId)}>
                  <Icon name="close" />
                </button>
              </div>
            )}
          </For>
          <Show when={c.uploading()}>
            <div class="attachment"><span>Uploading {c.uploading()}…</span></div>
          </Show>
        </div>
      </Show>

      <div class="composer-actions">
        <button type="button" class="btn" onClick={() => void composers.send(c)} title="Send (Ctrl+Enter)">
          Send
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void c.attach(e.currentTarget.files ?? []); e.currentTarget.value = ''; }} />
        <button type="button" class="icon-btn" title="Attach files" onClick={() => fileInput?.click()}>
          <Icon name="clip" />
        </button>
        <span class="compose-status" aria-live="polite">
          {statusText()}
          <Show when={c.status() === 'error'}>
            <button type="button" class="compose-retry" onClick={() => composers.retrySave(c)}>
              Retry
            </button>
          </Show>
        </span>
        <button type="button" class="icon-btn" title="Discard draft" onClick={() => void composers.discard(c)}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

/** Floating windows for new messages (inline replies render inside their conversation). */
export function ComposeDock() {
  const { composers, nav } = useApp();
  const floating = () => composers.list().filter((c) => !c.threadId || c.threadId !== nav.openThread());
  return (
    <div class="compose-dock">
      <For each={floating()}>{(c) => <ComposerView composer={c} inline={false} />}</For>
    </div>
  );
}
