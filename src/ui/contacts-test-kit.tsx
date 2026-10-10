// Shared by the contacts component tests: a real store over the fake server, inside the app context and a router.
import { MemoryRouter, Route, createMemoryHistory } from '@solidjs/router';
import { render } from '@solidjs/testing-library';
import { createRoot, type JSX } from 'solid-js';
import { vi } from 'vitest';
import { createContacts } from '../app/contacts';
import { AppContext, type App } from '../app/context';
import { FakeJmap } from '../sync/fake-jmap';

export const NOW = '2026-10-10T12:00:00Z';

export function contactsKit(extra: Partial<App> = {}) {
  const fake = new FakeJmap();
  const toast = vi.fn();
  let n = 0;
  const contacts = createRoot(() => createContacts(fake.client(), toast, { now: () => NOW, uid: () => `urn:uuid:test-${++n}`, saveDelayMs: 0 }));
  const draft = { update: vi.fn() };
  const composers = { open: vi.fn(() => draft) };
  const confirm = vi.fn(async () => true);
  const info = { id: 'a1', address: 'alice@example.test', personal: true, label: 'You', base: '' };
  const app = {
    contacts, toast, composers, confirm,
    hasContacts: () => true,
    spaces: { current: () => ({ info }) },
    directory: { entries: () => [] },
    ...extra,
  } as unknown as App;
  const history = createMemoryHistory();
  /** Render `routes` (Route elements) at `path`. */
  const show = (path: string, routes: () => JSX.Element) => {
    history.set({ value: path });
    return render(() => (
      <AppContext.Provider value={app}>
        <MemoryRouter history={history}>{routes()}</MemoryRouter>
      </AppContext.Provider>
    ));
  };
  const path = () => history.get();
  return { fake, contacts, toast, composers, draft, confirm, app, show, path, Route };
}
