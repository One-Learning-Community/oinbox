import type { TipTapHandle } from '@rozie-ui/tiptap-solid';
import { Show } from 'solid-js';

/** Bold, italic, underline, lists and link: the formatting the composer and the signature editor share. The composer adds images. */
export function FormatToolbar(props: { editor: () => TipTapHandle | undefined; onImage?: (files: File[]) => void }) {
  const e = () => props.editor();
  let picker: HTMLInputElement | undefined;
  return (
    <div class="compose-format" role="toolbar" aria-label="Formatting">
      <button type="button" title="Bold (Ctrl+B)" onClick={() => e()?.toggleBold()}><b>B</b></button>
      <button type="button" title="Italic (Ctrl+I)" onClick={() => e()?.toggleItalic()}><i>I</i></button>
      <button type="button" title="Underline (Ctrl+U)" onClick={() => e()?.toggleUnderline()}><u>U</u></button>
      <button type="button" title="Bulleted list" onClick={() => e()?.toggleBulletList()}>•≡</button>
      <button type="button" title="Numbered list" onClick={() => e()?.toggleOrderedList()}>1≡</button>
      <button type="button" title="Link" onClick={() => e()?.openLinkEditor()}>🔗</button>
      <Show when={props.onImage}>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(ev) => {
            // `accept` is advice to the file dialog, not a rule.
            props.onImage?.([...(ev.currentTarget.files ?? [])].filter((f) => f.type.startsWith('image/')));
            ev.currentTarget.value = '';
          }}
        />
        <button type="button" title="Insert image" aria-label="Insert image" onClick={() => picker?.click()}>🖼</button>
      </Show>
    </div>
  );
}
