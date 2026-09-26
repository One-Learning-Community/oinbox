import { createContext, createSignal, useContext, type Accessor } from 'solid-js';
import type { Actions, ToastFn } from './actions';
import type { OAuth } from '../auth/oauth';
import { loadImageAllowList, saveImageAllowList } from '../cache/persist';
import type { JmapClient } from '../jmap/client';
import type { MailEngine } from '../sync/engine';
import type { Nav } from '../ui/nav';

export type Theme = 'system' | 'light' | 'dark';

export interface App {
  client: JmapClient;
  engine: MailEngine;
  auth: OAuth;
  toast: ToastFn;
  actions: Actions;
  nav: Nav;
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
