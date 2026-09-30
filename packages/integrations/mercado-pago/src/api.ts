import { z } from 'zod';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoRequestError,
  MercadoPagoValidationError,
} from './errors';
import { DEFAULT_API_BASE_URL } from './oauth';
import {
  type MpPreferenceExpireRequest,
  type MpPreferenceRequest,
  mpPreferenceExpireRequestSchema,
  mpPreferenceRequestSchema,
} from './requests';
import {
  type MpPayment,
  type MpPaymentSearch,
  type MpPreference,
  type MpUser,
  mpPaymentSchema,
  mpPaymentSearchSchema,
  mpPreferenceSchema,
  mpUserSchema,
  tokenErrorSchema,
} from './types';

const DEFAULT_USER_AGENT = '@delfrance/erp-next';
const DEFAULT_MAX_RETRIES = 3;

/**
 * `GET /v1/payments/search` looks back only `NOW-3MONTHS` unless told otherwise,
 * and accepts a window of under 365 days (error 9062 beyond it). The sync route
 * (#367) must see a link older than three months — including the ones still open
 * at the cutover — so the window is always sent, at the widest value that is
 * safely under the limit.
 */
const SEARCH_BEGIN_DATE = 'NOW-360DAYS';
const SEARCH_END_DATE = 'NOW';

export interface MercadoPagoApiConfig {
  /**
   * Returns a live (non-expired) access token. Token refresh is the caller's
   * concern (the app-side token store) — this client just sends what it's given.
   */
  readonly getAccessToken: () => Promise<string>;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Extra attempts on a **network** failure (fetch throw). Default 3. Applies to
   * `GET` and `PUT` only — a `POST` is attempted ONCE (see `RETRY_ON_NETWORK_THROW`).
   */
  readonly maxRetries?: number;
  /** Backoff (ms) before a network retry (attempt N, 1-based). Default 2^N·250ms; tests pass `() => 0`. */
  readonly retryDelayMs?: (attempt: number) => number;
}

type HttpMethod = 'GET' | 'POST' | 'PUT';

/**
 * Whether a fetch THROW (no response at all) is retried, by method.
 *
 * ⚠️ A property of the method, not a caller option — the caller cannot tell from
 * where it stands whether a retry is safe:
 *
 *  - `GET` reads and `PUT` sets absolute values (the expire patch), so repeating
 *    either is harmless.
 *  - `POST /checkout/preferences` documents NO idempotency key. A throw can happen
 *    AFTER Mercado Pago received the request, so a retry would mint a SECOND
 *    payable preference. The orphan is never persisted or shared — nobody can pay
 *    it — but it is noise nobody can expire. Idempotency for a link lives one
 *    layer up instead (the client-minted link id); this layer simply never sends a
 *    POST twice.
 */
const RETRY_ON_NETWORK_THROW: Readonly<Record<HttpMethod, boolean>> = {
  GET: true,
  PUT: true,
  POST: false,
};

/** A JSON body together with the STRICT schema it must satisfy before it is sent. */
interface RequestBody {
  readonly schema: z.ZodType;
  readonly value: unknown;
}

interface RequestOpts {
  readonly query?: Record<string, string | number | undefined>;
  readonly headers?: Record<string, string>;
  /**
   * The schema travels WITH the value so no code path can send an unvalidated
   * body: `request()` validates it before the token is fetched or `fetch` runs.
   */
  readonly body?: RequestBody;
}

export interface MercadoPagoApi {
  /** `GET /users/me` — the connected account's identity (conta panel). */
  getMe(): Promise<MpUser>;
  /** `GET /v1/payments/{id}`. */
  getPayment(id: number | string): Promise<MpPayment>;
  /**
   * `POST /checkout/preferences` — creates a Checkout Pro preference (a payment
   * link). The body is validated against its STRICT schema before `fetch`
   * ({@link MercadoPagoRequestError}, field paths only), and the request is
   * attempted exactly once even if `fetch` throws.
   */
  createPreference(body: MpPreferenceRequest): Promise<MpPreference>;
  /**
   * `PUT /checkout/preferences/{id}` — the early close of a link. Idempotent, so a
   * network throw IS retried, unlike {@link createPreference}.
   */
  updatePreference(id: string, patch: MpPreferenceExpireRequest): Promise<MpPreference>;
  /**
   * `GET /v1/payments/search` filtered by `external_reference` (the pedido id),
   * newest first, over the widest window Mercado Pago allows.
   */
  searchPayments(params: {
    readonly externalReference: string;
    readonly offset: number;
    readonly limit: number;
  }): Promise<MpPaymentSearch>;
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
   * backoff; any HTTP response, 429/5xx included, is returned as-is. `retries`
   * is 0 for a method that must never be repeated ({@link RETRY_ON_NETWORK_THROW}).
   */
  async function fetchWithNetworkRetry(
    url: string,
    init: RequestInit,
    retries: number,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      try {
        return await fetchImpl(url, init);
      } catch (err) {
        if (attempt < retries) {
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
    method: HttpMethod,
    path: string,
    schema: z.ZodType<T>,
    opts: RequestOpts = {},
  ): Promise<T> {
    // Validate the outbound body FIRST: a bad body must not cost a token fetch
    // (which may refresh and persist a credential) and must never reach the wire.
    const body = opts.body ? assertRequest(opts.body.schema, opts.body.value) : undefined;

    const url = buildUrl(path, opts.query);
    // Fetch the token once; it stays valid across the (few, quick) retries.
    const token = await config.getAccessToken();

    const res = await fetchWithNetworkRetry(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...opts.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      RETRY_ON_NETWORK_THROW[method] ? maxRetries : 0,
    );

    if (res.ok) return parseOk(res, schema);
    throw await toHttpError(res);
  }

  return {
    getMe: () => request('GET', '/users/me', mpUserSchema),
    getPayment: (id) => request('GET', `/v1/payments/${id}`, mpPaymentSchema),
    createPreference: (body) =>
      request('POST', '/checkout/preferences', mpPreferenceSchema, {
        body: { schema: mpPreferenceRequestSchema, value: body },
      }),
    updatePreference: (id, patch) =>
      request('PUT', `/checkout/preferences/${encodeURIComponent(id)}`, mpPreferenceSchema, {
        body: { schema: mpPreferenceExpireRequestSchema, value: patch },
      }),
    searchPayments: ({ externalReference, offset, limit }) =>
      request('GET', '/v1/payments/search', mpPaymentSearchSchema, {
        query: {
          external_reference: externalReference,
          sort: 'date_created',
          criteria: 'desc',
          range: 'date_created',
          begin_date: SEARCH_BEGIN_DATE,
          end_date: SEARCH_END_DATE,
          limit,
          offset,
        },
      }),
  };
}

type ZodIssue = z.ZodError['issues'][number];

/** Dot-joined field paths of a failed parse — names, never values (#1015). */
function camposInvalidos(issues: readonly ZodIssue[]): string[] {
  const campos = new Set<string>();
  for (const issue of issues) {
    const base = issue.path.map((p) => String(p)).join('.');
    if (issue.code === 'unrecognized_keys') {
      // The offending KEY names are code, not data, and they are the useful part:
      // `notification_url` is what a reader must see, not `(raiz)`.
      for (const key of issue.keys) campos.add(base === '' ? key : `${base}.${key}`);
    } else {
      campos.add(base === '' ? '(raiz)' : base);
    }
  }
  return [...campos];
}

/**
 * The single strict gate for everything this client SENDS. Returns the validated
 * body, or throws {@link MercadoPagoRequestError} BEFORE any I/O.
 *
 * ⚠️ Paths only in the message — a preference body can carry a payer's e-mail, CPF
 * and phone, and a message reaches a log line. Do not "improve" it with Zod's own
 * `issue.message`, which for some codes quotes what it received.
 */
function assertRequest<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const campos = camposInvalidos(result.error.issues);
  throw new MercadoPagoRequestError(
    `Corpo da requisição ao Mercado Pago inválido; nada foi enviado. Campos inválidos: ${campos.join(', ')}.`,
    campos,
  );
}

/** The `cause` array of a Mercado Pago error body — entries are read one at a time below. */
const erroComCausasSchema = z.object({ cause: z.array(z.unknown()) }).passthrough();
/** One cause entry. A code is a number (`2001`) or a string, depending on the endpoint. */
const causaSchema = z.object({ code: z.union([z.string(), z.number()]) }).passthrough();

/**
 * The `cause[].code` values of a Mercado Pago error body, as strings — `[]` when
 * the body carries none (or is not JSON at all). Tolerant on purpose: this only
 * ever DISCRIMINATES an error, so an entry it cannot read is skipped instead of
 * hiding the ones it can.
 *
 * The one the sync route cares about is `2001` — "already posted the same request
 * in the last minute" — which it answers with 429 instead of a generic 502.
 */
export function mpCauseCodes(err: MercadoPagoHttpError): string[] {
  const corpo = erroComCausasSchema.safeParse(err.body);
  if (!corpo.success) return [];
  const codigos: string[] = [];
  for (const entrada of corpo.data.cause) {
    const causa = causaSchema.safeParse(entrada);
    if (causa.success) codigos.push(String(causa.data.code));
  }
  return codigos;
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
    // ⚠️ The field names go in the MESSAGE, not only in `issues` — mirroring
    // `parseOk` in the Mercado Livre sibling. `issues` reaches a log line and
    // nothing else: the notification pipeline persists `err.message` ALONE into
    // the failures doc (`persistFailure`) and the sweep marks with `err.message`
    // too. So the durable record of a parked notification — precisely the
    // artifact that was useless in #1087, saying only "formato inesperado" while
    // a quoted number stopped a payment importing — carries whatever is in this
    // string and nothing more.
    //
    // Paths are field names and carry no value, which is what makes this safe;
    // the raw body must never end up here (see the non-JSON branch above, #1015).
    const campos = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(raiz)'))];
    throw new MercadoPagoValidationError(
      `Resposta do Mercado Pago em formato inesperado. Campos inválidos: ${campos.join(', ')}.`,
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
