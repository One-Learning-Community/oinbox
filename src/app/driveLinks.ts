import { createSignal } from 'solid-js';
import { DriveError, type DriveClient, type SharingRules } from '../drive/client';
import type { ToastFn } from './actions';
import { freeName, safeName } from './drive';
import type { LinkPasswords } from './linkPasswords';

/** A megabyte as sizes are shown: 1024 × 1024 bytes. */
export const MB = 1024 * 1024;
const MAIL_FOLDER = 'Mail attachments';
const DAY_MS = 86_400_000;

/** What to do with files being added: attach them, offer a link, or insist on one. */
export type Offer = 'attach' | 'offer' | 'must';

/**
 * A link is offered once the message's attachments would pass the threshold, and is the only way
 * for a file the mail server would refuse.
 */
export function linkOffer(o: { attachedBytes: number; sizes: number[]; linkOverMb: number; maxUploadBytes?: number | undefined }): Offer {
  if (o.maxUploadBytes && o.sizes.some((s) => s > o.maxUploadBytes!)) return 'must';
  return o.attachedBytes + o.sizes.reduce((a, b) => a + b, 0) > o.linkOverMb * MB ? 'offer' : 'attach';
}

/** The folder a message's files go into: the day and the subject, made safe for a folder name. */
export function folderName(subject: string, today: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const day = `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`;
  const clean = subject.replace(/[/\\\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return `${day} ${clean || 'No subject'}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dayText = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The lines that go into the message: ordinary text, so the saved draft says what will be sent, a
 * mail client that strips HTML still shows it, and the sender can edit it. It names no files, so
 * adding one later never makes it wrong.
 */
export function linkBlock(o: { url: string; password?: string | undefined; expires?: Date | undefined }): string {
  const url = escapeHtml(o.url);
  return [
    `<p>Files for this message: <a href="${url}">${url}</a>`,
    o.password ? `<br>Password: ${escapeHtml(o.password)}` : '',
    o.expires ? `<br>Available until ${dayText.format(o.expires)}.` : '',
    '</p>',
  ].join('');
}

/** A file to send: one from this computer, or one already in Drive. */
export interface LinkSource {
  name: string;
  size: number;
  file?: File;
  /** Where it is in the drive, for a file chosen there: OpenCloud copies it itself. */
  drivePath?: string[];
}

/** What the sender decided in the dialog. */
export interface LinkChoice {
  /** Empty for none, where none is required. */
  password: string;
  /** Write the password into the message; otherwise the sender passes it on another way. */
  includePassword: boolean;
  /** null: the link does not expire. */
  expiryDays: number | null;
}

/** As much of a composer as this needs. */
export interface ComposerLike {
  draft: () => { subject: string; bodyHtml: string; attachments: { size: number }[] };
  update: (patch: { bodyHtml: string }) => void;
  attach: (files: File[]) => Promise<void>;
}

type Answer = 'linked' | 'attach' | 'cancel';

interface Folder {
  path: string[];
  id: string;
}

export interface LinkRequest {
  composer: ComposerLike;
  sources: LinkSource[];
  /** The size of the files being added. */
  bytes: number;
  /** False when a file is more than the mail server takes: then it is a link or nothing. */
  canAttach: boolean;
  /** The message has its link already: these files join its folder, with no password step. */
  adding: boolean;
}

export interface LinkProgress {
  name: string;
  /** Which file, from 1. */
  index: number;
  count: number;
  /** How much of this file has gone, 0 to 1. */
  fraction: number;
}

const message = (e: unknown): string => {
  if (e instanceof DriveError) {
    if (e.kind === 'unavailable' || e.kind === 'refused') return "Drive isn't available right now.";
    if (e.kind === 'tooLarge') return 'Not enough space in Drive.';
    // A password or expiry the server will not have: it says which rule.
    if (e.kind === 'policy') return e.message;
  }
  return `Couldn't upload to Drive: ${e instanceof Error ? e.message : String(e)}`;
};

/**
 * Sending files as a Drive link instead of attaching them: one folder and one link per message.
 * The dialog (ui/LinkDialog) shows `request`, `progress` and `error`, and answers with
 * `attachAnyway`, `send` or `cancel`.
 */
export function createDriveLinks(deps: {
  drive: { offered: () => boolean; linkOverMb: () => number; client: DriveClient };
  toast: ToastFn;
  passwords: LinkPasswords;
  /** The largest file the mail server takes as an attachment, when that is known. */
  maxUploadBytes?: () => number | undefined;
  now?: () => Date;
}) {
  const { drive, toast, passwords } = deps;
  const client = drive.client;
  const now = deps.now ?? (() => new Date());
  const [request, setRequest] = createSignal<LinkRequest | null>(null);
  const [progress, setProgress] = createSignal<LinkProgress | null>(null);
  const [error, setError] = createSignal('');
  /** The folder and link of each message that has them, for as long as its composer lives. */
  const sessions = new WeakMap<ComposerLike, Folder>();

  /** The request on screen, beyond what the dialog shows of it. */
  interface Open {
    answer: (a: Answer) => void;
    /** The path of the folder made for this request, from the moment it is asked for. */
    made?: string[];
    /** That folder, once it is known to be there. */
    folder?: Folder;
    /** Files already in the folder, after a try that stopped part-way. */
    done: Set<LinkSource>;
    /** Stops whatever this request has under way. One for the request's whole life. */
    stop: AbortController;
    /** A try is running: a second press of the button does nothing. */
    running: boolean;
  }
  let open: Open | null = null;

  /** A folder made for a request that ended with no link has no reason to stay. */
  const tidy = (was: Open, c: ComposerLike) => {
    if (was.made && !sessions.has(c)) void client.remove(was.made).catch(() => {});
  };

  const finish = (a: Answer) => {
    const was = open;
    open = null;
    setRequest(null);
    setProgress(null);
    setError('');
    was?.answer(a);
  };

  /** Put the files into the message's folder, making the folder and its link if it has none yet. */
  const run = async (choice?: LinkChoice): Promise<boolean> => {
    const req = request();
    const mine = open;
    if (!req || !mine || mine.running) return false;
    mine.running = true;
    setError('');
    const c = req.composer;
    const stopped = () => mine.stop.signal.aborted || open !== mine;
    /** Cancelled part-way: cancel() tidied up, but a request that was in flight may have landed since. */
    const bail = () => {
      tidy(mine, c);
      return false;
    };
    try {
      let folder = sessions.get(c) ?? mine.folder;
      if (!folder) {
        await client.createFolder([MAIL_FOLDER]);
        const parent = (await client.children()).find((i) => i.folder && i.name === MAIL_FOLDER);
        if (!parent) throw new DriveError('missing', 404, `${MAIL_FOLDER} could not be made`);
        const taken = new Set((await client.children(parent.id)).map((i) => i.name.toLowerCase()));
        const wanted = folderName(c.draft().subject, now());
        let name = wanted;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted} (${n})`;
        if (stopped()) return false;
        mine.made = [MAIL_FOLDER, name];
        await client.createFolder(mine.made);
        if (stopped()) return bail();
        const made = (await client.children(parent.id)).find((i) => i.folder && i.name === name);
        if (!made) throw new DriveError('missing', 404, 'The folder could not be made');
        folder = mine.folder = { path: mine.made, id: made.id };
      }
      const taken = new Set((await client.children(folder.id)).map((i) => i.name.toLowerCase()));
      for (const [i, source] of req.sources.entries()) {
        if (mine.done.has(source)) continue;
        if (stopped()) return bail();
        const at = (fraction: number) => setProgress({ name: source.name, index: i + 1, count: req.sources.length, fraction });
        at(0);
        const name = freeName(safeName(source.name), taken);
        // From this computer the file goes straight to Drive, never through the mail server.
        if (source.file) await client.upload([...folder.path, name], source.file, { signal: mine.stop.signal, onProgress: (sent, total) => at(total ? sent / total : 0) });
        else await client.copy(source.drivePath!, [...folder.path, name]);
        taken.add(name.toLowerCase());
        mine.done.add(source);
      }
      if (stopped()) return bail();
      if (!sessions.has(c)) {
        const expires = choice?.expiryDays ? new Date(now().getTime() + choice.expiryDays * DAY_MS) : undefined;
        const password = choice?.password || undefined;
        const url = await client.createLink(folder.id, { ...(password ? { password } : {}), ...(expires ? { expires } : {}) });
        if (stopped()) return bail();
        if (password) passwords.remember(url, password);
        c.update({ bodyHtml: c.draft().bodyHtml + linkBlock({ url, password: choice?.includePassword ? password : undefined, expires }) });
        sessions.set(c, folder);
      } else {
        toast("Added to this message's Drive link.", 'success');
      }
      finish('linked');
      return true;
    } catch (e) {
      // Cancelled: nothing went wrong.
      if (stopped()) return bail();
      setProgress(null);
      setError(message(e));
      return false;
    } finally {
      mine.running = false;
    }
  };

  /** Decide what becomes of files being added to a message: resolves once that is settled and done. */
  const decide = (c: ComposerLike, sources: LinkSource[]): Promise<Answer> => {
    if (!sources.length || !drive.offered()) return Promise.resolve('attach');
    const offer = linkOffer({
      attachedBytes: c.draft().attachments.reduce((n, a) => n + a.size, 0),
      sizes: sources.map((s) => s.size),
      linkOverMb: drive.linkOverMb(),
      maxUploadBytes: deps.maxUploadBytes?.(),
    });
    if (offer === 'attach') return Promise.resolve('attach');
    // One question at a time: a second lot of files while the dialog is up is not taken.
    if (open) return Promise.resolve('cancel');
    return new Promise<Answer>((answer) => {
      const adding = sessions.has(c);
      open = { answer, done: new Set(), stop: new AbortController(), running: false };
      setError('');
      setRequest({ composer: c, sources, bytes: sources.reduce((n, s) => n + s.size, 0), canAttach: offer === 'offer', adding });
      // The message has its link and its password already: nothing to ask.
      if (adding) void run();
    });
  };

  return {
    /** What the dialog is open for, or null. */
    request,
    /** The file going up now, or null when nothing is. */
    progress,
    /** Why the last try failed, or ''. */
    error,
    /** What this OpenCloud demands of a link: asked when the dialog opens. */
    loadRules: (): Promise<SharingRules> => client.rules(),

    /** Files from this computer: attach them, or offer to send them as a link. */
    add: async (c: ComposerLike, sources: LinkSource[]): Promise<void> => {
      if ((await decide(c, sources)) === 'attach') await c.attach(sources.flatMap((s) => (s.file ? [s.file] : [])));
    },
    /** Files chosen in Drive, before they are fetched: 'attach' leaves them to be fetched and attached. */
    intercept: (c: ComposerLike, refs: { path: string[]; name: string; size: number }[]): Promise<Answer> =>
      decide(c, refs.map((r) => ({ name: r.name, size: r.size, drivePath: r.path }))),

    attachAnyway: () => {
      const req = request();
      if (!open || !req?.canAttach || open.running) return;
      // After a try that failed part-way there is a folder with some of the files in it.
      tidy(open, req.composer);
      finish('attach');
    },
    /** Make the link (or try again after a failure). True when done; false leaves the dialog up with `error`. */
    send: (choice?: LinkChoice) => run(choice),
    /** Close the dialog. An upload under way is stopped, and a folder made for it and not yet linked is removed. */
    cancel: () => {
      const was = open;
      if (!was) return;
      was.stop.abort();
      tidy(was, request()!.composer);
      finish('cancel');
    },

    /** The links made in this tab whose passwords are still remembered, among those this text mentions. */
    recallIn: (text: string) => passwords.findIn(text),

    /** For the composer (createComposers): what discarding a draft means for its files in Drive. */
    hooks: {
      discardNote: (c: object): string | null => (sessions.has(c as ComposerLike) ? 'The files uploaded to Drive for it will be removed.' : null),
      discarded: (c: object): void => {
        const folder = sessions.get(c as ComposerLike);
        if (!folder) return;
        sessions.delete(c as ComposerLike);
        void client.remove(folder.path).catch(() => toast("The message's files could not be removed from Drive.", 'error'));
      },
      /** A message came back as a new composer (its send was undone, or failed): its files are still its own. */
      reopened: (from: object, to: object): void => {
        const folder = sessions.get(from as ComposerLike);
        if (!folder) return;
        sessions.delete(from as ComposerLike);
        sessions.set(to as ComposerLike, folder);
      },
    },
  };
}

export type DriveLinks = ReturnType<typeof createDriveLinks>;
