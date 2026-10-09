import { describe, expect, it, vi } from 'vitest';
import { DriveClient, DriveError } from './client';
import { FakeDrive } from './fake';

const blob = (text: string) => new Blob([text], { type: 'text/plain' });
const kindOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e instanceof DriveError ? e.kind : `not a DriveError: ${String(e)}`));

describe('DriveClient', () => {
  it("finds the user's drive once and remembers it", async () => {
    const server = new FakeDrive();
    const c = server.client();
    expect(await c.drive()).toEqual({ id: server.driveId, name: 'Alice Example' });
    await c.drive();
    expect(server.requests.filter((r) => r.path === '/graph/v1.0/me/drive')).toHaveLength(1);
  });

  it('asks again after a failed first attempt', async () => {
    const server = new FakeDrive();
    const c = server.client();
    server.down = true;
    expect(await kindOf(c.drive())).toBe('unavailable');
    server.down = false;
    expect((await c.drive()).id).toBe(server.driveId);
  });

  it('lists the top folder and a folder inside it', async () => {
    const server = new FakeDrive();
    const reports = server.mkdir(['Reports']);
    server.put(['Reports', 'q3.pdf'], blob('pdf!'));
    server.put(['notes.txt'], blob('hello'));
    const c = server.client();
    expect(await c.children()).toEqual([
      { id: reports, name: 'Reports', size: 0, folder: true, modified: '2026-10-09T12:00:00Z' },
      { id: expect.any(String), name: 'notes.txt', size: 5, folder: false, modified: '2026-10-09T12:00:00Z' },
    ]);
    expect((await c.children(reports)).map((i) => i.name)).toEqual(['q3.pdf']);
    // The drive's id has a `$`, a folder's a `!`: both travel encoded.
    expect(server.requests.at(-1)!.path).toBe(`/graph/v1.0/drives/${encodeURIComponent(server.driveId)}/items/${encodeURIComponent(reports)}/children`);
  });

  it('says a folder that is gone is missing', async () => {
    const server = new FakeDrive();
    expect(await kindOf(server.client().children(`${server.driveId}!nope`))).toBe('missing');
  });

  it('creates a folder, and is content if it is already there', async () => {
    const server = new FakeDrive();
    const c = server.client();
    await c.createFolder(['Reports']);
    await c.createFolder(['Reports']);
    await c.createFolder(['Reports', '2026']);
    expect(server.names([])).toEqual(['Reports']);
    expect(server.names(['Reports'])).toEqual(['2026']);
  });

  it('uploads a file and returns its id', async () => {
    const server = new FakeDrive();
    server.mkdir(['Reports']);
    const body = blob('pdf!');
    const id = await server.client().upload(['Reports', 'q3.pdf'], body);
    expect(id).toMatch(/^store-1\$space-1!n\d+$/);
    expect(server.read(['Reports', 'q3.pdf'])).toBe(body);
  });

  it('encodes each part of a path, so a name with # % ? & or a space arrives whole', async () => {
    const server = new FakeDrive();
    server.mkdir(['R & D']);
    const name = 'a #1 100% why?.txt';
    await server.client().upload(['R & D', name], blob('x'));
    expect(server.names(['R & D'])).toEqual([name]);
    expect(server.requests.at(-1)!.path).toBe(`/dav/spaces/${encodeURIComponent(server.driveId)}/R%20%26%20D/a%20%231%20100%25%20why%3F.txt`);
  });

  it('says so when the folder is gone, the drive is full, or the server is down', async () => {
    const server = new FakeDrive();
    const c = server.client();
    expect(await kindOf(c.upload(['Gone', 'a.txt'], blob('x')))).toBe('missing');
    server.full = true;
    expect(await kindOf(c.upload(['a.txt'], blob('x')))).toBe('tooLarge');
    server.down = true;
    expect(await kindOf(c.children())).toBe('unavailable');
  });

  it('counts a network failure and a time-out as unavailable', async () => {
    const offline = new DriveClient({ getToken: async () => 't', fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(await kindOf(offline.children())).toBe('unavailable');
    const slow = new DriveClient({ getToken: async () => 't', timeoutMs: 5, fetch: (_u, init) => new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason))) });
    expect(await kindOf(slow.children())).toBe('unavailable');
  });

  it('counts an HTML answer as unavailable: a proxy with no Drive route serves the app page', async () => {
    const c = new DriveClient({ getToken: async () => 't', fetch: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
    expect(await kindOf(c.drive())).toBe('unavailable');
    expect(await kindOf(c.children())).toBe('unavailable');
  });

  it('counts a 404 for the drive itself as unavailable, not as a missing folder', async () => {
    const c = new DriveClient({ getToken: async () => 't', fetch: async () => new Response(null, { status: 404 }) });
    expect(await kindOf(c.drive())).toBe('unavailable');
  });

  it('renews an expired token once and carries on', async () => {
    const server = new FakeDrive();
    let token = 'old';
    const onUnauthorized = vi.fn(async () => {
      token = 't';
      return true;
    });
    const c = server.client({ getToken: async () => token, onUnauthorized });
    expect((await c.children()).length).toBe(0);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('is refused when the token cannot be renewed, without asking twice', async () => {
    const server = new FakeDrive();
    const onUnauthorized = vi.fn(async () => true);
    const c = server.client({ getToken: async () => 'still-wrong', onUnauthorized });
    expect(await kindOf(c.children())).toBe('refused');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(await kindOf(server.client({ getToken: async () => 'wrong' }).children())).toBe('refused');
  });

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
});
