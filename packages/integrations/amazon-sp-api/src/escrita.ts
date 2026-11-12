/**
 * The SP-API WRITE client, `criarClienteEscritaSpApi`: the package's only writer
 * to the Selling Partner API, kept apart from the read client (`client.ts`) on
 * purpose. Its consumers are the Delivery invoice upload (`entrega.ts`,
 * `enviarNotaFiscal`), the RDT mint (`tokens.ts`, `criarTokenRestrito`), the
 * Easy Ship bulk (`easyShip.ts`, `agendarPacotesEasyShip`), the listings stock
 * patch (`listings.ts`, `enviarDisponibilidadeAmazon`) and the two feed
 * submissions (`feeds.ts`, `criarDocumentoFeedAmazon` and `criarFeedAmazon`);
 * the app builds it in exactly one place, its write engine.
 *
 * ## Two methods, `post` and `patch`
 *
 * Each sends ONE request (`POST`, `PATCH`) through the SAME request core as
 * `get` (`executarSpApi`, `client.ts`): the same path checks, the same
 * token-in-URL refusal, the same correlation id, the same status
 * classification. What differs is only what a write needs:
 *
 *  - **the body**, `corpo`, is a JSON STRING the caller already built from
 *    named keys (`entrega.ts`, `tokens.ts`, `easyShip.ts`, `listings.ts`,
 *    `feeds.ts`), sent byte for byte. It is refused when it contains the access
 *    token, or is not text and so cannot be checked
 *    (`AmazonConfigError('token-no-corpo')`), before anything is sent;
 *  - **exactly five headers**: `get`'s four plus `content-type:
 *    application/json` (the listings model `consumes` it for the `PATCH`);
 *  - **the deadline class `'escrita'`** (`prazos.ts`), longer than a read's,
 *    for both methods.
 *
 * ⚠️ **The request body never reaches the observer.** The event is built from
 * named fields (`criarEmissor`), and `ChamadaAmazon` has no request-body field:
 * a write's body is a whole fiscal document, buyer data included. The RESPONSE
 * body reaches the observer as a read's does, scrubbed of the token — except
 * the Restricted Data Token mint's (`tokens.ts`): no Tokens API body ever
 * reaches it (`client.ts`).
 *
 * ## What a write's outcome means
 *
 *  - A 2xx whose body passes the caller's schema resolves.
 *  - A 2xx that FAILS the schema is `AmazonSchemaError`, and the write MAY HAVE
 *    LANDED: Amazon answered success. So is a 5xx, a timeout
 *    (`AmazonTimeoutError`) and a dropped connection (`AmazonNetworkError`).
 *    ⚠️ None of them is ever repeated in the same attempt: the caller re-reads
 *    the provider's state and decides from that.
 *  - A 429 (`AmazonThrottleError`) was not processed.
 *  - Any other non-2xx classifies exactly as a `GET` does, with the body's
 *    `errors[].code` labels on `codigosErro`.
 *  - `AmazonConfigError`: nothing was sent.
 *
 * ⚠️ An `onChamada` observer that throws rejects the call in place of its
 * outcome — after a write that landed. A write client's observer must be total.
 */
import type { z } from 'zod';

import {
  executarSpApi,
  type OpcoesClienteSpApi,
  prepararNucleoSpApi,
  type RespostaSpApi,
} from './client';

/** The operation name a refused construction reports. */
const OPERACAO_CONSTRUCAO = 'criarClienteEscritaSpApi';

export interface PedidoPostSpApi<S extends z.ZodType> {
  /** The caller's label for the call (the model's `operationId`). */
  readonly operacao: string;
  /** An SP-API path, without a query. */
  readonly caminho: string;
  /** The query, as `get` takes it. */
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  /** The JSON body as TEXT, already built by the caller from named keys; sent as is. */
  readonly corpo: string;
  /** The 2xx body's schema. */
  readonly schema: S;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

/** A `PATCH` carries exactly what a `POST` does: a path, a query, the JSON text, a schema. */
export type PedidoPatchSpApi<S extends z.ZodType> = PedidoPostSpApi<S>;

/** The write client. Two methods; no `get`. */
export interface SpApiEscritaClient {
  post<S extends z.ZodType>(p: PedidoPostSpApi<S>): Promise<RespostaSpApi<z.infer<S>>>;
  patch<S extends z.ZodType>(p: PedidoPatchSpApi<S>): Promise<RespostaSpApi<z.infer<S>>>;
}

/** The options are the read client's own (`OpcoesClienteSpApi`): the same credential rule. */
export function criarClienteEscritaSpApi(opts: OpcoesClienteSpApi): SpApiEscritaClient {
  const n = prepararNucleoSpApi(opts, OPERACAO_CONSTRUCAO);

  // The core gets a POST built from the named fields: nothing else rides along.
  async function post<S extends z.ZodType>(
    p: PedidoPostSpApi<S>,
  ): Promise<RespostaSpApi<z.infer<S>>> {
    return executarSpApi(n, {
      metodo: 'POST',
      operacao: p.operacao,
      caminho: p.caminho,
      query: p.query,
      corpo: p.corpo,
      schema: p.schema,
      sinal: p.sinal,
    });
  }

  // The same, as a PATCH: the method is the only difference.
  async function patch<S extends z.ZodType>(
    p: PedidoPatchSpApi<S>,
  ): Promise<RespostaSpApi<z.infer<S>>> {
    return executarSpApi(n, {
      metodo: 'PATCH',
      operacao: p.operacao,
      caminho: p.caminho,
      query: p.query,
      corpo: p.corpo,
      schema: p.schema,
      sinal: p.sinal,
    });
  }

  return { post, patch };
}
