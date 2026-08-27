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
import { z } from 'zod';

import { envelopeDeErro, lerRespostaJson } from '@delfrance/core/wire';

import {
  agencySchema,
  balanceSchema,
  calculateResponseSchema,
  meSchema,
} from '../melhor-envio/types';
import type { CalculateRequest, CalculateResponse, CartInsertRequest } from '../melhor-envio/types';

import {
  FreightAuthError,
  FreightSchemaError,
  FreightBadRequestError,
  FreightHttpError,
  FreightLabelTerminalError,
  FreightNetworkError,
  FreightNotFoundError,
  FreightReauthRequiredError,
  FreightServerError,
  FreightValidationError,
} from './errors';

/**
 * ⚠️ Schemas rather than interfaces, with the types inferred from them — one
 * definition, so the runtime check and the type cannot disagree. The ME wire
 * shapes (`meSchema`, `balanceSchema`, `agencySchema`, `calculateResponseSchema`)
 * are reused from `../melhor-envio/types` rather than re-described here: those
 * ARE the shapes this route forwards, and a second description of them would be
 * a second thing to keep in step.
 *
 * Unknown keys pass — nothing here is `.strict()`. The browser calls the
 * DEPLOYED apps/melhor-envio, so a newer backend must not break an older tab.
 */

/** `oauth/start` result — the ME consent URL the browser navigates to. */
export const freightOAuthStartResultSchema = z.object({ authorizeUrl: z.string() });
export type FreightOAuthStartResult = z.infer<typeof freightOAuthStartResultSchema>;

/** `conta` result — connection state + account info/balance when connected. */
export const freightContaResultSchema = z.object({
  connected: z.boolean(),
  me: meSchema.nullable(),
  balance: balanceSchema.nullable(),
});
export type FreightContaResult = z.infer<typeof freightContaResultSchema>;

/** `agencias` result — the drop-off agencies of the carrier behind a service. */
export const freightAgenciasResultSchema = z.object({
  // `.default([])` because `EtiquetaComprarModal` already reads it as
  // `agencias.data?.agencies ?? []` — that `??` is the evidence about the wire.
  agencies: z.array(agencySchema).default([]),
});
export type FreightAgenciasResult = z.infer<typeof freightAgenciasResultSchema>;

/** `comprar` result — the bought label, its print URL and tracking code. */
export const freightComprarResultSchema = z.object({
  printLabelId: z.string(),
  printUrl: z.string(),
  tracking: z.string().nullable(),
  estado: z.string(),
});
export type FreightComprarResult = z.infer<typeof freightComprarResultSchema>;

/** `imprimir` result — the printable label URL. */
export const freightImprimirResultSchema = z.object({ url: z.string() });
export type FreightImprimirResult = z.infer<typeof freightImprimirResultSchema>;

/**
 * `rastrear` result — Melhor Envio's tracking payload (keyed by order id).
 *
 * ⚠️ `tracking` stays `z.unknown()`: it is an ME-owned map nobody here reads by
 * name, so a schema over it would assert nothing while inventing a way to
 * reject a payload the caller handles fine. The KEY is still required —
 * `z.unknown()` accepts any value but does not make its key optional in Zod 4.
 */
export const freightRastrearResultSchema = z.object({ tracking: z.unknown() });
export type FreightRastrearResult = z.infer<typeof freightRastrearResultSchema>;

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
  /**
   * Drop-off agencies of the carrier behind `service`, near the sender —
   * feeds the buy modal's agency picker (#377). The server lists the sender's
   * city first and falls back to a state-wide list when the city has none.
   */
  agencias(
    intFreteId: string,
    params: { service: number; state: string; city: string },
  ): Promise<FreightAgenciasResult>;
  /** Buy + generate + print a label for `pedidoId` (idempotent on resume). */
  comprar(
    intFreteId: string,
    pedidoId: string,
    cartPayload: CartInsertRequest,
    printLabelId?: string | null,
  ): Promise<FreightComprarResult>;
  /** Get the printable URL of an already-bought label. */
  imprimir(intFreteId: string, printLabelId: string): Promise<FreightImprimirResult>;
  /** Get the tracking payload for a label. */
  rastrear(intFreteId: string, printLabelId: string): Promise<FreightRastrearResult>;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * The operator-facing message for a non-2xx body.
 *
 * ⚠️ Goes through `envelopeDeErro` rather than `String(body.error)`. The old
 * form stringified whatever `error` happened to be, so a non-string one
 * rendered as `[object Object]` in a message a human reads; the shared reader
 * drops a field of the wrong type instead. It is also the reason that import
 * exists — it was added in this PR and then never used.
 */
function messageOf(body: unknown, fallback: string): string {
  return envelopeDeErro(body)?.error ?? fallback;
}

function errorFromResponse(status: number, body: unknown): FreightHttpError {
  const message = messageOf(body, `HTTP ${status}`);
  if (status === 400) return new FreightBadRequestError(message, body);
  if (status === 401 || status === 403) return new FreightAuthError(message, status, body);
  if (status === 404) return new FreightNotFoundError(message, body);
  if (status === 409) {
    const obj = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (obj.code === 'ME_LABEL_TERMINAL') {
      const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
      return new FreightLabelTerminalError(message, reason, body);
    }
    return new FreightReauthRequiredError(message, body);
  }
  if (status === 422) {
    const errors =
      body !== null && typeof body === 'object' && 'errors' in body
        ? ((body as { errors: Record<string, string[]> }).errors ?? {})
        : {};
    return new FreightValidationError(message, errors, body);
  }
  return new FreightServerError(message, status, body);
}

/**
 * Log a body the operator will never see, capped so a whole HTML document
 * cannot flood the console.
 */
function logarCorpoNaoJson(path: string, status: number, corpo: string): void {
  console.error(
    `[freight] resposta não-JSON em ${path} (HTTP ${String(status)})`,
    corpo.slice(0, 500),
  );
}

export function createFreightHttpClient(config: FreightHttpClientConfig): FreightHttpClient {
  const baseUrl = normalizeBase(config.baseUrl);
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
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

    const text = await res.text();

    if (!res.ok) {
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          // ⚠️ The body used to become `{ error: text }`, so a proxy's whole HTML
          // document rode into the thrown message. The Mercado Livre client fixed
          // this in 3a4b7278; this one never got the same treatment.
          if (err instanceof SyntaxError) {
            logarCorpoNaoJson(path, res.status, text);
          } else throw err;
        }
      }
      throw errorFromResponse(res.status, parsed);
    }

    const leitura = lerRespostaJson(text, schema);
    if (leitura.ok) return leitura.data;

    if (leitura.motivo === 'nao-json') {
      logarCorpoNaoJson(path, res.status, leitura.texto);
      throw new FreightSchemaError(
        `O serviço de frete respondeu HTTP ${String(res.status)} sem um corpo JSON — o pedido ` +
          'não chegou à rota esperada. Atualize a página e, se continuar, avise o suporte.',
        res.status,
        [],
      );
    }

    throw new FreightSchemaError(
      'O serviço de frete respondeu num formato que este aplicativo não reconhece. ' +
        `Campos inválidos: ${leitura.campos.join(', ')}. Normalmente isso significa que o ` +
        'backend e esta tela estão em versões diferentes — faça o deploy de ' +
        '`apps/melhor-envio` e recarregue a página.',
      res.status,
      leitura.campos,
    );
  }

  return {
    oauthStart: (intFreteId) =>
      call(
        'GET',
        `/api/freight/melhor-envio/oauth/start?intFreteId=${encodeURIComponent(intFreteId)}`,
        freightOAuthStartResultSchema,
      ),
    calculate: (intFreteId, req) =>
      call('POST', '/api/freight/melhor-envio/calculate', calculateResponseSchema, {
        intFreteId,
        ...req,
      }),
    conta: (intFreteId) =>
      call(
        'GET',
        `/api/freight/melhor-envio/conta?intFreteId=${encodeURIComponent(intFreteId)}`,
        freightContaResultSchema,
      ),
    agencias: (intFreteId, params) => {
      const q = new URLSearchParams({
        intFreteId,
        service: String(params.service),
        state: params.state,
        city: params.city,
      });
      return call(
        'GET',
        `/api/freight/melhor-envio/agencias?${q.toString()}`,
        freightAgenciasResultSchema,
      );
    },
    comprar: (intFreteId, pedidoId, cartPayload, printLabelId) =>
      call('POST', '/api/freight/melhor-envio/comprar', freightComprarResultSchema, {
        intFreteId,
        pedidoId,
        cartPayload,
        printLabelId: printLabelId ?? null,
      }),
    imprimir: (intFreteId, printLabelId) =>
      call('POST', '/api/freight/melhor-envio/imprimir', freightImprimirResultSchema, {
        intFreteId,
        printLabelId,
      }),
    rastrear: (intFreteId, printLabelId) =>
      call('POST', '/api/freight/melhor-envio/rastrear', freightRastrearResultSchema, {
        intFreteId,
        printLabelId,
      }),
  };
}
