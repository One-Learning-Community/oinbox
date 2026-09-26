import { describe, expect, it } from 'vitest';
import { SseParser } from './sse';

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
