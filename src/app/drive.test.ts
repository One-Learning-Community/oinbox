import { describe, expect, it, vi } from 'vitest';
import { DriveError, type DriveItem } from '../drive/client';
import { FakeDrive } from '../drive/fake';
import { createDrive, driveMessage, freeName, safeName, type SaveFile, type Trail } from './drive';

const blob = (text: string) => new Blob([text], { type: 'text/plain' });
const file = (name: string, text = name): SaveFile => ({ name, fetch: async () => blob(text) });
const TOP: Trail = [{ name: 'Drive' }];

const setup = () => {
  const server = new FakeDrive();
  const toast = vi.fn();
  const drive = createDrive({ client: server.client(), toast });
  drive.setConfig({ enabled: true, linkOverMb: 20 });
  return { server, toast, drive };
};

describe('safeName', () => {
  it('keeps an ordinary name', () => {
    expect(safeName('Q3 report (final).pdf')).toBe('Q3 report (final).pdf');
  });
  it('takes the slashes and control characters out of a name', () => {
    expect(safeName('a/b\\c\u0000d.txt')).toBe('a_b_c_d.txt');
  });
  it('calls a nameless or dot-only attachment "attachment"', () => {
    for (const name of [null, undefined, '', '   ', '.', '..']) expect(safeName(name)).toBe('attachment');
  });
});

describe('freeName', () => {
  it('keeps a name nobody has', () => {
    expect(freeName('notes.txt', new Set(['other.txt']))).toBe('notes.txt');
  });
  it('numbers a taken name before its extension', () => {
    expect(freeName('notes.txt', new Set(['notes.txt']))).toBe('notes (1).txt');
    expect(freeName('notes.txt', new Set(['notes.txt', 'notes (1).txt']))).toBe('notes (2).txt');
  });
  it('compares without regard to case', () => {
    expect(freeName('Notes.TXT', new Set(['notes.txt']))).toBe('Notes (1).TXT');
  });
  it('numbers a name with no extension, and a dotfile, at the end', () => {
    expect(freeName('README', new Set(['readme']))).toBe('README (1)');
    expect(freeName('.env', new Set(['.env']))).toBe('.env (1)');
  });
});

describe('driveMessage', () => {
  it('has a plain sentence for each kind of failure', () => {
    expect(driveMessage(new DriveError('unavailable', 503, 'x'))).toBe("Drive isn't available right now.");
    expect(driveMessage(new DriveError('refused', 401, 'x'))).toBe("Drive isn't available right now.");
    expect(driveMessage(new DriveError('missing', 409, 'x'))).toBe('That folder is no longer in Drive.');
    expect(driveMessage(new DriveError('tooLarge', 507, 'x'))).toBe('Not enough space in Drive.');
    expect(driveMessage(new DriveError('other', 500, 'Uploading: HTTP 500'))).toBe("Couldn't save to Drive: Uploading: HTTP 500");
    expect(driveMessage(new Error('blob gone'))).toBe("Couldn't save to Drive: blob gone");
    expect(driveMessage(new DriveError('missing', 404, 'x'), 'attach')).toBe('That file is no longer in Drive.');
    expect(driveMessage(new DriveError('unavailable', 0, 'x'), 'attach')).toBe("Drive isn't available right now.");
    expect(driveMessage(new DriveError('other', 425, 'Downloading: HTTP 425'), 'attach')).toBe("Couldn't attach from Drive: Downloading: HTTP 425");
  });
});

describe('createDrive', () => {
  it('is not offered until the configuration says so', () => {
    const drive = createDrive({ client: new FakeDrive().client(), toast: vi.fn() });
    expect(drive.offered()).toBe(false);
    drive.setConfig({ enabled: true, linkOverMb: 20 });
    expect(drive.offered()).toBe(true);
  });

  it('asks nothing of OpenCloud until a folder is confirmed', () => {
    const { server, drive } = setup();
    drive.saveToDrive([file('notes.txt')]);
    const req = drive.request();
    expect(req?.kind === 'save' && req.files.length).toBe(1);
    expect(server.requests).toEqual([]);
  });

  it('saves into the chosen folder, says where, closes, and remembers the folder', async () => {
    const { server, toast, drive } = setup();
    const id = server.mkdir(['Reports']);
    const trail: Trail = [{ name: 'Drive' }, { id, name: 'Reports' }];
    drive.saveToDrive([file('q3.pdf', 'pdf!')]);
    expect(await drive.confirm(trail)).toBe(true);
    expect(server.names(['Reports'])).toEqual(['q3.pdf']);
    expect(server.read(['Reports', 'q3.pdf'])!.size).toBe(4);
    expect(toast).toHaveBeenCalledWith('Saved to Drive: Reports', 'success');
    expect(drive.request()).toBeNull();
    expect(drive.lastTrail()).toEqual(trail);
  });

  it("names the drive when saving to its top folder, and counts several files", async () => {
    const { server, toast, drive } = setup();
    drive.saveToDrive([file('a.txt'), file('b.txt'), file('c.txt')]);
    await drive.confirm(TOP);
    expect(server.names([])).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(toast).toHaveBeenCalledWith('3 files saved to Drive: Alice Example', 'success');
  });

  it('never replaces a file: a taken name gets a number', async () => {
    const { server, drive } = setup();
    server.put(['Notes.txt'], blob('the old one'));
    drive.saveToDrive([file('notes.txt', 'new')]);
    await drive.confirm(TOP);
    expect(server.names([])).toEqual(['Notes.txt', 'notes (1).txt']);
    expect(server.read(['Notes.txt'])!.size).toBe('the old one'.length);
  });

  it('keeps two attachments of the same name apart', async () => {
    const { server, drive } = setup();
    drive.saveToDrive([file('image.png', 'one'), file('image.png', 'second')]);
    await drive.confirm(TOP);
    expect(server.names([])).toEqual(['image.png', 'image (1).png']);
    expect(server.read(['image (1).png'])!.size).toBe(6);
  });

  it('saves a nameless attachment, and one named like a path, under a sane name', async () => {
    const { server, drive } = setup();
    drive.saveToDrive([file(''), file('../../etc/passwd')]);
    await drive.confirm(TOP);
    expect(server.names([])).toEqual(['attachment', '.._.._etc_passwd']);
  });

  it('says Drive is unavailable and keeps the request open', async () => {
    const { server, toast, drive } = setup();
    server.down = true;
    drive.saveToDrive([file('a.txt')]);
    expect(await drive.confirm(TOP)).toBe(false);
    expect(toast).toHaveBeenCalledWith("Drive isn't available right now.", 'error');
    expect(drive.request()).not.toBeNull();
  });

  it('says so when the folder has gone since it was chosen', async () => {
    const { server, toast, drive } = setup();
    const id = server.mkdir(['Reports']);
    server.remove(['Reports']);
    drive.saveToDrive([file('a.txt')]);
    expect(await drive.confirm([{ name: 'Drive' }, { id, name: 'Reports' }])).toBe(false);
    expect(toast).toHaveBeenCalledWith('That folder is no longer in Drive.', 'error');
  });

  it('says how far it got when a later file fails', async () => {
    const { server, toast, drive } = setup();
    const broken: SaveFile = { name: 'b.txt', fetch: () => Promise.reject(new Error('blob gone')) };
    drive.saveToDrive([file('a.txt'), broken, file('c.txt')]);
    expect(await drive.confirm(TOP)).toBe(false);
    expect(server.names([])).toEqual(['a.txt']);
    expect(toast).toHaveBeenCalledWith("Couldn't save to Drive: blob gone 1 of 3 saved.", 'error');
  });

  it('a second try saves only what the first did not', async () => {
    const { server, toast, drive } = setup();
    let failing = true;
    const flaky: SaveFile = {
      name: 'b.txt',
      fetch: async () => {
        if (failing) throw new Error('blob gone');
        return blob('b');
      },
    };
    drive.saveToDrive([file('a.txt'), flaky, file('c.txt')]);
    expect(await drive.confirm(TOP)).toBe(false);
    failing = false;
    expect(await drive.confirm(TOP)).toBe(true);
    expect(server.names([])).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(toast).toHaveBeenLastCalledWith('3 files saved to Drive: Alice Example', 'success');
  });

  it('does nothing on confirm when nothing is waiting', async () => {
    const { server, drive } = setup();
    expect(await drive.confirm(TOP)).toBe(false);
    expect(server.requests).toEqual([]);
  });
});

describe('attaching from Drive', () => {
  const item = (id: string, name: string, size = 1): DriveItem => ({ id, name, size, folder: false, modified: '' });

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
    expect(await drive.choose(trail, [item(a, 'q3.pdf', 4), item(b, 'empty.txt', 0)])).toBe(true);
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

describe('attaching from Drive: what is refused, and stopping', () => {
  const item = (id: string, name: string, size: number): DriveItem => ({ id, name, size, folder: false, modified: '' });

  it('refuses a file the mail server would refuse, before fetching anything', async () => {
    const server = new FakeDrive();
    const toast = vi.fn();
    const drive = createDrive({ client: server.client(), toast, maxUploadBytes: () => 2048 });
    const small = server.put(['small.txt'], blob('ok'));
    const big = server.put(['video.mp4'], blob('x'.repeat(3000)));
    const deliver = vi.fn();
    drive.attachFromDrive(deliver);
    expect(await drive.choose(TOP, [item(small, 'small.txt', 2), item(big, 'video.mp4', 3000)])).toBe(false);
    expect(toast).toHaveBeenCalledWith('video.mp4 is too large to attach (the limit is 2 KB).', 'error');
    expect(server.requests.filter((r) => r.path.startsWith('/dav/'))).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    expect(drive.request()?.kind).toBe('pick');
  });

  it('attaches a file of exactly the limit, and any size when the limit is not known', async () => {
    const server = new FakeDrive();
    const a = server.put(['a.bin'], blob('x'.repeat(2048)));
    const limited = createDrive({ client: server.client(), toast: vi.fn(), maxUploadBytes: () => 2048 });
    limited.attachFromDrive(() => {});
    expect(await limited.choose(TOP, [item(a, 'a.bin', 2048)])).toBe(true);
    const unknown = createDrive({ client: server.client(), toast: vi.fn(), maxUploadBytes: () => undefined });
    unknown.attachFromDrive(() => {});
    expect(await unknown.choose(TOP, [item(a, 'a.bin', 2048)])).toBe(true);
  });

  it('can be cancelled while a file is being fetched: nothing attached, nothing said', async () => {
    const { server, toast, drive } = setup();
    const a = server.put(['a.txt'], blob('a'));
    await drive.client.drive();
    server.stall = true;
    const deliver = vi.fn();
    drive.attachFromDrive(deliver);
    const going = drive.choose(TOP, [item(a, 'a.txt', 1)]);
    setTimeout(() => drive.cancel(), 0);
    expect(await going).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(drive.request()).toBeNull();
  });

  it('does not attach bytes that are not the file that was listed', async () => {
    const { server, toast, drive } = setup();
    const a = server.put(['a.txt'], blob('now much longer than it was'));
    const deliver = vi.fn();
    drive.attachFromDrive(deliver);
    expect(await drive.choose(TOP, [item(a, 'a.txt', 3)])).toBe(false);
    expect(toast).toHaveBeenCalledWith("Couldn't attach from Drive: a.txt changed while it was being fetched. Try again.", 'error');
    expect(deliver).not.toHaveBeenCalled();
  });
});
