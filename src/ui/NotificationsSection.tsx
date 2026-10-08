import { Switch } from '@rozie-ui/switch-solid';
import { Show } from 'solid-js';
import { branding } from '../app/branding';
import { notifications, type NotifyPrefs } from '../app/notify';

export function NotificationsSection(props: { prefs?: NotifyPrefs }) {
  const prefs = () => props.prefs ?? notifications.prefs;
  return (
    <section class="settings-section" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading">Notifications</h2>
      <Show when={prefs().supported} fallback={<p class="settings-note">This browser doesn't support desktop notifications.</p>}>
        <div class="switch-row">
          {/* The click that flips the switch is what lets the browser ask for permission. */}
          <Switch id="notify-enabled" modelValue={prefs().enabled()} onModelValueChange={(v: boolean) => void prefs().setEnabled(v)} />
          <label for="notify-enabled">Desktop notifications for new mail</label>
        </div>
        <Show when={prefs().blocked()}>
          <p class="settings-note" role="status">Your browser is blocking notifications for this site. Allow them in the browser's site settings, then switch this on.</p>
        </Show>
        <p class="settings-note">Shown for new mail in your Inbox while {branding().name} is open in a tab you're not looking at. This setting is for this browser only.</p>
      </Show>
    </section>
  );
}
