/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [
    solid({
      // @rozie-ui/*-solid ship untransformed JSX in dist/index.mjs (see docs/rozie-feedback.md),
      // so compile those files too.
      extensions: ['.mjs'],
      include: [/\.[mc]?[jt]sx$/, /@rozie-ui[\\/][^\\/]+-solid[\\/]dist[\\/].+\.mjs$/],
    }),
  ],
  optimizeDeps: {
    exclude: ['@rozie-ui/toast-solid', '@rozie-ui/popover-solid', '@rozie-ui/combobox-solid', '@rozie-ui/command-palette-solid', '@rozie-ui/tags-solid', '@rozie-ui/tiptap-solid', '@rozie-ui/date-picker-solid'],
  },
  server: {
    // Dev: proxy JMAP + OAuth to the Docker Compose Caddy so the app stays same-origin.
    proxy: Object.fromEntries(
      ['/.well-known', '/jmap', '/auth/authorize', '/auth/token', '/api', '/login', '/authorize']
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
