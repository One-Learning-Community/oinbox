import { fireEvent, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it } from 'vitest';
import { createNotifyPrefs, type NotificationApi } from '../app/notify';
import { NotificationsSection } from './NotificationsSection';

const api = (permission: NotificationPermission, answer: NotificationPermission = permission): NotificationApi => {
  const a: NotificationApi = {
    permission,
    requestPermission: () => Promise.resolve((a.permission = answer)),
    show: () => ({ onclick: null }),
  };
  return a;
};

beforeEach(() => localStorage.clear());

describe('NotificationsSection', () => {
  it('turns notifications on when the browser agrees', async () => {
    const prefs = createNotifyPrefs(localStorage, api('default', 'granted'));
    const { getByRole } = render(() => <NotificationsSection prefs={prefs} />);
    const toggle = getByRole('switch', { name: 'Desktop notifications for new mail' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(prefs.enabled()).toBe(true);
  });
  it('stays off and explains when the browser refuses', async () => {
    const prefs = createNotifyPrefs(localStorage, api('default', 'denied'));
    const { getByRole, findByText } = render(() => <NotificationsSection prefs={prefs} />);
    const toggle = getByRole('switch');
    fireEvent.click(toggle);
    expect(await findByText(/Your browser is blocking notifications/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
  it('says so where the browser has no notifications, and offers no switch', () => {
    const prefs = createNotifyPrefs(localStorage, undefined);
    const { queryByRole, getByText } = render(() => <NotificationsSection prefs={prefs} />);
    expect(queryByRole('switch')).toBeNull();
    expect(getByText(/This browser doesn't support desktop notifications/)).toBeInTheDocument();
  });
});
