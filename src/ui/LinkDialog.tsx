import { Dialog } from '@rozie-ui/dialog-solid';
import { createSignal, For, onMount, Show } from 'solid-js';
import { useApp } from '../app/context';
import type { LinkRequest } from '../app/driveLinks';
import { DriveError, type SharingRules } from '../drive/client';
import { checkPassword, generatePassword, policyText } from '../drive/password';
import { fileSize } from '../mail/format';

/** Files too large for the message: send them as a link to the user's Drive, or attach them anyway. */
export function LinkDialog() {
  const { driveLinks } = useApp();
  return (
    <Show when={driveLinks.request()} keyed>
      {(req) => <Ask req={req} />}
    </Show>
  );
}

/** The expiries on offer, in days; null is never. A limit the server enforces narrows them. */
const expiries = (max: number | null): (number | null)[] => {
  if (!max) return [7, 30, 90, null];
  const within = [7, 30, 90].filter((d) => d < max);
  return [...within, max];
};

function Ask(props: { req: LinkRequest }) {
  const { driveLinks: links } = useApp();
  const req = props.req;
  const [rules, setRules] = createSignal<SharingRules | null>(null);
  const [rulesError, setRulesError] = createSignal('');
  const [password, setPassword] = createSignal('');
  /** The field has been left, or sending tried: time to say what is wrong with it. */
  const [tried, setTried] = createSignal(false);
  const [include, setInclude] = createSignal(true);
  const [expiry, setExpiry] = createSignal<number | null>(30);
  /** From the press of the button until that try has ended: the first seconds show no progress yet. */
  const [sending, setSending] = createSignal(false);

  const loadRules = async () => {
    setRulesError('');
    try {
      const r = await links.loadRules();
      setRules(r);
      const offered = expiries(r.maxExpiryDays);
      if (!offered.includes(expiry())) setExpiry(offered.at(-1)!);
    } catch (e) {
      setRulesError(e instanceof DriveError && e.kind !== 'other' ? "Drive isn't available right now." : `Couldn't ask Drive what a link needs: ${(e as Error).message}`);
    }
  };
  // A message that has its link already has its password too: there is nothing to ask.
  onMount(() => !req.adding && void loadRules());

  const busy = () => !!links.progress();
  const problem = () => {
    const r = rules();
    if (!r) return '';
    if (!password()) return r.passwordRequired ? 'A password is required.' : '';
    return checkPassword(password(), r.policy);
  };
  const names = req.sources.map((s) => s.name).join(', ');
  const them = req.sources.length === 1 ? 'it' : 'them';

  const send = (e: SubmitEvent) => {
    e.preventDefault();
    setTried(true);
    if (sending() || busy() || !rules() || problem()) return;
    setSending(true);
    void links.send({ password: password(), includePassword: include(), expiryDays: expiry() }).finally(() => setSending(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && links.cancel()} ariaLabelledby="link-dialog-title">
      <form class="link-dialog" onSubmit={send}>
        <h2 id="link-dialog-title">Send as a Drive link</h2>
        <p class="link-files">
          <strong>{names}</strong> ({fileSize(req.bytes)}){' '}
          <Show when={!req.adding} fallback={<span>Adding to this message's Drive link.</span>}>
            {req.canAttach
              ? `is a lot to attach to a message. Send a link to ${them} in your Drive instead?`
              : `is more than the mail server accepts. Send a link to ${them} in your Drive instead.`}
          </Show>
        </p>

        <Show when={links.progress()}>
          {(p) => (
            <div class="link-progress">
              <p role="status">
                Uploading {p().name} ({p().index} of {p().count})
              </p>
              <progress max="1" value={p().fraction} aria-label="Upload progress" />
            </div>
          )}
        </Show>

        <Show when={!req.adding && !busy()}>
          <Show when={!rulesError()} fallback={
            <p class="field-error" role="alert">
              {rulesError()} <button type="button" class="link-btn" onClick={() => void loadRules()}>Try again</button>
            </p>
          }>
            <Show when={rules()} fallback={<p role="status">Asking Drive what a link needs…</p>}>
              {(r) => (
                <>
                  <label class="link-field">
                    <span>Password{r().passwordRequired ? '' : ' (optional)'}</span>
                    <span class="link-password">
                      <input
                        type="text"
                        autocomplete="off"
                        spellcheck={false}
                        required={r().passwordRequired}
                        value={password()}
                        aria-invalid={tried() && problem() ? 'true' : undefined}
                        aria-describedby="link-policy link-password-error"
                        onInput={(e) => setPassword(e.currentTarget.value)}
                        onBlur={() => setTried(true)}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setPassword(generatePassword(r().policy));
                          setTried(true);
                        }}
                      >
                        Generate
                      </button>
                    </span>
                  </label>
                  <p class="label-hint" id="link-policy">{policyText(r().policy)}</p>
                  <Show when={tried() && problem()}>
                    <p class="field-error" id="link-password-error" role="alert">{problem()}</p>
                  </Show>

                  <Show when={password()}>
                    <fieldset class="link-delivery">
                      <legend>How the recipient gets the password</legend>
                      <label>
                        <input type="radio" name="link-delivery" checked={include()} onChange={() => setInclude(true)} /> Put it in the message
                      </label>
                      <label>
                        <input type="radio" name="link-delivery" checked={!include()} onChange={() => setInclude(false)} /> I'll send it another way
                      </label>
                      <Show when={!include()}>
                        <p class="label-hint">
                          Copy it now, or later: it stays available on the sent message for 30 minutes, in this tab only.{' '}
                          <button type="button" class="link-btn" onClick={() => void navigator.clipboard?.writeText(password())}>Copy</button>
                        </p>
                      </Show>
                    </fieldset>
                  </Show>

                  <label class="link-field">
                    <span>The link expires</span>
                    <select value={expiry() ?? 'never'} onChange={(e) => setExpiry(e.currentTarget.value === 'never' ? null : Number(e.currentTarget.value))}>
                      <For each={expiries(r().maxExpiryDays)}>
                        {(d) => <option value={d ?? 'never'}>{d ? `In ${d} days` : 'Never'}</option>}
                      </For>
                    </select>
                  </label>
                </>
              )}
            </Show>
          </Show>
        </Show>

        <Show when={links.error()}>
          <p class="field-error" role="alert">{links.error()}</p>
        </Show>

        <div class="dialog-actions">
          <button type="button" onClick={() => links.cancel()}>Cancel</button>
          <Show when={req.canAttach && !req.adding && !busy()}>
            <button type="button" onClick={() => links.attachAnyway()}>Attach anyway</button>
          </Show>
          <Show when={!req.adding && !busy()}>
            <button type="submit" class="primary" disabled={!rules() || !!problem() || sending()}>Send as a link</button>
          </Show>
          <Show when={req.adding && !busy() && links.error()}>
            <button type="button" class="primary" onClick={() => void links.send()}>Retry</button>
          </Show>
        </div>
      </form>
    </Dialog>
  );
}
