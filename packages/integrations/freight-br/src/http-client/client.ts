/**
 * Browser-safe typed client for the `apps/integrations` Melhor Envio
 * freight routes. Mirrors `@delfrance/integrations-nfe/http-provider`:
 * a Bearer Firebase ID token from the caller's auth context, typed
 * results, and HTTP statuses narrowed into typed errors. **Zero server
 * deps** — imports only `globalThis.fetch` and type-only ME shapes.
 *
 * The OAuth callback is hit by Melhor Envio's redirect, not by this
 * client, so there is no method for it.
 */
import type { Balance, CalculateRequest, CalculateResponse, Me } from '../melhor-envio/types';

import {
  FreightAuthError,
  FreightBadRequestError,
  FreightHttpError,
  FreightNetworkError,
  FreightNotFoundError,
  FreightReauthRequiredError,
  FreightServerError,
  FreightValidationError,
} from './errors';

/** `oauth/start` result — the ME consent URL the browser navigates to. */
export interface FreightOAuthStartResult {
  readonly authorizeUrl: string;
}

/** `conta` result — connection state + account info/balance when connected. */
export interface FreightContaResult {
  readonly connected: boolean;
  readonly me: Me | null;
  readonly balance: Balance | null;
}

export interface FreightHttpClientConfig {
  /** Origin of `apps/integrations` (dev: `http://localhost:3001`). */
  readonly baseUrl: string;
  readonly getAuthToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface FreightHttpClient {
  /** Mint the signed-state ME authorize URL for an int_frete account. */
  oauthStart(intFreteId: string): Promise<FreightOAuthStartResult>;
  /** Quote freight (`shipment/calculate`) for the given account. */
  calculate(intFreteId: string, req: CalculateRequest): Promise<CalculateResponse>;
  /** Account connection status + `/me` + `/balance`. */
  conta(intFreteId: string): Promise<FreightContaResult>;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function messageOf(body: unknown, fallback: string): string {
  return body !== null && typeof body === 'object' && 'error' in body
    ? String((body as { error: unknown }).error)
    : fallback;
}

function errorFromResponse(status: number, body: unknown): FreightHttpError {
  const message = messageOf(body, `HTTP ${status}`);
  if (status === 400) return new FreightBadRequestError(message, body);
  if (status === 401 || status === 403) return new FreightAuthError(message, status, body);
  if (status === 404) return new FreightNotFoundError(message, body);
  if (status === 409) return new FreightReauthRequiredError(message, body);
  if (status === 422) {
    const errors =
      body !== null && typeof body === 'object' && 'errors' in body
        ? ((body as { errors: Record<string, string[]> }).errors ?? {})
        : {};
    return new FreightValidationError(message, errors, body);
  }
  return new FreightServerError(message, status, body);
}

export function createFreightHttpClient(config: FreightHttpClientConfig): FreightHttpClient {
  const baseUrl = normalizeBase(config.baseUrl);
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = await config.getAuthToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, init);
    } catch (err) {
      throw new FreightNetworkError(err instanceof Error ? err.message : 'fetch failed', err);
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

    if (!res.ok) throw errorFromResponse(res.status, parsed);
    return parsed as T;
  }

  return {
    oauthStart: (intFreteId) =>
      call<FreightOAuthStartResult>(
        'GET',
        `/api/freight/melhor-envio/oauth/start?intFreteId=${encodeURIComponent(intFreteId)}`,
      ),
    calculate: (intFreteId, req) =>
      call<CalculateResponse>('POST', '/api/freight/melhor-envio/calculate', {
        intFreteId,
        ...req,
      }),
    conta: (intFreteId) =>
      call<FreightContaResult>(
        'GET',
        `/api/freight/melhor-envio/conta?intFreteId=${encodeURIComponent(intFreteId)}`,
      ),
  };
}
