import { describe, expect, it, vi } from 'vitest';
import { JmapClient } from './client';
import { openPushStream, SseParser } from './sse';
import type { Session } from './types';

function fakeSession(): Session {
  return {
    capabilities: {},
    accounts: {},
    primaryAccounts: {},
    username: 'alice@example.test',
    apiUrl: 'http://fake/jmap',
    downloadUrl: '',
    uploadUrl: '',
    eventSourceUrl: 'http://fake/jmap/events',
    state: 's',
  };
}

/** A stream that closes immediately, as if the connection dropped with no data. */
function droppedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

describe('SseParser', () => {
  it('parses events split across chunks', () => {
    const events: { event: string; data: string; id?: string }[] = [];
    const p = new SseParser((e) => events.push(e));
    p.push('event: state\ndata: {"@type":"State');
    p.push('Change","changed":{}}\nid: 7\n\n: comment\n\n');
    p.push('event: ping\r\ndata: {"interval":30}\r\n\r\n');
    expect(events).toEqual([
      { event: 'state', data: '{"@type":"StateChange","changed":{}}', id: '7' },
      { event: 'ping', data: '{"interval":30}' },
    ]);
  });

  it('joins multi-line data and defaults the event name to message', () => {
    const events: { event: string; data: string }[] = [];
    const p = new SseParser((e) => events.push(e));
    p.push('data: a\ndata: b\n\n');
    expect(events).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('ignores a dispatch with no data', () => {
    const events: unknown[] = [];
    const p = new SseParser((e) => events.push(e));
    p.push('event: state\n\n');
    expect(events).toEqual([]);
  });
});

describe('openPushStream', () => {
  it('reconnects with backoff and calls onConnected again after the stream drops (e.g. tab woke from sleep)', async () => {
    vi.useFakeTimers();
    try {
      let fetchCalls = 0;
      const fetchImpl = async () => {
        fetchCalls++;
        return { ok: true, status: 200, body: droppedStream() } as unknown as Response;
      };
      const client = new JmapClient({ sessionUrl: 'http://fake/session', getToken: async () => 't', fetch: fetchImpl as typeof fetch });
      client.useSession(fakeSession());

      let connected = 0;
      const { close } = openPushStream(client, { onStateChange: () => {}, onConnected: () => connected++ });
      try {
        // First connection succeeds, onConnected fires once, then the empty stream ends
        // immediately and the client schedules a reconnect.
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchCalls).toBe(1);
        expect(connected).toBe(1);

        // First backoff is at most ~1s; advancing past it should trigger a second connect
        // and a second onConnected call — this is what lets the caller re-run catchUp()
        // after the tab was asleep and the connection dropped.
        await vi.advanceTimersByTimeAsync(1500);
        expect(fetchCalls).toBeGreaterThanOrEqual(2);
        expect(connected).toBeGreaterThanOrEqual(2);
      } finally {
        close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribes to mail and calendar state changes', async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, body: droppedStream() } as unknown as Response;
    };
    const client = new JmapClient({ sessionUrl: 'http://fake/session', getToken: async () => 't', fetch: fetchImpl as unknown as typeof fetch });
    client.useSession({ ...fakeSession(), eventSourceUrl: 'http://fake/events?types={types}&closeafter={closeafter}&ping={ping}' });
    const { close } = openPushStream(client, { onStateChange: () => {} });
    try {
      await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
      const types = new URL(urls[0]!).searchParams.get('types')!.split(',');
      expect(types).toEqual(expect.arrayContaining(['Email', 'Mailbox', 'Thread', 'EmailDelivery', 'Calendar', 'CalendarEvent']));
    } finally {
      close();
    }
  });

  it('reports a dropped stream and reconnects at once when woken', async () => {
    let calls = 0;
    const client = {
      eventSourceUrl: () => 'http://x/es',
      authFetch: async () => {
        calls++;
        return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
      },
    } as unknown as JmapClient;
    const dropped = vi.fn();
    const push = openPushStream(client, { onStateChange: () => {}, onDisconnected: dropped });
    await vi.waitFor(() => expect(dropped).toHaveBeenCalledTimes(1));
    push.wake();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    push.close();
  });
  /** A stream that opens and then says nothing, like a connection the network silently dropped. */
  const silentClient = (onFetch: () => void) =>
    ({
      eventSourceUrl: () => 'http://x/es',
      authFetch: async (_url: string, init: RequestInit) => {
        onFetch();
        const body = new ReadableStream({
          start: (c) => init.signal!.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
        });
        return new Response(body, { status: 200 });
      },
    }) as unknown as JmapClient;

  it('treats a stream with no data for longer than two pings as dropped', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const dropped = vi.fn();
      const push = openPushStream(silentClient(() => calls++), { onStateChange: () => {}, onDisconnected: dropped });
      await vi.advanceTimersByTimeAsync(74_000);
      expect(dropped).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(dropped).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toBe(2);
      push.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops and reopens the stream on restart', async () => {
    let calls = 0;
    const dropped = vi.fn();
    const push = openPushStream(silentClient(() => calls++), { onStateChange: () => {}, onDisconnected: dropped });
    await vi.waitFor(() => expect(calls).toBe(1));
    push.restart();
    await vi.waitFor(() => expect(dropped).toHaveBeenCalledTimes(1));
    push.wake();
    await vi.waitFor(() => expect(calls).toBe(2));
    push.close();
  });
  it('counts a request still waiting for its first bytes as connected, unconfirmed, after 2 seconds', async () => {
    vi.useFakeTimers();
    try {
      // Some engines hold fetch() back until the first body chunk, which is the server's first ping.
      const client = {
        eventSourceUrl: () => 'http://x/es',
        authFetch: (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
      } as unknown as JmapClient;
      const connected = vi.fn();
      const push = openPushStream(client, { onStateChange: () => {}, onConnected: connected });
      await vi.advanceTimersByTimeAsync(1999);
      expect(connected).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(connected).toHaveBeenCalledTimes(1);
      expect(connected).toHaveBeenCalledWith(false);
      push.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms the connection when the response arrives', async () => {
    const connected = vi.fn();
    const push = openPushStream(silentClient(() => {}), { onStateChange: () => {}, onConnected: connected });
    await vi.waitFor(() => expect(connected).toHaveBeenCalledWith(true));
    push.close();
  });
});
