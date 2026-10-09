// Test-side helpers for OpenCloud behind the dev stack's /drive prefix.
import type { Page } from '@playwright/test';
import { BASE, waitFor } from './mail';

/** Whether this stack runs OpenCloud (it was started with deploy/docker-compose.drive.yml). CI's does not. */
export async function driveOn(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/drive.json`);
    return res.ok && ((await res.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    // Unreachable, or a stack that answers with the app page: no Drive.
    return false;
  }
}

/** The signed-in page's access token: OpenCloud takes no Basic auth, only what Stalwart issued. */
export const driveToken = (page: Page): Promise<string> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('oinbox.tokens') ?? '{}') as { accessToken: string }).accessToken);

export const driveFetch = (token: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}/drive${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });

export interface DriveEntry {
  id: string;
  name: string;
  size: number;
  folder?: object;
}

export async function driveId(token: string): Promise<string> {
  const res = await driveFetch(token, '/graph/v1.0/me/drive');
  if (!res.ok) throw new Error(`drive: HTTP ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** A folder's entries; the top folder when no id is given. */
export async function driveChildren(token: string, itemId?: string): Promise<DriveEntry[]> {
  const path = itemId
    ? `/graph/v1.0/drives/${encodeURIComponent(await driveId(token))}/items/${encodeURIComponent(itemId)}/children`
    : '/graph/v1.0/me/drive/root/children';
  const res = await driveFetch(token, path);
  if (!res.ok) throw new Error(`children: HTTP ${res.status}`);
  return ((await res.json()) as { value: DriveEntry[] }).value;
}

export async function removeFromDrive(token: string, path: string[]): Promise<void> {
  const res = await driveFetch(token, `/dav/spaces/${encodeURIComponent(await driveId(token))}/${path.map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`delete ${path.join('/')}: HTTP ${res.status}`);
}

/** OpenCloud starts after Caddy and takes a while the first time. */
export const waitForDrive = (token: string): Promise<boolean> =>
  waitFor(() => driveFetch(token, '/graph/v1.0/me/drive').then((r) => r.ok, () => false), 120_000, 'OpenCloud to answer');
