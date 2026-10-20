import { describe, expect, it } from 'vitest';
import { checksOf, headersOf, shownSource, SHOWN_CHARS } from './original';

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

/** The headers Stalwart wrote on a real message that went to Junk, with the names changed. */
const junk = crlf(`X-Spam-Status: Yes
Authentication-Results: mail.example.test;
\tdkim=pass header.d=google.com header.s=20251104 header.b=A/DNxNUb;
\tdkim=pass header.d=sender-com.gappssmtp.com header.s=20251104 header.b=fNaP66BT;
\tspf=none (mail.example.test: no SPF records found for postmaster@relay.example.test) smtp.helo=relay.example.test;
\tspf=softfail (mail.example.test: domain of pat@sender.example reports soft fail for 10.10.1.127) smtp.mailfrom=pat@sender.example;
\tiprev=pass policy.iprev=10.10.1.127;
\tdmarc=fail (policy not aligned) header.from=sender.example policy.dmarc=none
Received-SPF: softfail (mail.example.test: domain of pat@sender.example reports soft fail for 10.10.1.127)
\treceiver=mail.example.test; client-ip=10.10.1.127; envelope-from="pat@sender.example"; helo=relay.example.test;
X-Spam-Result: DKIM_ALLOW (-0.20),
\tARC_NA (0.00),
\tDMARC_POLICY_SOFTFAIL (0.10),
\tHELO_IPREV_MISMATCH (1.00),
\tRCPT_IN_SUBJECT (3.00),
\tVIOLATED_DIRECT_SPF (3.50)
X-Spam-Score: spam, score=9.40
Authentication-Results: relay.example.test;
 spf=pass (spfCheck: domain of sender.example designates 209.85.218.70 as permitted sender) client-ip=209.85.218.70;
 dkim=pass header.i=@sender.example;
 dmarc=pass header.from=sender.example;
From: Pat <pat@sender.example>
Subject: Website

Body: not a header
`);

describe('headersOf', () => {
  it('reads the header lines, unfolded, and stops at the body', () => {
    const h = headersOf(junk);
    expect(h[0]).toEqual({ name: 'X-Spam-Status', value: 'Yes' });
    expect(h[1]!.name).toBe('Authentication-Results');
    expect(h[1]!.value).toMatch(/^mail\.example\.test; dkim=pass header\.d=google\.com .* policy\.dmarc=none$/);
    expect(h.map((x) => x.name)).not.toContain('Body');
    expect(h.at(-1)).toEqual({ name: 'Subject', value: 'Website' });
  });

  it('takes bare newlines too', () => {
    expect(headersOf('A: 1\nB: 2\n\nbody')).toEqual([{ name: 'A', value: '1' }, { name: 'B', value: '2' }]);
  });
});

describe('checksOf', () => {
  it("reads SPF, DKIM and DMARC from the topmost Authentication-Results, the one Stalwart added", () => {
    const c = checksOf(headersOf(junk));
    expect(c.spf).toEqual({ result: 'softfail', detail: 'with IP 10.10.1.127' });
    expect(c.dkim).toEqual([
      { result: 'pass', detail: 'with domain google.com' },
      { result: 'pass', detail: 'with domain sender-com.gappssmtp.com' },
    ]);
    expect(c.dmarc).toEqual({ result: 'fail', detail: 'policy not aligned' });
  });

  it('reads the spam verdict, the score and the rules that added to it, largest first', () => {
    expect(checksOf(headersOf(junk)).spam).toEqual({
      spam: true,
      score: '9.40',
      rules: [
        { name: 'VIOLATED_DIRECT_SPF', score: 3.5 },
        { name: 'RCPT_IN_SUBJECT', score: 3 },
        { name: 'HELO_IPREV_MISMATCH', score: 1 },
        { name: 'DMARC_POLICY_SOFTFAIL', score: 0.1 },
        { name: 'DKIM_ALLOW', score: -0.2 },
      ],
    });
  });

  it('reads a message that is not spam', () => {
    const c = checksOf(headersOf('X-Spam-Status: No\nX-Spam-Score: ham, score=-1.20\n\n'));
    expect(c.spam).toEqual({ spam: false, score: '-1.20', rules: [] });
  });

  it('leaves out what the message does not say', () => {
    expect(checksOf(headersOf('From: me@example.test\n\nhi'))).toEqual({ dkim: [] });
  });

  it('leaves out a check that is "none", as Stalwart writes with its checks off', () => {
    expect(checksOf(headersOf('Authentication-Results: mail.example.test; none\n\n'))).toEqual({ dkim: [] });
  });

  it('takes the helo SPF result when there is no mail-from one, and names the domain when there is no IP', () => {
    const c = checksOf(headersOf('Authentication-Results: mx; spf=pass smtp.helo=relay.example\n\n'));
    expect(c.spf).toEqual({ result: 'pass', detail: 'with domain relay.example' });
  });

  it('falls back to Received-SPF for SPF', () => {
    const c = checksOf(headersOf('Received-SPF: softfail (x) client-ip=198.51.100.1; envelope-from=a@b\n\n'));
    expect(c.spf).toEqual({ result: 'softfail', detail: 'with IP 198.51.100.1' });
  });
});

describe('shownSource', () => {
  it('shows a small message whole', () => {
    expect(shownSource('abc')).toEqual({ text: 'abc', cut: false });
  });

  it('cuts a large one short', () => {
    const s = shownSource('x'.repeat(SHOWN_CHARS + 10));
    expect(s.cut).toBe(true);
    expect(s.text.length).toBe(SHOWN_CHARS);
  });
});
