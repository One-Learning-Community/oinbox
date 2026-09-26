import { CallHandle, RequestBuilder, type Invocation } from './request';
import { CORE, MAIL, SUBMISSION, type MethodErrorBody, type MethodName, type Session } from './types';

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
    for (const r of responses) this.byId.set(r[2], r);
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

export interface JmapClientOptions {
  sessionUrl: string;
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  /** Abort non-streaming requests after this long (default 30 s). */
  timeoutMs?: number;
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

  /** Authenticated fetch. Requests without their own signal time out; streams pass a signal. */
  async authFetch(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await this.opts.getToken()}`);
    const signal = init.signal ?? AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers, signal });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') throw new RequestError(0, 'the mail server did not respond in time');
      throw e;
    }
    if (res.status === 401) {
      // Blob bodies (uploads) can be re-sent; streams can't, but we never upload streams.
      if (!retried && (await this.opts.onUnauthorized?.())) return this.authFetch(url, init, true);
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
    const res = await this.authFetch(this.session.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(builder.build(using)),
    });
    if (!res.ok) throw new RequestError(res.status, await res.text());
    const body = (await res.json()) as { methodResponses: Invocation[]; sessionState: string };
    return new BatchResult(body.methodResponses, body.sessionState !== this.session.state);
  }

  async upload(blob: Blob): Promise<UploadResult> {
    const url = this.session.uploadUrl.replace('{accountId}', encodeURIComponent(this.accountId));
    const res = await this.authFetch(url, {
      method: 'POST',
      headers: { 'content-type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) throw new RequestError(res.status, await res.text());
    return (await res.json()) as UploadResult;
  }

  downloadUrl(blobId: string, name: string, type: string): string {
    return this.session.downloadUrl
      .replace('{accountId}', encodeURIComponent(this.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name))
      .replace('{type}', encodeURIComponent(type));
  }

  /** Fetch a blob with auth (downloads can't carry a bearer token via a plain <img src>). */
  async fetchBlob(blobId: string, name: string, type: string): Promise<Blob> {
    const res = await this.authFetch(this.downloadUrl(blobId, name, type));
    if (!res.ok) throw new RequestError(res.status, await res.text());
    return res.blob();
  }

  eventSourceUrl(types = '*'): string {
    return this.session.eventSourceUrl
      .replace('{types}', encodeURIComponent(types))
      .replace('{closeafter}', 'no')
      .replace('{ping}', '30');
  }
}
