// OpenCloud as Drive, reached on this origin under /drive (deploy/routes.caddy). It takes the token
// Stalwart issued to oinbox; see docs/superpowers/specs/2026-10-09-drive-integration-design.md.

export type DriveErrorKind =
  /** OpenCloud cannot be reached, is not there, or is not answering as OpenCloud. */
  | 'unavailable'
  /** It will not have this user: 401 after one renewal, or 403. */
  | 'refused'
  /** The file or its folder is gone. */
  | 'missing'
  /** No room for it. */
  | 'tooLarge'
  | 'other';

export class DriveError extends Error {
  constructor(
    readonly kind: DriveErrorKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface DriveItem {
  id: string;
  name: string;
  size: number;
  folder: boolean;
  /** ISO 8601. */
  modified: string;
}

export interface DriveClientOptions {
  /** Where OpenCloud is on this origin. */
  base?: string;
  getToken: () => Promise<string>;
  /** The token was refused. Resolves true if it was renewed and the request is worth one more try. */
  onUnauthorized?: () => Promise<boolean>;
  fetch?: typeof fetch;
  /** For everything but uploads, which take as long as they take. */
  timeoutMs?: number;
  /** How long to wait before asking again for a file OpenCloud says is not ready (425). */
  retryMs?: number;
}

const kindOf = (status: number): DriveErrorKind => {
  if (status === 401 || status === 403) return 'refused';
  if (status === 404 || status === 409) return 'missing';
  if (status === 413 || status === 507) return 'tooLarge';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'other';
};

/** A drive or item id (they contain `$` and `!`), or one name of a path, as a URL segment. */
const seg = encodeURIComponent;

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: object;
}

export class DriveClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private found: Promise<{ id: string; name: string }> | null = null;

  constructor(private opts: DriveClientOptions) {
    this.base = opts.base ?? '/drive';
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  /** An authenticated request. Resolves with any answer but a 401; rejects with a DriveError when there is none. */
  private async request(path: string, init: RequestInit = {}, noTimeout = false, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await this.opts.getToken()}`);
    const signal = noTimeout ? undefined : AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw new DriveError('unavailable', 0, (e as Error).name === 'TimeoutError' ? 'Drive did not respond in time' : 'Drive could not be reached');
    }
    if (res.status === 401) {
      if (!retried && (await this.opts.onUnauthorized?.())) return this.request(path, init, noTimeout, true);
      throw new DriveError('refused', 401, 'Drive refused the sign-in');
    }
    return res;
  }

  private fail(res: Response, what: string): never {
    throw new DriveError(kindOf(res.status), res.status, `${what}: HTTP ${res.status}`);
  }

  /** A JSON answer. HTML with a 200 is some proxy's fallback page, not OpenCloud. */
  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) this.fail(res, what);
    try {
      return (await res.json()) as T;
    } catch {
      throw new DriveError('unavailable', res.status, `${what}: not an answer from Drive`);
    }
  }

  /** The user's personal drive. Asked for once; a failure is not remembered. */
  drive(): Promise<{ id: string; name: string }> {
    this.found ??= (async () => {
      const res = await this.request('/graph/v1.0/me/drive');
      // No drive at this address at all: that is Drive being absent, not a folder being gone.
      if (res.status === 404) throw new DriveError('unavailable', 404, 'There is no Drive at /drive');
      const d = await this.json<{ id?: string; name?: string }>(res, 'Finding the drive');
      if (typeof d.id !== 'string') throw new DriveError('unavailable', res.status, 'Finding the drive: not an answer from Drive');
      return { id: d.id, name: d.name ?? 'Drive' };
    })().catch((e) => {
      this.found = null;
      throw e;
    });
    return this.found;
  }

  /** What a folder holds, as OpenCloud lists it; the top folder when no id is given. */
  async children(itemId?: string): Promise<DriveItem[]> {
    const path = itemId
      ? `/graph/v1.0/drives/${seg((await this.drive()).id)}/items/${seg(itemId)}/children`
      : '/graph/v1.0/me/drive/root/children';
    const body = await this.json<{ value?: GraphItem[] }>(await this.request(path), 'Listing the folder');
    if (!Array.isArray(body.value)) throw new DriveError('unavailable', 200, 'Listing the folder: not an answer from Drive');
    return body.value.map((i) => ({ id: i.id, name: i.name, size: i.size ?? 0, folder: !!i.folder, modified: i.lastModifiedDateTime ?? '' }));
  }

  private async dav(path: string[]): Promise<string> {
    return `/dav/spaces/${seg((await this.drive()).id)}/${path.map(seg).join('/')}`;
  }

  /** Create one folder; its parent must exist. A folder that is already there is fine. */
  async createFolder(path: string[]): Promise<void> {
    const res = await this.request(await this.dav(path), { method: 'MKCOL' });
    if (!res.ok && res.status !== 405) this.fail(res, 'Creating the folder');
  }

  /**
   * Store a file and return its id. A file of the same name is replaced: OpenCloud ignores
   * If-None-Match, so a caller that must not overwrite lists the folder first.
   */
  async upload(path: string[], body: Blob): Promise<string> {
    const res = await this.request(await this.dav(path), { method: 'PUT', headers: { 'content-type': body.type || 'application/octet-stream' }, body }, true);
    if (!res.ok) this.fail(res, 'Uploading');
    return res.headers.get('oc-fileid') ?? '';
  }

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
}
