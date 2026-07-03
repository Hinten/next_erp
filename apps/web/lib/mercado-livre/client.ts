'use client';

/**
 * `useMercadoLivreClient()` — a memoized typed client bound to the current
 * Firebase auth state, talking to the apps/mercado-livre marketplace routes
 * (its own App Hosting backend). Mirrors `useFreightClient` (lib/freight/client.ts):
 * returns `null` while logged out so components can disable their buttons, and
 * passes `() => user.getIdToken()` so token refreshes propagate.
 *
 * The client is defined here (not in `@delfrance/integrations-mercado-livre`)
 * on purpose: that package's root is SERVER-SIDE ONLY (its OAuth core handles
 * the app clientSecret) and must never be bundled into the browser. When the
 * endpoint surface grows, promote this to a browser-safe `./http-client`
 * subpath export like `@delfrance/integrations-freight-br/http-client`.
 */
import { useMemo } from 'react';

import { useAuth } from '@/lib/auth/useAuth';

const DEFAULT_MERCADO_LIVRE_URL = 'http://localhost:3006';

/** Non-2xx response from the mercado-livre backend. */
export class MercadoLivreClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Optional machine code from the backend (e.g. ML_REAUTH_REQUIRED). */
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'MercadoLivreClientHttpError';
  }
}

/** Network-level failure reaching the mercado-livre backend. */
export class MercadoLivreClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MercadoLivreClientNetworkError';
  }
}

export interface MercadoLivreConta {
  connected: boolean;
  me: { id: number; nickname: string | null; email: string | null } | null;
}

export interface MercadoLivreClient {
  /** Mint the ML consent URL for an account (PERM.integracao.write). */
  oauthStart(integracaoId: string): Promise<{ authorizeUrl: string }>;
  /** Connection status: `/users/me` identity or `connected: false`. */
  conta(integracaoId: string): Promise<MercadoLivreConta>;
}

export function createMercadoLivreClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): MercadoLivreClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<T>(path: string): Promise<T> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch (err) {
      throw new MercadoLivreClientNetworkError(
        err instanceof Error ? err.message : 'fetch falhou',
        err,
      );
    }

    let parsed: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) parsed = { error: text };
        else throw err;
      }
    }

    if (!res.ok) {
      const body = parsed as { error?: string; code?: string } | null;
      throw new MercadoLivreClientHttpError(
        body?.error ?? `HTTP ${res.status}`,
        res.status,
        body?.code ?? null,
      );
    }
    return parsed as T;
  }

  return {
    oauthStart: (integracaoId) =>
      call<{ authorizeUrl: string }>(
        `/api/marketplace/mercado-livre/oauth/start?integracaoId=${encodeURIComponent(integracaoId)}`,
      ),
    conta: (integracaoId) =>
      call<MercadoLivreConta>(
        `/api/marketplace/mercado-livre/conta?integracaoId=${encodeURIComponent(integracaoId)}`,
      ),
  };
}

export function useMercadoLivreClient(): MercadoLivreClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_MERCADO_LIVRE_URL ?? DEFAULT_MERCADO_LIVRE_URL;
    return createMercadoLivreClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
