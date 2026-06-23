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
import { ensureCartAgency } from './agency';
import { MelhorEnvioError, MelhorEnvioHttpError, MelhorEnvioValidationError } from './errors';
import {
  type Agency,
  type Balance,
  type CalculateRequest,
  type CalculateResponse,
  type CartInsertRequest,
  type CartItem,
  type Me,
  type Order,
  type PrintResponse,
  type ShipmentService,
  agenciesResponseSchema,
  balanceSchema,
  calculateResponseSchema,
  cartItemSchema,
  meSchema,
  opaqueResponseSchema,
  orderSchema,
  printResponseSchema,
  shipmentServicesResponseSchema,
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
  /** `GET /api/v2/me/shipment/services` — carrier services + their company. */
  listServices(): Promise<ShipmentService[]>;
  /** `GET /api/v2/me/shipment/agencies` — a carrier's drop-off agencies. */
  listAgencies(params: {
    company: number | null;
    country: string;
    state: string;
    city: string;
  }): Promise<Agency[]>;
  /**
   * `POST /api/v2/me/cart` — insert a freight item, returns the label/order.
   * Auto-resolves the drop-off `agency` for carriers that need one (Jadlog)
   * when the caller hasn't set it; see `ensureCartAgency`.
   */
  addToCart(req: CartInsertRequest): Promise<CartItem>;
  /** `GET /api/v2/me/orders/{id}` — current state of a label/order. */
  getOrder(id: string): Promise<Order>;
  /** `POST /api/v2/me/shipment/checkout` — buy labels (spends wallet balance). */
  checkout(orderIds: readonly string[]): Promise<unknown>;
  /** `POST /api/v2/me/shipment/generate` — generate the bought labels. */
  generate(orderIds: readonly string[]): Promise<unknown>;
  /** `POST /api/v2/me/shipment/print` — printable label URL `{ url }`. */
  print(orderIds: readonly string[]): Promise<PrintResponse>;
  /** `POST /api/v2/me/shipment/tracking` — tracking info, keyed by order id. */
  tracking(orderIds: readonly string[]): Promise<unknown>;
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

    // Surface a SHORT, safe hint from the ME response body — for non-422 errors
    // (e.g. an opaque 500 on cart insert) it's often the only clue. Extract a
    // known string field (`message`/`error`/`raw`) rather than stringifying the
    // whole object — the thrown message reaches the browser, so this avoids
    // leaking unnecessary data / huge HTML bodies. Full body stays on `err.body`.
    const pickHint = (o: unknown): string | null => {
      if (typeof o === 'string') return o;
      if (o != null && typeof o === 'object') {
        const r = o as { message?: unknown; error?: unknown; raw?: unknown };
        for (const v of [r.message, r.error, r.raw]) if (typeof v === 'string') return v;
      }
      return null;
    };
    const hint = pickHint(parsed);
    const detail = hint ? ` — ${hint.slice(0, 300)}${hint.length > 300 ? '…' : ''}` : '';
    throw new MelhorEnvioHttpError(
      `Melhor Envio ${method} ${path}: HTTP ${res.status}${detail}`,
      res.status,
      parsed,
    );
  }

  const listServices = (): Promise<ShipmentService[]> =>
    request<ShipmentService[]>(
      'GET',
      '/api/v2/me/shipment/services',
      shipmentServicesResponseSchema,
    );

  const listAgencies = (params: {
    company: number | null;
    country: string;
    state: string;
    city: string;
  }): Promise<Agency[]> => {
    const q = new URLSearchParams({
      country: params.country,
      state: params.state,
      city: params.city,
    });
    if (params.company != null) q.set('company', String(params.company));
    return request<Agency[]>(
      'GET',
      `/api/v2/me/shipment/agencies?${q.toString()}`,
      agenciesResponseSchema,
    );
  };

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
    listServices,
    listAgencies,
    addToCart: async (req) => {
      const withAgency = await ensureCartAgency({ listServices, listAgencies }, req);
      return request<CartItem>('POST', '/api/v2/me/cart', cartItemSchema, withAgency);
    },
    getOrder: (id) =>
      request<Order>('GET', `/api/v2/me/orders/${encodeURIComponent(id)}`, orderSchema),
    checkout: (orderIds) =>
      request<unknown>('POST', '/api/v2/me/shipment/checkout', opaqueResponseSchema, {
        orders: [...orderIds],
      }),
    generate: (orderIds) =>
      request<unknown>('POST', '/api/v2/me/shipment/generate', opaqueResponseSchema, {
        orders: [...orderIds],
      }),
    print: (orderIds) =>
      request<PrintResponse>('POST', '/api/v2/me/shipment/print', printResponseSchema, {
        orders: [...orderIds],
      }),
    tracking: (orderIds) =>
      request<unknown>('POST', '/api/v2/me/shipment/tracking', opaqueResponseSchema, {
        orders: [...orderIds],
      }),
  };
}
