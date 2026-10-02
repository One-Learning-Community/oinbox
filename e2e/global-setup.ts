import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanupE2eMail } from './cleanup';
import { destroyE2eLabels } from './support/labels';
import { BASE } from './support/mail';

/**
 * Make sure the dev stack is up and seeded.
 *  - E2E_RESET=1: wipe and recreate the stack first (docker compose down -v / up -d), ~2 min.
 *  - Always runs deploy/seed.sh, which is idempotent (only fills in what is missing),
 *    then deletes any messages left over from earlier e2e runs.
 */
export default async function globalSetup() {
  const root = path.resolve(import.meta.dirname, '..');
  const deploy = path.join(root, 'deploy');
  if (!existsSync(path.join(root, 'dist', 'index.html'))) {
    throw new Error('dist/index.html not found: run `pnpm build` before the e2e suite.');
  }
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: deploy, stdio: 'inherit' });
  // Serve the local ./dist (not the dist baked into the oinbox-web image).
  const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.local-dist.yml'];
  if (process.env.E2E_RESET === '1') {
    run('docker', [...compose, 'down', '-v']);
    run('docker', [...compose, 'up', '-d']);
  } else {
    const up = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.ok, () => false);
    if (!up) run('docker', [...compose, 'up', '-d']);
  }
  const served = await fetch(`${BASE}/index.html`).then((r) => r.text(), () => '');
  if (served !== readFileSync(path.join(root, 'dist', 'index.html'), 'utf8')) {
    throw new Error(
      'Caddy is not serving this checkout\'s dist/ (stale image?). Recreate it with the local-dist override:\n' +
        '  (cd deploy && docker compose -f docker-compose.yml -f docker-compose.local-dist.yml up -d caddy)',
    );
  }
  if (process.env.E2E_SKIP_SEED !== '1') run('./seed.sh', []);
  // Remove mail that earlier (aborted) runs may have left behind.
  const removed = await cleanupE2eMail();
  if (removed) console.log(`e2e: removed ${removed} leftover test message(s)`);
  const labels = await destroyE2eLabels();
  if (labels) console.log(`e2e: removed ${labels} leftover test label(s)`);
}
