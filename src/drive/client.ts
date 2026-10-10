// OpenCloud as Drive, reached on this origin under /drive (deploy/routes.caddy). It takes the token
// Stalwart issued to oinbox; see docs/superpowers/specs/2026-10-09-drive-integration-design.md.

import { xhrPut } from './xhr';

export type DriveErrorKind =
  /** OpenCloud cannot be reached, is not there, or is not answering as OpenCloud. */
  | 'unavailable'
  /** It will not have this user: 401 after one renewal, or 403. */
  | 'refused'
  /** The file or its folder is gone. */
  | 'missing'
  /** No room for it. */
  | 'tooLarge'
  /** A link's password or expiry was refused; the message is the server's own. */
  | 'policy'
  /** A copy would have replaced a file. */
  | 'exists'
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

/** What a password for a public link must have. A count of 0 means no such rule. */
export interface PasswordPolicy {
  min: number;
  max: number;
  lower: number;
  upper: number;
  digits: number;
  special: number;
}

export interface SharingRules {
  /** A view-only public link cannot be made without a password. */
  passwordRequired: boolean;
  policy: PasswordPolicy;
  /** The longest a link may live, when the server enforces one. */
  maxExpiryDays: number | null;
}

/** An upload that can report how far it has got. The default is XMLHttpRequest (xhr.ts); tests bring their own. */
export type PutTransport = (
  url: string,
  body: Blob,
  headers: Record<string, string>,
  opts: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void },
) => Promise<{ status: number; fileId: string }>;

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
  put?: PutTransport;
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
  /**
   * A token OpenCloud refused though it was fresh from a renewal. It answers 401 for reasons of its
   * own too (it cannot ask Stalwart who the user is, or will not have them), and renewing again for
   * the same token would only send every request, and every upload, twice.
   */
  private refused: string | null = null;

  constructor(private opts: DriveClientOptions) {
    this.base = opts.base ?? '/drive';
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  /** An authenticated request. Resolves with any answer but a 401; rejects with a DriveError when there is none. */
  private async request(path: string, init: RequestInit = {}, noTimeout = false, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = await this.opts.getToken();
    headers.set('authorization', `Bearer ${token}`);
    const signal = noTimeout ? undefined : AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { ...init, headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      // The caller stopped its own request: that is not Drive failing.
      if ((e as Error).name === 'AbortError') throw e;
      throw new DriveError('unavailable', 0, (e as Error).name === 'TimeoutError' ? 'Drive did not respond in time' : 'Drive could not be reached');
    }
    if (res.status === 401) {
      if (!retried && (await this.renewed(token))) return this.request(path, init, noTimeout, true);
      if (retried) this.refused = token;
      throw new DriveError('refused', 401, 'Drive refused the sign-in');
    }
    return res;
  }

  /** After a 401 for `token`: whether the token was renewed and the request is worth one more try. */
  private async renewed(token: string): Promise<boolean> {
    if (token === this.refused) return false;
    return (await this.opts.onUnauthorized?.()) ?? false;
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
   * If-None-Match, so a caller that must not overwrite lists the folder first. With `onProgress` the
   * upload reports how far it has got; with `signal` it can be stopped (an AbortError, not a DriveError).
   */
  async upload(path: string[], body: Blob, opts: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {}): Promise<string> {
    const type = body.type || 'application/octet-stream';
    if (!opts.onProgress) {
      const res = await this.request(await this.dav(path), { method: 'PUT', headers: { 'content-type': type }, body, ...(opts.signal ? { signal: opts.signal } : {}) }, true);
      if (!res.ok) this.fail(res, 'Uploading');
      return res.headers.get('oc-fileid') ?? '';
    }
    const url = `${this.base}${await this.dav(path)}`;
    const put = this.opts.put ?? xhrPut;
    let token = '';
    const send = async () => {
      token = await this.opts.getToken();
      const headers = { authorization: `Bearer ${token}`, 'content-type': type };
      try {
        return await put(url, body, headers, opts);
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new DriveError('unavailable', 0, 'Drive could not be reached');
      }
    };
    let sent = await send();
    if (sent.status === 401 && (await this.renewed(token))) {
      sent = await send();
      if (sent.status === 401) this.refused = token;
    }
    if (sent.status === 401) throw new DriveError('refused', 401, 'Drive refused the sign-in');
    if (sent.status < 200 || sent.status > 299) throw new DriveError(kindOf(sent.status), sent.status, `Uploading: HTTP ${sent.status}`);
    return sent.fileId;
  }

  /** Copy a file to another place in the drive, by OpenCloud itself. It never replaces a file. */
  async copy(from: string[], to: string[]): Promise<void> {
    // The destination is a path as OpenCloud knows it: no host, and none of this origin's /drive prefix.
    const destination = await this.dav(to);
    const res = await this.request(await this.dav(from), { method: 'COPY', headers: { destination, overwrite: 'F' } });
    if (res.status === 412) throw new DriveError('exists', 412, 'There is already a file of that name');
    if (!res.ok) this.fail(res, 'Copying');
  }

  /** Remove a file, or a folder and what is in it (to OpenCloud's trash). One that is already gone is fine. */
  async remove(path: string[]): Promise<void> {
    const res = await this.request(await this.dav(path), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) this.fail(res, 'Removing');
  }

  /** What this OpenCloud demands of a public link. */
  async rules(): Promise<SharingRules> {
    interface Caps {
      password_policy?: Record<string, unknown>;
      files_sharing?: { public?: { password?: { enforced?: unknown; enforced_for?: { read_only?: unknown } }; expire_date?: { enforced?: unknown; days?: unknown } } };
    }
    const body = await this.json<{ ocs?: { data?: { capabilities?: Caps } } }>(await this.request('/ocs/v1.php/cloud/capabilities?format=json'), 'Reading the sharing rules');
    const caps = body.ocs?.data?.capabilities;
    if (!caps) throw new DriveError('unavailable', 200, 'Reading the sharing rules: not an answer from Drive');
    const policy = caps.password_policy ?? {};
    const n = (v: unknown, otherwise = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : otherwise);
    const pub = caps.files_sharing?.public ?? {};
    const days = Number(pub.expire_date?.days);
    return {
      passwordRequired: pub.password?.enforced_for?.read_only === true || pub.password?.enforced === true,
      policy: {
        min: n(policy.min_characters),
        max: n(policy.max_characters, 72) || 72,
        lower: n(policy.min_lowercase_characters),
        upper: n(policy.min_uppercase_characters),
        digits: n(policy.min_digits),
        special: n(policy.min_special_characters),
      },
      maxExpiryDays: pub.expire_date?.enforced === true && Number.isFinite(days) && days > 0 ? days : null,
    };
  }

  /** Make a view-only public link to a file or folder and return its address. */
  async createLink(itemId: string, opts: { password?: string; expires?: Date }): Promise<string> {
    const res = await this.request(`/graph/v1beta1/drives/${seg((await this.drive()).id)}/items/${seg(itemId)}/createLink`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'view', ...(opts.password ? { password: opts.password } : {}), ...(opts.expires ? { expirationDateTime: opts.expires.toISOString() } : {}) }),
    });
    if (res.status === 400) {
      // A password or expiry the server will not have: it says which rule, and its words are the best there are.
      const said = ((await res.json().catch(() => null)) as { error?: { message?: unknown } } | null)?.error?.message;
      throw new DriveError('policy', 400, typeof said === 'string' && said ? said : 'Drive refused the link');
    }
    const made = await this.json<{ link?: { webUrl?: unknown } }>(res, 'Creating the link');
    if (typeof made.link?.webUrl !== 'string') throw new DriveError('unavailable', res.status, 'Creating the link: not an answer from Drive');
    return made.link.webUrl;
  }

  /**
   * A file's bytes. Straight after an upload OpenCloud can answer 425 while it finishes with the
   * file (seen 2026-10-09): wait and ask again, five times in all. A download has no time limit, so
   * the caller can stop it: aborting `signal` rejects with an AbortError, not a DriveError.
   */
  async download(path: string[], signal?: AbortSignal): Promise<Blob> {
    const url = await this.dav(path);
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      const res = await this.request(url, signal ? { signal } : {}, true);
      if (res.status === 425 && attempt < 5) {
        await new Promise((r) => setTimeout(r, this.opts.retryMs ?? 400));
        continue;
      }
      if (!res.ok) this.fail(res, 'Downloading');
      return res.blob();
    }
  }
}
