import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError, UnauthorizedError } from '../jmap/client';
import { createConnection, isTransportFailure, WAKE_GRACE_MS } from './connection';

const net = () => new TypeError('Failed to fetch');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('isTransportFailure', () => {
  it('counts network errors, timeouts and gateway errors only', () => {
    expect(isTransportFailure(net())).toBe(true);
    expect(isTransportFailure(new RequestError(0, 'timeout'))).toBe(true);
    for (const s of [502, 503, 504]) expect(isTransportFailure(new RequestError(s, ''))).toBe(true);
    for (const s of [400, 403, 404, 413, 500]) expect(isTransportFailure(new RequestError(s, ''))).toBe(false);
    expect(isTransportFailure(new UnauthorizedError())).toBe(false);
    expect(isTransportFailure(new Error('Email/set failed: invalidArguments'))).toBe(false);
    expect(isTransportFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('createConnection', () => {
  it('ignores one blip', () => {
    const c = createConnection();
    c.reportFailure('request', net());
    expect(c.state()).toBe('ok');
    vi.advanceTimersByTime(2000);
    c.reportSuccess('request');
    vi.advanceTimersByTime(5000);
    expect(c.state()).toBe('ok');
  });

  it('shows after two failures in a row', () => {
    const c = createConnection();
    c.reportFailure('request', net());
    c.reportFailure('push', new Error('stream closed'));
    expect(c.state()).toBe('retrying');
  });

  it('shows after one failure that lasts 3 seconds', () => {
    const c = createConnection();
    c.reportFailure('push', new Error('stream closed'));
    vi.advanceTimersByTime(2999);
    expect(c.state()).toBe('ok');
    vi.advanceTimersByTime(1);
    expect(c.state()).toBe('retrying');
  });

  it('ignores request failures that are not transport failures', () => {
    const c = createConnection();
    c.reportFailure('request', new RequestError(400, 'bad'));
    c.reportFailure('request', new Error('method error'));
    vi.advanceTimersByTime(10_000);
    expect(c.state()).toBe('ok');
  });

  it('recovers on the first success and tells listeners once', () => {
    const c = createConnection();
    const recovered = vi.fn();
    c.onRecovered(recovered);
    c.reportFailure('request', net());
    c.reportFailure('request', net());
    c.reportSuccess('push');
    c.reportSuccess('request');
    expect(c.state()).toBe('ok');
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('does not flicker while the connection flaps', () => {
    const c = createConnection();
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      c.reportFailure('request', net());
      seen.push(c.state());
      vi.advanceTimersByTime(1000);
      c.reportSuccess('request');
      seen.push(c.state());
      vi.advanceTimersByTime(1000);
    }
    expect(new Set(seen)).toEqual(new Set(['ok']));
  });

  it('retries with capped backoff while retrying, and at once on retryNow', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    c.reportFailure('request', net());
    c.reportFailure('request', net());
    vi.advanceTimersByTime(1000);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(retry).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10 * 60_000);
    const calls = retry.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(20); // capped at 30 s
    expect(calls).toBeLessThanOrEqual(26);
    c.retryNow();
    expect(retry).toHaveBeenCalledTimes(calls + 1);
    c.reportSuccess('request');
    vi.advanceTimersByTime(60_000);
    expect(retry).toHaveBeenCalledTimes(calls + 1);
  });

  it('stays signed out whatever is reported afterwards', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    c.signedOut();
    c.reportSuccess('request');
    c.reportFailure('request', net());
    c.reportFailure('request', net());
    vi.advanceTimersByTime(60_000);
    expect(c.state()).toBe('signed-out');
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('createConnection, by source', () => {
  it('stays up while one source keeps failing, however often the other succeeds', () => {
    const c = createConnection();
    const seen = new Set<string>();
    c.reportFailure('push', new Error('closed'));
    c.reportFailure('push', new Error('closed'));
    for (let i = 0; i < 10; i++) {
      c.reportSuccess('request');
      seen.add(c.state());
      c.reportFailure('push', new Error('closed'));
      seen.add(c.state());
      vi.advanceTimersByTime(1000);
    }
    expect([...seen]).toEqual(['retrying']);
    c.reportSuccess('push');
    expect(c.state()).toBe('ok');
  });

  it('tells retry listeners whether a person asked', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    c.reportFailure('request', net());
    c.reportFailure('request', net());
    vi.advanceTimersByTime(1000);
    expect(retry).toHaveBeenLastCalledWith(false);
    c.retryNow();
    expect(retry).toHaveBeenLastCalledWith(true);
  });
});

// Away from the tab, failures pile up unseen (sleep, a Wi-Fi change) and a background tab's
// timers run about once a minute, so a banner raised then outlives the outage.
describe('createConnection, while the tab is hidden', () => {
  it('shows nothing for failures while hidden, however many or long', () => {
    const c = createConnection();
    c.setVisible(false);
    for (let i = 0; i < 5; i++) c.reportFailure('push', new Error('closed'));
    c.reportFailure('request', net());
    vi.advanceTimersByTime(10 * 60_000);
    expect(c.state()).toBe('ok');
  });

  it('retries at once on return and gives the network the wake grace before showing', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    c.setVisible(false);
    c.reportFailure('push', new Error('closed'));
    c.setVisible(true);
    expect(retry).toHaveBeenCalledWith(true);
    // The network is still coming back: fast failures do not show the banner yet.
    c.reportFailure('push', net());
    c.reportFailure('request', net());
    vi.advanceTimersByTime(WAKE_GRACE_MS - 1);
    expect(c.state()).toBe('ok');
    vi.advanceTimersByTime(1);
    expect(c.state()).toBe('retrying');
  });

  it('stays quiet when the retry on return works', () => {
    const c = createConnection();
    c.setVisible(false);
    c.reportFailure('push', new Error('closed'));
    c.setVisible(true);
    c.reportSuccess('push');
    vi.advanceTimersByTime(60_000);
    expect(c.state()).toBe('ok');
  });

  it('retries at once on return when the banner was already up', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    c.reportFailure('push', new Error('closed'));
    c.reportFailure('push', new Error('closed'));
    expect(c.state()).toBe('retrying');
    c.setVisible(false);
    retry.mockClear();
    c.setVisible(true);
    expect(retry).toHaveBeenCalledWith(true);
    c.reportSuccess('push');
    expect(c.state()).toBe('ok');
  });

  it('does nothing on return when all was well', () => {
    const c = createConnection();
    const retry = vi.fn();
    c.onRetry(retry);
    c.setVisible(false);
    c.setVisible(true);
    expect(retry).not.toHaveBeenCalled();
    c.reportFailure('push', new Error('closed'));
    c.reportFailure('push', new Error('closed'));
    expect(c.state()).toBe('retrying');
  });

  it('hidden again during the wake grace, a later return still shows a lasting failure', () => {
    const c = createConnection();
    c.setVisible(false);
    c.reportFailure('push', new Error('closed'));
    c.setVisible(true);
    c.setVisible(false);
    c.reportSuccess('push');
    c.setVisible(true);
    c.reportFailure('push', new Error('closed'));
    c.reportFailure('push', new Error('closed'));
    expect(c.state()).toBe('retrying');
  });
});

// Firefox holds a streamed fetch back until its first chunk: the server's first ping, 30 s in.
// A reopened stream is not a failure, though only a server answer takes the banner down.
describe('createConnection, a reopened push stream', () => {
  it('back from hidden, an open stream does not show the banner when the wake grace ends', () => {
    const c = createConnection();
    c.setVisible(false);
    c.reportFailure('push', net());
    c.setVisible(true);
    c.reportOpen('push');
    c.reportSuccess('request');
    vi.advanceTimersByTime(WAKE_GRACE_MS + 60_000);
    expect(c.state()).toBe('ok');
  });

  it('takes the banner down at the next answer from the server', () => {
    const c = createConnection();
    c.reportFailure('push', net());
    c.reportFailure('push', net());
    expect(c.state()).toBe('retrying');
    c.reportOpen('push');
    expect(c.state()).toBe('retrying');
    c.reportSuccess('request');
    expect(c.state()).toBe('ok');
  });

  it('a stream that fails again counts as failing again', () => {
    const c = createConnection();
    c.reportFailure('push', net());
    c.reportFailure('push', net());
    c.reportOpen('push');
    c.reportFailure('push', net());
    c.reportSuccess('request');
    expect(c.state()).toBe('retrying');
  });
});
