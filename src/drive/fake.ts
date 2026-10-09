import { DriveClient, type DriveClientOptions } from './client';

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
    if (new Headers(init.headers).get('authorization') !== `Bearer ${this.validToken}`) return empty(401);

    if (method === 'GET' && path === '/graph/v1.0/me/drive') return json({ id: this.driveId, name: this.driveName, driveType: 'personal' });
    if (method === 'GET' && path === '/graph/v1.0/me/drive/root/children') return json(this.listing(this.root));
    const items = /^\/graph\/v1\.0\/drives\/([^/]+)\/items\/([^/]+)\/children$/.exec(path);
    if (method === 'GET' && items) {
      const node = decodeURIComponent(items[1]!) === this.driveId ? this.byId(decodeURIComponent(items[2]!)) : undefined;
      return node?.children ? json(this.listing(node)) : json({ error: { code: 'itemNotFound' } }, 404);
    }
    const dav = /^\/dav\/spaces\/([^/]+)\/(.+)$/.exec(path);
    if (dav && decodeURIComponent(dav[1]!) === this.driveId) {
      const names = dav[2]!.split('/').map(decodeURIComponent);
      const parent = this.at(names.slice(0, -1));
      const name = names.at(-1)!;
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
      if (method === 'MKCOL') {
        if (!parent?.children) return empty(409);
        if (parent.children.has(name)) return empty(405);
        parent.children.set(name, this.newNode(name, true));
        return empty(201);
      }
      if (method === 'PUT') {
        if (!parent?.children) return empty(409);
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

  client(opts: Partial<DriveClientOptions> = {}): DriveClient {
    return new DriveClient({ base: 'http://fake/drive', getToken: async () => this.validToken, fetch: this.fetch, ...opts });
  }
}
