import { createSignal } from 'solid-js';
import { DriveError, type DriveClient } from '../drive/client';
import { NO_DRIVE, type DriveConfig } from '../drive/config';
import type { ToastFn } from './actions';

export interface Crumb {
  id?: string;
  name: string;
}
/** A folder as the way to it from the top: the first crumb is the drive itself and has no id. */
export type Trail = Crumb[];

/** Something to save: its name, and how to get its bytes when the time comes. */
export interface SaveFile {
  name: string;
  fetch: () => Promise<Blob>;
}
export interface SaveRequest {
  files: SaveFile[];
  /** Those already in Drive, after a save that stopped part-way: a second try leaves them alone. */
  saved: Set<SaveFile>;
}

/** A name a folder can hold: no slashes or control characters, and never empty or a dot name. */
export function safeName(name: string | null | undefined): string {
  const clean = (name ?? '').replace(/[/\\\u0000-\u001f\u007f]/g, '_').trim();
  return clean === '' || clean === '.' || clean === '..' ? 'attachment' : clean;
}

/** `name`, or `name (1).ext`, `name (2).ext`… if it is among `taken` (lower-case names), as a browser numbers downloads. */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function driveMessage(e: unknown): string {
  if (e instanceof DriveError) {
    if (e.kind === 'unavailable' || e.kind === 'refused') return "Drive isn't available right now.";
    if (e.kind === 'missing') return 'That folder is no longer in Drive.';
    if (e.kind === 'tooLarge') return 'Not enough space in Drive.';
  }
  return `Couldn't save to Drive: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Drive as the app sees it: whether it is offered, the save the picker is open for, and the save.
 * It is the signed-in user's own drive, whichever mailbox is on screen.
 */
export function createDrive(deps: { client: DriveClient; toast: ToastFn }) {
  const { client, toast } = deps;
  const [config, setConfig] = createSignal<DriveConfig>(NO_DRIVE);
  const [request, setRequest] = createSignal<SaveRequest | null>(null);
  let last: Trail = [{ name: 'Drive' }];

  /** Save the waiting files into the folder. True when all are there; the picker then closes. */
  const confirm = async (trail: Trail): Promise<boolean> => {
    const req = request();
    if (!req) return false;
    const path = trail.slice(1).map((c) => c.name);
    try {
      // OpenCloud replaces a file of the same name without a word, so look first.
      const taken = new Set((await client.children(trail.at(-1)!.id)).map((i) => i.name.toLowerCase()));
      for (const f of req.files) {
        if (req.saved.has(f)) continue;
        const name = freeName(safeName(f.name), taken);
        await client.upload([...path, name], await f.fetch());
        taken.add(name.toLowerCase());
        req.saved.add(f);
      }
      const where = path.at(-1) ?? (await client.drive()).name;
      toast(req.files.length === 1 ? `Saved to Drive: ${where}` : `${req.files.length} files saved to Drive: ${where}`, 'success');
      last = trail;
      setRequest(null);
      return true;
    } catch (e) {
      toast(`${driveMessage(e)}${req.saved.size ? ` ${req.saved.size} of ${req.files.length} saved.` : ''}`, 'error');
      return false;
    }
  };

  return {
    client,
    /** Whether this installation has a Drive at all. Nothing is asked of it until it is used. */
    offered: () => config().enabled,
    setConfig,
    /** What the folder picker is open for, or null. */
    request,
    /** Open the folder picker for these files. */
    saveToDrive: (files: SaveFile[]) => {
      if (files.length) setRequest({ files, saved: new Set() });
    },
    cancel: () => setRequest(null),
    /** Where the picker opens: the folder last saved to in this tab, or the top. */
    lastTrail: (): Trail => last,
    confirm,
  };
}

export type Drive = ReturnType<typeof createDrive>;
