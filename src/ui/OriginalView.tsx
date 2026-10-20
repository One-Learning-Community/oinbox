import { Dialog } from '@rozie-ui/dialog-solid';
import { createResource, For, Show, type JSX } from 'solid-js';
import { useApp } from '../app/context';
import { fullDate } from '../mail/format';
import { checksOf, headersOf, shownSource, type Check } from '../mail/original';
import type { EmailAddress } from '../jmap/types';
import type { EmailRec } from '../sync/engine';
import { Icon } from './icons';

const RAW_TYPE = 'message/rfc822';

/** A name to save the message under: its subject, made safe for any file system. */
export function emlName(email: EmailRec): string {
  const base = (email.subject ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${base || 'message'}.eml`;
}

/** Save a message's raw bytes as an .eml file. */
export async function downloadOriginal(fetchBlob: (blobId: string, name: string, type: string) => Promise<Blob>, email: EmailRec): Promise<void> {
  const name = emlName(email);
  const url = URL.createObjectURL(await fetchBlob(email.blobId!, name, RAW_TYPE));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const addresses = (list: EmailAddress[] | null | undefined) =>
  (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');

const tone = (result: string) => (result === 'pass' ? 'ok' : /fail|permerror|temperror/.test(result) ? 'bad' : 'other');

function CheckRow(props: { label: string; check: Check }) {
  return (
    <Row label={props.label}>
      <b class={`original-check ${tone(props.check.result)}`}>{props.check.result.toUpperCase()}</b>
      <Show when={props.check.detail}>{(d) => ` ${d()}`}</Show>
    </Row>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <tr>
      <th scope="row">{props.label}</th>
      <td>{props.children}</td>
    </tr>
  );
}

/** A message as the server holds it: what its checks found, then every byte of it. Full screen. */
export function OriginalView(props: { email: EmailRec; onClose: () => void }) {
  const { engine, toast } = useApp();
  const fetchBlob = (blobId: string, name: string, type: string) => engine.fetchBlob(blobId, name, type);
  const [raw] = createResource(
    () => props.email.blobId,
    // null: it could not be loaded. A rejected resource would throw wherever it is read.
    (blobId) =>
      fetchBlob(blobId, emlName(props.email), RAW_TYPE)
        .then((b) => b.arrayBuffer())
        .then((bytes) => new TextDecoder().decode(bytes), () => null),
  );
  const checks = () => {
    const r = raw();
    return r == null ? undefined : checksOf(headersOf(r));
  };

  const download = () => void downloadOriginal(fetchBlob, props.email).catch((e) => toast(`Download failed: ${String(e)}`, 'error'));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw() ?? '');
      toast('Copied to the clipboard');
    } catch (e) {
      toast(`Couldn't copy: ${String(e)}`, 'error');
    }
  };

  return (
    <Dialog open class="original-view" ariaLabelledby="original-title" initialFocus=".original-close" onOpenChange={(open) => !open && props.onClose()}>
      <header class="original-bar">
        <h2 id="original-title">Original message</h2>
        <button type="button" class="btn tonal" onClick={download}>
          <Icon name="download" /> Download original
        </button>
        <button type="button" class="btn tonal" disabled={raw() == null} onClick={() => void copy()}>
          Copy to clipboard
        </button>
        <button type="button" class="icon-btn original-close" title="Close" onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </header>
      <div class="original-body">
        <table class="original-summary">
          <tbody>
            <Show when={props.email.messageId?.[0]}>{(id) => <Row label="Message ID">{`<${id()}>`}</Row>}</Show>
            <Show when={props.email.sentAt ?? props.email.receivedAt}>{(at) => <Row label="Created at">{fullDate(at())}</Row>}</Show>
            <Show when={addresses(props.email.from)}>{(v) => <Row label="From">{v()}</Row>}</Show>
            <Show when={addresses(props.email.to)}>{(v) => <Row label="To">{v()}</Row>}</Show>
            <Show when={addresses(props.email.cc)}>{(v) => <Row label="Cc">{v()}</Row>}</Show>
            <Row label="Subject">{props.email.subject || '(no subject)'}</Row>
            <Show when={checks()}>
              {(c) => (
                <>
                  <Show when={c().spf}>{(spf) => <CheckRow label="SPF" check={spf()} />}</Show>
                  <For each={c().dkim}>{(dkim) => <CheckRow label="DKIM" check={dkim} />}</For>
                  <Show when={c().dmarc}>{(dmarc) => <CheckRow label="DMARC" check={dmarc()} />}</Show>
                  <Show when={c().spam}>
                    {(spam) => (
                      <Row label="Spam">
                        <b class={`original-check ${spam().spam ? 'bad' : 'ok'}`}>{spam().spam ? 'SPAM' : 'NOT SPAM'}</b>
                        <Show when={spam().score}>{(s) => `, score ${s()}`}</Show>
                        <Show when={spam().rules.length}>
                          <ul class="original-rules">
                            <For each={spam().rules}>
                              {(r) => (
                                <li>
                                  <code>{r.name}</code> {r.score > 0 ? `+${r.score}` : String(r.score)}
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </Row>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </tbody>
        </table>
        <Show
          when={raw() != null ? shownSource(raw()!) : undefined}
          fallback={
            raw() === null ? (
              <p role="alert">This message could not be loaded. You can still try to download it.</p>
            ) : (
              <p role="status">Loading…</p>
            )
          }
        >
          {(shown) => (
            <>
              <Show when={shown().cut}>
                <p class="original-cut" role="note">
                  This message is too large to show in full. Download it to see the rest.
                </p>
              </Show>
              <pre class="original-source" tabindex="0" aria-label="Message source">{shown().text}</pre>
            </>
          )}
        </Show>
      </div>
    </Dialog>
  );
}
