import { CallHandle, RequestBuilder, type Invocation } from './request';
import { CORE, MAIL, PRINCIPALS, SUBMISSION, type MethodErrorBody, type MethodName, type Principal, type Session } from './types';

export class UnauthorizedError extends Error {
  constructor() {
    super('JMAP request was not authorized');
  }
}

/** A JMAP request-level failure (non-2xx, or a problem-details body). */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`JMAP request failed (${status}): ${detail}`);
  }
}

/** A method-level error response (RFC 8620 §3.6.2). */
export class MethodError extends Error {
  constructor(
    readonly method: string,
    readonly type: string,
    readonly description?: string,
  ) {
    super(`${method} failed: ${type}${description ? ` — ${description}` : ''}`);
  }
}

export class BatchResult {
  private byId = new Map<string, Invocation>();
  constructor(
    responses: Invocation[],
    readonly sessionChanged: boolean,
  ) {
    // A call's own response comes first; implicit calls the server adds (e.g. the Email/set
    // behind onSuccessUpdateEmail) reuse its id and must not replace it.
    for (const r of responses) if (!this.byId.has(r[2])) this.byId.set(r[2], r);
  }

  /** Error body for a call, if it failed. */
  error(handle: CallHandle<MethodName>): MethodErrorBody | undefined {
    const r = this.byId.get(handle.id);
    return r && r[0] === 'error' ? (r[1] as unknown as MethodErrorBody) : undefined;
  }

  /** Typed result for a call. Throws MethodError if the call failed. */
  get<M extends MethodName>(handle: CallHandle<M>): CallHandle<M>['_result'] {
    const r = this.byId.get(handle.id);
    if (!r) throw new MethodError(handle.name, 'missingResponse');
    if (r[0] === 'error') {
      const e = r[1] as unknown as MethodErrorBody;
      throw new MethodError(handle.name, e.type, e.description);
    }
    return r[1] as CallHandle<M>['_result'];
  }
}

const MAX_BUSY_RETRIES = 3;
/** Stalwart returns at most 500 objects to one get. */
const PRINCIPALS_PAGE = 500;
const PRINCIPALS_MAX = 10_000;

/** RFC 8620 §3.6.1 `limit` error for `maxConcurrentRequests`: the request was refused, not run. */
function isBusy(status: number, detail: string): boolean {
  if (status !== 400) return false;
  try {
    const problem = JSON.parse(detail) as { type?: string; limit?: string };
    return problem.type === 'urn:ietf:params:jmap:error:limit' && problem.limit === 'maxConcurrentRequests';
  } catch {
    return false;
  }
}

export interface JmapClientOptions {
  sessionUrl: string;
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  /** Abort non-streaming requests after this long (default 30 s). */
  timeoutMs?: number;
  /** Once per attempt: null when Stalwart answered, else the transport failure (network, timeout, 502-504). */
  onOutcome?: (error: unknown | null) => void;
  /** Base wait before re-sending a request Stalwart refused for concurrency (default 250 ms). */
  retryDelayMs?: number;
  /** Called on 401; resolve true if credentials were renewed and the request should be retried once. */
  onUnauthorized?: () => Promise<boolean>;
}

export interface UploadResult {
  accountId: string;
  blobId: string;
  type: string;
  size: number;
}

export class JmapClient {
  private _session: Session | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: JmapClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get session(): Session {
    if (!this._session) throw new Error('JMAP session not loaded');
    return this._session;
  }

  get accountId(): string {
    const id = this.session.primaryAccounts[MAIL];
    if (!id) throw new Error('Server has no primary mail account');
    return id;
  }

  /**
   * Authenticated fetch. Requests without their own signal time out, unless `noTimeout`
   * (uploads and downloads take as long as they take); streams pass a signal.
   */
  async authFetch(url: string, init: RequestInit = {}, retried = false, noTimeout = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await this.opts.getToken()}`);
    const own = !init.signal && !noTimeout;
    // A request with its own signal is a stream (the push connection): its owner reports on it, or a
    // failure to open it would count twice.
    const report = init.signal ? undefined : this.opts.onOutcome;
    const signal = init.signal ?? (noTimeout ? undefined : AbortSignal.timeout(this.opts.timeoutMs ?? 30_000));
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      const timedOut = own && (e as Error).name === 'TimeoutError';
      const err = timedOut ? new RequestError(0, 'the mail server did not respond in time') : e;
      // An abort is the caller closing its own request, not a connection problem.
      if ((e as Error).name !== 'AbortError') report?.(err);
      throw err;
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) report?.(new RequestError(res.status, 'the mail server is unavailable'));
    else report?.(null);
    if (res.status === 401) {
      if (!retried && (await this.opts.onUnauthorized?.())) return this.authFetch(url, init, true, noTimeout);
      throw new UnauthorizedError();
    }
    return res;
  }

  /** Use a previously fetched session (warm start) until loadSession() refreshes it. */
  useSession(session: Session): void {
    this._session = session;
  }

  get hasSession(): boolean {
    return this._session !== null;
  }

  async loadSession(): Promise<Session> {
    const res = await this.authFetch(this.opts.sessionUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new RequestError(res.status, await res.text());
    const session = (await res.json()) as Session;
    // Stalwart answers an unauthenticated session request with 200 and no accounts.
    if (!session.accounts || !Object.keys(session.accounts).length) throw new UnauthorizedError();
    this._session = session;
    return this._session;
  }

  batch(): RequestBuilder {
    return new RequestBuilder();
  }

  async send(builder: RequestBuilder, using: string[] = [CORE, MAIL, SUBMISSION]): Promise<BatchResult> {
    const body = JSON.stringify(builder.build(using));
    let res: Response;
    let detail = '';
    for (let attempt = 0; ; attempt++) {
      res = await this.authFetch(this.session.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
      });
      if (res.ok) break;
      detail = await res.text();
      // Stalwart runs four requests per account at a time and refuses the fifth outright. Two tabs
      // starting together, or one busy moment, is enough: nothing was processed, so send it again.
      if (attempt >= MAX_BUSY_RETRIES || !isBusy(res.status, detail)) throw new RequestError(res.status, detail);
      await new Promise((r) => setTimeout(r, (this.opts.retryDelayMs ?? 250) * 2 ** attempt * (0.5 + Math.random())));
    }
    const answer = (await res.json()) as { methodResponses: Invocation[]; sessionState: string };
    return new BatchResult(answer.methodResponses, answer.sessionState !== this.session.state);
  }

  /** `accountId` is the account to act in: the user's own unless a shared one is named. */
  async upload(blob: Blob, accountId = this.accountId): Promise<UploadResult> {
    const url = this.session.uploadUrl.replace('{accountId}', encodeURIComponent(accountId));
    const res = await this.authFetch(url, {
      method: 'POST',
      headers: { 'content-type': blob.type || 'application/octet-stream' },
      body: blob,
    }, false, true);
    if (!res.ok) throw new RequestError(res.status, await res.text());
    return (await res.json()) as UploadResult;
  }

  downloadUrl(blobId: string, name: string, type: string, accountId = this.accountId): string {
    return this.session.downloadUrl
      .replace('{accountId}', encodeURIComponent(accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name))
      .replace('{type}', encodeURIComponent(type));
  }

  /** Fetch a blob with auth (downloads can't carry a bearer token via a plain <img src>). */
  async fetchBlob(blobId: string, name: string, type: string, accountId = this.accountId): Promise<Blob> {
    const res = await this.authFetch(this.downloadUrl(blobId, name, type, accountId), {}, false, true);
    if (!res.ok) throw new RequestError(res.status, await res.text());
    return res.blob();
  }

  /**
   * Every person and group the server lists, or none where it keeps no directory. Stalwart shows them
   * all to any user; its text filter matches whole words only, so searching is left to the caller.
   */
  async principals(): Promise<Principal[]> {
    const accountId = this.session.primaryAccounts[PRINCIPALS];
    if (!accountId) return [];
    const out: Principal[] = [];
    for (let position = 0; position < PRINCIPALS_MAX; position += PRINCIPALS_PAGE) {
      const b = this.batch();
      const q = b.call('Principal/query', { accountId, position, limit: PRINCIPALS_PAGE });
      const g = b.call('Principal/get', { accountId, '#ids': q.ref('/ids'), properties: ['type', 'name', 'description', 'email'] });
      const r = await this.send(b, [CORE, PRINCIPALS]);
      out.push(...r.get(g).list);
      if (r.get(q).ids.length < PRINCIPALS_PAGE) break;
    }
    return out;
  }

  eventSourceUrl(types = '*'): string {
    return this.session.eventSourceUrl
      .replace('{types}', encodeURIComponent(types))
      .replace('{closeafter}', 'no')
      .replace('{ping}', '30');
  }
}
