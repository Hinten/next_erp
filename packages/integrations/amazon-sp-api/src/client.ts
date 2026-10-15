/**
 * The Selling Partner API transport: one GET-only client, `criarClienteSpApi`.
 *
 * ## There is no write method, by construction
 *
 * The client exposes `get` and nothing else, and `get` takes no body. Every
 * SP-API request this package can make is a `GET` — there is no flag to flip,
 * no verb parameter, no request body to fill. Nothing writes to Amazon before
 * the cutover; the first write step adds its own, separately reviewed method.
 *
 * ## The host and the marketplace
 *
 * Brazil belongs to the North America region, served by
 * `https://sellingpartnerapi-na.amazon.com` [D:sp-api-endpoints], and its
 * marketplace id is `A2Q3Y263D00KWC` [D:store-identifiers] — Amazon's public
 * identifier of the BR store, not a seller id. The host is a constant, not an
 * option: the sandbox host is never used (D11), and a fixed origin rules out a
 * response-supplied host.
 *
 * ## The credential and the headers
 *
 * The LWA access token travels in `x-amz-access-token`, and only there. There
 * is no SigV4, no `Authorization` and no `x-amz-date`: SP-API stopped requiring
 * AWS IAM and Signature V4 on 2023-10-02
 * [CL:sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4].
 *
 * - `obterCredencial()` is called on EVERY request and its result is never kept,
 *   so a refreshed token takes effect on the next call and the token lives in
 *   this module only for the duration of one request. Refreshing it is the
 *   app's job (`lwa.ts` does the exchange; the cache lives in the app).
 * - ⚠️ **The token must be visible ASCII (`\x21-\x7E`), checked before any header
 *   is built.** Node's `fetch` rejects a header value carrying a control
 *   character with a `TypeError` whose message QUOTES the value — which this
 *   module would otherwise have turned into an `AmazonNetworkError` with the
 *   token in its `cause`. The token is never trimmed here.
 * - ⚠️ **The `user-agent` is mandatory and the CALLER's.** Amazon requires one
 *   on every request [D:connecting-to-the-selling-partner-api]; this package
 *   carries no default product string, so the app names itself. It is checked
 *   once at construction (printable ASCII, 1–500 characters, no space at either
 *   end) and, per request, refused if it contains the token.
 * - `ref` is an opaque, non-secret label for the credential. It is echoed on the
 *   response, on every error and on every observer event, so the app can tell
 *   WHICH credential a 403 belonged to — except on the error that refuses the
 *   token or the `ref` itself.
 * - The token is never in the URL, and that is CHECKED, not assumed: a path or a
 *   query key or value carrying it is refused with
 *   `AmazonConfigError('token-na-url')` before the URL exists.
 *
 * ## Each request, in order
 *
 *  1. Validate the path (`/<api>/…`, no `?`, `#`, `://`, `..` or an encoded `.`,
 *     `/` or `\`, and unchanged by the URL parser).
 *  2. `await obterCredencial()` — OUTSIDE the deadline, so a slow getter does
 *     not eat the call's budget — then validate the token and the `ref`, refuse
 *     a URL or a user-agent that carries the token.
 *  3. Generate the correlation id (ours only; Amazon documents no request
 *     header for it, so it is never sent).
 *  4. Build exactly `x-amz-access-token`, `x-amz-date`, `user-agent` and
 *     `accept`. No `Content-Type` on a GET.
 *  5. Send through `transporte.ts`: one deadline, `redirect: 'manual'`, the body
 *     read inside the window, the deadline released in `finally`.
 *  6. Classify the outcome into the `errors.ts` taxonomy, by HTTP STATUS —
 *     never by `errors[].code`, which is free-form.
 *  7. Call `onChamada` once, then return or throw.
 *
 * ⚠️ **Redirects are never followed.** SP-API documents none (no 3xx in any
 * model), so a 3xx is an `AmazonHttpError` with `transitorio: false`. Following
 * one would resend `x-amz-access-token` to whatever `Location` names.
 */
import { lerRespostaJson } from '@delfrance/core/wire';
import type { z } from 'zod';

import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonHttpError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
} from './errors';
import { PRAZO_AMAZON_MS } from './prazos';
import {
  type ChamadaAmazon,
  contemSegredo,
  criarEmissor,
  ehAsciiVisivel,
  enviar,
  refValida,
  resolverFetch,
  TOKEN_REMOVIDO,
  userAgentValido,
} from './transporte';
import { spApiErrosSchema } from './types';

export {
  type ChamadaAmazon,
  MAX_REF_CREDENCIAL,
  MAX_USER_AGENT,
  type ResultadoChamadaAmazon,
  TOKEN_REMOVIDO,
} from './transporte';

/** The SP-API host of the North America region, which serves the BR store. */
export const URL_BASE_SP_API = 'https://sellingpartnerapi-na.amazon.com';

/** Amazon's public marketplace id of the Brazil store [D:store-identifiers]. */
export const MARKETPLACE_ID_BR = 'A2Q3Y263D00KWC';

/**
 * The first path segment names an SP-API (`/orders/`, `/sellers/`,
 * `/externalFulfillment/`); every operation path continues under it.
 */
const PREFIXO_CAMINHO = /^\/[a-z][a-zA-Z0-9-]*\//;

/**
 * A percent-encoded `.`, `/` or `\`. None of the three ever NEEDS encoding in a
 * path this client builds today, so the encoded form has no use but to slip a
 * parent segment or a separator past a literal check.
 *
 * ⚠️ Listings paths embed a URL-encoded SKU (`/listings/2021-08-01/items/{sellerId}/{sku}`),
 * and a SKU containing `/` would be refused here. No consumer exists yet; the
 * listing steps bring a reviewed segment encoder with their first such path.
 */
const SEPARADOR_CODIFICADO = /%(?:2e|2f|5c)/i;

/** An `errors[].code` as the observer keeps it: printable ASCII, a label. */
const CODIGO_ERRO = /^[\x20-\x7E]{1,64}$/;

/** At most this many distinct codes per event. */
const MAX_CODIGOS_ERRO = 10;

/** The operation name a refused construction reports. */
const OPERACAO_CONSTRUCAO = 'criarClienteSpApi';

/** The credential for ONE request. */
export interface CredencialSpApi {
  /** The LWA access token (`x-amz-access-token`), raw. */
  readonly accessToken: string;
  /** An opaque, non-secret label for this credential (see the module header). */
  readonly ref: string;
}

export interface OpcoesClienteSpApi {
  /**
   * Called on EVERY request; the result is never stored. A getter that throws
   * propagates as itself and no request is made.
   */
  readonly obterCredencial: () => CredencialSpApi | Promise<CredencialSpApi>;
  /**
   * REQUIRED, with no default: the app's own `AppId/AppVersionId
   * (Language=…)`. Printable ASCII, 1–500 characters, no space at either end.
   * ⚠️ The repo is public — never a store or brand name.
   */
  readonly userAgent: string;
  /** Defaults to `globalThis.fetch`, resolved at call time. */
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to `crypto.randomUUID()`. */
  readonly gerarCorrelationId?: () => string;
  /**
   * Called once per request that was sent, synchronously, after the outcome is
   * known and before the call returns or throws. Not called when nothing was
   * sent (`AmazonConfigError`, a getter that threw, a `sinal` already aborted).
   * The step-2b logger attaches here.
   *
   * ⚠️ An observer that throws propagates in place of the outcome. Harmless for
   * a GET; a logger must still never throw.
   */
  readonly onChamada?: (e: ChamadaAmazon) => void;
  /** Milliseconds, for `latenciaMs` only. Defaults to `Date.now`. */
  readonly agora?: () => number;
}

export interface PedidoGetSpApi<S extends z.ZodType> {
  /** The caller's label for the call (the model's `operationId`). */
  readonly operacao: string;
  /** An SP-API path (`/sellers/v1/marketplaceParticipations`), without a query. */
  readonly caminho: string;
  /**
   * The query. A list parameter (`marketplaceIds`) is the caller's CSV string;
   * `URLSearchParams` encodes its comma as `%2C`.
   */
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly schema: S;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

export interface RespostaSpApi<T> {
  readonly dados: T;
  readonly status: number;
  readonly correlationId: string;
  readonly requestIdAmazon: string | null;
  /** `x-amzn-RateLimit-Limit` of THIS response, in requests per second, or `null`. */
  readonly limiteTaxa: number | null;
  /** The `ref` of the credential THIS request used. */
  readonly refCredencial: string;
}

/** The read-only client. There is no other method, and no body parameter. */
export interface SpApiLeituraClient {
  get<S extends z.ZodType>(p: PedidoGetSpApi<S>): Promise<RespostaSpApi<z.infer<S>>>;
}

/**
 * An SP-API path that reaches the server exactly as written.
 *
 * ⚠️ The literal checks alone are not enough. The WHATWG parser `fetch` uses
 * reads `%2e%2e` and `.%2E` as a parent segment, strips a tab or a line break
 * (so `.<tab>.` becomes `..`), and treats `\` as `/`. So the path must ALSO come
 * out of that parser unchanged, on our origin, with no query and no fragment —
 * whatever the parser would have rewritten, it refuses instead.
 */
function caminhoValido(caminho: unknown): caminho is string {
  if (
    typeof caminho !== 'string' ||
    !PREFIXO_CAMINHO.test(caminho) ||
    caminho.includes('?') ||
    caminho.includes('#') ||
    caminho.includes('://') ||
    caminho.includes('..') ||
    SEPARADOR_CODIFICADO.test(caminho)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(`${URL_BASE_SP_API}${caminho}`);
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
  return (
    url.origin === URL_BASE_SP_API &&
    url.pathname === caminho &&
    url.search === '' &&
    url.hash === ''
  );
}

/**
 * Refuse an unusable credential before anything is built from it.
 *
 * ⚠️ **A refused token never carries its `ref`.** `refValida` can only spot the
 * token VERBATIM inside the `ref`, and a malformed token is by definition not
 * the string the app meant: a `ref` holding the clean token does not contain
 * the dirty one (`TOKEN` vs `TOKEN\n`), and would ride the error whole.
 */
function validarCredencial(credencial: CredencialSpApi, operacao: string): void {
  const { accessToken, ref } = credencial;
  if (!ehAsciiVisivel(accessToken)) {
    throw new AmazonConfigError('token', { operacao, refCredencial: null });
  }
  if (!refValida(ref, [accessToken])) {
    throw new AmazonConfigError('ref', { operacao, refCredencial: null });
  }
}

/**
 * Whether the token appears in the URL about to be built: in the path, in a
 * query key or value as given, or in the final URL (a token can also be
 * assembled across `key=value`).
 */
function tokenNaUrl(
  token: string,
  url: string,
  query: readonly (readonly [string, string])[],
): boolean {
  return url.includes(token) || query.some(([k, v]) => k.includes(token) || v.includes(token));
}

/**
 * The distinct `errors[].code` values of a non-2xx body, for the observer.
 * A body that is not the envelope (`{}`, HTML, empty) has none.
 */
function lerCodigosErro(texto: string, token: string): readonly string[] {
  const leitura = lerRespostaJson(texto, spApiErrosSchema);
  if (!leitura.ok) return [];
  const codigos: string[] = [];
  for (const { code } of leitura.data.errors) {
    if (!CODIGO_ERRO.test(code) || code.includes(token) || codigos.includes(code)) continue;
    codigos.push(code);
    if (codigos.length >= MAX_CODIGOS_ERRO) break;
  }
  return codigos;
}

/**
 * `x-amz-date`: the request time in ISO-8601 basic UTC (`20190430T123600Z`).
 * The connecting page (D:connecting-to-the-selling-partner-api, Step 3) lists it
 * among the request headers and its unsigned example request carries it, but no
 * page says whether the gateway requires it since SigV4 was dropped — and D11
 * forbids finding out live before the window. One timestamp is cheaper than a
 * rejected request, so it is always sent, from the injected clock.
 */
function dataAmz(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/.d{3}Z$/, 'Z');
}

export function criarClienteSpApi(opts: OpcoesClienteSpApi): SpApiLeituraClient {
  if (!userAgentValido(opts.userAgent)) {
    throw new AmazonConfigError('user-agent', {
      operacao: OPERACAO_CONSTRUCAO,
      refCredencial: null,
    });
  }
  const userAgent = opts.userAgent;
  const fetchImpl = resolverFetch(opts.fetch);
  const gerarCorrelationId = opts.gerarCorrelationId ?? (() => globalThis.crypto.randomUUID());
  const agora = opts.agora ?? (() => Date.now());

  async function get<S extends z.ZodType>(
    p: PedidoGetSpApi<S>,
  ): Promise<RespostaSpApi<z.infer<S>>> {
    const { operacao, caminho, schema, sinal } = p;

    // 1. The path. Its message never echoes it: a malformed one may carry a query.
    if (!caminhoValido(caminho)) {
      throw new AmazonConfigError('caminho', { operacao, refCredencial: null });
    }

    // 2. The credential, OUTSIDE the deadline, every time.
    const credencial = await opts.obterCredencial();
    validarCredencial(credencial, operacao);
    const { accessToken, ref } = credencial;

    const query: readonly (readonly [string, string])[] = Object.entries(p.query ?? {}).map(
      ([k, v]) => [k, String(v)] as const,
    );
    const qs = new URLSearchParams(query.map(([k, v]) => [k, v])).toString();
    const url = `${URL_BASE_SP_API}${caminho}${qs === '' ? '' : `?${qs}`}`;

    // The token travels in `x-amz-access-token` only. Refused here, before any
    // message or event is built from the path and the query.
    if (tokenNaUrl(accessToken, url, query)) {
      throw new AmazonConfigError('token-na-url', { operacao, refCredencial: ref });
    }
    if (contemSegredo(userAgent, [accessToken])) {
      throw new AmazonConfigError('user-agent', { operacao, refCredencial: ref });
    }

    // 3. The correlation id: ours, never sent.
    const correlationId = gerarCorrelationId();

    // 4. Exactly these headers.
    const headers: Record<string, string> = {
      'x-amz-access-token': accessToken,
      'x-amz-date': dataAmz(agora()),
      'user-agent': userAgent,
      accept: 'application/json',
    };

    const emitir = criarEmissor(
      {
        destino: 'sp-api',
        operacao,
        metodo: 'GET',
        caminho,
        query,
        correlationId,
        refCredencial: ref,
      },
      true,
      opts.onChamada,
    );

    // 5. Send.
    const r = await enviar({
      fetchImpl,
      agora,
      url,
      metodo: 'GET',
      headers,
      prazoMs: PRAZO_AMAZON_MS.leitura,
      sinal,
      ctx: {
        destino: 'sp-api',
        operacao,
        metodo: 'GET',
        caminho,
        correlationId,
        refCredencial: ref,
      },
      segredos: [accessToken],
      emitir,
    });

    // 6. Classify. The scrubbed text is for the observer ONLY; the parse reads
    // the raw text, so a scrub can never alter the data.
    const { status, texto, ctx } = r;
    const base = {
      status,
      latenciaMs: r.latenciaMs,
      requestIdAmazon: r.requestIdAmazon,
      limiteTaxa: r.limiteTaxa,
      corpo: texto.replaceAll(accessToken, TOKEN_REMOVIDO),
    };

    if (r.ok) {
      const leitura = lerRespostaJson(texto, schema);
      if (leitura.ok) {
        emitir({ ...base, resultado: 'ok' });
        return {
          dados: leitura.data,
          status,
          correlationId,
          requestIdAmazon: r.requestIdAmazon,
          limiteTaxa: r.limiteTaxa,
          refCredencial: ref,
        };
      }
      // `'nao-json'` hands back the raw text; it is dropped here, never carried.
      const campos = leitura.motivo === 'formato' ? leitura.campos : [];
      emitir({ ...base, resultado: 'schema' });
      throw new AmazonSchemaError({ ...ctx, status, motivo: leitura.motivo, campos });
    }

    const codigosErro = lerCodigosErro(texto, accessToken);
    if (status === 401 || status === 403) {
      emitir({ ...base, resultado: 'auth', codigosErro });
      throw new AmazonAuthError({ ...ctx, status, codigoLwa: null });
    }
    if (status === 404) {
      emitir({ ...base, resultado: 'nao-encontrado', codigosErro });
      throw new AmazonNotFoundError({ ...ctx, status });
    }
    if (status === 429) {
      emitir({ ...base, resultado: 'limite', codigosErro });
      throw new AmazonThrottleError({ ...ctx, status, limiteTaxa: r.limiteTaxa });
    }
    emitir({ ...base, resultado: 'http', codigosErro });
    throw new AmazonHttpError({ ...ctx, status });
  }

  return { get };
}
