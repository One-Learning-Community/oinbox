import { useLocation } from '@solidjs/router';
import { withinAccount } from '../app/accounts';
import { useApp } from '../app/context';

/**
 * The address inside the open mailbox: "/inbox", "/search/…", whichever account is on screen. The
 * router's own pathname includes a shared mailbox's base (/shared/<id>), so it is never to be
 * matched against the app's routes directly.
 */
export function useAccountPath(): () => string {
  const info = useApp().spaces.current().info;
  const location = useLocation();
  return () => withinAccount(location.pathname, info);
}
