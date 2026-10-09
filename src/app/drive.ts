import { createSignal } from 'solid-js';
import { DriveError, type DriveClient, type DriveItem } from '../drive/client';
import { NO_DRIVE, type DriveConfig } from '../drive/config';
import { fileSize } from '../mail/format';
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
/** The picker is open to choose the folder these files go into. */
export interface SaveRequest {
  kind: 'save';
  files: SaveFile[];
  /** Those already in Drive, after a save that stopped part-way: a second try leaves them alone. */
  saved: Set<SaveFile>;
}
/** The picker is open to choose files; `deliver` gets them, fetched. */
export interface PickRequest {
  kind: 'pick';
  deliver: (files: File[]) => void | Promise<void>;
  /**
   * Asked before anything is fetched, with where each chosen file is: 'linked' means they were sent
   * another way (as a Drive link) and need no fetching, 'cancel' that the user thought better of it.
   */
  intercept?: ((refs: DriveRef[]) => Promise<'linked' | 'attach' | 'cancel'>) | undefined;
}
/** A file in the drive: its path from the top, its name and its size. */
export interface DriveRef {
  path: string[];
  name: string;
  size: number;
}
export type DriveRequest = SaveRequest | PickRequest;

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

/** What to tell the user when saving to Drive, or attaching from it, failed. */
export function driveMessage(e: unknown, doing: 'save' | 'attach' = 'save'): string {
  if (e instanceof DriveError) {
    if (e.kind === 'unavailable' || e.kind === 'refused') return "Drive isn't available right now.";
    if (e.kind === 'missing') return doing === 'save' ? 'That folder is no longer in Drive.' : 'That file is no longer in Drive.';
    if (e.kind === 'tooLarge') return 'Not enough space in Drive.';
  }
  return `Couldn't ${doing === 'save' ? 'save to' : 'attach from'} Drive: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Drive as the app sees it: whether it is offered, what the picker is open for, saving into it and
 * attaching from it. It is the signed-in user's own drive, whichever mailbox is on screen.
 */
export function createDrive(deps: {
  client: DriveClient;
  toast: ToastFn;
  /** The largest file the mail server takes as an attachment, when that is known. */
  maxUploadBytes?: () => number | undefined;
}) {
  const { client, toast } = deps;
  const [config, setConfig] = createSignal<DriveConfig>(NO_DRIVE);
  const [request, setRequest] = createSignal<DriveRequest | null>(null);
  let last: Trail = [{ name: 'Drive' }];
  /** The fetch of chosen files that is under way, so that Cancel can stop it. */
  let fetching: AbortController | null = null;

  /** Save the waiting files into the folder. True when all are there; the picker then closes. */
  const confirm = async (trail: Trail): Promise<boolean> => {
    const req = request();
    if (req?.kind !== 'save') return false;
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

  /**
   * Fetch the chosen files of the folder and hand them to whoever asked. All or nothing: if one
   * cannot be had, none is handed over and the picker stays open. True closes the picker.
   */
  const choose = async (trail: Trail, items: DriveItem[]): Promise<boolean> => {
    const req = request();
    if (req?.kind !== 'pick' || !items.length) return false;
    if (req.intercept) {
      const from = trail.slice(1).map((c) => c.name);
      const answer = await req.intercept(items.map((i) => ({ path: [...from, i.name], name: i.name, size: i.size })));
      if (answer === 'cancel' || request() !== req) return false;
      if (answer === 'linked') {
        last = trail;
        setRequest(null);
        return true;
      }
    }
    // What the mail server would refuse is refused here, before minutes are spent fetching it.
    const limit = deps.maxUploadBytes?.();
    const tooBig = limit ? items.find((i) => i.size > limit) : undefined;
    if (tooBig) {
      toast(`${tooBig.name} is too large to attach (the limit is ${fileSize(limit!)}).`, 'error');
      return false;
    }
    const path = trail.slice(1).map((c) => c.name);
    const stop = (fetching = new AbortController());
    try {
      const files: File[] = [];
      for (const item of items) {
        const bytes = await client.download([...path, item.name], stop.signal);
        // Not the file that was listed: it was replaced meanwhile, or something other than Drive
        // answered. Either way it must not be sent under this name.
        if (bytes.size !== item.size) throw new Error(`${item.name} changed while it was being fetched. Try again.`);
        files.push(new File([bytes], item.name, { type: bytes.type || 'application/octet-stream' }));
      }
      if (request() !== req) return false;
      last = trail;
      setRequest(null);
      // What happens to them next (the composer's upload) reports its own failures.
      void req.deliver(files);
      return true;
    } catch (e) {
      // Cancelled: the user knows, and nothing went wrong.
      if (stop.signal.aborted) return false;
      toast(driveMessage(e, 'attach'), 'error');
      return false;
    } finally {
      if (fetching === stop) fetching = null;
    }
  };

  return {
    client,
    /** Whether this installation has a Drive at all. Nothing is asked of it until it is used. */
    offered: () => config().enabled,
    /** Past this many megabytes of attachments, a message's files are offered as a link. */
    linkOverMb: () => config().linkOverMb,
    setConfig,
    /** What the picker is open for, or null. */
    request,
    /** Open the picker to choose a folder for these files. */
    saveToDrive: (files: SaveFile[]) => {
      if (files.length) setRequest({ kind: 'save', files, saved: new Set() });
    },
    /** Open the picker to choose files; `deliver` gets them once fetched. */
    attachFromDrive: (deliver: PickRequest['deliver'], intercept?: PickRequest['intercept']) => setRequest({ kind: 'pick', deliver, intercept }),
    /** Close the picker, stopping a fetch of chosen files if one is running. */
    cancel: () => {
      fetching?.abort();
      fetching = null;
      setRequest(null);
    },
    /** Where the picker opens: the folder last used in this tab, or the top. */
    lastTrail: (): Trail => last,
    confirm,
    choose,
  };
}

export type Drive = ReturnType<typeof createDrive>;
