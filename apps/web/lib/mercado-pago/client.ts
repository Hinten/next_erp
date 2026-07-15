'use client';

/**
 * `useMercadoPagoClient()` — a memoized typed client bound to the current
 * Firebase auth state, talking to the mercado-pago payments backend's own
 * App Hosting deployment. Mirrors `useMercadoLivreClient`
 * (lib/mercado-livre/client.ts): returns `null` while logged out so
 * components can disable their buttons, and passes `() => user.getIdToken()`
 * so token refreshes propagate.
 *
 * The client is defined here (not in `@delfrance/integrations-mercado-pago`)
 * on purpose: that package's OAuth core handles the app clientSecret and must
 * never be bundled into the browser. The browser never sees a Mercado Pago
 * access/refresh token — the panel only ever reads the connected collector's
 * identity via `conta()`.
 */
import { useMemo } from 'react';

import { useAuth } from '@/lib/auth/useAuth';

const DEFAULT_MERCADO_PAGO_URL = 'http://localhost:3007';

/** Non-2xx response from the mercado-pago backend. */
export class MercadoPagoClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Optional machine code from the backend (e.g. MP_REAUTH_REQUIRED). */
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'MercadoPagoClientHttpError';
  }
}

/** Network-level failure reaching the mercado-pago backend. */
export class MercadoPagoClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MercadoPagoClientNetworkError';
  }
}

export interface MercadoPagoConta {
  connected: boolean;
  me: { id: number; nickname: string | null; email: string | null } | null;
}

export interface MercadoPagoClient {
  /** Mint the MP consent URL for a metodo_pgto account (PERM.metodoPagamento.write). */
  oauthStart(metodoId: string): Promise<{ authorizeUrl: string }>;
  /** Connection status: `/users/me` identity or `connected: false`. */
  conta(metodoId: string): Promise<MercadoPagoConta>;
}

export function createMercadoPagoClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): MercadoPagoClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<T>(path: string): Promise<T> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new MercadoPagoClientNetworkError(
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
      const errBody = parsed as { error?: string; code?: string } | null;
      throw new MercadoPagoClientHttpError(
        errBody?.error ?? `HTTP ${res.status}`,
        res.status,
        errBody?.code ?? null,
      );
    }
    return parsed as T;
  }

  return {
    oauthStart: (metodoId) =>
      call<{ authorizeUrl: string }>(
        `/api/payments/mercado-pago/oauth/start?metodoId=${encodeURIComponent(metodoId)}`,
      ),
    conta: (metodoId) =>
      call<MercadoPagoConta>(
        `/api/payments/mercado-pago/conta?metodoId=${encodeURIComponent(metodoId)}`,
      ),
  };
}

export function useMercadoPagoClient(): MercadoPagoClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_MERCADO_PAGO_URL ?? DEFAULT_MERCADO_PAGO_URL;
    return createMercadoPagoClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
