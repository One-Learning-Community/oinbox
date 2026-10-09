import { Dialog } from '@rozie-ui/dialog-solid';
import { createEffect, createSignal, For, on, Show } from 'solid-js';
import { useApp } from '../app/context';
import { driveMessage, type Trail } from '../app/drive';
import { DriveError, type DriveItem } from '../drive/client';
import { fileSize } from '../mail/format';
import { Icon } from './icons';

/** Choose the Drive folder to save into. Open while the app has a save waiting. */
export function DrivePicker() {
  const { drive } = useApp();
  return (
    <Show when={drive.request()} keyed>
      {(req) => <Picker count={req.files.length} />}
    </Show>
  );
}

function Picker(props: { count: number }) {
  const { drive } = useApp();
  const [trail, setTrail] = createSignal<Trail>(drive.lastTrail());
  /** null while the folder is being listed. */
  const [items, setItems] = createSignal<DriveItem[] | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [naming, setNaming] = createSignal(false);
  const [nameError, setNameError] = createSignal('');
  const [rootName, setRootName] = createSignal(trail()[0]!.name);
  let list: HTMLUListElement | undefined;
  let nameField: HTMLInputElement | undefined;
  /** Only the latest listing counts: a slow answer for a folder already left is dropped. */
  let asked = 0;

  const here = () => trail().at(-1)!;
  const path = () => trail().slice(1).map((c) => c.name);
  const label = (i: number) => (i === 0 ? rootName() : trail()[i]!.name);

  const load = async () => {
    const mine = ++asked;
    setItems(null);
    setError('');
    try {
      const found = await drive.client.children(here().id);
      if (mine !== asked) return;
      setItems([...found].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)));
    } catch (e) {
      if (mine !== asked) return;
      // The folder remembered from last time has gone: start again from the top.
      if (e instanceof DriveError && e.kind === 'missing' && trail().length > 1) return void setTrail([trail()[0]!]);
      setError(driveMessage(e));
    }
  };
  createEffect(on(trail, () => void load()));
  void drive.client.drive().then((d) => setRootName(d.name), () => {});

  const enter = (item: DriveItem) => setTrail([...trail(), { id: item.id, name: item.name }]);
  const up = () => trail().length > 1 && setTrail(trail().slice(0, -1));
  const ready = () => items() !== null && !busy();

  const onListKey = (e: KeyboardEvent) => {
    const rows = [...(list?.querySelectorAll<HTMLElement>('button[data-folder]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Backspace') {
      e.preventDefault();
      return void up();
    }
    const moves: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 };
    const to = moves[e.key];
    if (to === undefined || !rows.length) return;
    e.preventDefault();
    rows[(to + rows.length) % rows.length]?.focus();
  };

  const save = async () => {
    if (!ready()) return;
    setBusy(true);
    try {
      // On success the app drops the request and this dialog goes with it.
      await drive.confirm(trail());
    } finally {
      setBusy(false);
    }
  };

  const checkName = (raw: string): string => {
    const name = raw.trim();
    if (!name || name === '.' || name === '..') return 'Give the folder a name.';
    if (/[/\\]/.test(name)) return "A folder name can't contain a slash.";
    if ((items() ?? []).some((i) => i.name.toLowerCase() === name.toLowerCase())) return 'A folder or file with that name is already here.';
    return '';
  };

  const create = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!ready() || !nameField) return;
    const name = nameField.value.trim();
    const problem = checkName(name);
    setNameError(problem);
    if (problem) return;
    setBusy(true);
    try {
      await drive.client.createFolder([...path(), name]);
      const made = (await drive.client.children(here().id)).find((i) => i.folder && i.name === name);
      setNaming(false);
      if (made) enter(made);
      else void load();
    } catch (err) {
      setNameError(driveMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy() && drive.cancel()} ariaLabelledby="drive-picker-title">
      <div class="drive-picker">
        <h2 id="drive-picker-title">{props.count === 1 ? 'Save to Drive' : `Save ${props.count} files to Drive`}</h2>
        <nav class="drive-crumbs" aria-label="Folder path">
          <For each={trail()}>
            {(_, i) => (
              <Show when={i() < trail().length - 1} fallback={<span aria-current="location">{label(i())}</span>}>
                <button type="button" onClick={() => setTrail(trail().slice(0, i() + 1))}>{label(i())}</button>
                <span aria-hidden="true">›</span>
              </Show>
            )}
          </For>
        </nav>
        <div class="drive-list">
          <Show when={!error()} fallback={
            <div class="drive-note" role="alert">
              <span>{error()}</span>
              <button type="button" onClick={() => void load()}>Try again</button>
            </div>
          }>
            <Show when={items()} fallback={<div class="drive-note" role="status">Loading…</div>}>
              {(found) => (
                <Show when={found().length} fallback={<div class="drive-note">This folder is empty.</div>}>
                  <ul ref={list} aria-label={label(trail().length - 1)} onKeyDown={onListKey}>
                    <For each={found()}>
                      {(item) => (
                        <li>
                          <Show when={item.folder} fallback={
                            <span class="drive-file">
                              <Icon name="file" />
                              <span>{item.name}</span>
                              <small>{fileSize(item.size)}</small>
                            </span>
                          }>
                            <button type="button" data-folder aria-label={`Open ${item.name}`} onClick={() => enter(item)}>
                              <Icon name="label" />
                              <span>{item.name}</span>
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              )}
            </Show>
          </Show>
        </div>
        <Show when={naming()}>
          <form class="label-form drive-new" onSubmit={create}>
            <input
              ref={(el) => {
                nameField = el;
                queueMicrotask(() => el.focus());
              }}
              type="text"
              aria-label="Folder name"
              aria-invalid={nameError() ? 'true' : undefined}
              aria-describedby={nameError() ? 'drive-new-error' : undefined}
              onInput={(e) => nameError() && setNameError(checkName(e.currentTarget.value))}
            />
            <Show when={nameError()}>
              <p class="field-error" id="drive-new-error" role="alert">{nameError()}</p>
            </Show>
            <div class="dialog-actions">
              <button type="button" onClick={() => { setNaming(false); setNameError(''); }}>Cancel</button>
              <button type="submit" class="primary" disabled={!ready()}>Create</button>
            </div>
          </form>
        </Show>
        <Show when={!naming()}>
          <div class="dialog-actions drive-actions">
            <button type="button" class="drive-add" disabled={!ready()} onClick={() => setNaming(true)}>
              <Icon name="add" /> New folder
            </button>
            <button type="button" disabled={busy()} onClick={() => drive.cancel()}>Cancel</button>
            <button type="button" class="primary" disabled={!ready()} onClick={() => void save()}>
              {busy() ? 'Saving…' : 'Save here'}
            </button>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}
