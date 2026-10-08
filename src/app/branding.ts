import { createSignal } from 'solid-js';

/** The name and logo an operator gives their installation (docs/operating.md, "Branding"). */
export interface Branding {
  name: string;
  /** An image URL the Content-Security-Policy lets the page load, or null for the text mark. */
  logo: string | null;
}

export const DEFAULT_BRANDING: Branding = { name: 'oinbox', logo: null };

const KEY = 'oinbox.branding';
type Fetcher = (url: string) => Promise<Response>;

/** https, an image data URL, or a path on this origin. Anything else is no logo. */
const allowedLogo = (v: unknown): v is string =>
  typeof v === 'string' && (/^https:\/\//i.test(v) || /^data:image\//i.test(v) || /^\/(?!\/)/.test(v));

export function parseBranding(raw: unknown): Branding {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  return { name: name || DEFAULT_BRANDING.name, logo: allowedLogo(o.logo) ? o.logo : null };
}

/** What the last start read, so a returning user never sees the default name first. */
export function cachedBranding(storage: Storage): Branding | null {
  try {
    const raw = storage.getItem(KEY);
    return raw ? parseBranding(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Read /branding.json. If it can't be had, keep what was remembered: a branded page must not flip back on a bad connection. */
export async function loadBranding(fetcher: Fetcher, storage: Storage): Promise<Branding> {
  try {
    const res = await fetcher('/branding.json');
    if (!res.ok) throw new Error(String(res.status));
    const branding = parseBranding(await res.json());
    storage.setItem(KEY, JSON.stringify(branding));
    return branding;
  } catch {
    return cachedBranding(storage) ?? DEFAULT_BRANDING;
  }
}

/** The tab's title and icon. */
export function applyBranding(doc: Document, b: Branding): void {
  doc.title = b.name;
  if (!b.logo) return;
  const icon = doc.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon) return;
  icon.removeAttribute('type');
  icon.setAttribute('href', b.logo);
}

const [branding, setBranding] = createSignal<Branding>(DEFAULT_BRANDING);
/** The branding in force, for components. */
export { branding };

/**
 * Called once at start-up. Resolves when the branding is known: at once for a returning user, and
 * after the fetch (or `patience` ms, whichever is first) for a new one, who would otherwise see the
 * default name flash by.
 */
export function startBranding(fetcher: Fetcher, storage: Storage, doc: Document, patience = 1000): Promise<void> {
  const use = (b: Branding) => {
    setBranding(b);
    applyBranding(doc, b);
  };
  const cached = cachedBranding(storage);
  if (cached) use(cached);
  const loaded = loadBranding(fetcher, storage).then(use);
  if (cached) return Promise.resolve();
  return Promise.race([loaded, new Promise<void>((r) => setTimeout(r, patience))]);
}
