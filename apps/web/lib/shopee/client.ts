'use client';

/**
 * `useShopeeClient()` — a memoized typed client bound to the current Firebase
 * auth state, talking to the `apps/shopee` marketplace routes on their own App
 * Hosting backend. Mirrors `useMercadoPagoClient` (`lib/mercado-pago/client.ts`),
 * which is the two-method shape this channel has today: returns `null` while
 * logged out so components can disable their buttons, and passes
 * `() => user.getIdToken()` so token refreshes propagate.
 *
 * The client is defined here and not in `@delfrance/integrations-shopee` on
 * purpose: that package signs every request with the partner key, which must
 * never be bundled into a browser. The browser never sees a Shopee access or
 * refresh token — it reads the connection STATUS and mints a consent URL, and
 * both are answered by `apps/shopee` over an authenticated cross-origin call
 * (its `proxy.ts` allows exactly `/api/marketplace/*`).
 *
 * ⚠️ The three error classes carry a `Client` infix. `@delfrance/integrations-shopee`
 * already exports `ShopeeHttpError` and `ShopeeNetworkError` for Shopee's own
 * wire, and those names mean something different — a failure talking to SHOPEE,
 * not to our backend. Two classes with one name in one repo is a narrowing bug
 * waiting to happen.
 */
import { useMemo } from 'react';
import type { z } from 'zod';

import { envelopeDeErro, lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { useAuth } from '@/lib/auth/useAuth';

import {
  oauthStartResponseSchema,
  shopeeContaStatusSchema,
  type ShopeeContaStatus,
  type ShopeeOauthStart,
} from './wire';

const DEFAULT_SHOPEE_URL = 'http://localhost:3009';

/** Non-2xx response from the `apps/shopee` backend. */
export class ShopeeClientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine code from the backend (`SHOPEE_NETWORK_ERROR`, `SHOPEE_BAD_RESPONSE`, …). */
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ShopeeClientHttpError';
  }
}

/**
 * The backend answered 2xx and the body was not the shape this app claims — the
 * wrong fields, no body at all, or not JSON.
 *
 * ⚠️ Nothing here describes what WE send: it is a browser-side `Error` that
 * never leaves the tab, and `status` records the 2xx the backend sent US. That
 * combination — transport fine, payload unusable — is exactly what a
 * `return parsed as T` used to report as a success (#1295 → #1302).
 *
 * ⚠️ A SUBCLASS of {@link ShopeeClientHttpError}, matching both siblings for the
 * same reason: catch sites narrow to that class and `throw err` for anything
 * else, so a brand-new sibling class would sail past every one of them and land
 * as an unhandled rejection instead of a message. `code === 'RESPOSTA_INVALIDA'`
 * is what tells the two apart where it matters.
 */
export class ShopeeClientRespostaInvalidaError extends ShopeeClientHttpError {
  constructor(
    message: string,
    /** The real 2xx the backend sent — never a hardcoded 200. */
    status: number,
    /**
     * The field paths that failed, de-duplicated with array indices collapsed.
     * ⚠️ Paths only, never values: an OAuth response body is a live credential
     * often enough that the rule has to hold unconditionally (#1015).
     */
    readonly campos: string[],
  ) {
    super(message, status, 'RESPOSTA_INVALIDA');
    this.name = 'ShopeeClientRespostaInvalidaError';
  }
}

/** Network-level failure reaching the `apps/shopee` backend. */
export class ShopeeClientNetworkError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ShopeeClientNetworkError';
  }
}

/**
 * What to say when the backend answered a non-2xx WITHOUT our JSON envelope —
 * the case where the request never reached one of its routes at all.
 *
 * Written for the OPERATOR, who cannot inspect a deployment: it says what to do,
 * and carries the status only so support can act on a screenshot. The four
 * branches match the statuses `apps/shopee/lib/shopee/core/respond.ts` actually
 * emits (400 / 404 / 500 / 502 / 503) plus the auth failures `verifyCaller`
 * answers before any route body runs.
 */
export function shopeeHttpFallbackMessage(status: number): string {
  if (status === 401 || status === 403) {
    return 'Sem permissão para esta operação na Shopee.';
  }
  if (status === 404) {
    return `A integração com a Shopee não respondeu (HTTP ${String(status)}). Atualize a página e, se continuar, avise o suporte.`;
  }
  if (status >= 500) {
    return `A integração com a Shopee falhou (HTTP ${String(status)}). Tente novamente em instantes.`;
  }
  return `Falha na comunicação com a Shopee (HTTP ${String(status)}).`;
}

export interface ShopeeClient {
  /** Mint the Shopee consent URL for an `integracao` conta (PERM.integracao.write). */
  oauthStart(integracaoId: string): Promise<ShopeeOauthStart>;
  /** Connection status — the two clocks. Always 200 (PERM.integracao.read). */
  conta(integracaoId: string): Promise<ShopeeContaStatus>;
}

/**
 * Log a body the operator will never see, capped so a whole HTML document
 * cannot flood the console.
 */
function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(
    `[shopee] resposta não-JSON em ${path} (HTTP ${String(status)})`,
    corpo.slice(0, 500),
  );
}

export function createShopeeClient(config: {
  baseUrl: string;
  getAuthToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}): ShopeeClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
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
      throw new ShopeeClientNetworkError(err instanceof Error ? err.message : 'fetch falhou', err);
    }

    const text = await res.text();

    if (!res.ok) {
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          // ⚠️ The body must NOT become `{ error: text }`: a proxy's whole HTML
          // document would then end up verbatim in `err.message` and bury the
          // real cause behind a wall of markup. It stays reachable on the
          // console instead.
          if (err instanceof SyntaxError) {
            logarCorpoNaoJson(path, res.status, text);
          } else throw err;
        }
      }
      const errBody = envelopeDeErro(parsed);
      throw new ShopeeClientHttpError(
        errBody?.error ?? shopeeHttpFallbackMessage(res.status),
        res.status,
        errBody?.code ?? null,
      );
    }

    const leitura = lerRespostaJson(text, schema);
    if (leitura.ok) return leitura.data;

    if (leitura.motivo !== 'formato') {
      // ⚠️ EMPTY and NON-JSON share this branch, and they must: neither is
      // version skew — in both, the request failed to reach a route that
      // answers JSON. Sending someone to deploy a backend that was never the
      // problem is the defect this wording exists to avoid.
      logarCorpoNaoJson(
        path,
        res.status,
        leitura.motivo === 'nao-json' ? leitura.texto : '(corpo vazio)',
      );
      throw new ShopeeClientRespostaInvalidaError(
        `A integração com a Shopee respondeu HTTP ${String(res.status)} sem um corpo JSON — ` +
          'o pedido não chegou à rota esperada. Atualize a página e, se continuar, avise o ' +
          'suporte.',
        res.status,
        [],
      );
    }

    throw new ShopeeClientRespostaInvalidaError(
      'O backend da Shopee respondeu num formato que este aplicativo não reconhece. ' +
        `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
        'backend e esta tela estão em versões diferentes — faça o deploy de `apps/shopee` e ' +
        'recarregue a página.',
      res.status,
      leitura.campos,
    );
  }

  return {
    oauthStart: (integracaoId) =>
      call(
        `/api/marketplace/shopee/oauth/start?integracaoId=${encodeURIComponent(integracaoId)}`,
        oauthStartResponseSchema,
      ),
    conta: (integracaoId) =>
      call(
        `/api/marketplace/shopee/conta?integracaoId=${encodeURIComponent(integracaoId)}`,
        shopeeContaStatusSchema,
      ),
  };
}

export function useShopeeClient(): ShopeeClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_SHOPEE_URL ?? DEFAULT_SHOPEE_URL;
    return createShopeeClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
