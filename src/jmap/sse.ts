import { UnauthorizedError, type JmapClient } from './client';
import type { StateChange } from './types';

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental text/event-stream parser (WHATWG HTML §9.2.6), the subset JMAP needs.
 * Native EventSource can't send an Authorization header, so we stream with fetch.
 */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  constructor(private readonly onEvent: (e: SseEvent) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith('\r\n', nl) ? 2 : 1;
      // A lone trailing \r might be the first half of \r\n; wait for more input.
      if (this.buf[nl] === '\r' && sepLen === 1 && nl === this.buf.length - 1) break;
      this.buf = this.buf.slice(nl + sepLen);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length) {
        const e: SseEvent = { event: this.event || 'message', data: this.data.join('\n') };
        if (this.id !== undefined) e.id = this.id;
        this.onEvent(e);
      }
      this.event = '';
      this.data = [];
      this.id = undefined;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
  }
}

export interface PushStream {
  close(): void;
  wake(): void;
  restart(): void;
}

export interface PushOptions {
  onStateChange: (change: StateChange) => void;
  /**
   * Called after every (re)connect so the caller can catch up with /changes. `confirmed` is false when
   * the request is merely still open after 2 s: some engines hold fetch() back until the first body
   * chunk, which is the server's first ping, 30 s in. It is called again, confirmed, when that arrives.
   */
  onConnected?: (confirmed: boolean) => void;
  /** The server refused our credentials. Return false to keep trying (they may still be good); anything else stops the stream. */
  onUnauthorized?: () => boolean | void;
  /** The stream ended or could not be opened; a reconnect follows. */
  onDisconnected?: (error: unknown) => void;
}

/**
 * The server pings every 30 s (eventSourceUrl). A stream that has been silent for longer than two
 * pings is dead: a network that drops without closing the connection leaves it open for ever.
 */
const STALE_MS = 75_000;
const ASSUME_OPEN_MS = 2000;

/** Data types oinbox wants StateChange pushes for. */
export const PUSH_TYPES = 'Email,Mailbox,Thread,EmailDelivery,Calendar,CalendarEvent';

/**
 * Keep a JMAP push connection open, reconnecting with capped exponential backoff.
 * `wake` skips the rest of a backoff wait: the user pressed Retry, or the browser came back online.
 * `restart` drops the current stream and opens a new one: the browser says the network went away.
 */
export function openPushStream(client: JmapClient, opts: PushOptions): PushStream {
  let closed = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let wakeUp: (() => void) | null = null;

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      const stream = controller;
      let stale: ReturnType<typeof setTimeout> | undefined;
      const heard = () => {
        clearTimeout(stale);
        stale = setTimeout(() => stream.abort(), STALE_MS);
      };
      const assume = setTimeout(() => !closed && opts.onConnected?.(false), ASSUME_OPEN_MS);
      try {
        const res = await client.authFetch(client.eventSourceUrl(PUSH_TYPES), {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        clearTimeout(assume);
        if (!res.ok || !res.body) throw new Error(`push stream failed: ${res.status}`);
        attempt = 0;
        heard();
        opts.onConnected?.(true);
        const parser = new SseParser((e) => {
          if (e.event !== 'state') return;
          try {
            opts.onStateChange(JSON.parse(e.data) as StateChange);
          } catch {
            // Malformed event; the next state change will resync.
          }
        });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          heard();
          parser.push(value);
        }
        throw new Error('push stream closed');
      } catch (e) {
        clearTimeout(assume);
        clearTimeout(stale);
        if (closed) return;
        if (e instanceof UnauthorizedError && opts.onUnauthorized?.() !== false) return;
        opts.onDisconnected?.(e);
      }
      if (closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.5 + Math.random() / 2);
      await new Promise<void>((r) => {
        const t = setTimeout(r, delay);
        wakeUp = () => {
          clearTimeout(t);
          r();
        };
      });
      wakeUp = null;
    }
  };
  void run();

  return {
    close: () => {
      closed = true;
      controller?.abort();
      wakeUp?.();
    },
    wake: () => {
      attempt = 0;
      wakeUp?.();
    },
    restart: () => controller?.abort(),
  };
}
