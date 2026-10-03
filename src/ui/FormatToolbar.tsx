import type { TipTapHandle } from '@rozie-ui/tiptap-solid';

/** Bold, italic, underline, lists and link: the formatting the composer and the signature editor share. */
export function FormatToolbar(props: { editor: () => TipTapHandle | undefined }) {
  const e = () => props.editor();
  return (
    <div class="compose-format" role="toolbar" aria-label="Formatting">
      <button type="button" title="Bold (Ctrl+B)" onClick={() => e()?.toggleBold()}><b>B</b></button>
      <button type="button" title="Italic (Ctrl+I)" onClick={() => e()?.toggleItalic()}><i>I</i></button>
      <button type="button" title="Underline (Ctrl+U)" onClick={() => e()?.toggleUnderline()}><u>U</u></button>
      <button type="button" title="Bulleted list" onClick={() => e()?.toggleBulletList()}>•≡</button>
      <button type="button" title="Numbered list" onClick={() => e()?.toggleOrderedList()}>1≡</button>
      <button type="button" title="Link" onClick={() => e()?.openLinkEditor()}>🔗</button>
    </div>
  );
}
