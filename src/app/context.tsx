import { createContext, createSignal, useContext, type Accessor } from 'solid-js';
import type { Spaces } from './accounts';
import type { Actions, ToastFn } from './actions';
import type { Composers } from './composer';
import type { ErrorReporter } from './errors';
import type { Labels } from './labels';
import type { Drive } from './drive';
import type { Password } from './password';
import type { Recipients } from './recipients';
import type { Settings } from './settings';
import type { OAuth } from '../auth/oauth';
import type { CalendarStore } from '../calendar/store';
import { loadImageAllowList, saveImageAllowList } from '../cache/persist';
import type { JmapClient } from '../jmap/client';
import type { Connection } from '../sync/connection';
import type { MailEngine } from '../sync/engine';
import type { Nav } from '../ui/nav';

export type Theme = 'system' | 'light' | 'dark';

export interface App {
  client: JmapClient;
  /** Every mail account the user may open. The mail fields below are those of the one on screen. */
  spaces: Spaces;
  engine: MailEngine;
  calendar: CalendarStore;
  /** Whether the server offers JMAP Calendars (false until the session is known). */
  hasCalendars: () => boolean;
  auth: OAuth;
  toast: ToastFn;
  /** Where a caught error goes: the console and one toast. */
  errors: ErrorReporter;
  connection: Connection;
  /** Start the OAuth flow again, coming back to the current page. */
  signIn: () => void;
  actions: Actions;
  labels: Labels;
  settings: Settings;
  /** The user's own password, whichever account is on screen. */
  password: Password;
  /** OpenCloud as Drive, if this installation has one. The user's own, whichever mailbox is on screen. */
  drive: Drive;
  nav: Nav;
  composers: Composers;
  recipients: Recipients;
  images: ImagePrefs;
  theme: Accessor<Theme>;
  setTheme: (t: Theme) => void;
  isDark: Accessor<boolean>;
  signOut: () => void;
}

export const AppContext = createContext<App>();

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp outside AppContext');
  return app;
}

export interface ImagePrefs {
  allowed: (sender: string) => boolean;
  allow: (sender: string) => void;
}

export async function createImagePrefs(): Promise<ImagePrefs> {
  const [list, setList] = createSignal(new Set(await loadImageAllowList()));
  return {
    allowed: (sender) => list().has(sender.toLowerCase()),
    allow: (sender) => {
      const next = new Set(list()).add(sender.toLowerCase());
      setList(next);
      void saveImageAllowList([...next]);
    },
  };
}

export function createTheme() {
  const stored = (localStorage.getItem('oinbox.theme') as Theme | null) ?? 'system';
  const [theme, setThemeSignal] = createSignal<Theme>(stored);
  const media = matchMedia('(prefers-color-scheme: dark)');
  const [systemDark, setSystemDark] = createSignal(media.matches);
  media.addEventListener('change', (e) => setSystemDark(e.matches));
  const apply = (t: Theme) => {
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  apply(stored);
  return {
    theme,
    setTheme: (t: Theme) => {
      localStorage.setItem('oinbox.theme', t);
      setThemeSignal(t);
      apply(t);
    },
    isDark: () => (theme() === 'system' ? systemDark() : theme() === 'dark'),
  };
}
