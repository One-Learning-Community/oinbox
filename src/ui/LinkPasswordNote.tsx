import { createMemo, createSignal, For, onCleanup } from 'solid-js';
import { useApp } from '../app/context';

/**
 * Above a message's attachments: the password of a Drive link in its text, if the link was made in
 * this tab within the last half hour. OpenCloud never gives a password back, and one copied to be
 * sent another way is easily lost to the next copy.
 */
export function LinkPasswordNote(props: { text: string }) {
  const { driveLinks } = useApp();
  /** Bumped when a note's time is up: asking again is also what clears the password from the storage. */
  const [turn, setTurn] = createSignal(0);
  const found = createMemo(() => (turn(), driveLinks.recallIn(props.text).filter((f) => f.until > Date.now())));
  return <For each={found()}>{(f) => <Note password={f.password} until={f.until} onGone={() => setTurn((n) => n + 1)} />}</For>;
}

function Note(props: { password: string; until: number; onGone: () => void }) {
  const [shown, setShown] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  // The message may stay open past the half hour: the note must not.
  const timer = setTimeout(() => props.onGone(), Math.max(0, props.until - Date.now()));
  onCleanup(() => clearTimeout(timer));
  const copy = () => {
    void navigator.clipboard?.writeText(props.password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <p class="link-recall">
      <span>Password for the Drive link:</span> <code>{shown() ? props.password : '••••••••'}</code>
      <button type="button" class="link-btn" onClick={() => setShown(!shown())}>{shown() ? 'Hide' : 'Show'}</button>
      <button type="button" class="link-btn" onClick={copy}>{copied() ? 'Copied' : 'Copy'}</button>
      <small>Kept in this tab until {new Date(props.until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</small>
    </p>
  );
}
