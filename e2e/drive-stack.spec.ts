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

test('only the three APIs the app uses are reachable, and their answers can run nothing on this origin', async () => {
  test.skip(!(await driveOn()), 'needs the stack started with docker-compose.drive.yml');
  // OpenCloud's web UI, its public-link pages and everything else stay off the mail origin.
  for (const path of ['/drive/', '/drive/index.html', '/drive/s/anything', '/drive/dav/public-files/anything', '/drive/config.json', '/drive/status.php', '/drive/ocs/v1.php/cloud/user', '/drive/ocs/v2.php/apps/files_sharing/api/v1/shares']) {
    expect((await fetch(`${BASE}${path}`, { redirect: 'manual' })).status, path).toBe(404);
  }
  for (const path of ['/drive/graph/v1.0/me/drive', '/drive/dav/spaces/x/y']) {
    const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    expect(res.status, path).toBe(401);
    expect(res.headers.get('content-security-policy'), path).toBe("sandbox; default-src 'none'");
    expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
  }
  // The sharing rules: configuration, which OpenCloud gives to anyone.
  const rules = await fetch(`${BASE}/drive/ocs/v1.php/cloud/capabilities?format=json`);
  expect(rules.status).toBe(200);
  expect(rules.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  expect(((await rules.json()) as { ocs: { data: { capabilities: { password_policy?: object } } } }).ocs.data.capabilities.password_policy).toBeTruthy();
});

test('without a token OpenCloud answers 401 and no browser login prompt', async () => {
  test.skip(!(await driveOn()), 'needs the stack started with docker-compose.drive.yml');
  const res = await fetch(`${BASE}/drive/graph/v1.0/me/drive`, { redirect: 'manual' });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBeNull();
});
