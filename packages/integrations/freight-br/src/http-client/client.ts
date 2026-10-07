/**
 * Browser-safe typed client for the `apps/melhor-envio` Melhor Envio
 * freight routes. Mirrors `@delfrance/integrations-nfe/http-provider`:
 * a Bearer Firebase ID token from the caller's auth context, typed
 * results, and HTTP statuses narrowed into typed errors. **Zero server
 * deps** — imports only `globalThis.fetch` and type-only ME shapes.
 *
 * The OAuth callback is hit by Melhor Envio's redirect, not by this
 * client, so there is no method for it.
 */
import { z } from 'zod';

import {
  abrirPrazo,
  ehTempoEsgotadoNoGateway,
  envelopeDeErro,
  lerRespostaJson,
  type PrazoDeTransporte,
  resumirCampos,
} from '@delfrance/core/wire';

import {
  agencySchema,
  balanceSchema,
  calculateResponseSchema,
  meSchema,
} from '../melhor-envio/types';
import type { CalculateRequest, CalculateResponse, CartInsertRequest } from '../melhor-envio/types';

import {
  FREIGHT_CODIGO_ME_TIMEOUT,
  FreightAuthError,
  FreightSchemaError,
  FreightBadRequestError,
  type FreightHttpError,
  FreightLabelTerminalError,
  FreightNetworkError,
  FreightNotFoundError,
  FreightReauthRequiredError,
  FreightServerError,
  FreightTimeoutError,
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
  /** Origin of `apps/melhor-envio` (dev: `http://localhost:3005`). */
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

/**
 * How long this client waits for each route (#1094).
 *
 * `fetch()` has no default timeout, so before this a route that accepted the
 * connection and never answered left the caller spinning for ever. But no
 * route observes a client abort — the server keeps running — so a deadline is
 * only harmless where a RE-SEND is harmless:
 *
 *  - `curto` — the route has no effect a repeat could duplicate (a quote, a
 *    read, a label URL, a tracking lookup; `oauthStart`'s overwritten nonce
 *    fails CLOSED on a racing repeat). 60 s: a cold start plus up to three
 *    sequential Melhor Envio calls.
 *  - `longo` — a repeat could duplicate the effect (`comprar` pays for a label).
 *    It must be at least the backend's request ceiling (App Hosting's 300 s)
 *    plus a margin for the CORS preflight and a cold start, so the abort never
 *    fires before the platform's own 504 and opens no window that 504 does not.
 *
 * ⚠️ There is deliberately no config knob: a caller-tunable budget on
 * `comprar` is exactly how that window would reopen. The ceiling invariant is
 * pinned by `packages/config-eslint/rules/http-client-timeout-ceiling.test.js`.
 */
export const FREIGHT_PRAZO_MS = { curto: 60_000, longo: 360_000 } as const;

type Nivel = keyof typeof FREIGHT_PRAZO_MS;
type Operacao = keyof FreightHttpClient;

/**
 * Every method's tier. `satisfies Record<keyof FreightHttpClient, …>` makes a
 * new method a compile error until someone decides whether repeating it is
 * safe — that decision is the whole point of the table.
 */
export const FREIGHT_NIVEL_POR_OPERACAO = {
  oauthStart: 'curto',
  calculate: 'curto',
  conta: 'curto',
  agencias: 'curto',
  comprar: 'longo',
  imprimir: 'curto',
  rastrear: 'curto',
} as const satisfies Record<Operacao, Nivel>;

function mensagemDeTempoEsgotado(nivel: Nivel, timeoutMs: number | null): string {
  if (nivel === 'longo') {
    return (
      'O serviço de frete não respondeu a tempo e a compra pode ainda estar em andamento. ' +
      'Aguarde alguns minutos e confira se a etiqueta já aparece no pedido antes de comprar de novo.'
    );
  }
  const quando = timeoutMs === null ? 'a tempo' : `em ${String(Math.round(timeoutMs / 1000))} s`;
  return `O serviço de frete não respondeu ${quando}. Tente novamente.`;
}

/**
 * Map a rejection from the transport — the `fetch` itself OR the body read —
 * to this client's taxonomy.
 *
 * ⚠️ Classified by asking the deadline (`motivoDeTempoEsgotado()`), never by
 * `err instanceof DOMException`: `fetch` rejects with the signal's reason
 * as-is, and under jsdom that `DOMException` is a different realm's class.
 *
 * ⚠️ A failure that arrives LATE is a timeout too (`origem: 'gateway'`). This
 * client runs in the browser, cross-origin to `apps/melhor-envio`, and the
 * platform's own 504 comes from its frontend without CORS headers — so it
 * reaches `fetch` as a `TypeError`, never as a status. Without this rule a
 * `comprar` that outlived the platform would read "falha de rede" and invite
 * the second-label click. See `LIMIAR_FALHA_TARDIA_MS`.
 *
 * Everything else stays today's typed wrap, now also covering the body read,
 * which used to sit outside any `try` and let a mid-body failure escape raw.
 */
function erroDeTransporte(
  err: unknown,
  prazo: PrazoDeTransporte,
  operacao: Operacao,
  timeoutMs: number,
): FreightNetworkError {
  const origem = prazo.motivoDeTempoEsgotado();
  if (origem !== null) {
    const ms = origem === 'prazo' ? timeoutMs : null;
    return new FreightTimeoutError(
      mensagemDeTempoEsgotado(FREIGHT_NIVEL_POR_OPERACAO[operacao], ms),
      { origem, timeoutMs: ms, operacao },
      err,
    );
  }
  return new FreightNetworkError(err instanceof Error ? err.message : 'fetch failed', err);
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
    operacao: Operacao,
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    // Outside the deadline: Firebase Auth bounds its own token refresh, and the
    // window measures the ROUTE, not the SDK.
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

    const timeoutMs = FREIGHT_PRAZO_MS[FREIGHT_NIVEL_POR_OPERACAO[operacao]];
    const prazo = abrirPrazo(timeoutMs);
    init.signal = prazo.signal;

    // ⚠️ The body read is INSIDE the window and the mapping: a route that sends
    // its headers and then stalls would otherwise hang past the deadline, and an
    // abort landing mid-body would escape as a raw DOMException that every
    // caller's `instanceof` chain rethrows.
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${baseUrl}${path}`, init);
      text = await res.text();
    } catch (err) {
      throw erroDeTransporte(err, prazo, operacao, timeoutMs);
    } finally {
      prazo.liberar();
    }

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
      // ⚠️ Before the status mapping: a 504 no route of ours wrote is the
      // platform giving up on the request, and the server may still be running
      // it. As a `FreightServerError` it would read as a plain failure and invite
      // the re-click this whole module exists to make safe. (Only a READABLE 504
      // lands here — same-origin or server-side. The cross-origin browser case
      // arrives as a late network failure: see `erroDeTransporte`.)
      if (ehTempoEsgotadoNoGateway(res.status, parsed)) {
        throw new FreightTimeoutError(
          mensagemDeTempoEsgotado(FREIGHT_NIVEL_POR_OPERACAO[operacao], null),
          { origem: 'gateway', timeoutMs: null, operacao },
        );
      }
      // The ROUTE telling us Melhor Envio stopped answering (#1679). Same class
      // as our own deadline because it means the same thing to the operator —
      // the outcome is unknown (a `checkout` may have paid) — so every caller's
      // timeout arm (no re-click, no query retry) applies without a new branch.
      // The route's message is kept: it names the step that stalled.
      const envelope = envelopeDeErro(parsed);
      if (res.status === 504 && envelope?.code === FREIGHT_CODIGO_ME_TIMEOUT) {
        const corpo = parsed as { timeoutMs?: unknown };
        const timeoutMs =
          typeof corpo.timeoutMs === 'number' && Number.isFinite(corpo.timeoutMs)
            ? corpo.timeoutMs
            : null;
        throw new FreightTimeoutError(
          envelope.error ?? mensagemDeTempoEsgotado(FREIGHT_NIVEL_POR_OPERACAO[operacao], null),
          { origem: 'provedor', timeoutMs, operacao },
        );
      }
      throw errorFromResponse(res.status, parsed);
    }

    const leitura = lerRespostaJson(text, schema);
    if (leitura.ok) return leitura.data;

    if (leitura.motivo !== 'formato') {
      // ⚠️ EMPTY and NON-JSON share this branch: neither is version skew — in
      // both the request failed to reach a route that answers JSON, so neither
      // may tell the operator to deploy anything.
      logarCorpoNaoJson(
        path,
        res.status,
        leitura.motivo === 'nao-json' ? leitura.texto : '(corpo vazio)',
      );
      throw new FreightSchemaError(
        `O serviço de frete respondeu HTTP ${String(res.status)} sem um corpo JSON — o pedido ` +
          'não chegou à rota esperada. Atualize a página e, se continuar, avise o suporte.',
        res.status,
        [],
      );
    }

    throw new FreightSchemaError(
      'O serviço de frete respondeu num formato que este aplicativo não reconhece. ' +
        `Campos inválidos: ${resumirCampos(leitura.campos)}. Normalmente isso significa que o ` +
        'backend e esta tela estão em versões diferentes — faça o deploy de ' +
        '`apps/melhor-envio` e recarregue a página.',
      res.status,
      leitura.campos,
    );
  }

  return {
    oauthStart: (intFreteId) =>
      call(
        'oauthStart',
        'GET',
        `/api/freight/melhor-envio/oauth/start?intFreteId=${encodeURIComponent(intFreteId)}`,
        freightOAuthStartResultSchema,
      ),
    calculate: (intFreteId, req) =>
      call('calculate', 'POST', '/api/freight/melhor-envio/calculate', calculateResponseSchema, {
        intFreteId,
        ...req,
      }),
    conta: (intFreteId) =>
      call(
        'conta',
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
        'agencias',
        'GET',
        `/api/freight/melhor-envio/agencias?${q.toString()}`,
        freightAgenciasResultSchema,
      );
    },
    comprar: (intFreteId, pedidoId, cartPayload, printLabelId) =>
      call('comprar', 'POST', '/api/freight/melhor-envio/comprar', freightComprarResultSchema, {
        intFreteId,
        pedidoId,
        cartPayload,
        printLabelId: printLabelId ?? null,
      }),
    imprimir: (intFreteId, printLabelId) =>
      call('imprimir', 'POST', '/api/freight/melhor-envio/imprimir', freightImprimirResultSchema, {
        intFreteId,
        printLabelId,
      }),
    rastrear: (intFreteId, printLabelId) =>
      call('rastrear', 'POST', '/api/freight/melhor-envio/rastrear', freightRastrearResultSchema, {
        intFreteId,
        printLabelId,
      }),
  };
}
