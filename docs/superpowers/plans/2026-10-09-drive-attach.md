# Drive, slice 2: Attach from Drive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While writing a message, a user with a Drive can attach files straight from it, without downloading them to their computer first.

**Architecture:** Everything slice 1 built is reused: the `/drive` route, `DriveClient`, the fake, `createDrive` and the folder picker. The client learns to download; the app's Drive gains a second kind of request ("pick files"); the picker gains a file mode; the composer's paperclip becomes a two-item menu when there is a Drive. A chosen file is downloaded in the browser and handed to the composer's existing `attach`, so upload, limits, progress and the draft behave as for a file from disk.

**Tech Stack:** SolidJS 1.9, `@rozie-ui/dialog-solid`, `@rozie-ui/popover-solid`, Vitest + jsdom, Playwright, OpenCloud 7.2.4 (local only).

**Spec:** `docs/superpowers/specs/2026-10-09-drive-integration-design.md`, "Slice 2: Attach from Drive" and "The folder picker". Builds on `docs/superpowers/plans/2026-10-09-drive-save.md`, on the same branch (`drive-integration`).

## Global Constraints

- No new dependencies. No change to `deploy/routes.caddy`: downloads use `/drive/dav/spaces/*`, already proxied.
- With Drive off the composer's paperclip is exactly today's button: one click opens the file chooser.
- Nothing is asked of OpenCloud until the user chooses "From Drive".
- A file from Drive goes through the composer's own `attach`; this slice adds no size rule of its own. (Offering a link for large files is slice 3.)
- Attaching is all or nothing: if any chosen file cannot be fetched, none is attached and the picker stays open.
- OpenCloud stays out of CI. A spec that needs it skips itself unless `/drive.json` says `enabled: true`.
- Copy, verbatim: menu items `From this computer` and `From Drive`; dialog title `Attach from Drive`; buttons `Attach`, `Attach 2 files`, `Attaching…`, `Cancel`; error `That file is no longer in Drive.`; other failures `Couldn't attach from Drive: <reason>`.
- Commit after every task, message prefix `Drive:`, ending with the session's attribution lines. Do not push.

## Review Focus

1. **A file is deleted or renamed in OpenCloud after the folder was listed.** Expect a plain message, nothing attached, the picker still open. Pinned in Task 2.
2. **A file uploaded a moment ago answers 425 "too early".** Expect the download to wait and succeed, not an error. Pinned in Task 1.
3. **Ticks made in one folder, then the user opens another.** Expect the ticks gone and `Attach` disabled, not files attached from a folder no longer on screen. Pinned in Task 4.
4. **An empty file (0 bytes).** Expect it to attach like any other. Pinned in Task 1 (download) and Task 2 (the `File` handed over).
5. **Attach pressed twice.** Expect one set of attachments. Pinned in Task 4.

## File Structure

| File | Change |
|---|---|
| `src/drive/client.ts`, `src/drive/fake.ts` (modify) | `download`, with the 425 wait; the fake serves files. |
| `src/app/drive.ts` (replace) | Requests are of two kinds; `attachFromDrive`, `choose`; messages for attaching. |
| `src/ui/Menu.tsx` (create) | `MenuButton`: a button that opens a popover menu. The chip menu and the paperclip use it. |
| `src/ui/Attachments.tsx` (replace) | Uses `MenuButton`. |
| `src/ui/DrivePicker.tsx` (replace) | File mode. |
| `src/ui/ComposerView.tsx` (modify) | The paperclip menu. |
| `src/ui/styles.css` (modify) | `.attachment-menu` becomes `.menu-anchor`; file-mode rows. |
| `e2e/drive.spec.ts` (modify) | Attach from Drive end to end; the paperclip with and without a Drive. |
| `docs/operating.md`, `README.md`, `CHANGELOG.md` (modify) | Say what Drive now does. |

---

### Task 1: Downloading a file

**Files:**
- Modify: `src/drive/client.ts`, `src/drive/fake.ts`
- Test: `src/drive/client.test.ts` (append)

**Interfaces:**
- Produces: `DriveClient.download(path: string[]): Promise<Blob>`; `DriveClientOptions.retryMs?: number` (the wait between tries after a 425, default 400); `FakeDrive.early: number` (the next that many downloads answer 425).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('DriveClient', …)` block of `src/drive/client.test.ts`:

```ts
  it("downloads a file's bytes, an empty file too", async () => {
    const server = new FakeDrive();
    server.mkdir(['Reports']);
    const body = blob('pdf!');
    server.put(['Reports', 'q3 #1.pdf'], body);
    server.put(['empty.txt'], new Blob([]));
    const c = server.client();
    expect(await c.download(['Reports', 'q3 #1.pdf'])).toBe(body);
    expect(server.requests.at(-1)).toEqual({ method: 'GET', path: `/dav/spaces/${encodeURIComponent(server.driveId)}/Reports/q3%20%231.pdf` });
    expect((await c.download(['empty.txt'])).size).toBe(0);
  });

  it('waits out "too early" for a file that was only just uploaded', async () => {
    const server = new FakeDrive();
    server.put(['new.txt'], blob('fresh'));
    server.early = 2;
    const fetched = await server.client({ retryMs: 1 }).download(['new.txt']);
    expect(fetched.size).toBe(5);
    expect(server.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/new.txt'))).toHaveLength(3);
  });

  it('gives up on a file that stays "too early", and says a missing one is missing', async () => {
    const server = new FakeDrive();
    server.put(['stuck.txt'], blob('x'));
    server.early = 99;
    const c = server.client({ retryMs: 1 });
    expect(await kindOf(c.download(['stuck.txt']))).toBe('other');
    expect(server.requests.filter((r) => r.path.endsWith('/stuck.txt'))).toHaveLength(5);
    server.early = 0;
    expect(await kindOf(c.download(['nope.txt']))).toBe('missing');
    expect(await kindOf(c.download(['No folder', 'a.txt']))).toBe('missing');
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/drive/client.test.ts`
Expected: 3 failed (`c.download is not a function`, and `early`/`retryMs` unknown to TypeScript is not checked by Vitest), 13 passed.

- [ ] **Step 3: Implement**

In `src/drive/fake.ts`, add the field after `full = false;`:

```ts
  /** The next this-many downloads answer 425, as OpenCloud does for a file it has not finished with. */
  early = 0;
```

and, inside the `if (dav && …)` block, before `if (method === 'MKCOL')`:

```ts
      if (method === 'GET') {
        const node = parent?.children?.get(name);
        if (!node?.data) return empty(404);
        if (this.early > 0) {
          this.early--;
          return empty(425);
        }
        // Not a real Response: under jsdom a Response built from a Blob does not give the same Blob back.
        const data = node.data;
        return { ok: true, status: 200, headers: new Headers({ 'content-type': data.type }), blob: async () => data } as Response;
      }
```

In `src/drive/client.ts`, add to `DriveClientOptions`:

```ts
  /** How long to wait before asking again for a file OpenCloud says is not ready (425). */
  retryMs?: number;
```

and add the method after `upload`:

```ts
  /**
   * A file's bytes. Straight after an upload OpenCloud can answer 425 while it finishes with the
   * file (seen 2026-10-09): wait and ask again, five times in all.
   */
  async download(path: string[]): Promise<Blob> {
    const url = await this.dav(path);
    for (let attempt = 1; ; attempt++) {
      const res = await this.request(url, {}, true);
      if (res.status === 425 && attempt < 5) {
        await new Promise((r) => setTimeout(r, this.opts.retryMs ?? 400));
        continue;
      }
      if (!res.ok) this.fail(res, 'Downloading');
      return res.blob();
    }
  }
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test src/drive/client.test.ts && pnpm typecheck`
Expected: 16 passed; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/drive/client.ts src/drive/fake.ts src/drive/client.test.ts
git commit -m "Drive: download a file, waiting out OpenCloud's 'too early'"
```

---

### Task 2: A second kind of request: picking files

**Files:**
- Replace: `src/app/drive.ts`
- Modify: `src/ui/DrivePicker.tsx` (one line, so the project still typechecks), `src/app/drive.test.ts`

**Interfaces:**
- Consumes: `DriveClient.download` (Task 1); `DriveItem` (`{ id, name, size, folder, modified }`).
- Produces:
  ```ts
  export interface SaveRequest { kind: 'save'; files: SaveFile[]; saved: Set<SaveFile> }
  export interface PickRequest { kind: 'pick'; deliver: (files: File[]) => void | Promise<void> }
  export type DriveRequest = SaveRequest | PickRequest;
  export function driveMessage(e: unknown, doing?: 'save' | 'attach'): string;   // default 'save'
  // on Drive:
  request: () => DriveRequest | null;
  attachFromDrive: (deliver: (files: File[]) => void | Promise<void>) => void;   // opens the picker in file mode
  choose: (trail: Trail, items: DriveItem[]) => Promise<boolean>;               // fetches, delivers; true closes the picker
  ```
  `saveToDrive`, `confirm`, `cancel`, `lastTrail`, `offered`, `setConfig`, `client` are unchanged, except that `confirm` does nothing unless the request is a save.

- [ ] **Step 1: Write the failing tests**

In `src/app/drive.test.ts`:

1. Change the import line to add `DriveItem`: `import { DriveError, type DriveItem } from '../drive/client';`
2. In the test "asks nothing of OpenCloud until a folder is confirmed", replace `expect(drive.request()?.files).toHaveLength(1);` with:
   ```ts
    const req = drive.request();
    expect(req?.kind === 'save' && req.files.length).toBe(1);
   ```
3. Add to the `driveMessage` test, before its closing `});`:
   ```ts
    expect(driveMessage(new DriveError('missing', 404, 'x'), 'attach')).toBe('That file is no longer in Drive.');
    expect(driveMessage(new DriveError('unavailable', 0, 'x'), 'attach')).toBe("Drive isn't available right now.");
    expect(driveMessage(new DriveError('other', 425, 'Downloading: HTTP 425'), 'attach')).toBe("Couldn't attach from Drive: Downloading: HTTP 425");
   ```
4. Append a new block at the end of the file:

```ts
describe('attaching from Drive', () => {
  const item = (id: string, name: string): DriveItem => ({ id, name, size: 1, folder: false, modified: '' });

  it('opens a request for files and asks nothing of OpenCloud yet', () => {
    const { server, drive } = setup();
    drive.attachFromDrive(() => {});
    expect(drive.request()?.kind).toBe('pick');
    expect(server.requests).toEqual([]);
  });

  it('fetches the chosen files, hands them over as Files, closes, and remembers the folder', async () => {
    const { server, drive } = setup();
    const folder = server.mkdir(['Reports']);
    const a = server.put(['Reports', 'q3.pdf'], new Blob(['pdf!'], { type: 'application/pdf' }));
    const b = server.put(['Reports', 'empty.txt'], new Blob([]));
    const deliver = vi.fn<(files: File[]) => void>();
    const trail: Trail = [{ name: 'Drive' }, { id: folder, name: 'Reports' }];
    drive.attachFromDrive(deliver);
    expect(await drive.choose(trail, [item(a, 'q3.pdf'), item(b, 'empty.txt')])).toBe(true);
    const files = deliver.mock.calls[0]![0];
    expect(files.map((f) => ({ name: f.name, type: f.type, size: f.size }))).toEqual([
      { name: 'q3.pdf', type: 'application/pdf', size: 4 },
      { name: 'empty.txt', type: 'application/octet-stream', size: 0 },
    ]);
    expect(files[0]).toBeInstanceOf(File);
    expect(drive.request()).toBeNull();
    expect(drive.lastTrail()).toEqual(trail);
  });

  it('says so when a file has gone since the folder was listed, attaches nothing and stays open', async () => {
    const { server, toast, drive } = setup();
    const a = server.put(['a.txt'], blob('a'));
    const deliver = vi.fn();
    drive.attachFromDrive(deliver);
    server.remove(['a.txt']);
    expect(await drive.choose(TOP, [item(a, 'a.txt')])).toBe(false);
    expect(toast).toHaveBeenCalledWith('That file is no longer in Drive.', 'error');
    expect(deliver).not.toHaveBeenCalled();
    expect(drive.request()?.kind).toBe('pick');
  });

  it('attaches none when one of several cannot be fetched', async () => {
    const { server, drive } = setup();
    const a = server.put(['a.txt'], blob('a'));
    const deliver = vi.fn();
    drive.attachFromDrive(deliver);
    expect(await drive.choose(TOP, [item(a, 'a.txt'), item('gone', 'b.txt')])).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('says Drive is unavailable when it is', async () => {
    const { server, toast, drive } = setup();
    const a = server.put(['a.txt'], blob('a'));
    drive.attachFromDrive(() => {});
    server.down = true;
    expect(await drive.choose(TOP, [item(a, 'a.txt')])).toBe(false);
    expect(toast).toHaveBeenCalledWith("Drive isn't available right now.", 'error');
  });

  it('does nothing with no files chosen, and keeps saving and picking apart', async () => {
    const { server, drive } = setup();
    const a = server.put(['a.txt'], blob('a'));
    const deliver = vi.fn();
    drive.attachFromDrive(deliver);
    expect(await drive.choose(TOP, [])).toBe(false);
    // A pick request is not a save…
    expect(await drive.confirm(TOP)).toBe(false);
    expect(drive.request()?.kind).toBe('pick');
    drive.cancel();
    // …and a save request is not a pick.
    drive.saveToDrive([file('x.txt')]);
    expect(await drive.choose(TOP, [item(a, 'a.txt')])).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(server.names([])).toEqual(['a.txt']);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/app/drive.test.ts`
Expected: the six new tests and the `driveMessage` test fail (`drive.attachFromDrive is not a function`; a wrong message); the rest pass.

- [ ] **Step 3: Implement**

Replace `src/app/drive.ts` with:

```ts
import { createSignal } from 'solid-js';
import { DriveError, type DriveClient, type DriveItem } from '../drive/client';
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
export function createDrive(deps: { client: DriveClient; toast: ToastFn }) {
  const { client, toast } = deps;
  const [config, setConfig] = createSignal<DriveConfig>(NO_DRIVE);
  const [request, setRequest] = createSignal<DriveRequest | null>(null);
  let last: Trail = [{ name: 'Drive' }];

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
    const path = trail.slice(1).map((c) => c.name);
    try {
      const files: File[] = [];
      for (const item of items) {
        const bytes = await client.download([...path, item.name]);
        files.push(new File([bytes], item.name, { type: bytes.type || 'application/octet-stream' }));
      }
      last = trail;
      setRequest(null);
      // What happens to them next (the composer's upload) reports its own failures.
      void req.deliver(files);
      return true;
    } catch (e) {
      toast(driveMessage(e, 'attach'), 'error');
      return false;
    }
  };

  return {
    client,
    /** Whether this installation has a Drive at all. Nothing is asked of it until it is used. */
    offered: () => config().enabled,
    setConfig,
    /** What the picker is open for, or null. */
    request,
    /** Open the picker to choose a folder for these files. */
    saveToDrive: (files: SaveFile[]) => {
      if (files.length) setRequest({ kind: 'save', files, saved: new Set() });
    },
    /** Open the picker to choose files; `deliver` gets them once fetched. */
    attachFromDrive: (deliver: PickRequest['deliver']) => setRequest({ kind: 'pick', deliver }),
    cancel: () => setRequest(null),
    /** Where the picker opens: the folder last used in this tab, or the top. */
    lastTrail: (): Trail => last,
    confirm,
    choose,
  };
}

export type Drive = ReturnType<typeof createDrive>;
```

In `src/ui/DrivePicker.tsx`, change the one line that reads the request, so the project typechecks until Task 4 replaces the file:

```tsx
      {(req) => <Picker count={req.kind === 'save' ? req.files.length : 1} />}
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test src/app/drive.test.ts src/ui/DrivePicker.test.tsx && pnpm typecheck`
Expected: all pass (26 in `drive.test.ts`, 15 in `DrivePicker.test.tsx`); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/drive.ts src/app/drive.test.ts src/ui/DrivePicker.tsx
git commit -m "Drive: choosing files to attach, fetched all or none"
```

---

### Task 3: One menu button for the chip and the paperclip

**Files:**
- Create: `src/ui/Menu.tsx`
- Replace: `src/ui/Attachments.tsx`
- Modify: `src/ui/styles.css`
- Test: `src/ui/Menu.test.tsx`

**Interfaces:**
- Consumes: `menuKeys(items, close)` from `src/ui/menu.ts`; `Popover` from `@rozie-ui/popover-solid`.
- Produces:
  ```ts
  export interface MenuItem { label: string; run: () => void }
  export function MenuButton(props: {
    class: string;                       // the button's class
    title: string;                       // the button's title (its name, for an icon-only button)
    menuLabel: string;                   // aria-label of the menu
    items: MenuItem[];
    placement?: 'bottom-start' | 'top-start';   // default 'bottom-start'
    children: JSX.Element;               // the button's content
  }): JSX.Element;
  ```
  The wrapper element has class `menu-anchor`, which is what gives the popover the theme's colours.

- [ ] **Step 1: Write the failing test**

Create `src/ui/Menu.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton } from './Menu';

function setup() {
  const first = vi.fn();
  const second = vi.fn();
  render(() => (
    <MenuButton class="icon-btn" title="Attach files" menuLabel="Attach files" items={[{ label: 'From this computer', run: first }, { label: 'From Drive', run: second }]}>
      <span>clip</span>
    </MenuButton>
  ));
  return { first, second, button: screen.getByRole('button', { name: 'Attach files' }) };
}

describe('MenuButton', () => {
  it('is a button that says it has a menu, closed to begin with', () => {
    const { button } = setup();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.closest('.menu-anchor')).not.toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens with the focus on the first item and moves with the arrows', async () => {
    const { button } = setup();
    fireEvent.click(button);
    const [one, two] = await screen.findAllByRole('menuitem');
    expect(screen.getByRole('menu', { name: 'Attach files' })).toBeInTheDocument();
    await vi.waitFor(() => expect(one).toHaveFocus());
    fireEvent.keyDown(one!, { key: 'ArrowDown' });
    expect(two).toHaveFocus();
    fireEvent.keyDown(two!, { key: 'ArrowDown' });
    expect(one).toHaveFocus();
  });

  it('runs the chosen item once and closes with the focus back on the button', async () => {
    const { button, first, second } = setup();
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'From Drive' }));
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });

  it('closes on Escape without running anything', async () => {
    const { button, first, second } = setup();
    fireEvent.click(button);
    const [one] = await screen.findAllByRole('menuitem');
    fireEvent.keyDown(one!, { key: 'Escape' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm test src/ui/Menu.test.tsx`
Expected: FAIL, cannot resolve `./Menu`.

- [ ] **Step 3: Implement**

Create `src/ui/Menu.tsx`:

```tsx
import { Popover } from '@rozie-ui/popover-solid';
import { createEffect, createSignal, For, on, type JSX } from 'solid-js';
import { menuKeys } from './menu';

export interface MenuItem {
  label: string;
  run: () => void;
}

/**
 * A button that opens a short menu under (or over) itself. The wrapper's class gives the popover
 * the theme's colours (styles.css, `.menu-anchor`); without it the popover is rozie's white.
 */
export function MenuButton(props: {
  class: string;
  /** The button's title: its name too, when it shows only an icon. */
  title: string;
  menuLabel: string;
  items: MenuItem[];
  placement?: 'bottom-start' | 'top-start';
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  createEffect(on(open, (isOpen) => {
    if (isOpen) queueMicrotask(() => items()[0]?.focus({ preventScroll: true }));
  }, { defer: true }));

  /** Close with the focus back on the button: Escape stays there, Tab moves on from there. */
  const close = () => {
    setOpen(false);
    button?.focus();
  };

  return (
    <span class="menu-anchor">
      <Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="manual"
        placement={props.placement ?? 'bottom-start'}
        strategy="fixed"
        offset={4}
        anchorSlot={() => (
          <button ref={button} type="button" class={props.class} title={props.title} aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
            {props.children}
          </button>
        )}
      >
        <div class="menu" role="menu" aria-label={props.menuLabel} ref={menu} onKeyDown={menuKeys(items, close)}>
          <For each={props.items}>
            {(item) => (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  item.run();
                }}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Popover>
    </span>
  );
}
```

Replace `src/ui/Attachments.tsx` with:

```tsx
import { For, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { EmailBodyPart } from '../jmap/types';
import { fileSize } from '../mail/format';
import type { EmailRec } from '../sync/engine';
import { Icon } from './icons';
import { MenuButton } from './Menu';

/** A message's attachments as chips. With a Drive, a chip offers a choice; without, it downloads. */
export function Attachments(props: { email: EmailRec }) {
  const { engine, toast, drive } = useApp();
  // Inline images referenced by the HTML body aren't listed as attachments.
  const list = () => (props.email.attachments ?? []).filter((a) => !(a.disposition === 'inline' && a.cid && a.type.startsWith('image/')));
  const nameOf = (a: EmailBodyPart) => a.name ?? 'attachment';
  const bytes = (a: EmailBodyPart) => engine.fetchBlob(a.blobId!, nameOf(a), a.type);

  const download = async (a: EmailBodyPart) => {
    try {
      const url = URL.createObjectURL(await bytes(a));
      const link = document.createElement('a');
      link.href = url;
      link.download = nameOf(a);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast(`Download failed: ${String(e)}`, 'error');
    }
  };
  /** The bytes are fetched when the save runs, not now: the user may yet cancel. */
  const toDrive = (parts: EmailBodyPart[]) => drive.saveToDrive(parts.map((a) => ({ name: nameOf(a), fetch: () => bytes(a) })));

  const face = (a: EmailBodyPart) => (
    <>
      <Icon name="file" style={{ width: '20px', height: '20px', flex: 'none' }} />
      <span>{nameOf(a)}</span>
      <small>{fileSize(a.size)}</small>
    </>
  );

  return (
    <Show when={list().length}>
      <div class="attachments">
        <For each={list()}>
          {(a) => (
            <Show
              when={drive.offered()}
              fallback={
                <button type="button" class="attachment" onClick={() => void download(a)} title={a.name ?? ''}>
                  {face(a)}
                </button>
              }
            >
              <MenuButton
                class="attachment"
                title={nameOf(a)}
                menuLabel={`Options for ${nameOf(a)}`}
                items={[
                  { label: 'Download', run: () => void download(a) },
                  { label: 'Save to Drive', run: () => toDrive([a]) },
                ]}
              >
                {face(a)}
              </MenuButton>
            </Show>
          )}
        </For>
        <Show when={drive.offered() && list().length > 1}>
          <button type="button" class="attachment attachment-all" onClick={() => toDrive(list())}>
            Save all to Drive
          </button>
        </Show>
      </div>
    </Show>
  );
}
```

In `src/ui/styles.css`, rename the class in the two rules slice 1 added (`.nav-menu, .attachment-menu {` and `.attachment-menu { display: inline-flex; max-width: 100%; }`) from `.attachment-menu` to `.menu-anchor`.

- [ ] **Step 4: Run to see it pass, with the chips' own tests**

Run: `pnpm test src/ui/Menu.test.tsx src/ui/Attachments.test.tsx src/ui/LabelMenu.test.tsx && pnpm typecheck`
Expected: 4 + 6 + 5 passed; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Menu.tsx src/ui/Menu.test.tsx src/ui/Attachments.tsx src/ui/styles.css
git commit -m "Drive: one menu button, for the attachment chip now and the paperclip next"
```

---

### Task 4: The picker's file mode

**Files:**
- Replace: `src/ui/DrivePicker.tsx`
- Modify: `src/ui/styles.css` (append)
- Test: `src/ui/DrivePicker.test.tsx` (append)

**Interfaces:**
- Consumes: `drive.request()` of kind `'save'` or `'pick'`, `drive.choose(trail, items)` (Task 2).
- Produces: `DrivePicker` unchanged in name and mounting. In file mode a file is a checkbox whose label holds its name and size; folders are the same buttons as before.

Behaviour in file mode, beyond what the picker already does:
- Title `Attach from Drive`. No `New folder`. The primary button is `Attach`, or `Attach 2 files` with several ticked, disabled until one is ticked.
- Ticks belong to the folder on screen: opening another folder, or going up, clears them.
- The arrow keys move through folders and files alike; Space ticks a file (the checkbox's own behaviour).

- [ ] **Step 1: Write the failing tests**

In `src/ui/DrivePicker.test.tsx`, change `setup`'s return to also offer a way to open in file mode: replace `return { server, drive, toast, open };` with:

```tsx
  const deliver = vi.fn<(files: File[]) => void>();
  const pick = () => drive.attachFromDrive(deliver);
  return { server, drive, toast, open, pick, deliver };
```

and append a new block at the end of the file:

```tsx
describe('DrivePicker, choosing files', () => {
  const arrange = (s: FakeDrive) => {
    s.mkdir(['Reports']);
    s.put(['Reports', 'q3.pdf'], blob('pdf!'));
    s.put(['budget.csv'], blob('1,2'));
    s.put(['notes.txt'], blob('hello'));
  };
  const box = (name: RegExp) => screen.findByRole('checkbox', { name });

  it('offers files as checkboxes, with Attach and no New folder', async () => {
    const { pick } = setup(arrange);
    pick();
    expect(await screen.findByRole('heading', { name: 'Attach from Drive' })).toBeInTheDocument();
    expect(await box(/budget\.csv/)).not.toBeChecked();
    expect(await folderRow('Reports')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save here' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
  });

  it('counts the ticked files on its button', async () => {
    const { pick } = setup(arrange);
    pick();
    fireEvent.click(await box(/budget\.csv/));
    expect(screen.getByRole('button', { name: 'Attach' })).toBeEnabled();
    fireEvent.click(await box(/notes\.txt/));
    expect(screen.getByRole('button', { name: 'Attach 2 files' })).toBeEnabled();
    fireEvent.click(await box(/notes\.txt/));
    expect(screen.getByRole('button', { name: 'Attach' })).toBeEnabled();
  });

  it('hands over the ticked files and closes', async () => {
    const { pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await box(/budget\.csv/));
    fireEvent.click(await box(/notes\.txt/));
    fireEvent.click(screen.getByRole('button', { name: 'Attach 2 files' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deliver.mock.calls[0]![0].map((f) => f.name)).toEqual(['budget.csv', 'notes.txt']);
  });

  it('attaches a file from inside a folder', async () => {
    const { pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await folderRow('Reports'));
    fireEvent.click(await box(/q3\.pdf/));
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(deliver.mock.calls[0]![0].map((f) => `${f.name}:${f.size}`)).toEqual(['q3.pdf:4']);
  });

  it('forgets the ticks when another folder is opened', async () => {
    const { pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await box(/budget\.csv/));
    fireEvent.click(await folderRow('Reports'));
    await box(/q3\.pdf/);
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole('button'));
    expect(await box(/budget\.csv/)).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeDisabled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('hands the files over once however often Attach is pressed', async () => {
    const { pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await box(/notes\.txt/));
    const attach = screen.getByRole('button', { name: 'Attach' });
    fireEvent.click(attach);
    fireEvent.click(attach);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('stays open with a message when a ticked file has gone', async () => {
    const { server, toast, pick, deliver } = setup(arrange);
    pick();
    fireEvent.click(await box(/notes\.txt/));
    server.remove(['notes.txt']);
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('That file is no longer in Drive.', 'error'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(deliver).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeEnabled();
  });

  it('moves through folders and files with the arrow keys', async () => {
    const { pick } = setup(arrange);
    pick();
    const reports = await folderRow('Reports');
    const budget = await box(/budget\.csv/);
    const notes = await box(/notes\.txt/);
    await waitFor(() => expect(reports).toHaveFocus());
    fireEvent.keyDown(reports, { key: 'ArrowDown' });
    expect(budget).toHaveFocus();
    fireEvent.keyDown(budget, { key: 'End' });
    expect(notes).toHaveFocus();
    fireEvent.keyDown(notes, { key: 'ArrowDown' });
    expect(reports).toHaveFocus();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm test src/ui/DrivePicker.test.tsx`
Expected: the 8 new tests fail (no heading `Attach from Drive`, no checkboxes); the 15 older ones pass.

- [ ] **Step 3: Implement**

Replace `src/ui/DrivePicker.tsx` with:

```tsx
import { Dialog } from '@rozie-ui/dialog-solid';
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import { useApp } from '../app/context';
import { driveMessage, type Trail } from '../app/drive';
import { DriveError, type DriveItem } from '../drive/client';
import { fileSize } from '../mail/format';
import { Icon } from './icons';

/**
 * The Drive picker. Open while the app has a request waiting: a folder to save files into, or
 * files to attach.
 */
export function DrivePicker() {
  const { drive } = useApp();
  return (
    <Show when={drive.request()} keyed>
      {(req) => <Picker mode={req.kind} count={req.kind === 'save' ? req.files.length : 0} />}
    </Show>
  );
}

function Picker(props: { mode: 'save' | 'pick'; count: number }) {
  const { drive } = useApp();
  const picking = props.mode === 'pick';
  const [trail, setTrail] = createSignal<Trail>(drive.lastTrail());
  /** null while the folder is being listed. */
  const [items, setItems] = createSignal<DriveItem[] | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [naming, setNaming] = createSignal(false);
  const [nameError, setNameError] = createSignal('');
  const [rootName, setRootName] = createSignal(trail()[0]!.name);
  /** Ids of the files ticked in the folder on screen. */
  const [ticked, setTicked] = createSignal<ReadonlySet<string>>(new Set());
  let box: HTMLDivElement | undefined;
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
    // Ticks belong to the folder they were made in.
    setTicked(new Set<string>());
    try {
      const found = await drive.client.children(here().id);
      if (mine !== asked) return;
      setItems([...found].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)));
      // The row that was opened is gone with its folder: put the focus in the new listing, on its first
      // row or, with none, on the list itself, so the arrows and Backspace keep working.
      queueMicrotask(() => (box?.querySelector<HTMLElement>('[data-row]') ?? box)?.focus({ preventScroll: true }));
    } catch (e) {
      if (mine !== asked) return;
      // The folder remembered from last time has gone: start again from the top.
      if (e instanceof DriveError && e.kind === 'missing' && trail().length > 1) return void setTrail([trail()[0]!]);
      setError(driveMessage(e, picking ? 'attach' : 'save'));
    }
  };
  createEffect(on(trail, () => void load()));
  void drive.client.drive().then((d) => setRootName(d.name), () => {});

  const enter = (item: DriveItem) => setTrail([...trail(), { id: item.id, name: item.name }]);
  const up = () => trail().length > 1 && setTrail(trail().slice(0, -1));
  const ready = () => items() !== null && !busy();
  const chosen = () => (items() ?? []).filter((i) => ticked().has(i.id));
  const toggle = (id: string) => {
    const next = new Set(ticked());
    if (!next.delete(id)) next.add(id);
    setTicked(next);
  };

  const onListKey = (e: KeyboardEvent) => {
    const rows = [...(box?.querySelectorAll<HTMLElement>('[data-row]') ?? [])];
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

  /** Run the request's own action; on success the app drops the request and this dialog goes with it. */
  const act = async (run: () => Promise<boolean>) => {
    if (!ready()) return;
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };
  const save = () => act(() => drive.confirm(trail()));
  const attach = () => (chosen().length ? act(() => drive.choose(trail(), chosen())) : undefined);

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

  const title = () => (picking ? 'Attach from Drive' : props.count === 1 ? 'Save to Drive' : `Save ${props.count} files to Drive`);

  const row = (item: DriveItem): JSX.Element => {
    if (item.folder) {
      return (
        <button type="button" data-row data-folder aria-label={`Open ${item.name}`} onClick={() => enter(item)}>
          <Icon name="label" />
          <span>{item.name}</span>
        </button>
      );
    }
    const face = (
      <>
        <Icon name="file" />
        <span>{item.name}</span>
        <small>{fileSize(item.size)}</small>
      </>
    );
    // Saving, a file only shows what the folder holds. Attaching, it is what is chosen.
    if (!picking) return <span class="drive-file">{face}</span>;
    return (
      <label class="drive-file drive-pick">
        <input type="checkbox" data-row checked={ticked().has(item.id)} onChange={() => toggle(item.id)} />
        {face}
      </label>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy() && drive.cancel()} ariaLabelledby="drive-picker-title">
      <div class="drive-picker">
        <h2 id="drive-picker-title">{title()}</h2>
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
        <div class="drive-list" ref={box} tabindex={-1} onKeyDown={onListKey}>
          <Show when={!error()} fallback={
            <div class="drive-note" role="alert">
              <span>{error()}</span>
              <button type="button" onClick={() => void load()}>Try again</button>
            </div>
          }>
            <Show when={items()} fallback={<div class="drive-note" role="status">Loading…</div>}>
              {(found) => (
                <Show when={found().length} fallback={<div class="drive-note">This folder is empty.</div>}>
                  <ul aria-label={label(trail().length - 1)}>
                    <For each={found()}>{(item) => <li>{row(item)}</li>}</For>
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
            <Show when={!picking}>
              <button type="button" class="drive-add" disabled={!ready()} onClick={() => setNaming(true)}>
                <Icon name="add" /> New folder
              </button>
            </Show>
            <button type="button" disabled={busy()} onClick={() => drive.cancel()}>Cancel</button>
            <Show when={picking} fallback={
              <button type="button" class="primary" disabled={!ready()} onClick={() => void save()}>
                {busy() ? 'Saving…' : 'Save here'}
              </button>
            }>
              <button type="button" class="primary" disabled={!ready() || !chosen().length} onClick={() => void attach()}>
                {busy() ? 'Attaching…' : chosen().length > 1 ? `Attach ${chosen().length} files` : 'Attach'}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}
```

Append to `src/ui/styles.css`:

```css
/* Drive picker, choosing files: a file is a row you can tick, not a greyed fact. */
.drive-pick { color: var(--text); cursor: pointer; }
.drive-pick:hover, .drive-pick:focus-within { background: var(--hover); }
.drive-pick input { flex: none; width: 16px; height: 16px; margin: 0 2px 0 1px; accent-color: var(--accent); }
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm test src/ui/DrivePicker.test.tsx && pnpm typecheck`
Expected: 23 passed; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/DrivePicker.tsx src/ui/DrivePicker.test.tsx src/ui/styles.css
git commit -m "Drive: the picker can choose files, several at once, a folder at a time"
```

---

### Task 5: The paperclip, end to end, and the documentation

**Files:**
- Modify: `src/ui/ComposerView.tsx` (the paperclip, around line 221), `e2e/drive.spec.ts` (append), `docs/operating.md`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `MenuButton` (Task 3); `drive.offered()`, `drive.attachFromDrive(deliver)` (Task 2); the composer's `c.attach(files: FileList | File[]): Promise<void>`; e2e helpers `composeNew`, `sendAndWait`, `deliveredCopy`, `emailDetails`, `destroyBySubject` (`e2e/support/compose.ts`), `driveFetch`, `driveId`, `driveOn`, `driveToken`, `removeFromDrive`, `waitForDrive` (`e2e/support/drive.ts`), `mailboxByRole`, `BOB` (`e2e/support/mail.ts`).

- [ ] **Step 1: Write the end-to-end tests**

In `e2e/drive.spec.ts`, extend the imports:

```ts
import { composeNew, deliveredCopy, destroyBySubject, emailDetails, inlineImageMail, sendAndWait, toast } from './support/compose';
import { driveChildren, driveFetch, driveId, driveOn, driveToken, removeFromDrive, waitForDrive } from './support/drive';
import { BOB, deliverToAlice, destroyEmails, mailboxByRole, uniqueTag, type EmailInfo } from './support/mail';
```

(replacing the three existing import lines from those modules) and append:

```ts
const paperclip = (c: Locator) => c.getByRole('button', { name: 'Attach files' });

test('a file is attached from Drive, sent, and arrives intact', async ({ page }) => {
  test.skip(!(await driveOn()), 'needs the stack started with docker-compose.drive.yml');
  test.setTimeout(240_000);
  const subject = `Drive attach ${uniqueTag()}`;
  const name = `${uniqueTag('e2e-drive')}.txt`;
  const content = `from drive ${uniqueTag()}\n`;
  await openInbox(page);
  const token = await driveToken(page);
  await waitForDrive(token);
  const put = await driveFetch(token, `/dav/spaces/${encodeURIComponent(await driveId(token))}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content });
  expect(put.status).toBe(201);
  try {
    const c = await composeNew(page, { to: BOB, subject, body: 'From my Drive.' });
    await paperclip(c).click();
    await page.getByRole('menuitem', { name: 'From Drive' }).click();
    const picker = page.getByRole('dialog');
    await expect(picker.getByRole('heading', { name: 'Attach from Drive' })).toBeVisible();
    await picker.getByRole('checkbox', { name: new RegExp(name.replace(/[.]/g, '\\.')) }).check();
    await picker.getByRole('button', { name: 'Attach', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(c.locator('.compose-attachments .attachment', { hasText: name })).toBeVisible();
    await expect(c.locator('.compose-attachments')).not.toContainText('Uploading');
    await sendAndWait(page, c);

    const received = await deliveredCopy(subject, BOB, await mailboxByRole('inbox', BOB));
    const { attachments } = await emailDetails(received.id, BOB);
    expect(attachments.map((a) => ({ name: a.name, size: a.size }))).toEqual([{ name, size: Buffer.byteLength(content) }]);
  } finally {
    await removeFromDrive(token, [name]);
    await destroyBySubject(subject);
  }
});

test('with a Drive the paperclip offers both sources, and "From this computer" attaches as before', async ({ page }) => {
  await page.route('**/drive.json', (route) => route.fulfill({ json: { enabled: true, linkOverMb: 20 } }));
  const subject = `Drive paperclip ${uniqueTag()}`;
  await openInbox(page);
  try {
    const c = await composeNew(page, { to: BOB, subject, body: 'A file from here.' });
    await expect(paperclip(c)).toHaveAttribute('aria-haspopup', 'menu');
    await paperclip(c).click();
    await expect(page.getByRole('menuitem')).toHaveText(['From this computer', 'From Drive']);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'From this computer' }).click();
    await (await chooser).setFiles({ name: 'local.txt', mimeType: 'text/plain', buffer: Buffer.from('local') });
    await expect(c.locator('.compose-attachments .attachment', { hasText: 'local.txt' })).toBeVisible();
  } finally {
    await destroyBySubject(subject);
  }
});

test('without a Drive the paperclip opens the file chooser directly', async ({ page }) => {
  await page.route('**/drive.json', (route) => route.fulfill({ json: { enabled: false, linkOverMb: 20 } }));
  const subject = `Drive paperclip ${uniqueTag()}`;
  await openInbox(page);
  try {
    const c = await composeNew(page, { to: BOB, subject, body: 'No Drive here.' });
    await expect(paperclip(c)).not.toHaveAttribute('aria-haspopup', 'menu');
    const chooser = page.waitForEvent('filechooser');
    await paperclip(c).click();
    await chooser;
    await expect(page.getByRole('menu')).toHaveCount(0);
  } finally {
    await destroyBySubject(subject);
  }
});
```

and add `type Locator` to the `@playwright/test` import at the top of the file.

- [ ] **Step 2: Run to see the two that need no OpenCloud fail**

Run: `pnpm build && pnpm e2e e2e/drive.spec.ts -g "paperclip"`
Expected: "with a Drive the paperclip offers both sources…" FAILS (the paperclip has no `aria-haspopup`); "without a Drive…" passes already, which is right: it pins behaviour that must not change.

- [ ] **Step 3: Implement the paperclip**

In `src/ui/ComposerView.tsx`:

1. Add `import { MenuButton } from './Menu';` and change `const { composers } = useApp();` to `const { composers, drive } = useApp();`.
2. Replace the paperclip button

```tsx
        <button type="button" class="icon-btn" title="Attach files" onClick={() => fileInput?.click()}>
          <Icon name="clip" />
        </button>
```

with

```tsx
        <Show
          when={drive.offered()}
          fallback={
            <button type="button" class="icon-btn" title="Attach files" onClick={() => fileInput?.click()}>
              <Icon name="clip" />
            </button>
          }
        >
          {/* The actions sit at the bottom of the composer: the menu opens upwards. */}
          <MenuButton
            class="icon-btn"
            title="Attach files"
            menuLabel="Attach files"
            placement="top-start"
            items={[
              { label: 'From this computer', run: () => fileInput?.click() },
              // A file from Drive is attached like one from disk: the composer uploads it and reports on it.
              { label: 'From Drive', run: () => drive.attachFromDrive((files) => c.attach(files)) },
            ]}
          >
            <Icon name="clip" />
          </MenuButton>
        </Show>
```

- [ ] **Step 4: Run everything**

Run:
```sh
pnpm test && pnpm typecheck && pnpm build
(cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml -f docker-compose.drive.yml up -d)
pnpm e2e e2e/drive.spec.ts e2e/drive-stack.spec.ts e2e/compose.spec.ts
```
Expected: unit tests all pass; in the e2e run every Drive test passes with one skipped (the "with no OpenCloud" route test), and `compose.spec.ts` passes unchanged (its file test sets the hidden input directly, and the dev stack's own `/drive.json` now says Drive is on, so this also shows the composer works with the menu in place).

Then look at it: open `http://localhost:8080`, compose, use the paperclip in both themes, attach from Drive.

- [ ] **Step 5: Write the documentation**

In `docs/operating.md`, in the "Drive" section, replace the sentence that begins "In this version that means one thing:" with:

```markdown
In this version that means two things: an attachment can be saved into a Drive folder from the message it came in, and files can be attached to a message straight from Drive.
```

In `README.md`, replace the Drive line of "What it does" with:

```markdown
- **Drive**: where an [OpenCloud](https://opencloud.eu) runs beside Stalwart, save a message's attachments into a Drive folder and attach files from Drive when writing, with no second sign-in.
```

In `CHANGELOG.md`, replace the "Unreleased" Drive entry with:

```markdown
- Drive: where an OpenCloud runs beside Stalwart, an attachment can be saved into one of its folders from the message, and files can be attached from it when writing, with no second sign-in. Operators turn it on with `OINBOX_DRIVE_UPSTREAM` (docs/operating.md, "Drive"). Tested against OpenCloud 7.2.4 and 8.1.0.
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/ComposerView.tsx e2e/drive.spec.ts docs/operating.md README.md CHANGELOG.md
git commit -m "Drive: attach files from Drive when writing a message"
```
