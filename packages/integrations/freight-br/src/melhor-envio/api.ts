/**
 * Melhor Envio API surface used by F4 (quote + account). Port of the
 * relevant `MelhorEnviosApi` methods (`calcularFretePacote`,
 * `listarInformacoesUsuario`, `saldoUsuario`). Every request carries
 * `Accept` / `Authorization` / `User-Agent` — the legacy omitted
 * `User-Agent` on GETs, but ME documents it as required.
 *
 * Token handling is delegated: `getAccessToken` is called per request
 * (it runs `getOrRefreshAccessToken` upstream), so a 60s-skew refresh is
 * transparent. A 401 bubbles as `MelhorEnvioHttpError` for the caller to
 * decide on.
 */
import { MelhorEnvioError, MelhorEnvioHttpError, MelhorEnvioValidationError } from './errors';
import {
  type Balance,
  type CalculateRequest,
  type CalculateResponse,
  type Me,
  balanceSchema,
  calculateResponseSchema,
  meSchema,
  validationErrorSchema,
} from './types';
import type { z } from 'zod';

export interface MelhorEnvioApiConfig {
  /** From `melhorEnvioBaseUrl(sandbox)`. */
  readonly baseUrl: string;
  /** Returns a fresh bearer access token (runs getOrRefresh upstream). */
  readonly getAccessToken: () => Promise<string>;
  /** Required by ME — app name + contact email. */
  readonly userAgent: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface MelhorEnvioApi {
  /** `POST /api/v2/me/shipment/calculate` — freight quote. */
  calculate(req: CalculateRequest): Promise<CalculateResponse>;
  /** `GET /api/v2/me` — account info. */
  getMe(): Promise<Me>;
  /** `GET /api/v2/me/balance` — wallet balance. */
  getBalance(): Promise<Balance>;
}

export function createMelhorEnvioApi(config: MelhorEnvioApiConfig): MelhorEnvioApi {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const token = await config.getAccessToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': config.userAgent,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetchImpl(`${config.baseUrl}${path}`, init);
    } catch (err) {
      throw new MelhorEnvioError(
        `Falha de rede ao chamar Melhor Envio ${method} ${path}: ${err instanceof Error ? err.message : 'fetch failed'}`,
      );
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) parsed = { raw: text };
        else throw err;
      }
    }

    if (res.ok) {
      return schema.parse(parsed);
    }

    if (res.status === 422) {
      const v = validationErrorSchema.safeParse(parsed);
      const message = v.success ? (v.data.message ?? 'Dados inválidos.') : 'Dados inválidos.';
      const errors = v.success ? (v.data.errors ?? {}) : {};
      throw new MelhorEnvioValidationError(message, errors, parsed);
    }

    throw new MelhorEnvioHttpError(
      `Melhor Envio ${method} ${path}: HTTP ${res.status}`,
      res.status,
      parsed,
    );
  }

  return {
    calculate: (req) =>
      request<CalculateResponse>(
        'POST',
        '/api/v2/me/shipment/calculate',
        calculateResponseSchema,
        req,
      ),
    getMe: () => request<Me>('GET', '/api/v2/me', meSchema),
    getBalance: () => request<Balance>('GET', '/api/v2/me/balance', balanceSchema),
  };
}
