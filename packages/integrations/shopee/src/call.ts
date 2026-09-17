/**
 * The one HTTP path in this package: sign, fetch, read the envelope, then read
 * the operation schema.
 *
 * Modelled on `packages/integrations/freight-br/src/http-client/client.ts`, with
 * the one structural difference Shopee forces: **a failing call is routinely
 * HTTP 200**, so the outcome is decided by `envelope.error === ''` and never by
 * `res.ok`.
 *
 * ⚠️ That invariant has exactly ONE exception, and it is opt-in PER OPERATION:
 * {@link ShopeeCallParams.emptyErrorAliases}. Three pages — the two on the
 * lost-push queue and `v2.order.get_package_detail` — print `"-"` where the
 * others print `""`, and the alias exists so those three operations can read it
 * as success. It is never a global widening: the default stays exact equality
 * with `''`, the opt-in is per CALL SITE — three of them, over TWO constants —
 * and a `' '` is a failure everywhere, aliases included.
 *
 * ## Why the body is parsed TWICE
 *
 * Stage 1 parses the envelope alone; stage 2 parses the operation schema. That
 * is deliberate, not redundancy: a failing body carries no `access_token` and no
 * `response`, so parsing the operation schema first would report
 * "`access_token` is missing" and BURY the `invalid_code` that actually explains
 * the failure. One `text`, two `safeParse`s, no second network call.
 *
 * ## The two body shapes
 *
 * Almost every operation posts JSON. Exactly one — `v2.media_space.upload_image`
 * — posts `multipart/form-data`, and it is a different enough animal that
 * {@link ShopeeCallParams} makes the two **mutually exclusive at compile time**
 * rather than guarding them at runtime: no `Content-Type` header (`fetch` writes
 * the boundary), the file as a `Blob` over a copied buffer, and `undefined` text
 * fields dropped. Everything after the request — the signature, the two-stage
 * parse, the `error === ''` verdict, the warning channel — is byte-identical for
 * both: a multipart request still answers a perfectly ordinary Shopee envelope.
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
import { type ShopeeQueryValue, type SignedCall, signedQuery } from './sign';
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

/**
 * One file part of a `multipart/form-data` POST.
 *
 * ⚠️ The `contentType` rides on the {@link Blob}, never on a request header:
 * `fetch` writes the one `Content-Type` this request may carry, with the
 * boundary in it.
 */
export interface ShopeeMultipartFile {
  /**
   * The form field name.
   *
   * ⚠️ A CONTRADICTED literal at the one call site that has one: the
   * `upload_image` page's Request-params table, its PHP sample and its cURL
   * sample all say `image`, while its Java sample says `file`. The package
   * carries the choice as `SHOPEE_UPLOAD_IMAGE_FIELD` (`types.ts`) so the probe
   * can flip it in one line; the transport itself sends whatever it is given.
   */
  readonly field: string;
  readonly filename: string;
  /** Rides on the Blob, never on a request header. */
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** A `multipart/form-data` body: exactly ONE file, plus text fields. */
export interface ShopeeMultipartBody {
  readonly file: ShopeeMultipartFile;
  /**
   * Text fields that travel in the SAME form as the file.
   *
   * ⚠️ An `undefined` value is DROPPED, never appended: `FormData.append`
   * stringifies, so `scene: undefined` would travel as the literal four-letter
   * word `"undefined"` — a value `upload_image`'s `scene` (`normal | desc`) does
   * not accept, sent by a caller that meant to send nothing at all.
   */
  readonly fields?: Readonly<Record<string, string | undefined>>;
}

/** Everything a call needs that does not decide HOW the body travels. */
interface ShopeeCallBase<S extends z.ZodType> {
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
  /**
   * The operation's own query parameters, handed straight to `signedQuery`.
   *
   * ⚠️ An ARRAY value becomes a REPEATED key, one entry per element — see
   * {@link ShopeeQueryValue}. Nothing here joins, and nothing here refuses: an
   * empty array emits no key at all, and the refusal for a required parameter
   * belongs to the operation's bound guard in `api.ts`.
   */
  readonly query?: Readonly<Record<string, ShopeeQueryValue>>;
  /**
   * Envelope `error` values THIS OPERATION accepts as success, beyond `''`.
   *
   * ⚠️ Exactly THREE call sites over TWO `['-']` constants — the two lost-push
   * pages (`get_lost_push_message`, `confirm_consumed_lost_push_message`) SHARE
   * `SHOPEE_LOST_PUSH_ERROR_ALIASES`, and `v2.order.get_package_detail` (step 7)
   * carries its own `SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES` — and every one of
   * them is here because the page CONTRADICTS ITSELF: its
   * parameter table samples `error` as `""` ("Empty if no error happened") while
   * its rendered response sample prints `"-"` for `error`, `message` AND
   * `warning`. Other cached pages, `get_app_push_config` and `get_order_detail`
   * included, sample `""` — so the tolerance is opt-in per CALL SITE because the
   * contradiction is per PAGE: the order op carries a SECOND constant rather
   * than reusing a lost-push-named one, while the two lost-push pages share
   * theirs because they are one queue, one page family, one observation.
   * ⚠️ That sharing is the edit hazard: narrowing ONE of those two pages means
   * splitting the constant first, or the other page moves with it. The sandbox
   * cannot exercise the two push APIs, so their first
   * call is PRODUCTION; `get_package_detail` is rehearsable on the sandbox shop.
   *
   * ⚠️ EXACT equality against each alias — never a trim, never a
   * `.length === 0` fold. `' '` stays a failure on these operations too, and a
   * test pins it. `-` appears on no documented error list anywhere (Shopee's are
   * `error_data`, `error_param`, `error_server`, …), so the alias cannot mask a
   * real code.
   *
   * ⚠️ Cost of guessing wrong, in both directions: with the alias, a `-` that
   * really meant failure surfaces as a `ShopeeSchemaError` on the wrapped getter
   * (a failing body carries no `response`) or as duplicate work on the ack —
   * never as a loss. Without it, a live `-` would make the sweep throw on its
   * first production call and stay dead until a code change ships, with a 3-day
   * expiry clock running.
   *
   * ⚠️ `warning: "-"` is NOT filtered here: no config in this repo sets
   * `onWarning` today (grepped 2026-09-14 — `apps/shopee` wires none), and if one
   * ever does it will see `-` as noise on these three operations,
   * `get_package_detail` included: that page samples `"warning": "-"` as well.
   */
  readonly emptyErrorAliases?: readonly string[];
}

/**
 * A call, plus exactly one way of carrying a body — or none.
 *
 * ⚠️ A UNION rather than two optional fields, so `{ body, multipart }` together
 * is **unconstructible** instead of guarded: repo rule 7 tier 0. The transport
 * would otherwise have to pick a winner at runtime, and whichever it picked
 * would be silent — a JSON body dropped for a form, or a form dropped for a
 * body, with a 200 either way.
 */
export type ShopeeCallParams<S extends z.ZodType> = ShopeeCallBase<S> &
  (
    | {
        /**
         * JSON. Serialised with `JSON.stringify` under
         * `Content-Type: application/json`.
         */
        readonly body?: unknown;
        readonly multipart?: undefined;
      }
    | {
        readonly body?: undefined;
        /** A `multipart/form-data` POST — see {@link ShopeeMultipartBody}. */
        readonly multipart: ShopeeMultipartBody;
      }
  );

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

/**
 * The `FormData` for a multipart POST.
 *
 * ⚠️ Three things here are load-bearing, and every one of them is silent when
 * it is wrong:
 *
 *  1. **No `Content-Type` header anywhere on the request.** `fetch` writes
 *     `multipart/form-data; boundary=…` itself from this object. Setting the
 *     header by hand — as `upload_image`'s own PHP sample does, WITHOUT a
 *     boundary — produces a body Shopee cannot parse, and the reply is a
 *     parameter error that reads like a bad request rather than a bad envelope.
 *     The ML precedent says the same thing
 *     (`packages/integrations/mercado-livre/src/api.ts:874`).
 *  2. **The Blob owns a COPIED `ArrayBuffer` slice.** A `Uint8Array` is a VIEW:
 *     handed to `Blob` directly, a view over a pooled buffer (what
 *     `Buffer.from`/`Buffer.concat` hand out) would send the neighbouring bytes
 *     of whatever else that pool holds. `slice` copies exactly this view's
 *     range — same precedent, `api.ts:858-863`.
 *  3. **An `undefined` text field is DROPPED.** See
 *     {@link ShopeeMultipartBody.fields}.
 */
function corpoMultipart(m: ShopeeMultipartBody): FormData {
  const form = new FormData();
  const { field, filename, contentType, bytes } = m.file;
  const copia = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  form.append(field, new Blob([copia], { type: contentType }), filename);
  for (const [chave, valor] of Object.entries(m.fields ?? {})) {
    if (valor !== undefined) form.append(chave, valor);
  }
  return form;
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
  // ⚠️ Neither body shape is part of the signature — `baseStringFor` reads
  // partner_id, path and timestamp (+ the token and the id) and nothing else.
  // The operation's own parameters travel here; the common ones stay in the
  // query for POST as well as GET. A test pins that two different multipart
  // bodies produce the SAME `sign`, and that a different PATH does not.
  if (p.multipart !== undefined) {
    init.body = corpoMultipart(p.multipart);
  } else if (p.body !== undefined) {
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

  // ⚠️ EXACT equality with the empty string, and EXACT equality with each alias.
  // `' '` is a failure — trimming here, on either side, would read a padded
  // value as a success. See `emptyErrorAliases` for the three operations that
  // carry one and why the tolerance is per operation.
  const sucesso = envelope.error === '' || (p.emptyErrorAliases?.includes(envelope.error) ?? false);
  if (!sucesso) {
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
