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

export interface PushOptions {
  onStateChange: (change: StateChange) => void;
  /** Called after every (re)connect so the caller can catch up with /changes. */
  onConnected?: () => void;
  onUnauthorized?: () => void;
}

/**
 * Keep a JMAP push connection open, reconnecting with capped exponential backoff.
 * Returns a function that closes it.
 */
export function openPushStream(client: JmapClient, opts: PushOptions): () => void {
  let closed = false;
  let controller: AbortController | null = null;
  let attempt = 0;

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        const res = await client.authFetch(client.eventSourceUrl('Email,Mailbox,Thread,EmailDelivery'), {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`push stream failed: ${res.status}`);
        attempt = 0;
        opts.onConnected?.();
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
          parser.push(value);
        }
      } catch (e) {
        if (closed) return;
        if (e instanceof UnauthorizedError) {
          opts.onUnauthorized?.();
          return;
        }
      }
      if (closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.5 + Math.random() / 2);
      await new Promise((r) => setTimeout(r, delay));
    }
  };
  void run();

  return () => {
    closed = true;
    controller?.abort();
  };
}
