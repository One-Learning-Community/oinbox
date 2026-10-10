import { describe, expect, it, vi } from 'vitest';
import { FakeDrive } from '../drive/fake';
import { createDriveLinks, folderName, linkBlock, linkOffer, MB, type ComposerLike, type LinkChoice } from './driveLinks';
import { createLinkFolders } from './linkFolders';
import { createLinkPasswords } from './linkPasswords';

const NOW = new Date(2026, 9, 9, 12, 0);
const CHOICE: LinkChoice = { password: 'Corr3ct-horse!', includePassword: true, expiryDays: 30 };
const file = (name: string, bytes: number) => new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' });

function composer(opts: { subject?: string; bodyHtml?: string; attached?: number[] } = {}) {
  let draft = { subject: opts.subject ?? 'Report', bodyHtml: opts.bodyHtml ?? '<p>Hello</p>', attachments: (opts.attached ?? []).map((size) => ({ size })) };
  const attach = vi.fn(async (_files: File[]) => {});
  const c: ComposerLike = { draft: () => draft, update: (patch) => void (draft = { ...draft, ...patch }), attach };
  return { c, attach, body: () => draft.bodyHtml };
}

/** A threshold of 1000 bytes and a mail-server limit of 5000, so tests need no megabytes. */
function setup(opts: { offered?: boolean } = {}) {
  const server = new FakeDrive();
  const toast = vi.fn();
  sessionStorage.clear();
  localStorage.clear();
  const passwords = createLinkPasswords(sessionStorage, () => NOW.getTime());
  const folders = createLinkFolders(localStorage, () => NOW.getTime());
  const links = createDriveLinks({
    drive: { offered: () => opts.offered ?? true, linkOverMb: () => 1000 / MB, client: server.client() },
    toast,
    passwords,
    folders,
    maxUploadBytes: () => 5000,
    now: () => NOW,
  });
  return { server, toast, passwords, folders, links };
}
const sources = (...files: File[]) => files.map((f) => ({ name: f.name, size: f.size, file: f }));
const FOLDER = ['Mail attachments', '2026-10-09 Report'];

describe('linkOffer', () => {
  const base = { attachedBytes: 0, linkOverMb: 20, maxUploadBytes: 50 * MB };
  it('attaches what fits', () => {
    expect(linkOffer({ ...base, sizes: [5 * MB, 5 * MB] })).toBe('attach');
    expect(linkOffer({ ...base, sizes: [20 * MB] })).toBe('attach');
  });
  it('offers a link once the message would pass the threshold, counting what is attached already', () => {
    expect(linkOffer({ ...base, sizes: [20 * MB + 1] })).toBe('offer');
    expect(linkOffer({ ...base, attachedBytes: 15 * MB, sizes: [6 * MB] })).toBe('offer');
  });
  it('insists on a link for a file the mail server would refuse', () => {
    expect(linkOffer({ ...base, sizes: [1, 50 * MB + 1] })).toBe('must');
    expect(linkOffer({ ...base, maxUploadBytes: undefined, sizes: [900 * MB] })).toBe('offer');
  });
});

describe('folderName', () => {
  it('is the day and the subject', () => {
    expect(folderName('Q3 report', NOW)).toBe('2026-10-09 Q3 report');
  });
  it('has a name for a message with no subject, and takes out what a folder name cannot hold', () => {
    expect(folderName('  ', NOW)).toBe('2026-10-09 No subject');
    expect(folderName('a/b\\c\u0000d', NOW)).toBe('2026-10-09 a b c d');
  });
  it('cuts a long subject to 80 characters', () => {
    expect(folderName('x'.repeat(200), NOW)).toBe(`2026-10-09 ${'x'.repeat(80)}`);
  });
  it('never cuts a character in half, and has no half characters in it', () => {
    const name = folderName(`${'x'.repeat(79)}\ud83d\ude00 and more`, NOW);
    expect(name).toBe(`2026-10-09 ${'x'.repeat(79)}\ud83d\ude00`);
    expect(() => encodeURIComponent(name)).not.toThrow();
    expect(() => encodeURIComponent(folderName('half \ud83d of one', NOW))).not.toThrow();
  });
});

describe('linkBlock', () => {
  it('is the link alone when there is no password to give and no expiry', () => {
    expect(linkBlock({ url: 'https://files.test/s/abc' })).toBe('<p>Files for this message: <a href="https://files.test/s/abc">https://files.test/s/abc</a></p>');
  });
  it('adds the password, exactly, and the last day', () => {
    const html = linkBlock({ url: 'https://files.test/s/abc', password: 'a<b>&"c\'', expires: new Date(2026, 10, 8, 12) });
    expect(html).toContain('<br>Password: a&lt;b&gt;&amp;&quot;c\'');
    expect(html).toContain('<br>Available until 8 November 2026.');
    const shown = document.createElement('div');
    shown.innerHTML = html;
    expect(shown.textContent).toBe('Files for this message: https://files.test/s/abcPassword: a<b>&"c\'Available until 8 November 2026.');
  });
});

describe('createDriveLinks', () => {
  it('attaches what fits and asks nothing of Drive', async () => {
    const { server, links } = setup();
    const { c, attach } = composer();
    const f = file('small.txt', 400);
    await links.add(c, sources(f));
    expect(attach).toHaveBeenCalledWith([f]);
    expect(links.request()).toBeNull();
    expect(server.requests).toEqual([]);
  });

  it('without a Drive attaches large files as it always did', async () => {
    const { links } = setup({ offered: false });
    const { c, attach } = composer();
    const f = file('big.bin', 4000);
    await links.add(c, sources(f));
    expect(attach).toHaveBeenCalledWith([f]);
  });

  it('offers a link for files that pass the threshold, and attaches them if the user would rather', async () => {
    const { links } = setup();
    const { c, attach } = composer({ attached: [600] });
    const f = file('video.mp4', 700);
    const done = links.add(c, sources(f));
    expect(links.request()).toMatchObject({ bytes: 700, canAttach: true, adding: false });
    expect(links.request()!.sources.map((s) => s.name)).toEqual(['video.mp4']);
    expect(attach).not.toHaveBeenCalled();
    links.attachAnyway();
    await done;
    expect(attach).toHaveBeenCalledWith([f]);
    expect(links.request()).toBeNull();
  });

  it('does not offer to attach a file the mail server would refuse', async () => {
    const { links } = setup();
    void links.add(composer().c, sources(file('huge.iso', 6000)));
    expect(links.request()!.canAttach).toBe(false);
  });

  it("makes the message's folder, uploads the files, links it, and writes the link into the text", async () => {
    const { server, links, passwords } = setup();
    const { c, attach, body } = composer();
    const done = links.add(c, sources(file('video.mp4', 3000), file('slides.pdf', 2000)));
    expect(await links.send(CHOICE)).toBe(true);
    await done;
    expect(server.names(FOLDER)).toEqual(['video.mp4', 'slides.pdf']);
    expect(server.read([...FOLDER, 'video.mp4'])!.size).toBe(3000);
    expect(server.links).toHaveLength(1);
    expect(server.links[0]).toMatchObject({ password: 'Corr3ct-horse!', url: 'https://files.test/s/link-1' });
    expect(new Date(server.links[0]!.expires!).getTime()).toBe(NOW.getTime() + 30 * 86_400_000);
    expect(body()).toBe(
      '<p>Hello</p><p>Files for this message: <a href="https://files.test/s/link-1">https://files.test/s/link-1</a><br>Password: Corr3ct-horse!<br>Available until 8 November 2026.</p>',
    );
    expect(passwords.recall('https://files.test/s/link-1')?.password).toBe('Corr3ct-horse!');
    expect(attach).not.toHaveBeenCalled();
    expect(links.request()).toBeNull();
    expect(links.progress()).toBeNull();
  });

  it('leaves the password out of the text when it is to be sent another way, and still remembers it', async () => {
    const { links, passwords } = setup();
    const { c, body } = composer();
    void links.add(c, sources(file('video.mp4', 3000)));
    await links.send({ ...CHOICE, includePassword: false, expiryDays: null });
    expect(body()).toBe('<p>Hello</p><p>Files for this message: <a href="https://files.test/s/link-1">https://files.test/s/link-1</a></p>');
    expect(passwords.recall('https://files.test/s/link-1')?.password).toBe('Corr3ct-horse!');
  });

  it('makes a link with no password where none is required, and remembers nothing', async () => {
    const { server, links, passwords } = setup();
    server.passwordRequired = false;
    void links.add(composer().c, sources(file('video.mp4', 3000)));
    expect(await links.send({ password: '', includePassword: true, expiryDays: null })).toBe(true);
    expect(server.links[0]).toMatchObject({ password: undefined, expires: undefined });
    expect(passwords.findIn('https://files.test/s/link-1')).toEqual([]);
  });

  it('numbers the folder when a message of that day and subject has one already', async () => {
    const { server, links } = setup();
    server.mkdir(FOLDER);
    server.mkdir(['Mail attachments', '2026-10-09 report (2)']);
    void links.add(composer().c, sources(file('video.mp4', 3000)));
    await links.send(CHOICE);
    expect(server.names(['Mail attachments'])).toEqual(['2026-10-09 Report', '2026-10-09 report (2)', '2026-10-09 Report (3)']);
    expect(server.names(FOLDER)).toEqual([]);
  });

  it("shows the server's words for a password it will not have, and does not upload again on the next try", async () => {
    const { server, links } = setup();
    const { c, body } = composer();
    void links.add(c, sources(file('video.mp4', 3000)));
    expect(await links.send({ ...CHOICE, password: 'weak' })).toBe(false);
    expect(links.error()).toContain('at least 8 characters are required');
    expect(links.request()).not.toBeNull();
    expect(body()).toBe('<p>Hello</p>');
    const uploads = () => server.requests.filter((r) => r.method === 'PUT').length;
    expect(uploads()).toBe(1);
    expect(await links.send(CHOICE)).toBe(true);
    expect(uploads()).toBe(1);
    expect(links.error()).toBe('');
    expect(server.names(['Mail attachments'])).toEqual(['2026-10-09 Report']);
  });

  it('says what stopped an upload, and a retry sends only what is not there yet', async () => {
    const { server, links } = setup();
    const { c, body } = composer();
    void links.add(c, sources(file('a.bin', 3000), file('b.bin', 2000)));
    const realPut = server.transport;
    let calls = 0;
    server.transport = async (...args) => (++calls === 2 ? { status: 507, fileId: '' } : realPut(...args));
    // The client took the transport when it was made; make the links again with this one.
    const links2 = createDriveLinks({ drive: { offered: () => true, linkOverMb: () => 1000 / MB, client: server.client() }, toast: vi.fn(), passwords: createLinkPasswords(sessionStorage), maxUploadBytes: () => 5000, now: () => NOW });
    links.cancel();
    void links2.add(c, sources(file('a.bin', 3000), file('b.bin', 2000)));
    expect(await links2.send(CHOICE)).toBe(false);
    expect(links2.error()).toBe('Not enough space in Drive.');
    expect(body()).toBe('<p>Hello</p>');
    expect(await links2.send(CHOICE)).toBe(true);
    expect(server.names(FOLDER)).toEqual(['a.bin', 'b.bin']);
    expect(calls).toBe(3);
  });

  it('can be cancelled while a file is going up: no link, no folder left, nothing attached', async () => {
    const { server, links, toast } = setup();
    const { c, attach, body } = composer();
    await links.loadRules();
    const done = links.add(c, sources(file('video.mp4', 3000)));
    server.stall = true;
    const sending = links.send(CHOICE);
    await vi.waitFor(() => expect(links.progress()?.name).toBe('video.mp4'));
    links.cancel();
    expect(await sending).toBe(false);
    await done;
    server.stall = false;
    await vi.waitFor(() => expect(server.names(['Mail attachments'])).toEqual([]));
    expect(body()).toBe('<p>Hello</p>');
    expect(server.links).toEqual([]);
    expect(attach).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(links.request()).toBeNull();
  });

  it('reports which file is going up and how far it has got', async () => {
    const { server, links } = setup();
    const seen: string[] = [];
    const real = server.transport;
    server.transport = async (url, body, headers, opts) =>
      real(url, body, headers, {
        ...opts,
        onProgress: (sent, total) => {
          opts.onProgress?.(sent, total);
          const p = links2.progress()!;
          seen.push(`${p.name} ${p.index}/${p.count} ${p.fraction}`);
        },
      });
    const links2 = createDriveLinks({ drive: { offered: () => true, linkOverMb: () => 1000 / MB, client: server.client() }, toast: vi.fn(), passwords: createLinkPasswords(sessionStorage), maxUploadBytes: () => 5000, now: () => NOW });
    links.cancel();
    void links2.add(composer().c, sources(file('a.bin', 3000), file('b.bin', 2000)));
    await links2.send(CHOICE);
    expect(seen).toEqual(['a.bin 1/2 0.5', 'a.bin 1/2 1', 'b.bin 2/2 0.5', 'b.bin 2/2 1']);
  });

  it("puts later large files into the message's folder, with no second link and no password step", async () => {
    const { server, links } = setup();
    const { c, body } = composer();
    void links.add(c, sources(file('video.mp4', 3000)));
    await links.send(CHOICE);
    const before = body();
    const done = links.add(c, sources(file('more.mov', 4000)));
    expect(links.request()).toMatchObject({ adding: true });
    await done;
    expect(server.names(FOLDER)).toEqual(['video.mp4', 'more.mov']);
    expect(server.links).toHaveLength(1);
    expect(body()).toBe(before);
    expect(links.request()).toBeNull();
  });

  it('keeps two files of one name apart in the folder', async () => {
    const { server, links } = setup();
    void links.add(composer().c, sources(file('clip.mp4', 3000), file('clip.mp4', 2500)));
    await links.send(CHOICE);
    expect(server.names(FOLDER)).toEqual(['clip.mp4', 'clip (1).mp4']);
  });

  it('says Drive is unavailable when it is, and leaves the message as it was', async () => {
    const { server, links } = setup();
    const { c, body } = composer();
    void links.add(c, sources(file('video.mp4', 3000)));
    server.down = true;
    expect(await links.send(CHOICE)).toBe(false);
    expect(links.error()).toBe("Drive isn't available right now.");
    expect(body()).toBe('<p>Hello</p>');
  });

  it('makes one link however often Send is pressed', async () => {
    const { server, links } = setup();
    const { c, body } = composer();
    void links.add(c, sources(file('video.mp4', 3000)));
    const [first, second] = await Promise.all([links.send(CHOICE), links.send(CHOICE)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(server.links).toHaveLength(1);
    expect(body().match(/Files for this message/g)).toHaveLength(1);
    expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(server.names(['Mail attachments'])).toEqual(['2026-10-09 Report']);
  });

  it('cancelled straight after Send, before anything has gone up, leaves no folder and no link', async () => {
    const { server, links } = setup();
    const { c, body } = composer();
    const done = links.add(c, sources(file('video.mp4', 3000)));
    const sending = links.send(CHOICE);
    void links.send(CHOICE);
    links.cancel();
    expect(await sending).toBe(false);
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(server.names(['Mail attachments'])).toEqual([]);
    expect(server.links).toEqual([]);
    expect(body()).toBe('<p>Hello</p>');
  });

  it('removes the folder when the user attaches after all, following a failed upload', async () => {
    const { server, links } = setup();
    const { c, attach } = composer();
    const done = links.add(c, sources(file('a.bin', 600), file('b.bin', 600)));
    await links.loadRules();
    server.full = true;
    expect(await links.send(CHOICE)).toBe(false);
    expect(server.names(['Mail attachments'])).toEqual(['2026-10-09 Report']);
    links.attachAnyway();
    await done;
    expect(attach).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(server.names(['Mail attachments'])).toEqual([]));
  });

  it('keeps its folder with a message that is reopened after an undone or failed send', async () => {
    const { server, links } = setup();
    const first = composer();
    void links.add(first.c, sources(file('video.mp4', 3000)));
    await links.send(CHOICE);
    const reopened = composer({ bodyHtml: first.body() });
    links.hooks.reopened(first.c, reopened.c);
    expect(links.hooks.discardNote(reopened.c)).toBe('The files uploaded to Drive for it will be removed.');
    const more = links.add(reopened.c, sources(file('more.mov', 4000)));
    expect(links.request()).toMatchObject({ adding: true });
    await more;
    expect(server.names(FOLDER)).toEqual(['video.mp4', 'more.mov']);
    expect(server.links).toHaveLength(1);
  });

  describe('files chosen in Drive', () => {
    const ref = (name: string, size: number) => ({ path: ['Videos', name], name, size });

    it('are left to be attached when they fit', async () => {
      const { links } = setup();
      expect(await links.intercept(composer().c, [ref('small.mp4', 500)])).toBe('attach');
      expect(links.request()).toBeNull();
    });

    it('are copied into the folder by Drive itself when sent as a link', async () => {
      const { server, links } = setup();
      server.mkdir(['Videos']);
      server.put(['Videos', 'talk.mp4'], new Blob([new Uint8Array(3000)]));
      const { c, body } = composer();
      const answer = links.intercept(c, [ref('talk.mp4', 3000)]);
      expect(links.request()!.sources[0]).toMatchObject({ name: 'talk.mp4', drivePath: ['Videos', 'talk.mp4'] });
      await links.send(CHOICE);
      expect(await answer).toBe('linked');
      expect(server.names(FOLDER)).toEqual(['talk.mp4']);
      expect(server.names(['Videos'])).toEqual(['talk.mp4']);
      expect(server.requests.some((r) => r.method === 'COPY')).toBe(true);
      expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);
      expect(body()).toContain('https://files.test/s/link-1');
    });

    it('answer "attach" or "cancel" as the user decides', async () => {
      const { links } = setup();
      const one = links.intercept(composer().c, [ref('talk.mp4', 3000)]);
      links.attachAnyway();
      expect(await one).toBe('attach');
      const two = links.intercept(composer().c, [ref('talk.mp4', 3000)]);
      links.cancel();
      expect(await two).toBe('cancel');
    });
  });

  describe('when a draft is discarded', () => {
    it('has nothing to say, and removes nothing, for a message with no link', () => {
      const { server, links } = setup();
      const { c } = composer();
      expect(links.hooks.discardNote(c)).toBeNull();
      links.hooks.discarded(c);
      expect(server.requests).toEqual([]);
    });

    it("warns that the files will go, and removes that message's folder only", async () => {
      const { server, links } = setup();
      const mine = composer();
      const other = composer({ subject: 'Other' });
      void links.add(mine.c, sources(file('video.mp4', 3000)));
      await links.send(CHOICE);
      void links.add(other.c, sources(file('other.mp4', 3000)));
      await links.send(CHOICE);
      expect(links.hooks.discardNote(mine.c)).toBe('The files uploaded to Drive for it will be removed.');
      links.hooks.discarded(mine.c);
      await vi.waitFor(() => expect(server.names(['Mail attachments'])).toEqual(['2026-10-09 Other']));
      expect(links.hooks.discardNote(mine.c)).toBeNull();
    });
  });
});

describe('adding to a message that has its link', () => {
  const linked = async () => {
    const all = setup();
    const msg = composer();
    void all.links.add(msg.c, sources(file('video.mp4', 3000)));
    await all.links.send(CHOICE);
    return { ...all, ...msg };
  };

  it('cancelled part-way, takes back what it had added: nothing is left behind the link', async () => {
    const { server, links, c, toast } = await linked();
    const real = server.fetch;
    // The first of the two goes up; the second never answers.
    server.fetch = async (input, init = {}) => {
      if (init.method === 'PUT' && String(input).includes('second')) server.stall = true;
      return real(input, init);
    };
    const links2 = createDriveLinks({ drive: { offered: () => true, linkOverMb: () => 1000 / MB, client: server.client({ fetch: server.fetch, put: server.transport }) }, toast, passwords: createLinkPasswords(sessionStorage), folders: createLinkFolders(localStorage, () => NOW.getTime()), maxUploadBytes: () => 5000, now: () => NOW });
    void links;
    const done = links2.add(c, sources(file('first.mov', 3000), file('second.mov', 3000)));
    expect(links2.request()).toMatchObject({ adding: true });
    await vi.waitFor(() => expect(links2.progress()?.name).toBe('second.mov'));
    expect(server.names(FOLDER)).toEqual(['video.mp4', 'first.mov']);
    links2.cancel();
    await done;
    server.stall = false;
    await vi.waitFor(() => expect(server.names(FOLDER)).toEqual(['video.mp4']));
    expect(server.links).toHaveLength(1);
  });

  it('knows the folder of a draft that was closed and opened again, by the link in its text', async () => {
    const { server, links, body } = await linked();
    // A new composer with the saved text, as openDraft and a rescue make.
    const again = composer({ bodyHtml: body() });
    expect(links.hooks.discardNote(again.c)).toBe('The files uploaded to Drive for it will be removed.');
    const more = links.add(again.c, sources(file('more.mov', 4000)));
    expect(links.request()).toMatchObject({ adding: true });
    await more;
    expect(server.names(FOLDER)).toEqual(['video.mp4', 'more.mov']);
    expect(server.links).toHaveLength(1);
    links.hooks.discarded(again.c);
    await vi.waitFor(() => expect(server.names(['Mail attachments'])).toEqual([]));
  });

  it('claims no folder for a message without the link in its own text, nor once the message is sent', async () => {
    const { server, links, c, body } = await linked();
    expect(links.hooks.discardNote(composer().c)).toBeNull();
    links.hooks.sent(c);
    const later = composer({ bodyHtml: body() });
    expect(links.hooks.discardNote(later.c)).toBeNull();
    links.hooks.discarded(later.c);
    expect(server.names(['Mail attachments'])).toEqual(['2026-10-09 Report']);
  });

  it('puts the link back when it was taken out of the text', async () => {
    const { server, links, c, body, toast } = await linked();
    const url = server.links[0]!.url;
    c.update({ bodyHtml: '<p>Hello</p>' });
    await links.add(c, sources(file('more.mov', 4000)));
    expect(body()).toContain(`<a href="${url}">${url}</a>`);
    expect(body()).toContain('Available until 8 November 2026.');
    expect(body()).not.toContain('Password');
    expect(toast).toHaveBeenLastCalledWith("Added to this message's Drive link, and put the link back into the message.", 'success');
  });

  it('starts over with a new link when the folder has been removed in Drive', async () => {
    const { server, links, c, body } = await linked();
    server.remove(FOLDER);
    void links.add(c, sources(file('more.mov', 4000)));
    await vi.waitFor(() => expect(links.error()).toMatch(/no longer in Drive/));
    // The password step is back, and with it the choice to attach.
    expect(links.request()).toMatchObject({ adding: false, canAttach: true });
    expect(await links.send(CHOICE)).toBe(true);
    expect(server.names(FOLDER)).toEqual(['more.mov']);
    expect(server.links).toHaveLength(2);
    expect(body()).toContain(server.links[1]!.url);
  });
});
