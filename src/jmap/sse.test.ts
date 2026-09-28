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
      const close = openPushStream(client, { onStateChange: () => {}, onConnected: () => connected++ });
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
});
