/**
 * HTTP client for `apps/nfe`. Browser- and Node-callable; wraps the
 * three routes (`/api/nfe/emitir`, `/api/nfe/consultar`,
 * `/api/nfe/processar-pendentes`) with typed results and a Bearer
 * Firebase ID token from the caller's auth context.
 *
 * Replaces the throwing `createNFeProvider()` stub: production
 * `apps/web` registers an `InvoiceProvider` backed by this client.
 */
import type { EstadoNFe } from '@delfrance/schemas';

import {
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeHttpError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
} from './errors';

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:EmitResult`. */
export interface NFeEmitResult {
  readonly nfeId: string;
  readonly pedidoId: string;
  readonly estado: EstadoNFe;
  readonly chave: string;
  readonly nRec: string | null;
  readonly cStat: string;
  readonly xMotivo: string;
  /**
   * `true` when the server short-circuited because an existing nfev4 doc
   * was already in a `STATUS_BLOQUEADORES` cStat (the dedup branch in
   * `emitirPedido`). `false` (or absent, for backward compat with older
   * route responses) when a fresh emission round-trip ran.
   */
  readonly reused?: boolean;
}

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:EmitError` — per-pedido failure inside a batch. */
export interface NFeEmitError {
  readonly pedidoId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
}

/** Discriminate `NFeEmitResult` from `NFeEmitError` in a batch result. */
export function isNFeEmitError(
  r: NFeEmitResult | NFeEmitError,
): r is NFeEmitError {
  return (r as NFeEmitError).errorCode !== undefined;
}

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:BatchEmitResult`. */
export interface NFeBatchEmitResult {
  readonly results: ReadonlyArray<NFeEmitResult | NFeEmitError>;
}

/** Mirrors `apps/nfe/app/api/nfe/consultar/route.ts` response. */
export interface NFeConsultaResult {
  readonly chave: string;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly nProt: string | null;
  /** Raw `TRetConsSitNFe` for callers that need the full payload. */
  readonly raw: unknown;
}

/** Mirrors `apps/nfe/app/api/nfe/processar-pendentes/route.ts` response. */
export interface NFeProcessarPendentesResult {
  readonly scanned: number;
  readonly recovered: number;
  readonly stillPending: number;
  readonly errors: number;
}

/**
 * Caller-provided config. `baseUrl` is the origin of `apps/nfe`
 * (in dev: `http://localhost:3004`; in prod: `https://nfe-<env>.web.app`).
 * `getAuthToken` runs on every call so a Firebase ID-token refresh
 * is picked up transparently. `fetch` is injectable for tests.
 */
export interface NFeHttpClientConfig {
  readonly baseUrl: string;
  readonly getAuthToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface NFeHttpClient {
  emitir(pedidoId: string): Promise<NFeEmitResult>;
  emitirLote(pedidoIds: ReadonlyArray<string>): Promise<NFeBatchEmitResult>;
  consultar(chave: string): Promise<NFeConsultaResult>;
  processarPendentes(): Promise<NFeProcessarPendentesResult>;
}

/** Strip a trailing slash off `baseUrl` so route concatenation is clean. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Map an HTTP error response to one of our typed errors. The route
 * layer in `apps/nfe` returns `{ error, code? }` for failures — we
 * inspect status code first, fall back to message on the body.
 */
function errorFromResponse(
  status: number,
  body: unknown,
  context: { pedidoId?: string },
): NFeHttpError {
  const message =
    body !== null && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${status}`;

  if (status === 400) return new NFeBadRequestError(message, body);
  if (status === 401 || status === 403) return new NFeAuthError(message, status, body);
  if (status === 404) {
    return new NFePedidoNotFoundError(context.pedidoId ?? '(unknown)', body);
  }
  if (status === 409) {
    return new NFeBlockedError(context.pedidoId ?? '(unknown)', body);
  }
  if (status === 422) {
    // The route returns the full EmitResult on 422 — extract cStat + xMotivo.
    const result = body as Partial<NFeEmitResult> | null;
    return new NFeRejectedError(
      result?.cStat ?? '(unknown)',
      result?.xMotivo ?? message,
      body,
    );
  }
  if (status === 503) return new NFeRuntimeNotReadyError(message, body);
  return new NFeServerError(message, status, body);
}

/**
 * Construct the HTTP client. The returned object is stateless modulo
 * the auth-token callback — safe to share across requests.
 */
export function createNFeHttpClient(config: NFeHttpClientConfig): NFeHttpClient {
  const baseUrl = normalizeBase(config.baseUrl);
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; context?: { pedidoId?: string } } = {},
  ): Promise<T> {
    const token = await config.getAuthToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const requestInit: RequestInit = { method, headers };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestInit.body = JSON.stringify(init.body);
    }

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, requestInit);
    } catch (err) {
      // fetch throws TypeError on network/abort failures — never on HTTP
      // status. Distinguish so callers can retry confidently.
      throw new NFeNetworkError(
        err instanceof Error ? err.message : 'fetch failed',
        err,
      );
    }

    // Body parse — tolerate empty bodies on errors (some 503 paths
    // don't ship JSON).
    let body: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Server returned non-JSON. Treat as a generic server error
          // with the raw text as the body — preserves diagnostics.
          body = { error: text };
        } else {
          throw err;
        }
      }
    }

    if (!res.ok) {
      throw errorFromResponse(res.status, body, init.context ?? {});
    }
    return body as T;
  }

  return {
    emitir: (pedidoId) =>
      call<NFeEmitResult>('POST', '/api/nfe/emitir', {
        body: { pedidoId },
        context: { pedidoId },
      }),
    emitirLote: (pedidoIds) =>
      call<NFeBatchEmitResult>('POST', '/api/nfe/emitir-lote', {
        body: { pedidoIds: [...pedidoIds] },
      }),
    consultar: (chave) =>
      call<NFeConsultaResult>('GET', `/api/nfe/consultar?chave=${encodeURIComponent(chave)}`),
    processarPendentes: () =>
      call<NFeProcessarPendentesResult>('POST', '/api/nfe/processar-pendentes', {
        body: {},
      }),
  };
}
