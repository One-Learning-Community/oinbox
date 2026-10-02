import { TipTap, type TipTapHandle } from '@rozie-ui/tiptap-solid';
import { createSignal, For, Show } from 'solid-js';
import type { Composer } from '../app/composer';
import { useApp } from '../app/context';
import { formatAddress } from '../mail/compose';
import { fileSize } from '../mail/format';
import { Icon } from './icons';
import { closedSuggestions, pickedSuggestion, RecipientField } from './RecipientField';

export function ComposerView(props: { composer: Composer; inline: boolean }) {
  const { composers } = useApp();
  const c = props.composer;
  const [showCc, setShowCc] = createSignal(c.draft().cc.length > 0 || c.draft().bcc.length > 0);
  const [dragging, setDragging] = createSignal(false);
  let editor: TipTapHandle | undefined;
  let root: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  const d = () => c.draft();

  const statusText = () =>
    ({ idle: '', dirty: '', saving: 'Saving…', saved: 'Draft saved', error: 'Couldn’t save draft' })[c.status()];

  const expandQuote = () => {
    const html = (editor?.getHTML() ?? d().bodyHtml) + d().quoteHtml;
    c.update({ bodyHtml: html, quoteHtml: '' });
    editor?.setContent(html);
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
        <TipTap
          ref={(h) => {
            editor = h;
            // TipTap's autofocus prop doesn't take (docs/rozie-feedback.md); focus once the editor exists.
            if (c.mode !== 'new' || d().to.length) {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  h.focusEditor();
                  if (!root?.contains(document.activeElement)) root?.querySelector<HTMLElement>('[contenteditable]')?.focus();
                }),
              );
            }
          }}
          html={d().bodyHtml}
          onHtmlChange={(html: string) => {
            if (html !== d().bodyHtml) c.update({ bodyHtml: html === '<p></p>' ? '' : html });
          }}
          placeholder={c.mode === 'new' ? '' : 'Write your reply…'}
          ariaLabel="Message body"
          editorClass="compose-editor"
          toolbarSlot={() => (
            <div class="compose-format" role="toolbar" aria-label="Formatting">
              <button type="button" title="Bold (Ctrl+B)" onClick={() => editor?.toggleBold()}><b>B</b></button>
              <button type="button" title="Italic (Ctrl+I)" onClick={() => editor?.toggleItalic()}><i>I</i></button>
              <button type="button" title="Underline (Ctrl+U)" onClick={() => editor?.toggleUnderline()}><u>U</u></button>
              <button type="button" title="Bulleted list" onClick={() => editor?.toggleBulletList()}>•≡</button>
              <button type="button" title="Numbered list" onClick={() => editor?.toggleOrderedList()}>1≡</button>
              <button type="button" title="Link" onClick={() => editor?.openLinkEditor()}>🔗</button>
            </div>
          )}
        />
        <Show when={d().quoteHtml}>
          <button type="button" class="quote-toggle" title="Show trimmed content" onClick={expandQuote}>
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
        <span class="compose-status" aria-live="polite">{statusText()}</span>
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
