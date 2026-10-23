import { describe, expect, it } from 'vitest';
import routes from '../../deploy/routes.caddy?raw';
import manifest from '../../public/manifest.webmanifest?raw';
import { MAILTO_HANDLER } from './mailto';

// The manifest is written three times: the file nginx and the dev server serve, and Caddy's two
// answers (with and without an operator's icon), which carry the operator's name. Keep them alike.
const file = JSON.parse(manifest) as Record<string, unknown>;

/** Caddy's answers, with its {$VAR:default} placeholders filled in as `env` says (or by their defaults). */
function caddyAnswers(env: Record<string, string> = {}): Record<string, unknown>[] {
  const block = /handle \/manifest\.webmanifest \{([\s\S]*?)\n\t\}/.exec(routes)![1]!;
  return [...block.matchAll(/respond (?:@\w+ )?`([^`]*)`/g)].map((m) =>
    JSON.parse(m[1]!.replace(/\{\$(\w+):([^}]*)\}/g, (_, name: string, fallback: string) => env[name] ?? fallback)) as Record<string, unknown>,
  );
}

describe('the web app manifest', () => {
  it('sends email links to the composer', () => {
    expect(file.protocol_handlers).toEqual([{ protocol: 'mailto', url: MAILTO_HANDLER }]);
  });
  it('is the same file in Caddy, unbranded', () => {
    const [withIcon, plain] = caddyAnswers();
    expect(plain).toEqual(file);
    expect({ ...withIcon, icons: file.icons }).toEqual(file);
  });
  it('carries the operator name, and their icon when there is one', () => {
    const [withIcon, plain] = caddyAnswers({ OINBOX_BRAND_NAME: 'Acme Mail', OINBOX_BRAND_ICON: '/acme-512.png' });
    expect(plain).toMatchObject({ name: 'Acme Mail', short_name: 'Acme Mail', icons: file.icons });
    expect(withIcon).toMatchObject({ name: 'Acme Mail', icons: [{ src: '/acme-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] });
  });
  it('has a shortcut for each place the app has a route for', () => {
    expect((file.shortcuts as { url: string }[]).map((s) => s.url)).toEqual(['/compose', '/calendar', '/contacts']);
  });
});
