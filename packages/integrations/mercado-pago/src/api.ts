import type { z } from 'zod';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoValidationError,
} from './errors';
import { DEFAULT_API_BASE_URL } from './oauth';
import {
  type MpPayment,
  type MpUser,
  mpPaymentSchema,
  mpUserSchema,
  tokenErrorSchema,
} from './types';

const DEFAULT_USER_AGENT = '@delfrance/erp-next';
const DEFAULT_MAX_RETRIES = 3;

export interface MercadoPagoApiConfig {
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
}

export interface MercadoPagoApi {
  /** `GET /users/me` — the connected account's identity (conta panel). */
  getMe(): Promise<MpUser>;
  /** `GET /v1/payments/{id}`. */
  getPayment(id: number | string): Promise<MpPayment>;
}

export function createMercadoPagoApi(config: MercadoPagoApiConfig): MercadoPagoApi {
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

  /**
   * Fetch with the network-retry policy shared by every endpoint: only a
   * fetch throw (no response — genuine network failure) retries, with
   * backoff; any HTTP response, 429/5xx included, is returned as-is.
   */
  async function fetchWithNetworkRetry(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0;
    for (;;) {
      try {
        return await fetchImpl(url, init);
      } catch (err) {
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(backoff(attempt));
          continue;
        }
        throw new MercadoPagoNetworkError(
          `Falha de rede ao contatar o Mercado Pago: ${err instanceof Error ? err.message : 'fetch falhou'}`,
          err,
        );
      }
    }
  }

  async function request<T>(
    method: 'GET',
    path: string,
    schema: z.ZodType<T>,
    opts: RequestOpts = {},
  ): Promise<T> {
    const url = buildUrl(path, opts.query);
    // Fetch the token once; it stays valid across the (few, quick) retries.
    const token = await config.getAccessToken();

    const res = await fetchWithNetworkRetry(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
        ...opts.headers,
      },
    });

    if (res.ok) return parseOk(res, schema);
    throw await toHttpError(res);
  }

  return {
    getMe: () => request('GET', '/users/me', mpUserSchema),
    getPayment: (id) => request('GET', `/v1/payments/${id}`, mpPaymentSchema),
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
        throw new MercadoPagoValidationError('Resposta não-JSON do Mercado Pago.', text);
      }
      throw err;
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new MercadoPagoValidationError(
      'Resposta do Mercado Pago em formato inesperado.',
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
    return new MercadoPagoReauthRequiredError(
      'refresh_failed',
      message ?? 'Token do Mercado Pago inválido. Reconecte a conta.',
    );
  }
  return new MercadoPagoHttpError(
    `MP ${res.status}: ${message ?? res.statusText}`,
    res.status,
    body,
  );
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
