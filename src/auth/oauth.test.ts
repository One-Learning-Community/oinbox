import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuth, pkceChallenge } from './oauth';

describe('pkceChallenge', () => {
  it('matches the RFC 7636 appendix B vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

const meta = {
  issuer: 'http://localhost:8080',
  authorization_endpoint: 'http://localhost:8080/authorize/code',
  token_endpoint: 'http://localhost:8080/auth/token',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('OAuth', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('builds an authorization URL with PKCE and state, then exchanges the code', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('.well-known')) return json(meta);
      const body = new URLSearchParams(init!.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('C1');
      expect(body.get('code_verifier')).toHaveLength(64);
      expect(body.get('client_id')).toBe('oinbox');
      return json({ access_token: 'A1', refresh_token: 'R1', expires_in: 3600, token_type: 'bearer' });
    });
    const auth = new OAuth({ origin: 'http://localhost:8080', clientId: 'oinbox', fetch: f as unknown as typeof fetch });
    const url = new URL(await auth.authorizationUrl());
    expect(url.origin + url.pathname).toBe(meta.authorization_endpoint);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/auth/callback');
    const state = url.searchParams.get('state')!;

    await auth.handleCallback(new URL(`http://localhost:8080/auth/callback?code=C1&state=${state}`));
    expect(await auth.getToken()).toBe('A1');
  });

  it('rejects a callback with the wrong state', async () => {
    const auth = new OAuth({ origin: 'http://localhost:8080', clientId: 'oinbox', fetch: (async () => json(meta)) as unknown as typeof fetch });
    await auth.authorizationUrl();
    await expect(auth.handleCallback(new URL('http://localhost:8080/auth/callback?code=C1&state=nope'))).rejects.toThrow(/state/);
  });

  it('refreshes an expiring token once for concurrent callers', async () => {
    let refreshes = 0;
    const f = vi.fn(async (url: string) => {
      if (url.includes('.well-known')) return json(meta);
      refreshes++;
      return json({ access_token: 'A2', expires_in: 3600, token_type: 'bearer' });
    });
    localStorage.setItem('oinbox.tokens', JSON.stringify({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 5_000 }));
    const auth = new OAuth({ origin: 'http://localhost:8080', clientId: 'oinbox', fetch: f as unknown as typeof fetch });
    expect(await Promise.all([auth.getToken(), auth.getToken()])).toEqual(['A2', 'A2']);
    expect(refreshes).toBe(1);
    // The refresh token is kept when the server doesn't rotate it.
    expect(JSON.parse(localStorage.getItem('oinbox.tokens')!).refreshToken).toBe('R1');
  });

  it('reports signed-out when there are no tokens', async () => {
    const auth = new OAuth({ origin: 'http://localhost:8080', clientId: 'oinbox', fetch: (async () => json(meta)) as unknown as typeof fetch });
    expect(auth.isSignedIn()).toBe(false);
    await expect(auth.getToken()).rejects.toThrow(/signed in/);
  });

  it('asks for the server metadata again after a failed attempt', async () => {
    let online = false;
    const f = vi.fn(async (url: string) => {
      if (!online) throw new TypeError('Failed to fetch');
      return url.includes('.well-known') ? json(meta) : json({ access_token: 'A2', expires_in: 3600 });
    });
    localStorage.setItem('oinbox.tokens', JSON.stringify({ accessToken: 'old', expiresAt: 0, refreshToken: 'R1' }));
    const auth = new OAuth({ origin: 'http://localhost:8080', clientId: 'oinbox', fetch: f as unknown as typeof fetch });
    await expect(auth.getToken()).rejects.toBeInstanceOf(TypeError);
    online = true;
    await expect(auth.getToken()).resolves.toBe('A2');
  });
});
