/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** The commit the build was made from: OINBOX_COMMIT in images and CI, git in a checkout. */
function commit(): string {
  if (process.env.OINBOX_COMMIT && process.env.OINBOX_COMMIT !== 'unknown') return process.env.OINBOX_COMMIT.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [solid()],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(commit()) },
  server: {
    // Only :5173/auth/callback is a registered OAuth redirect URI; fail instead of drifting to :5174.
    port: 5173,
    strictPort: true,
    // Dev: proxy JMAP + OAuth to the Docker Compose Caddy so the app stays same-origin.
    proxy: Object.fromEntries(
      // Stalwart's OAuth lives at /login (authorize), /api/auth (login form), /auth/token.
      // Drive (OpenCloud) is at /drive, and /drive.json says whether there is one.
      ['/.well-known', '/jmap', '/auth/token', '/auth/register', '/api', '/login', '/logo', '/drive']
        .map((p) => [p, { target: 'http://localhost:8080', changeOrigin: false }]),
    ),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
  resolve: { conditions: ['development', 'browser'] },
});
