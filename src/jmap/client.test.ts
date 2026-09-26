import { describe, expect, it, vi } from 'vitest';
import { JmapClient, MethodError, UnauthorizedError } from './client';
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

  it('raises UnauthorizedError on 401', async () => {
    const f = vi.fn(async () => new Response('', { status: 401 }));
    const c = makeClient(f as unknown as typeof fetch);
    await expect(c.loadSession()).rejects.toBeInstanceOf(UnauthorizedError);
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
