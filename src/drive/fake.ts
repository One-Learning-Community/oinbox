import { DriveClient, type DriveClientOptions, type PutTransport } from './client';

interface Node {
  id: string;
  name: string;
  modified: string;
  /** Present on a folder. */
  children?: Map<string, Node>;
  /** Present on a file. */
  data?: Blob;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

/**
 * An in-memory OpenCloud that answers as the real one was probed to (2026-10-09, 7.2.4 and 8.1.0):
 * ids with `$` and `!`, 405 for a folder that exists, 409 under a missing parent, a silent replace
 * on a second PUT, 401 without the token.
 */
export class FakeDrive {
  readonly driveId = 'store-1$space-1';
  driveName = 'Alice Example';
  validToken = 't';
  /** Every request answers 503. */
  down = false;
  /** Uploads answer 507. */
  full = false;
  /** The next this-many downloads answer 425, as OpenCloud does for a file it has not finished with. */
  early = 0;
  /** Downloads and uploads never answer; they end only when the request is aborted. */
  stall = false;
  /** Whether a public link must have a password (OpenCloud's default). */
  passwordRequired = true;
  /** The links made, for tests to read. */
  links: { itemId: string; password: string | undefined; expires: string | undefined; url: string }[] = [];
  requests: { method: string; path: string }[] = [];
  private seq = 0;
  private root: Node = { id: `${this.driveId}!root`, name: '', modified: '2026-10-09T12:00:00Z', children: new Map() };

  private newNode(name: string, folder: boolean, data?: Blob): Node {
    return { id: `${this.driveId}!n${++this.seq}`, name, modified: '2026-10-09T12:00:00Z', ...(folder ? { children: new Map() } : { data }) };
  }

  private at(path: string[]): Node | undefined {
    let node: Node | undefined = this.root;
    for (const name of path) node = node?.children?.get(name);
    return node;
  }

  private byId(id: string, from: Node = this.root): Node | undefined {
    if (from.id === id) return from;
    for (const child of from.children?.values() ?? []) {
      const found = this.byId(id, child);
      if (found) return found;
    }
    return undefined;
  }

  mkdir(path: string[]): string {
    let node = this.root;
    for (const name of path) {
      let next = node.children!.get(name);
      if (!next) node.children!.set(name, (next = this.newNode(name, true)));
      node = next;
    }
    return node.id;
  }

  put(path: string[], data: Blob): string {
    const parent = this.at(path.slice(0, -1));
    if (!parent?.children) throw new Error(`FakeDrive.put: no folder ${path.slice(0, -1).join('/')}`);
    const node = this.newNode(path.at(-1)!, false, data);
    parent.children.set(node.name, node);
    return node.id;
  }

  names(path: string[]): string[] {
    return [...(this.at(path)?.children?.keys() ?? [])];
  }

  read(path: string[]): Blob | undefined {
    return this.at(path)?.data;
  }

  remove(path: string[]): void {
    this.at(path.slice(0, -1))?.children?.delete(path.at(-1)!);
  }

  private listing(node: Node) {
    return {
      value: [...node.children!.values()].map((n) => ({
        id: n.id,
        name: n.name,
        size: n.data?.size ?? 0,
        lastModifiedDateTime: n.modified,
        ...(n.children ? { folder: {} } : { file: { mimeType: n.data?.type || 'application/octet-stream' } }),
      })),
    };
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://fake');
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/drive/, '');
    this.requests.push({ method, path });
    if (this.down) return empty(503);
    // The sharing rules are given to anyone.
    if (method === 'GET' && path === '/ocs/v1.php/cloud/capabilities') {
      return json({
        ocs: {
          data: {
            capabilities: {
              password_policy: { min_characters: 8, max_characters: 72, min_lowercase_characters: 1, min_uppercase_characters: 1, min_digits: 1, min_special_characters: 1 },
              files_sharing: { public: { enabled: true, password: { enforced: false, enforced_for: { read_only: this.passwordRequired } }, expire_date: { enabled: false } } },
            },
          },
        },
      });
    }
    if (new Headers(init.headers).get('authorization') !== `Bearer ${this.validToken}`) return empty(401);

    if (method === 'GET' && path === '/graph/v1.0/me/drive') return json({ id: this.driveId, name: this.driveName, driveType: 'personal' });
    if (method === 'GET' && path === '/graph/v1.0/me/drive/root/children') return json(this.listing(this.root));
    const items = /^\/graph\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)\/children$/.exec(path);
    if (method === 'GET' && items) {
      const node = decodeURIComponent(items[1]!) === this.driveId ? this.byId(decodeURIComponent(items[2]!)) : undefined;
      return node?.children ? json(this.listing(node)) : json({ error: { code: 'itemNotFound' } }, 404);
    }
    const link = /^\/graph\/v1beta1\/drives\/([^/]+)\/items\/([^/]+)\/createLink$/.exec(path);
    if (method === 'POST' && link) {
      const itemId = decodeURIComponent(link[2]!);
      if (!this.byId(itemId)) return json({ error: { code: 'itemNotFound' } }, 404);
      const asked = JSON.parse(String(init.body)) as { password?: string; expirationDateTime?: string };
      const refuse = (message: string) => json({ error: { code: 'invalidRequest', message } }, 400);
      if (!asked.password && this.passwordRequired) return refuse('password protection is enforced');
      if (asked.password) {
        // The policy holds for any password that is given, required or not, and every broken rule is named.
        const p = asked.password;
        const broken = [
          p.length < 8 ? 'at least 8 characters are required' : '',
          /[a-z]/.test(p) ? '' : 'at least 1 lowercase letters are required',
          /[A-Z]/.test(p) ? '' : 'at least 1 uppercase letters are required',
          /[0-9]/.test(p) ? '' : 'at least 1 numbers are required',
          /[^A-Za-z0-9]/.test(p) ? '' : 'at least 1 special characters are required',
        ].filter(Boolean);
        if (broken.length) return refuse(broken.join('\n'));
      }
      const url = `https://files.test/s/link-${this.links.length + 1}`;
      this.links.push({ itemId, password: asked.password, expires: asked.expirationDateTime, url });
      return json({ id: `perm-${this.links.length}`, hasPassword: !!asked.password, link: { type: 'view', webUrl: url } });
    }
    const dav = /^\/dav\/spaces\/([^/]+)\/(.+)$/.exec(path);
    if (dav && decodeURIComponent(dav[1]!) === this.driveId) {
      const names = dav[2]!.split('/').map(decodeURIComponent);
      const parent = this.at(names.slice(0, -1));
      const name = names.at(-1)!;
      if (method === 'GET') {
        const node = parent?.children?.get(name);
        if (!node?.data) return empty(404);
        if (this.stall) {
          return new Promise<Response>((_resolve, reject) => {
            const fail = () => reject(new DOMException('The request was aborted', 'AbortError'));
            if (init.signal?.aborted) fail();
            else init.signal?.addEventListener('abort', fail);
          });
        }
        if (this.early > 0) {
          this.early--;
          return empty(425);
        }
        // Not a real Response: under jsdom a Response built from a Blob does not give the same Blob back.
        const data = node.data;
        return { ok: true, status: 200, headers: new Headers({ 'content-type': data.type }), blob: async () => data } as Response;
      }
      if (method === 'DELETE') return parent?.children?.delete(name) ? empty(204) : empty(404);
      if (method === 'COPY') {
        const source = parent?.children?.get(name);
        if (!source?.data) return empty(404);
        const to = /^\/dav\/spaces\/[^/]+\/(.+)$/.exec(new Headers(init.headers).get('destination') ?? '');
        const toNames = (to?.[1] ?? '').split('/').map(decodeURIComponent);
        const target = this.at(toNames.slice(0, -1));
        if (!to || !target?.children) return empty(409);
        if (target.children.has(toNames.at(-1)!)) return empty(412);
        target.children.set(toNames.at(-1)!, this.newNode(toNames.at(-1)!, false, source.data));
        return empty(201);
      }
      if (method === 'MKCOL') {
        if (!parent?.children) return empty(409);
        if (parent.children.has(name)) return empty(405);
        parent.children.set(name, this.newNode(name, true));
        return empty(201);
      }
      if (method === 'PUT') {
        if (!parent?.children) return empty(409);
        if (this.stall) {
          return new Promise<Response>((_resolve, reject) => {
            const fail = () => reject(new DOMException('The request was aborted', 'AbortError'));
            if (init.signal?.aborted) fail();
            else init.signal?.addEventListener('abort', fail);
          });
        }
        if (this.full) return empty(507);
        const old = parent.children.get(name);
        const node = this.newNode(name, false, init.body as Blob);
        if (old) node.id = old.id;
        parent.children.set(name, node);
        return empty(old ? 204 : 201, { 'oc-fileid': node.id });
      }
    }
    return empty(404);
  };

  /** An upload with progress, as the browser's would report it: half-way, then done. */
  transport: PutTransport = async (url, body, headers, opts) => {
    opts.onProgress?.(body.size / 2, body.size);
    const res = await this.fetch(url, { method: 'PUT', headers, body, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (res.ok) opts.onProgress?.(body.size, body.size);
    return { status: res.status, fileId: res.headers.get('oc-fileid') ?? '' };
  };

  client(opts: Partial<DriveClientOptions> = {}): DriveClient {
    return new DriveClient({ base: 'http://fake/drive', getToken: async () => this.validToken, fetch: this.fetch, put: this.transport, ...opts });
  }
}
