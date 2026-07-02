import type { z } from 'zod';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
} from './errors';
import { DEFAULT_API_BASE_URL } from './oauth';
import {
  type MlItem,
  type MlOrder,
  type MlOrderSearch,
  type MlPack,
  type MlUser,
  itemSchema,
  orderSchema,
  orderSearchSchema,
  packSchema,
  tokenErrorSchema,
  userSchema,
} from './types';

const DEFAULT_USER_AGENT = '@delfrance/erp-next';
const DEFAULT_MAX_RETRIES = 3;

export interface MercadoLivreApiConfig {
  /**
   * Returns a live (non-expired) access token. Token refresh is the caller's
   * concern (the app-side token store) — this client just sends what it's given.
   */
  readonly getAccessToken: () => Promise<string>;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Extra attempts on a **network** failure (fetch throw). Default 3. */
  readonly maxRetries?: number;
  /** Backoff (ms) before a network retry (attempt N, 1-based). Default 2^N·250ms; tests pass `() => 0`. */
  readonly retryDelayMs?: (attempt: number) => number;
}

interface RequestOpts {
  readonly query?: Record<string, string | number | undefined>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export interface MercadoLivreApi {
  getMe(): Promise<MlUser>;
  getUser(id: number | string): Promise<MlUser>;
  getItem(id: string): Promise<MlItem>;
  getOrder(id: number | string): Promise<MlOrder>;
  getPack(id: number | string): Promise<MlPack>;
  searchOrders(params: {
    seller: number | string;
    [key: string]: string | number | undefined;
  }): Promise<MlOrderSearch>;
}

export function createMercadoLivreApi(config: MercadoLivreApiConfig): MercadoLivreApi {
  const baseUrl = config.baseUrl ?? DEFAULT_API_BASE_URL;
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoff = config.retryDelayMs ?? ((attempt: number) => 2 ** attempt * 250);

  function buildUrl(path: string, query?: RequestOpts['query']): string {
    const url = new URL(path, baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    schema: z.ZodType<T>,
    opts: RequestOpts = {},
  ): Promise<T> {
    const url = buildUrl(path, opts.query);
    // Fetch the token once; it stays valid across the (few, quick) retries.
    const token = await config.getAccessToken();
    let attempt = 0;

    for (;;) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': userAgent,
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        // fetch rejects only on a network-level failure — retry, then wrap.
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(backoff(attempt));
          continue;
        }
        throw new MercadoLivreNetworkError(
          `Falha de rede ao contatar o Mercado Livre: ${err instanceof Error ? err.message : 'fetch falhou'}`,
          err,
        );
      }

      // 2xx (incl. 206 Partial Content, valid for orders) → parse + validate.
      if (res.ok) return parseOk(res, schema);

      // A response arrived, so the server saw the request — do NOT retry HTTP
      // errors (429/5xx included): retrying a non-idempotent write could
      // double-execute. Only genuine network failures (the catch above) retry.
      throw await toHttpError(res);
    }
  }

  return {
    getMe: () => request('GET', '/users/me', userSchema),
    getUser: (id) => request('GET', `/users/${id}`, userSchema),
    getItem: (id) =>
      request('GET', `/items/${id}`, itemSchema, { query: { include_attributes: 'all' } }),
    getOrder: (id) => request('GET', `/orders/${id}`, orderSchema),
    getPack: (id) => request('GET', `/packs/${id}`, packSchema),
    searchOrders: (params) =>
      request('GET', '/orders/search', orderSearchSchema, { query: params }),
  };
}

async function parseOk<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new MercadoLivreValidationError('Resposta não-JSON do Mercado Livre.', text);
      }
      throw err;
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new MercadoLivreValidationError(
      'Resposta do Mercado Livre em formato inesperado.',
      result.error.issues,
    );
  }
  return result.data;
}

async function toHttpError(res: Response): Promise<Error> {
  const text = await res.text();
  let body: unknown = text.length > 0 ? text : null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // leave `body` as the raw text
    }
  }
  const parsed = tokenErrorSchema.safeParse(body);
  const message = parsed.success
    ? (parsed.data.message ?? parsed.data.error_description ?? parsed.data.error)
    : undefined;

  // 401 = the access token was rejected → the account must reconnect.
  if (res.status === 401) {
    return new MercadoLivreReauthRequiredError(
      'refresh_failed',
      message ?? 'Token do Mercado Livre inválido. Reconecte a conta.',
    );
  }
  return new MercadoLivreHttpError(
    `ML ${res.status}: ${message ?? res.statusText}`,
    res.status,
    body,
  );
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
