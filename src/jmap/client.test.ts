import { describe, expect, it, vi } from 'vitest';
import { JmapClient, MethodError, RequestError, UnauthorizedError } from './client';
import { RequestBuilder } from './request';
import type { Session } from './types';

const session: Session = {
  capabilities: { 'urn:ietf:params:jmap:core': { maxCallsInRequest: 16 }, 'urn:ietf:params:jmap:mail': {} },
  accounts: { a1: { name: 'alice@example.test', isPersonal: true, isReadOnly: false } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a1' },
  username: 'alice@example.test',
  apiUrl: 'http://localhost:8080/jmap/',
  downloadUrl: 'http://localhost:8080/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
  uploadUrl: 'http://localhost:8080/jmap/upload/{accountId}/',
  eventSourceUrl: 'http://localhost:8080/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
  state: 's1',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeClient(fetchImpl: typeof fetch) {
  return new JmapClient({ sessionUrl: 'http://localhost:8080/.well-known/jmap', fetch: fetchImpl, getToken: async () => 'tok' });
}

describe('RequestBuilder', () => {
  it('assigns call ids and builds back-references', () => {
    const b = new RequestBuilder();
    const q = b.call('Email/query', { accountId: 'a1', collapseThreads: true, limit: 50 });
    const g = b.call('Email/get', { accountId: 'a1', '#ids': q.ref('/ids'), properties: ['threadId'] });
    b.call('Thread/get', { accountId: 'a1', '#ids': g.ref('/list/*/threadId') });

    expect(b.build(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'])).toEqual({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [
        ['Email/query', { accountId: 'a1', collapseThreads: true, limit: 50 }, '0'],
        ['Email/get', { accountId: 'a1', '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['threadId'] }, '1'],
        ['Thread/get', { accountId: 'a1', '#ids': { resultOf: '1', name: 'Email/get', path: '/list/*/threadId' } }, '2'],
      ],
    });
  });
});

describe('JmapClient', () => {
  it('loads the session with a bearer token', async () => {
    const f = vi.fn(async () => json(session));
    const c = makeClient(f as unknown as typeof fetch);
    const s = await c.loadSession();
    expect(s.apiUrl).toBe(session.apiUrl);
    expect(c.accountId).toBe('a1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/.well-known/jmap');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('sends a batch and returns typed results by handle', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/jmap')) return json(session);
      return json({
        sessionState: 's1',
        methodResponses: [
          ['Email/query', { accountId: 'a1', queryState: 'q1', canCalculateChanges: true, position: 0, ids: ['e1'], total: 1 }, '0'],
          ['Email/get', { accountId: 'a1', state: 'st', list: [{ id: 'e1', threadId: 't1' }], notFound: [] }, '1'],
        ],
      });
    });
    const c = makeClient(f as unknown as typeof fetch);
    await c.loadSession();
    const b = c.batch();
    const q = b.call('Email/query', { accountId: c.accountId, collapseThreads: true });
    const g = b.call('Email/get', { accountId: c.accountId, '#ids': q.ref('/ids') });
    const res = await c.send(b);
    expect(res.get(q).total).toBe(1);
    expect(res.get(g).list[0]!.threadId).toBe('t1');

    const body = JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.using).toContain('urn:ietf:params:jmap:mail');
  });

  it('throws MethodError when a call fails, only when that result is read', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/jmap')) return json(session);
      return json({
        sessionState: 's1',
        methodResponses: [
          ['Mailbox/get', { accountId: 'a1', state: 'm', list: [], notFound: [] }, '0'],
          ['error', { type: 'cannotCalculateChanges' }, '1'],
        ],
      });
    });
    const c = makeClient(f as unknown as typeof fetch);
    await c.loadSession();
    const b = c.batch();
    const m = b.call('Mailbox/get', { accountId: 'a1' });
    const qc = b.call('Email/queryChanges', { accountId: 'a1', sinceQueryState: 'q0' });
    const res = await c.send(b);
    expect(res.get(m).list).toEqual([]);
    expect(() => res.get(qc)).toThrow(MethodError);
    try {
      res.get(qc);
    } catch (e) {
      expect((e as MethodError).type).toBe('cannotCalculateChanges');
    }
    expect(res.error(qc)?.type).toBe('cannotCalculateChanges');
  });

  it('returns the call\'s own result when the server adds an implicit call under the same id', async () => {
    // RFC 8621 §7.5: onSuccessUpdateEmail makes the server run an Email/set and answer it with
    // the EmailSubmission/set's method call id.
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/jmap')) return json(session);
      return json({
        sessionState: 's1',
        methodResponses: [
          ['EmailSubmission/set', { accountId: 'a1', newState: 's2', created: { send: { id: 'sub1' } } }, '0'],
          ['Email/set', { accountId: 'a1', oldState: 'e1', newState: 'e2', updated: { m1: null } }, '0'],
        ],
      });
    });
    const c = makeClient(f as unknown as typeof fetch);
    await c.loadSession();
    const b = c.batch();
    const s = b.call('EmailSubmission/set', {
      accountId: 'a1',
      create: { send: { identityId: 'i1', emailId: 'm1' } },
      onSuccessUpdateEmail: { '#send': { 'keywords/$draft': null } },
    });
    const res = await c.send(b);
    expect(res.get(s).created?.send?.id).toBe('sub1');
  });

  it('reports sessionState changes so callers can reload the session', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/jmap')) return json(session);
      return json({ sessionState: 's2', methodResponses: [['Mailbox/get', { accountId: 'a1', state: 'm', list: [], notFound: [] }, '0']] });
    });
    const c = makeClient(f as unknown as typeof fetch);
    await c.loadSession();
    const b = c.batch();
    b.call('Mailbox/get', { accountId: 'a1' });
    const res = await c.send(b);
    expect(res.sessionChanged).toBe(true);
  });

  it('treats a session without accounts as unauthorized (Stalwart returns 200)', async () => {
    const c = makeClient((async () => json({ ...session, accounts: {}, primaryAccounts: {} })) as unknown as typeof fetch);
    await expect(c.loadSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('renews credentials once on 401 and retries', async () => {
    let calls = 0;
    const f = vi.fn(async () => (++calls === 1 ? new Response('', { status: 401 }) : json(session)));
    let renewed = 0;
    const c = new JmapClient({ sessionUrl: 'http://x/s', fetch: f as unknown as typeof fetch, getToken: async () => 't', onUnauthorized: async () => (++renewed, true) });
    await c.loadSession();
    expect(renewed).toBe(1);
    expect(calls).toBe(2);
  });

  it('raises UnauthorizedError on 401', async () => {
    const f = vi.fn(async () => new Response('', { status: 401 }));
    const c = makeClient(f as unknown as typeof fetch);
    await expect(c.loadSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('times out a request that never answers', async () => {
    const f = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))),
    );
    const c = new JmapClient({ sessionUrl: 'http://x/s', fetch: f as unknown as typeof fetch, getToken: async () => 't', timeoutMs: 20 });
    await expect(c.loadSession()).rejects.toThrow(/did not respond/);
  });

  it('expands download URL templates', async () => {
    const c = makeClient((async () => json(session)) as unknown as typeof fetch);
    await c.loadSession();
    expect(c.downloadUrl('b 1', 'a/b.pdf', 'application/pdf')).toBe(
      'http://localhost:8080/jmap/download/a1/b%201/a%2Fb.pdf?accept=application%2Fpdf',
    );
  });

  it('uploads a blob to the account upload URL', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/jmap')) return json(session);
      return json({ accountId: 'a1', blobId: 'B1', type: 'text/plain', size: 3 });
    });
    const c = makeClient(f as unknown as typeof fetch);
    await c.loadSession();
    const r = await c.upload(new Blob(['abc'], { type: 'text/plain' }));
    expect(r.blobId).toBe('B1');
    expect((f.mock.calls[1] as unknown as [string])[0]).toBe('http://localhost:8080/jmap/upload/a1/');
  });
});

const make = (fetchImpl: typeof fetch, onOutcome = vi.fn(), timeoutMs = 30_000) =>
  ({ client: new JmapClient({ sessionUrl: 'http://x/session', getToken: async () => 't', fetch: fetchImpl, onOutcome, timeoutMs }), onOutcome });

describe('JmapClient outcomes', () => {
  it('reports an answer as success, even a 4xx', async () => {
    const { client, onOutcome } = make(async () => new Response('no', { status: 400 }));
    await client.authFetch('http://x/a');
    expect(onOutcome).toHaveBeenCalledWith(null);
  });
  it('reports a network failure and rethrows it', async () => {
    const err = new TypeError('Failed to fetch');
    const { client, onOutcome } = make(async () => { throw err; });
    await expect(client.authFetch('http://x/a')).rejects.toBe(err);
    expect(onOutcome).toHaveBeenCalledWith(err);
  });
  it('reports 502, 503 and 504 as failures', async () => {
    for (const status of [502, 503, 504]) {
      const { client, onOutcome } = make(async () => new Response('', { status }));
      await client.authFetch('http://x/a');
      expect(onOutcome.mock.calls[0]![0]).toBeInstanceOf(RequestError);
    }
  });
  it('reports a timeout as a RequestError with status 0', async () => {
    const hang: typeof fetch = (_u, init) => new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    const { client, onOutcome } = make(hang, vi.fn(), 20);
    await expect(client.authFetch('http://x/a')).rejects.toMatchObject({ status: 0 });
    expect(onOutcome.mock.calls[0]![0]).toMatchObject({ status: 0 });
  });
  it('does not report a caller abort', async () => {
    const ac = new AbortController();
    const hang: typeof fetch = (_u, init) => new Promise((_r, reject) => init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const { client, onOutcome } = make(hang);
    const p = client.authFetch('http://x/a', { signal: ac.signal });
    // After the token lookup, so the request is in flight when it is aborted.
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(onOutcome).not.toHaveBeenCalled();
  });
  it('gives uploads no timeout', async () => {
    let signal: AbortSignal | undefined;
    const { client } = make(async (_u, init) => { signal = init!.signal!; return Response.json({ accountId: 'a', blobId: 'b', type: 't', size: 1 }); }, vi.fn(), 5);
    client.useSession({ uploadUrl: 'http://x/up/{accountId}', primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' } } as never);
    await client.upload(new Blob(['x']));
    await new Promise((r) => setTimeout(r, 20));
    expect(signal?.aborted ?? false).toBe(false);
  });
});

describe('JmapClient and the concurrent request limit', () => {
  const limit = () =>
    new Response(JSON.stringify({ type: 'urn:ietf:params:jmap:error:limit', status: 400, limit: 'maxConcurrentRequests', detail: 'too many' }), {
      status: 400,
      headers: { 'content-type': 'application/problem+json' },
    });
  const ok = () => Response.json({ methodResponses: [], sessionState: 's' });
  const client = (fetchImpl: typeof fetch) => {
    const c = new JmapClient({ sessionUrl: 'http://x/session', getToken: async () => 't', fetch: fetchImpl, retryDelayMs: 1 });
    c.useSession({ ...session, apiUrl: 'http://x/api', state: 's' });
    return c;
  };

  it('waits and sends again when Stalwart says too many requests are in flight', async () => {
    const answers = [limit(), limit(), ok()];
    const fetchImpl = vi.fn(async () => answers.shift()!);
    const c = client(fetchImpl as unknown as typeof fetch);
    await expect(c.send(c.batch())).resolves.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after a few tries', async () => {
    const fetchImpl = vi.fn(async () => limit());
    const c = client(fetchImpl as unknown as typeof fetch);
    await expect(c.send(c.batch())).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry any other 400', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: 'urn:ietf:params:jmap:error:notRequest', status: 400 }), { status: 400 }));
    const c = client(fetchImpl as unknown as typeof fetch);
    await expect(c.send(c.batch())).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

