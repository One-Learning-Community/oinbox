import { beforeEach, describe, expect, it } from 'vitest';
import { applyBranding, cachedBranding, DEFAULT_BRANDING, loadBranding, parseBranding } from './branding';

const answer = (body: string, status = 200) => () => Promise.resolve(new Response(body, { status }));
const failing = () => Promise.reject(new TypeError('offline'));

beforeEach(() => localStorage.clear());

describe('parseBranding', () => {
  it('takes a name and an https logo', () => {
    expect(parseBranding({ name: 'Acme Mail', logo: 'https://cdn.example.com/logo.svg' })).toEqual({ name: 'Acme Mail', logo: 'https://cdn.example.com/logo.svg' });
  });
  it('falls back to oinbox with no logo for anything missing or empty', () => {
    expect(parseBranding({})).toEqual(DEFAULT_BRANDING);
    expect(parseBranding({ name: '  ', logo: '' })).toEqual(DEFAULT_BRANDING);
    expect(parseBranding(null)).toEqual(DEFAULT_BRANDING);
    expect(parseBranding('oinbox')).toEqual(DEFAULT_BRANDING);
    expect(parseBranding({ name: 7, logo: {} })).toEqual(DEFAULT_BRANDING);
  });
  it('accepts an image data URL and a path on this origin as the logo', () => {
    expect(parseBranding({ logo: 'data:image/svg+xml;base64,AAAA' }).logo).toBe('data:image/svg+xml;base64,AAAA');
    expect(parseBranding({ logo: '/logo.png' }).logo).toBe('/logo.png');
  });
  it('refuses a logo that is not an image the page may load', () => {
    for (const logo of ['javascript:alert(1)', 'http://cdn.example.com/logo.svg', 'data:text/html,<p>x', '//evil.example/logo.svg', 'logo.png']) {
      expect(parseBranding({ name: 'Acme', logo })).toEqual({ name: 'Acme', logo: null });
    }
  });
  it('takes an icon by the same rules as the logo', () => {
    expect(parseBranding({ name: 'Acme', icon: '/acme-512.png' })).toEqual({ name: 'Acme', logo: null, icon: '/acme-512.png' });
    expect(parseBranding({ name: 'Acme', icon: 'javascript:alert(1)' })).not.toHaveProperty('icon');
    expect(parseBranding({ name: 'Acme', icon: '' })).not.toHaveProperty('icon');
  });
  it('trims the name', () => {
    expect(parseBranding({ name: ' Acme ' }).name).toBe('Acme');
  });
});

describe('loadBranding', () => {
  it('reads /branding.json and remembers it for the next start', async () => {
    const urls: string[] = [];
    const fetcher = (url: string) => {
      urls.push(url);
      return answer('{"name":"Acme","logo":""}')();
    };
    expect(await loadBranding(fetcher, localStorage)).toEqual({ name: 'Acme', logo: null });
    expect(urls).toEqual(['/branding.json']);
    expect(cachedBranding(localStorage)).toEqual({ name: 'Acme', logo: null });
  });
  it('keeps what it remembered when the file cannot be fetched', async () => {
    await loadBranding(answer('{"name":"Acme"}'), localStorage);
    expect(await loadBranding(failing, localStorage)).toEqual({ name: 'Acme', logo: null });
    expect(await loadBranding(answer('gone', 404), localStorage)).toEqual({ name: 'Acme', logo: null });
    expect(await loadBranding(answer('<!doctype html>'), localStorage)).toEqual({ name: 'Acme', logo: null });
  });
  it('is oinbox when there is no file and nothing remembered', async () => {
    expect(await loadBranding(answer('', 404), localStorage)).toEqual(DEFAULT_BRANDING);
    expect(cachedBranding(localStorage)).toBeNull();
  });
  it('goes back to the default when the operator removes the branding', async () => {
    await loadBranding(answer('{"name":"Acme"}'), localStorage);
    expect(await loadBranding(answer('{"name":"oinbox","logo":""}'), localStorage)).toEqual(DEFAULT_BRANDING);
    expect(cachedBranding(localStorage)).toEqual(DEFAULT_BRANDING);
  });
});

describe('cachedBranding', () => {
  it('ignores an entry it cannot read', () => {
    localStorage.setItem('oinbox.branding', '{not json');
    expect(cachedBranding(localStorage)).toBeNull();
  });
});

describe('applyBranding', () => {
  beforeEach(() => {
    document.title = 'oinbox';
    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" /><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />';
  });
  const icon = () => document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')!;

  it('names the tab', () => {
    applyBranding(document, { name: 'Acme Mail', logo: null });
    expect(document.title).toBe('Acme Mail');
    expect(icon().getAttribute('href')).toBe('/favicon.svg');
  });
  it('uses the logo as the tab icon, whatever its image type', () => {
    applyBranding(document, { name: 'Acme', logo: 'https://cdn.example.com/logo.png' });
    expect(icon().getAttribute('href')).toBe('https://cdn.example.com/logo.png');
    expect(icon().hasAttribute('type')).toBe(false);
  });
  it('uses the icon for the home screen, and keeps the default without one', () => {
    const touch = () => document.head.querySelector('link[rel="apple-touch-icon"]')!.getAttribute('href');
    applyBranding(document, { name: 'Acme', logo: null });
    expect(touch()).toBe('/icons/apple-touch-icon.png');
    applyBranding(document, { name: 'Acme', logo: null, icon: '/acme-512.png' });
    expect(touch()).toBe('/acme-512.png');
  });
});
