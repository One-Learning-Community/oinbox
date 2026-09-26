// OAuth 2.0 Authorization Code + PKCE (RFC 7636) as a public client, against Stalwart.

const TOKENS_KEY = 'oinbox.tokens';
const PENDING_KEY = 'oinbox.oauth.pending';
/** Refresh this long before expiry. */
const SKEW_MS = 60_000;

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in');
  }
}

interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface OAuthOptions {
  origin: string;
  clientId: string;
  scope?: string;
  fetch?: typeof fetch;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export class OAuth {
  private meta: Promise<ServerMetadata> | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OAuthOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get redirectUri(): string {
    return `${this.opts.origin}/auth/callback`;
  }

  private metadata(): Promise<ServerMetadata> {
    this.meta ??= this.fetchImpl(`${this.opts.origin}/.well-known/oauth-authorization-server`).then(async (r) => {
      if (!r.ok) throw new Error(`OAuth discovery failed: ${r.status}`);
      return (await r.json()) as ServerMetadata;
    });
    return this.meta;
  }

  isSignedIn(): boolean {
    return this.load() !== null;
  }

  /** Start sign-in: returns the URL to send the browser to. */
  async authorizationUrl(returnTo = '/'): Promise<string> {
    const meta = await this.metadata();
    const verifier = randomString(48); // 64 base64url chars
    const state = randomString(16);
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, returnTo }));
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      redirect_uri: this.redirectUri,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    }).toString();
    return url.toString();
  }

  /** Finish sign-in on the redirect URI. Returns the path the user started from. */
  async handleCallback(url: URL): Promise<string> {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as
      | { verifier: string; state: string; returnTo: string }
      | null;
    sessionStorage.removeItem(PENDING_KEY);
    const error = url.searchParams.get('error');
    if (error) throw new Error(`Sign-in failed: ${url.searchParams.get('error_description') ?? error}`);
    if (!pending || url.searchParams.get('state') !== pending.state) throw new Error('Sign-in failed: state mismatch');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('Sign-in failed: no authorization code');
    await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.opts.clientId,
      code_verifier: pending.verifier,
    });
    return pending.returnTo;
  }

  async getToken(): Promise<string> {
    const t = this.load();
    if (!t) throw new NotSignedInError();
    if (t.expiresAt - SKEW_MS > Date.now()) return t.accessToken;
    if (!t.refreshToken) {
      this.signOut();
      throw new NotSignedInError();
    }
    this.refreshing ??= this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: this.opts.clientId,
    }).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** The server rejected our access token: try the refresh token. Resolves false if that fails too. */
  async renew(): Promise<boolean> {
    const t = this.load();
    if (!t?.refreshToken) return false;
    this.refreshing ??= this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: this.opts.clientId,
    }).finally(() => (this.refreshing = null));
    try {
      await this.refreshing;
      return true;
    } catch {
      return false;
    }
  }

  signOut(): void {
    localStorage.removeItem(TOKENS_KEY);
  }

  private async tokenRequest(params: Record<string, string>): Promise<string> {
    const meta = await this.metadata();
    const res = await this.fetchImpl(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) {
      if (params.grant_type === 'refresh_token') this.signOut();
      throw new NotSignedInError();
    }
    const body = (await res.json()) as TokenResponse;
    const prev = this.load();
    const tokens: StoredTokens = {
      accessToken: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    const refresh = body.refresh_token ?? prev?.refreshToken;
    if (refresh) tokens.refreshToken = refresh;
    localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    return tokens.accessToken;
  }

  private load(): StoredTokens | null {
    try {
      return JSON.parse(localStorage.getItem(TOKENS_KEY) ?? 'null') as StoredTokens | null;
    } catch {
      return null;
    }
  }
}
