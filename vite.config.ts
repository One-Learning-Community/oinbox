/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: {
    // Dev: proxy JMAP + OAuth to the Docker Compose Caddy so the app stays same-origin.
    proxy: Object.fromEntries(
      // Stalwart's OAuth lives at /login (authorize), /api/auth (login form), /auth/token.
      ['/.well-known', '/jmap', '/auth/token', '/auth/register', '/api', '/login', '/logo']
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
