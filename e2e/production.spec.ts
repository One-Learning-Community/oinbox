import { expect, test } from '@playwright/test';
import tls from 'node:tls';
import net from 'node:net';
import { signInThroughStalwart } from './support/login';

// The production template (deploy/production), started with its test override on https://localhost:8443.
// Run by the `production` project only; see deploy/README.md, "Testing the production template".

const USER = process.env.PROD_TEST_USER ?? 'prodtest@example.test';
const PASSWORD = process.env.PROD_TEST_PASSWORD ?? 'ci-only-user-pass';

test('@production signs in over HTTPS and reaches the inbox', async ({ page }) => {
  await signInThroughStalwart(page, USER, PASSWORD);
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible();
});

test('@production sends HSTS and the CSP, compresses the app, and offers no CORS', async ({ request }) => {
  const home = await request.get('/');
  expect(home.headers()['strict-transport-security']).toContain('max-age=31536000');
  expect(home.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(home.headers()['x-content-type-options']).toBe('nosniff');

  const script = /src="(\/assets\/index-[^"]+\.js)"/.exec(await home.text())![1]!;
  const asset = await request.get(script, { headers: { 'accept-encoding': 'gzip' } });
  expect(asset.headers()['content-encoding']).toBe('gzip');
  expect(asset.headers()['cache-control']).toContain('immutable');

  // Another site's page must not be able to read answers from here.
  const session = await request.get('/jmap/session', { headers: { origin: 'https://evil.example' } });
  expect(session.headers()['access-control-allow-origin']).toBeUndefined();
  const preflight = await request.fetch('/jmap/', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  expect(preflight.headers()['access-control-allow-origin']).toBeUndefined();
});

test('@production a 401 from Stalwart carries no Basic challenge', async ({ request }) => {
  const res = await request.get('/jmap/session', { headers: { authorization: 'Bearer not-a-token' } });
  expect(res.headers()['www-authenticate']).toBeUndefined();
});

test('@production plain HTTP redirects to HTTPS', async ({ request }) => {
  const res = await request.get('http://localhost:8081/', { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers().location).toMatch(/^https:\/\/localhost/);
});

/** The certificate a TLS server presents, as its subject alternative names. */
const altNames = (socket: tls.TLSSocket) => socket.getPeerCertificate().subjectaltname ?? '';

test('@production IMAP and submission present the certificate Caddy obtained', async () => {
  for (const port of [4993, 4465]) {
    const names = await new Promise<string>((resolve, reject) => {
      const s = tls.connect({ host: 'localhost', port, servername: 'localhost', rejectUnauthorized: false }, () => {
        resolve(altNames(s));
        s.end();
      });
      s.on('error', reject);
    });
    expect(names, `port ${port}`).toContain('DNS:localhost');
  }
});

test('@production SMTP offers STARTTLS with that certificate', async () => {
  const names = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(2526, 'localhost');
    let stage = 0;
    sock.on('error', reject);
    sock.on('data', (d) => {
      const text = d.toString();
      if (stage === 0 && text.startsWith('220')) {
        stage = 1;
        sock.write('EHLO test.example\r\n');
      } else if (stage === 1 && /250[ -]/.test(text)) {
        if (!/STARTTLS/i.test(text)) return reject(new Error(`no STARTTLS in: ${text}`));
        stage = 2;
        sock.write('STARTTLS\r\n');
      } else if (stage === 2 && text.startsWith('220')) {
        sock.removeAllListeners('data');
        const s = tls.connect({ socket: sock, servername: 'localhost', rejectUnauthorized: false }, () => {
          resolve(altNames(s));
          s.end();
        });
        s.on('error', reject);
      }
    });
  });
  expect(names).toContain('DNS:localhost');
});
