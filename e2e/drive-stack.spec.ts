import { expect, test } from '@playwright/test';
import { openInbox } from './support/app';
import { driveFetch, driveOn, driveToken, waitForDrive } from './support/drive';
import { BASE } from './support/mail';

// The /drive route itself (deploy/routes.caddy). The default stack and CI have no OpenCloud; a stack
// started with deploy/docker-compose.drive.yml has one, and the tests that need it run only there.
test('the stack says whether there is a Drive, as JSON, never cached', async ({ request }) => {
  const res = await request.get('/drive.json');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(res.headers()['cache-control']).toBe('no-cache');
  expect(await res.json()).toEqual({ enabled: await driveOn(), linkOverMb: 20 });
});

test('with no OpenCloud, a Drive request is answered 404 and never with the app page', async () => {
  test.skip(await driveOn(), 'this stack has an OpenCloud');
  const res = await fetch(`${BASE}/drive/graph/v1.0/me/drive`);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain('<html');
});

test("OpenCloud answers under /drive with the mail token and creates the user's drive", async ({ page }) => {
  test.skip(!(await driveOn()), 'needs the stack started with docker-compose.drive.yml');
  test.setTimeout(180_000);
  await openInbox(page);
  const token = await driveToken(page);
  await waitForDrive(token);
  const res = await driveFetch(token, '/graph/v1.0/me/drive');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ driveType: 'personal', driveAlias: 'personal/alice@example.test' });
});

test('without a token OpenCloud answers 401 and no browser login prompt', async () => {
  test.skip(!(await driveOn()), 'needs the stack started with docker-compose.drive.yml');
  const res = await fetch(`${BASE}/drive/graph/v1.0/me/drive`, { redirect: 'manual' });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBeNull();
});
