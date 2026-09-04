/**
 * The one HTTP path in this package: sign, fetch, read the envelope, then read
 * the operation schema.
 *
 * Modelled on `packages/integrations/freight-br/src/http-client/client.ts`, with
 * the one structural difference Shopee forces: **a failing call is routinely
 * HTTP 200**, so the outcome is decided by `envelope.error === ''` and never by
 * `res.ok`.
 *
 * ## Why the body is parsed TWICE
 *
 * Stage 1 parses the envelope alone; stage 2 parses the operation schema. That
 * is deliberate, not redundancy: a failing body carries no `access_token` and no
 * `response`, so parsing the operation schema first would report
 * "`access_token` is missing" and BURY the `invalid_code` that actually explains
 * the failure. One `text`, two `safeParse`s, no second network call.
 *
 * ⚠️ Shared by `oauth.ts` (the two token endpoints) and `api.ts` (everything
 * else). It lives in its own module rather than inside `api.ts` so the
 * dependency edge runs one way — `oauth.ts` must not import the client factories
 * it is a building block of. It is INTERNAL: `index.ts` deliberately does not
 * re-export it.
 */
import type { z } from 'zod';

import { lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import {
  SHOPEE_ERROR_KIND,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeSchemaError,
  type ShopeeSurface,
  shopeeErrorFromEnvelope,
} from './errors';
import { type SignedCall, signedQuery } from './sign';
import { shopeeEnvelopeSchema } from './types';

/** What Shopee reported alongside a SUCCESSFUL call. Never an error. */
export interface ShopeeWarning {
  readonly path: string;
  readonly warning: string;
  readonly requestId: string | null;
}

/** Everything the transport needs that is not specific to one call. */
export interface ShopeeTransport {
  readonly partnerId: number;
  readonly partnerKey: string;
  readonly apiHost: string;
  readonly fetch: typeof globalThis.fetch;
  /** Injected clock, milliseconds. */
  readonly now: () => number;
  readonly onWarning?: (w: ShopeeWarning) => void;
}

export interface ShopeeCallParams<S extends z.ZodType> {
  readonly method: 'GET' | 'POST';
  /** API path only, e.g. `/api/v2/shop/get_shop_info`. */
  readonly path: string;
  readonly call: SignedCall;
  /** The schema that decides FLAT vs WRAPPED. There is no mode flag. */
  readonly schema: S;
  readonly surface: ShopeeSurface;
  /**
   * The response body IS a credential (the token endpoints). Suppresses body
   * logging entirely — status and length only.
   */
  readonly sensitive?: boolean;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly body?: unknown;
}

/** How much of a non-JSON body may reach a log line. */
const MAX_LOGGED_BODY = 500;

/**
 * Log a body no operator will ever see, capped so a whole HTML error page cannot
 * flood the console — and never at all when the body is a credential (#1015).
 */
function logarCorpoNaoJson(path: string, status: number, corpo: string, sensitive: boolean): void {
  if (sensitive) {
    console.error(
      `[shopee] resposta não-JSON em ${path} (HTTP ${String(status)}), ${String(corpo.length)} bytes — corpo omitido (credencial)`,
    );
    return;
  }
  console.error(
    `[shopee] resposta não-JSON em ${path} (HTTP ${String(status)})`,
    corpo.slice(0, MAX_LOGGED_BODY),
  );
}

/**
 * `Retry-After` as whole seconds, or `null`.
 *
 * ⚠️ Only the delta-seconds form is read. The HTTP-date form would need a clock
 * and a date parse to become a delay, and Shopee has never been observed sending
 * one; answering `null` makes the caller fall back to its own backoff, which is
 * strictly better than a delay computed from a guess.
 */
function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export async function shopeeCall<S extends z.ZodType>(
  transport: ShopeeTransport,
  p: ShopeeCallParams<S>,
): Promise<z.infer<S>> {
  const qs = signedQuery({
    partnerId: transport.partnerId,
    partnerKey: transport.partnerKey,
    path: p.path,
    call: p.call,
    nowMs: transport.now(),
    extra: p.query,
  });

  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method: p.method, headers };
  if (p.body !== undefined) {
    // ⚠️ The body is NOT part of the signature. It carries the operation's own
    // parameters; the common ones stay in the query for POST as well as GET.
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(p.body);
  }

  let res: Response;
  try {
    res = await transport.fetch(`${transport.apiHost}${p.path}?${qs.toString()}`, init);
  } catch (err) {
    // ⚠️ The message names the PATH and nothing else. `err.message` from an
    // aborted fetch can echo the request URL, which carries `access_token`.
    throw new ShopeeNetworkError(`Falha de rede ao contatar a Shopee em ${p.path}.`, err);
  }

  const text = await res.text();
  const sensitive = p.sensitive === true;
  const retryAfterSeconds = parseRetryAfter(res);

  /* ------------------------------- stage 1 -------------------------------- */
  const envelopeLeitura = lerRespostaJson(text, shopeeEnvelopeSchema);
  if (!envelopeLeitura.ok) {
    // A bare 429 whose body is not an envelope is still a rate limit, and the
    // only signal a caller can act on. Classified as `burst`: the daily quota is
    // reported through `error_limit` IN an envelope, never as a naked status.
    if (res.status === 429) {
      throw new ShopeeRateLimitError(
        `Shopee ${p.path} respondeu HTTP 429 sem envelope (limite de requisições).`,
        {
          code: 'http_429',
          kind: SHOPEE_ERROR_KIND.burst,
          httpStatus: res.status,
          path: p.path,
          retryAfterSeconds,
        },
      );
    }

    if (envelopeLeitura.motivo !== 'formato') {
      // ⚠️ EMPTY and NON-JSON share this branch: in both the request never
      // reached a route that answers JSON. Under the IP whitelist (P2) that is
      // the EXPECTED shape of a rejection at Shopee's edge.
      logarCorpoNaoJson(
        p.path,
        res.status,
        envelopeLeitura.motivo === 'nao-json' ? envelopeLeitura.texto : '(corpo vazio)',
        sensitive,
      );
      if (!res.ok) {
        throw new ShopeeHttpError(
          `Shopee ${p.path} respondeu HTTP ${String(res.status)} sem um corpo JSON.`,
          { httpStatus: res.status, path: p.path },
        );
      }
      throw new ShopeeSchemaError(
        `Shopee ${p.path} respondeu HTTP ${String(res.status)} sem um corpo JSON — a requisição não chegou a uma rota que responde JSON.`,
        { httpStatus: res.status, path: p.path },
      );
    }

    // JSON, but not a Shopee envelope.
    if (!res.ok) {
      throw new ShopeeHttpError(
        `Shopee ${p.path} respondeu HTTP ${String(res.status)} com um corpo que não é um envelope da Shopee.`,
        { httpStatus: res.status, path: p.path },
      );
    }
    throw new ShopeeSchemaError(
      `Shopee ${p.path} respondeu sem o envelope esperado. Campos inválidos: ${resumirCampos(envelopeLeitura.campos)}.`,
      { campos: envelopeLeitura.campos, httpStatus: res.status, path: p.path },
    );
  }

  const envelope = envelopeLeitura.data;

  // ⚠️ EXACT equality with the empty string. `' '` is a failure, and trimming
  // here would read it as a success.
  if (envelope.error !== '') {
    throw shopeeErrorFromEnvelope(envelope, {
      path: p.path,
      httpStatus: res.status,
      surface: p.surface,
      retryAfterSeconds,
    });
  }

  // A warning rides on a SUCCESSFUL call — a partial-failure channel, never a
  // reason to throw. It also stays on the returned object.
  if (envelope.warning !== null && transport.onWarning !== undefined) {
    transport.onWarning({
      path: p.path,
      warning: envelope.warning,
      requestId: envelope.request_id,
    });
  }

  /* ------------------------------- stage 2 -------------------------------- */
  const leitura = lerRespostaJson(text, p.schema);
  if (leitura.ok) return leitura.data;

  // Unreachable for the other two outcomes: stage 1 already proved the body is
  // non-empty JSON. Handled anyway so the failure is a typed error rather than a
  // fallthrough.
  const campos = leitura.motivo === 'formato' ? leitura.campos : [];
  throw new ShopeeSchemaError(
    `Shopee ${p.path} respondeu num formato inesperado. Campos inválidos: ${resumirCampos(campos)}.`,
    { campos, httpStatus: res.status, path: p.path },
  );
}
