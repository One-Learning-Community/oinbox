import { Dialog } from '@rozie-ui/dialog-solid';
import { Switch as Toggle } from '@rozie-ui/switch-solid';
import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js';
import { useApp } from '../app/context';
import type { ImportResult, VcardBlock } from '../app/contacts-import';
import { findDuplicates, peekVcard, splitVcards, type VcardPeek } from '../contacts/vcard';

const MAX_BYTES = 25 * 1024 * 1024;
/** Stalwart's default upload allowance for an hour. It says its own nowhere before it is reached. */
const USUAL_ALLOWANCE = 1000;
const SHOWN_FAILURES = 20;

const contacts_ = (n: number) => `${n.toLocaleString()} contact${n === 1 ? '' : 's'}`;

/** Import contacts from vCard files: choose, see what they hold, import, see what happened. */
export function ImportDialog() {
  const { contacts } = useApp();
  return (
    <Show when={contacts.importOpen()}>
      <ImportSteps />
    </Show>
  );
}

interface Found {
  blocks: string[];
  peeks: VcardPeek[];
  unreadable: number;
}

function ImportSteps() {
  const { contacts } = useApp();
  const [found, setFound] = createSignal<Found | null>(null);
  const [error, setError] = createSignal('');
  const [skip, setSkip] = createSignal(true);
  const [progress, setProgress] = createSignal<{ done: number; total: number } | null>(null);
  const [result, setResult] = createSignal<(ImportResult & { skipped: number }) | null>(null);
  let stop: AbortController | null = null;

  const check = createMemo(() => {
    const f = found();
    return f ? findDuplicates(f.peeks, Object.values(contacts.state.cards)) : { fresh: [], duplicates: [] };
  });
  const groups = () => found()?.peeks.filter((p) => p.group).length ?? 0;
  const wanted = () => (skip() ? check().fresh.length : (found()?.blocks.length ?? 0));

  const choose = async (files: File[]) => {
    setError('');
    setFound(null);
    if (!files.length) return;
    if (files.reduce((n, f) => n + f.size, 0) > MAX_BYTES) return void setError('These files are too large to import at once (25 MB at most).');
    try {
      const cut = (await Promise.all(files.map((f) => f.text()))).map(splitVcards);
      const blocks = cut.flatMap((c) => c.blocks);
      setFound({ blocks, peeks: blocks.map(peekVcard), unreadable: cut.reduce((n, c) => n + c.unreadable, 0) });
    } catch (e) {
      setError(`Couldn't read the files: ${(e as Error).message}`);
    }
  };

  const run = async () => {
    const f = found();
    if (!f || progress()) return;
    const dupes = new Set(check().duplicates);
    const picked = f.blocks.map((_, i) => i).filter((i) => !skip() || !dupes.has(i));
    // A duplicate imported all the same cannot keep its uid: the server holds one card per uid.
    const blocks: VcardBlock[] = picked.map((i) => ({ text: f.blocks[i]!, name: f.peeks[i]!.name, uid: f.peeks[i]!.uid, ...(dupes.has(i) && f.peeks[i]!.uid ? { freshUid: true } : {}) }));
    stop = new AbortController();
    setProgress({ done: 0, total: blocks.length });
    const skipped = skip() ? dupes.size : 0;
    try {
      const out = await contacts.importVcards(blocks, { signal: stop.signal, onProgress: (done, total) => setProgress({ done, total }) });
      setResult({ ...out, skipped });
    } catch (e) {
      setResult({ imported: 0, failed: [{ name: 'Import', error: (e as Error).message }], cancelled: false, left: blocks.length, skipped });
    } finally {
      setProgress(null);
      stop = null;
    }
  };

  /** While an import runs, closing is stopping: it is never left running out of sight. */
  const close = () => {
    if (progress()) stop?.abort();
    else contacts.closeImport();
  };

  const when = (seconds: number | null) => {
    if (seconds === null) return 'about an hour';
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  };

  return (
    <Dialog open class="import-dialog" onOpenChange={(open) => !open && close()} ariaLabelledby="import-dialog-title">
      <div class="import-form">
        <h2 id="import-dialog-title">Import contacts</h2>
        <Switch>
          <Match when={result()}>
            {(r) => (
              <div class="import-result" role="status">
                <p>Imported {contacts_(r().imported)}.</p>
                <Show when={r().skipped}>
                  <p>Skipped {r().skipped.toLocaleString()} already in your contacts.</p>
                </Show>
                <Show when={r().cancelled && r().left}>
                  <p>Stopped: {r().left.toLocaleString()} {r().left === 1 ? 'was' : 'were'} not imported.</p>
                </Show>
                <Show when={r().quota}>
                  {(q) => (
                    <div class="import-warning">
                      <p>The server's upload limit was reached: {contacts_(r().left)} {r().left === 1 ? 'was' : 'were'} not imported.</p>
                      <p class="import-quiet">{q().message}</p>
                      <p>You can import {r().left === 1 ? 'it' : 'them'} in {when(q().retryAfter)}: choose the same files again, and the contacts already here are skipped.</p>
                      <p>Until then you may not be able to attach files to a message.</p>
                    </div>
                  )}
                </Show>
                <Show when={!r().quota && !r().cancelled && r().left}>
                  <p>{r().left.toLocaleString()} {r().left === 1 ? 'was' : 'were'} not sent.</p>
                </Show>
                <Show when={r().failed.length}>
                  <p>{r().failed.length.toLocaleString()} could not be saved:</p>
                  <ul class="import-failed">
                    <For each={r().failed.slice(0, SHOWN_FAILURES)}>{(f) => <li>{f.name}: {f.error}</li>}</For>
                    <Show when={r().failed.length > SHOWN_FAILURES}>
                      <li>and {(r().failed.length - SHOWN_FAILURES).toLocaleString()} more</li>
                    </Show>
                  </ul>
                </Show>
                <div class="dialog-actions">
                  <button type="button" class="primary" onClick={() => contacts.closeImport()}>Done</button>
                </div>
              </div>
            )}
          </Match>
          <Match when={progress()}>
            {(p) => (
              <>
                <progress max={p().total} value={p().done} aria-label="Import progress" />
                <p role="status">Imported {p().done.toLocaleString()} of {p().total.toLocaleString()}</p>
                <div class="dialog-actions">
                  <button type="button" onClick={() => stop?.abort()}>Stop</button>
                </div>
              </>
            )}
          </Match>
          <Match when={true}>
            <label class="import-pick">
              <span>vCard files</span>
              <input type="file" accept=".vcf,text/vcard,text/x-vcard" multiple onChange={(e) => void choose([...(e.currentTarget.files ?? [])])} />
            </label>
            <Show when={error()}>
              <p class="label-error" role="alert">{error()}</p>
            </Show>
            <Show when={found()}>
              {(f) => (
                <Show when={f().blocks.length} fallback={<p>No contacts were found in these files.</p>}>
                  <ul class="import-found">
                    <li>
                      {contacts_(f().blocks.length)} found{groups() ? `, ${groups().toLocaleString()} of them ${groups() === 1 ? 'a group' : 'groups'}` : ''}
                    </li>
                    <Show when={check().duplicates.length}>
                      <li class="import-dupes">
                        <span>{check().duplicates.length.toLocaleString()} already in your contacts</span>
                        <span class="switch-row">
                          <Toggle id="import-skip" modelValue={skip()} onModelValueChange={(v: boolean) => setSkip(v)} />
                          <label for="import-skip">Skip duplicates</label>
                        </span>
                      </li>
                    </Show>
                    <Show when={f().unreadable}>
                      <li>{f().unreadable.toLocaleString()} could not be read</li>
                    </Show>
                  </ul>
                  <p class="import-quiet">
                    The server reads each contact as an uploaded file, and counts it against the same hourly allowance as your attachments (usually {USUAL_ALLOWANCE.toLocaleString()} files an hour; your administrator may have set another).
                  </p>
                  <Show when={wanted() > USUAL_ALLOWANCE}>
                    <p class="import-warning" role="status">
                      This is more than the usual allowance. The import will stop when the server's limit is reached; import the same files again later and the contacts already here are skipped.
                    </p>
                  </Show>
                </Show>
              )}
            </Show>
            <div class="dialog-actions">
              <button type="button" onClick={() => contacts.closeImport()}>Cancel</button>
              <Show when={found()?.blocks.length}>
                <button type="button" class="primary" disabled={!wanted()} onClick={() => void run()}>Import {wanted().toLocaleString()}</button>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  );
}
