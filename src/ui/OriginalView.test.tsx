import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext, type App } from '../app/context';
import type { EmailRec } from '../sync/engine';
import { emlName, OriginalView } from './OriginalView';

const RAW = [
  'Authentication-Results: mail.example.test;',
  '\tdkim=pass header.d=sender.example;',
  '\tspf=softfail (mail.example.test: domain of pat@sender.example reports soft fail for 10.0.0.1) smtp.mailfrom=pat@sender.example;',
  '\tdmarc=fail (policy not aligned) header.from=sender.example',
  'X-Spam-Status: Yes',
  'X-Spam-Score: spam, score=9.40',
  'X-Spam-Result: RCPT_IN_SUBJECT (3.00), ARC_NA (0.00)',
  'From: Pat <pat@sender.example>',
  'Subject: Website',
  '',
  'Hello',
].join('\r\n');

const email = {
  id: 'e1',
  blobId: 'raw-1',
  subject: 'Website: v2/final?',
  messageId: ['m1@sender.example'],
  from: [{ name: 'Pat', email: 'pat@sender.example' }],
  to: [{ name: null, email: 'alice@example.test' }],
  receivedAt: '2026-10-18T09:14:02Z',
} as unknown as EmailRec;

function setup(fetchBlob = vi.fn(async () => new Blob([RAW]))) {
  const onClose = vi.fn();
  const toast = vi.fn();
  const app = { engine: { fetchBlob }, toast } as unknown as App;
  render(() => (
    <AppContext.Provider value={app}>
      <OriginalView email={email} onClose={onClose} />
    </AppContext.Provider>
  ));
  return { fetchBlob, onClose, toast };
}

afterEach(cleanup);

describe('OriginalView', () => {
  it("shows the message's details, what Stalwart's checks found, and its source", async () => {
    const { fetchBlob } = setup();
    expect(fetchBlob).toHaveBeenCalledWith('raw-1', 'Website v2 final.eml', 'message/rfc822');
    const source = await screen.findByLabelText('Message source');
    expect(source.textContent).toBe(RAW);
    const row = (label: string) => screen.getByRole('rowheader', { name: label }).nextElementSibling!.textContent;
    expect(row('Message ID')).toBe('<m1@sender.example>');
    expect(row('From')).toBe('Pat <pat@sender.example>');
    expect(row('To')).toBe('alice@example.test');
    expect(row('SPF')).toBe('SOFTFAIL with IP 10.0.0.1');
    expect(row('DKIM')).toBe('PASS with domain sender.example');
    expect(row('DMARC')).toBe('FAIL policy not aligned');
    expect(row('Spam')).toBe('SPAM, score 9.40RCPT_IN_SUBJECT +3');
  });

  it('leaves out the checks a message has none of', async () => {
    setup(vi.fn(async () => new Blob(['From: me@example.test\r\n\r\nhi'])));
    await screen.findByLabelText('Message source');
    expect(screen.queryByRole('rowheader', { name: 'SPF' })).toBeNull();
    expect(screen.queryByRole('rowheader', { name: 'Spam' })).toBeNull();
  });

  it('says so when the message cannot be loaded', async () => {
    setup(vi.fn(async () => { throw new Error('404'); }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });

  it('copies the source, and closes', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { onClose, toast } = setup();
    await screen.findByLabelText('Message source');
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(RAW));
    expect(toast).toHaveBeenCalledWith('Copied to the clipboard');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('emlName', () => {
  it('names the file after the subject', () => {
    expect(emlName({ id: 'x', subject: 'a/b' } as EmailRec)).toBe('a b.eml');
    expect(emlName({ id: 'x', subject: '' } as EmailRec)).toBe('message.eml');
  });
});
