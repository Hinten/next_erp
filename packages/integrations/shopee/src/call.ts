/**
 * The one HTTP path in this package: sign, fetch, read the envelope, then read
 * the operation schema.
 *
 * Modelled on `packages/integrations/freight-br/src/http-client/client.ts`, with
 * the one structural difference Shopee forces: **a failing call is routinely
 * HTTP 200**, so the outcome is decided by `envelope.error === ''` and never by
 * `res.ok`.
 *
 * ⚠️ That invariant has exactly TWO exceptions, and both are opt-in PER
 * OPERATION. The first is about the VALUE:
 * {@link ShopeeCallParams.emptyErrorAliases}. Four pages — the two on the
 * lost-push queue, `v2.order.get_package_detail` and step 19's
 * `v2.product.get_kit_item_limit` — print `"-"` where the others print `""`,
 * and the six `v2.returns.*` pages of step 17 print `"-"` or `" "` (one SPACE);
 * the alias exists so those ten operations can read it as success. It is never
 * a global widening: the default stays exact equality with `''`, the opt-in is
 * per CALL SITE — ten of them, over FOUR constants — and a `' '` is a failure
 * everywhere except the six returns call sites, the only ones whose constant
 * (`SHOPEE_RETURNS_ERROR_ALIASES`) names it.
 *
 * ⚠️ The second is about the KEY: {@link ShopeeCallParams.erroAusenteEhSucesso},
 * ONE call site (`get_item_violation_info`), whose SUCCESS body omits `error`
 * altogether — measured on the sandbox 2026-09-17. It reads an ABSENT key as
 * `''` and it is narrower than it sounds: it applies only when the body carries
 * a `response` object, so a body with NEITHER key stays unjudgeable and stays
 * refused, exactly as without the flag.
 *
 * ⚠️ A THIRD per-operation flag sits beside those two and is NOT a third
 * exception: {@link ShopeeCallParams.payloadNoErro} leaves the verdict alone and
 * changes only what the thrown error CARRIES. On `update_stock` (documented) and
 * `update_price` (measured on the sandbox, step 13) the failure code and its
 * per-model `failure_list` arrive in the same body, so the flag attaches the
 * parsed payload to a `ShopeeApiPartialError` — still a failure, with the
 * evidence still attached.
 *
 * ⚠️ A FOURTH per-operation flag, {@link ShopeeCallParams.avisoEmLista}, is not
 * an exception either: it leaves `error === ''` alone and only lets stage 1 read
 * a `warning` that arrives as an ARRAY (the three label-document pages, step 15)
 * as a COUNT sentence, so the envelope-level channels keep `string | null`.
 *
 * ## The bytes mode
 *
 * {@link shopeeCallArquivo} is the SECOND entry point, for the one operation that
 * answers a FILE (`download_shipping_document`, step 15). It shares the request
 * half with {@link shopeeCall} — {@link enviarRequisicao}: URL, signature, body,
 * `fetch`, the network-error mapping — and replaces the response half: it reads
 * `arrayBuffer()` (a `text()` would corrupt every byte ≥ 0x80 of a PDF) and lets
 * the first significant byte, not the status, decide envelope vs file.
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
 * Almost every operation posts JSON. Exactly two post `multipart/form-data` —
 * `v2.media_space.upload_image` (step 11, on the partner client) and
 * `v2.order.upload_invoice_doc` (step 14, on the shop client) — and that body is
 * a different enough animal that
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
import { z } from 'zod';

import { lerRespostaJson, resumirCampos } from '@delfrance/core/wire';

import { SHOPEE_ARQUIVO_ACCEPT, type ShopeeArquivoBaixado, pareceCorpoJson } from './arquivo';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiPartialError,
  ShopeeArquivoVazioError,
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
   * ⚠️ A CONTRADICTED literal at the first of the two call sites: the
   * `upload_image` page's Request-params table, its PHP sample and its cURL
   * sample all say `image`, while its Java sample says `file`. The package
   * carries the choice as `SHOPEE_UPLOAD_IMAGE_FIELD` (`types.ts`) so the probe
   * can flip it in one line; the transport itself sends whatever it is given.
   * The second, `upload_invoice_doc`, is UNcontradicted — `file` in all four of
   * its page's samples — and carries it as `SHOPEE_UPLOAD_INVOICE_DOC_FIELD`.
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
   * ⚠️ Exactly TEN call sites over FOUR constants — the two lost-push pages
   * (`get_lost_push_message`, `confirm_consumed_lost_push_message`) SHARE
   * `SHOPEE_LOST_PUSH_ERROR_ALIASES` (`['-']`), `v2.order.get_package_detail`
   * (step 7) carries its own `SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES` (`['-']`),
   * the six `v2.returns.*` operations (step 17) share
   * `SHOPEE_RETURNS_ERROR_ALIASES` (`[' ', '-']`, `devolucoes.ts`), and
   * `v2.product.get_kit_item_limit` (step 19) carries its own
   * `SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES` (`['-']`, `kits.ts`) — and every
   * one of them is here because the page CONTRADICTS ITSELF: its
   * parameter table samples `error` as `""` ("Empty if no error happened") while
   * its rendered response sample prints `"-"` (or, on four returns pages, `" "`)
   * for `error`, `message` AND `warning`. The kit-limit page qualifies on its
   * ONE success sample (`{"error": "-", "message": "success", "warning": "-"}`),
   * added on the doc's word: no host has answered a success yet (the SG sandbox
   * does not route the path — a bare 404), so a BR shop settles it, and it is
   * its OWN constant because a product page's contradiction is not the order
   * module's. Other cached pages, `get_app_push_config` and `get_order_detail`
   * included, sample `""` — so the tolerance is opt-in per CALL SITE because the
   * contradiction is per PAGE: the order op carries a SECOND constant rather
   * than reusing a lost-push-named one, while the two lost-push pages share
   * theirs because they are one queue, one page family, one observation — the
   * argument the six returns pages reuse for the THIRD.
   * ⚠️ That sharing is the edit hazard: narrowing ONE of the pages that share a
   * constant means splitting it first, or the others move with it (register
   * 231 narrows the returns one). The sandbox cannot exercise the two push APIs
   * nor the returns module, so their first call is PRODUCTION;
   * `get_package_detail` is rehearsable on the sandbox shop.
   *
   * ⚠️ EXACT equality against each alias — never a trim, never a
   * `.length === 0` fold. `' '` stays a failure on every operation whose
   * constant does not NAME it (the lost-push pair, `get_package_detail`,
   * `get_kit_item_limit`, every other page), and a test pins it; on the returns operations `'  '`, `'\t'`
   * and `' -'` stay failures. Neither `-` nor `' '` appears on any documented
   * error list (Shopee's are `error_data`, `error_param`, `error_server`, …), so
   * the alias cannot mask a real code — and every returns schema REQUIRES
   * `response`, so a `' '` that meant failure still dies at stage 2.
   *
   * ⚠️ Cost of guessing wrong, in both directions: with the alias, a `-` that
   * really meant failure surfaces as a `ShopeeSchemaError` on the wrapped getter
   * (a failing body carries no `response`) or as duplicate work on the ack —
   * never as a loss. Without it, a live `-` would make the sweep throw on its
   * first production call and stay dead until a code change ships, with a 3-day
   * expiry clock running. (The returns constant's own cost is written on it.)
   *
   * ⚠️ `warning: "-"` is NOT filtered here: no config in this repo sets
   * `onWarning` today (grepped 2026-09-14 — `apps/shopee` wires none), and if one
   * ever does it will see `-` as noise on the four `['-']` operations,
   * `get_package_detail` and `get_kit_item_limit` included: both pages sample
   * `"warning": "-"` as well. (No returns sample prints a `warning` at all.)
   */
  readonly emptyErrorAliases?: readonly string[];
  /**
   * Read an ABSENT `error` key as `''` — for the ONE page whose SUCCESS body
   * does not carry it.
   *
   * ⚠️ MEASURED, not inferred: on 2026-09-17 the sandbox answered
   * `get_item_violation_info` with `{message, request_id, response: {item_list:
   * […]}}` and stage 1 refused it (`ShopeeSchemaError campos=["error"]`) —
   * register 73. The page's own two response samples had printed exactly that
   * shape while its Response-params table declared an `error`, so the wire and
   * the samples agree and the table is the odd one out. ONE call site carries
   * this flag (`api.ts`, `getItemViolationInfo`), and nothing else may.
   *
   * ⚠️ The SECOND exception to `error === ''`, and deliberately NOT the same
   * mechanism as {@link emptyErrorAliases}: that one widens which VALUES count
   * as success, this one covers a key that is not there at all. A `.default('')`
   * on `shopeeEnvelopeSchema` would do it for every operation at once and would
   * be the wrong fix — a body carrying NEITHER `error` NOR `response` is a body
   * nobody can judge, and defaulting would read it as a success.
   *
   * ⚠️ Hence the condition that keeps it narrow: the tolerance applies ONLY when
   * the body carries a `response` OBJECT. A body with neither key is still
   * refused with `ShopeeSchemaError` naming `error`, flag or no flag, and a
   * near-miss test pins that the DEFAULT (no flag) refuses the very body this
   * flag accepts.
   *
   * ⚠️ It cannot hide a real error either. A body that DOES carry
   * `error: 'error_param'` parses on the strict pass, so the tolerant re-parse
   * is never reached and the `error === ''` verdict throws as always.
   */
  readonly erroAusenteEhSucesso?: boolean;
  /**
   * Carry the PARSED payload on a non-empty `error`. The call still FAILS.
   *
   * ⚠️ For `update_stock`, whose own error list reads
   * `error_busi_update_stock_failed: Update stock failed, please check
   * failure_list for detailed reason` — and `failure_list` lives under
   * `response`. The thrown {@link ShopeeApiError} carries only
   * code/message/requestId/warning, so without this flag the per-model
   * attribution is thrown away at the throw site and the whole item fails as
   * one lump. That is the legacy Flutter defect verbatim.
   *
   * ⚠️ And for `update_price`, on MEASUREMENT rather than documentation: its
   * page has no such code, yet step 13's sandbox probe (2026-09-24) received
   * `product.error_update_price_fail` together with a populated `failure_list`.
   * Two call sites, then — each one measured or documented, never inferred.
   *
   * ⚠️ The THIRD per-operation tolerance, and the only one that does not touch
   * the VERDICT. Deliberately NOT {@link emptyErrorAliases} (which widens which
   * VALUES count as success) and NOT {@link erroAusenteEhSucesso} (which covers
   * a key that is absent): this one keeps the failure a failure and merely
   * stops discarding the evidence. A SUCCESS envelope never takes this path,
   * and the flag changes neither of the other two verdicts — three tests pin
   * all three statements.
   *
   * ⚠️ It is well-defined because the operation schemas COMPOSE the envelope
   * (`wrappedOp`/`flatOp`/`dataOp` all spread `envelopeShape`), so re-reading
   * the same response text with {@link ShopeeCallBase.schema} IS the stage-2
   * parse below — one `text`, still no second network call. When that parse
   * fails, nothing is attached and the ordinary error is thrown: a failing body
   * carrying no `response` at all — the ordinary shape of a throttle or a dead
   * authorization — stays exactly the class it was.
   *
   * ⚠️ The flag is CODE-BLIND on purpose. The transport does not know which
   * codes an operation considers partial (`update_stock` alone has four
   * spellings of the reserved-stock floor and two readings of `error_inner`),
   * and a code table here would be a second place to keep the operation's
   * vocabulary. The caller narrows on {@link ShopeeApiPartialError} and decides.
   */
  readonly payloadNoErro?: boolean;
  /**
   * Read an ARRAY `warning` at stage 1 as a COUNT sentence,
   * `"<n> aviso(s) por pedido/pacote"`.
   *
   * ⚠️ DOCUMENTED, three call sites (step 15): `get_shipping_document_parameter`,
   * `create_shipping_document` and `get_shipping_document_result` declare
   * `warning: object[] {order_sn, package_number}`, and two of those pages' own
   * SUCCESS samples carry one. The envelope's `warning` is `z.string()`, so
   * without this flag a perfectly good batch answer — the first warned package —
   * becomes a `ShopeeSchemaError` naming `warning`.
   *
   * ⚠️ The `erroAusenteEhSucesso` shape, and it stays as narrow: it is ATTEMPTED
   * only after the STRICT stage 1 failed, and it only WINS when it succeeds, so
   * a string warning is read exactly as before and a body that is not an
   * envelope keeps the strict reading's diagnostics.
   *
   * ⚠️ A COUNT, never the rows. `onWarning` and `ShopeeApiError.warning` are
   * `string | null` and reach log lines; the rows carry an `order_sn` and a
   * package number, which must not. The rows themselves survive for the caller:
   * stage 2 (and `payloadNoErro`'s re-read) parse the ORIGINAL text, whose
   * operation schema declares both shapes. Unlike `erroAusenteEhSucesso`, this
   * flag never REWRITES the text stage 2 reads.
   */
  readonly avisoEmLista?: boolean;
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

/**
 * The envelope as the ONE page whose success body omits `error` answers it: the
 * key defaulted to `''`, and a `response` OBJECT REQUIRED in its place.
 *
 * ⚠️ Local to the TRANSPORT on purpose. `types.ts`'s `shopeeEnvelopeSchema`
 * stays strict and a test there pins that this page's sample still fails it —
 * the tolerance is a property of one call site, not of the wire format. Only a
 * call carrying {@link ShopeeCallBase.erroAusenteEhSucesso} ever reaches this
 * schema, and only after the strict parse has already failed.
 *
 * ⚠️ `response` is what makes the body judgeable: `z.object({}).passthrough()`
 * accepts any OBJECT and refuses `null`, an array and a scalar, so a failing
 * body — which carries no `response` — cannot slip through as a success just
 * because it also lost its `error`.
 */
const envelopeComErroAusenteSchema = shopeeEnvelopeSchema.extend({
  error: z.string().default(''),
  response: z.object({}).passthrough(),
});

/**
 * The envelope as the three label-document pages answer it: `warning` may be an
 * ARRAY, which becomes a COUNT sentence — see {@link ShopeeCallBase.avisoEmLista}.
 *
 * ⚠️ Local to the TRANSPORT for the same reason as the schema above: the strict
 * `shopeeEnvelopeSchema` stays strict, and only a call carrying the flag reaches
 * this one, after the strict parse failed. The OUTPUT type of `warning` stays
 * `string | null`, so nothing downstream of stage 1 changes type.
 */
const envelopeComAvisoEmListaSchema = shopeeEnvelopeSchema.extend({
  warning: z
    .union([
      z.string(),
      z
        .array(z.unknown())
        .transform((avisos) => `${String(avisos.length)} aviso(s) por pedido/pacote`),
    ])
    .nullable()
    .default(null),
});

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

/** The request half of a call, whichever entry point makes it. */
interface RequisicaoShopee {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly call: SignedCall;
  readonly query?: Readonly<Record<string, ShopeeQueryValue>>;
  readonly body?: unknown;
  readonly multipart?: ShopeeMultipartBody | undefined;
}

/**
 * Sign, build the body, `fetch` — the half {@link shopeeCall} and
 * {@link shopeeCallArquivo} share. Only the `Accept` header differs between the
 * two, so it is the one parameter.
 *
 * ⚠️ Extracted, not rewritten: every existing `call.test.ts` test runs through
 * here byte-unedited, and that is the proof the extraction changed nothing.
 */
async function enviarRequisicao(
  transport: ShopeeTransport,
  p: RequisicaoShopee,
  accept: string,
): Promise<Response> {
  const qs = signedQuery({
    partnerId: transport.partnerId,
    partnerKey: transport.partnerKey,
    path: p.path,
    call: p.call,
    nowMs: transport.now(),
    extra: p.query,
  });

  const headers: Record<string, string> = { Accept: accept };
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

  try {
    return await transport.fetch(`${transport.apiHost}${p.path}?${qs.toString()}`, init);
  } catch (err) {
    // ⚠️ The message names the PATH and nothing else. `err.message` from an
    // aborted fetch can echo the request URL, which carries `access_token`.
    throw new ShopeeNetworkError(`Falha de rede ao contatar a Shopee em ${p.path}.`, err);
  }
}

/**
 * Read a response BODY, turning a connection that dies mid-body into the same
 * {@link ShopeeNetworkError} a failed `fetch` becomes — for BOTH entry points.
 *
 * ⚠️ Wrapping only `fetch` ({@link enviarRequisicao}) is not enough: the headers
 * can arrive and the socket still drop while the body streams, and `text()` /
 * `arrayBuffer()` then reject with a bare `TypeError` ("terminated" in Node).
 * Unwrapped, that escaped every classifier above the package: a route answered
 * a bare 500 for a WRITE that may already have landed at Shopee, and the panel
 * said "try again" (#1525 review R4 F1). The same idiom as #1749's `lerCorpo`
 * in `apps/web/lib/shopee/client.ts`, raising this layer's own class.
 *
 * ⚠️ The message names the PATH and says the request WENT OUT, never
 * `err.message` — the same rule as the fetch boundary; the `TypeError` rides as
 * `cause`. Any other rejection is not a transport failure and rethrows as
 * itself. The package sets no `AbortSignal` (`ShopeeTransport` carries none),
 * so a mid-body abort cannot reach here today; a deadline added to the
 * transport (#1094) has to decide its class at BOTH reads, because the fetch
 * boundary wraps every rejection and this one only the `TypeError`.
 */
async function lerCorpo<T>(path: string, ler: () => Promise<T>): Promise<T> {
  try {
    return await ler();
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ShopeeNetworkError(
        `Falha de rede ao ler a resposta da Shopee em ${path} — a requisição foi enviada e o resultado é desconhecido.`,
        err,
      );
    }
    throw err;
  }
}

/**
 * A bare 429 whose body is not an envelope — the same error from both entry
 * points, so the two cannot drift apart.
 */
function limiteSemEnvelope(
  path: string,
  httpStatus: number,
  retryAfterSeconds: number | null,
): ShopeeRateLimitError {
  return new ShopeeRateLimitError(
    `Shopee ${path} respondeu HTTP 429 sem envelope (limite de requisições).`,
    {
      code: 'http_429',
      kind: SHOPEE_ERROR_KIND.burst,
      httpStatus,
      path,
      retryAfterSeconds,
    },
  );
}

export async function shopeeCall<S extends z.ZodType>(
  transport: ShopeeTransport,
  p: ShopeeCallParams<S>,
): Promise<z.infer<S>> {
  const res = await enviarRequisicao(transport, p, 'application/json');

  const text = await lerCorpo(p.path, () => res.text());
  const sensitive = p.sensitive === true;
  const retryAfterSeconds = parseRetryAfter(res);

  /* ------------------------------- stage 1 -------------------------------- */
  const envelopeEstrito = lerRespostaJson(text, shopeeEnvelopeSchema);
  // ⚠️ The per-operation tolerance for the ONE page whose SUCCESS body omits
  // `error` — see `erroAusenteEhSucesso`. Two things keep it narrow. It is only
  // ATTEMPTED when the strict parse already failed, so a present `error` (of any
  // value) is judged exactly as before; and it only WINS when it succeeds, so a
  // body that is not an envelope at all keeps the strict reading's diagnostics —
  // the refusal still names `error`, never `response`.
  const envelopeTolerante =
    !envelopeEstrito.ok && p.erroAusenteEhSucesso === true
      ? lerRespostaJson(text, envelopeComErroAusenteSchema)
      : null;
  // ⚠️ The fourth tolerance — see `avisoEmLista`. The same two narrowing rules:
  // attempted only when the strict parse (and the absent-`error` tolerance)
  // failed, and it only wins when it succeeds. It never feeds `textoParaSchema`
  // below: stage 2 reads the ORIGINAL text, rows and all.
  const envelopeComAviso =
    !envelopeEstrito.ok && envelopeTolerante?.ok !== true && p.avisoEmLista === true
      ? lerRespostaJson(text, envelopeComAvisoEmListaSchema)
      : null;
  const envelopeLeitura =
    envelopeTolerante?.ok === true
      ? envelopeTolerante
      : envelopeComAviso?.ok === true
        ? envelopeComAviso
        : envelopeEstrito;
  if (!envelopeLeitura.ok) {
    // A bare 429 whose body is not an envelope is still a rate limit, and the
    // only signal a caller can act on. Classified as `burst`: the daily quota is
    // reported through `error_limit` IN an envelope, never as a naked status.
    if (res.status === 429) throw limiteSemEnvelope(p.path, res.status, retryAfterSeconds);

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
  // value as a success. See `emptyErrorAliases` for the ten operations that
  // carry one and why the tolerance is per operation.
  const sucesso = envelope.error === '' || (p.emptyErrorAliases?.includes(envelope.error) ?? false);
  if (!sucesso) {
    const falha = shopeeErrorFromEnvelope(envelope, {
      path: p.path,
      httpStatus: res.status,
      surface: p.surface,
      retryAfterSeconds,
    });

    // ⚠️ The THIRD per-operation tolerance — see `payloadNoErro`. It runs ONLY
    // on the failure path and only when the flag is set, so the verdict above
    // is untouched: a success never reaches here, and an operation without the
    // flag throws `falha` exactly as before.
    //
    // ⚠️ The message and the classification are the BASE error's, read back off
    // the object rather than rebuilt. Reconstructing them here would be a second
    // copy of `shopeeErrorFromEnvelope`'s formatting, free to drift — and the
    // one thing that must never differ between the two classes is how the same
    // envelope reads.
    //
    // ⚠️ Field by field, so a NEW `ShopeeApiErrorInit` field is dropped here
    // unless it is added here too — `providerMessage` is, and `call.test.ts`
    // pins that the partial class still carries it.
    const parcial = p.payloadNoErro === true ? lerRespostaJson(text, p.schema) : null;
    if (parcial === null || !parcial.ok) throw falha;
    throw new ShopeeApiPartialError(falha.message, {
      code: falha.code,
      kind: falha.kind,
      httpStatus: falha.httpStatus,
      path: falha.path,
      requestId: falha.requestId,
      warning: falha.warning,
      providerMessage: falha.providerMessage,
      parsed: parcial.data,
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
  // ⚠️ The operation schemas COMPOSE the envelope (`wrappedOp`/`flatOp`/`dataOp`
  // all spread `envelopeShape`), so a missing `error` refuses the body a SECOND
  // time here — a tolerance that stopped at stage 1 would look like it worked
  // and still fail the call, one layer down. The repair therefore serves both
  // stages: `envelopeComErroAusenteSchema` is `.passthrough()` at the top level
  // and on `response`, so re-serialising its output is the body Shopee sent with
  // the one absent key filled in as `''` and nothing else changed.
  const textoParaSchema =
    envelopeTolerante?.ok === true ? JSON.stringify(envelopeTolerante.data) : text;
  const leitura = lerRespostaJson(textoParaSchema, p.schema);
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

/* -------------------------------------------------------------------------- */
/*                         The bytes mode (step 15)                           */
/* -------------------------------------------------------------------------- */

/**
 * A call that answers a FILE. The same request fields as {@link ShopeeCallBase},
 * and deliberately nothing else: no `schema` (the answer is bytes), no
 * `multipart` (nothing uploads through here), and none of the per-operation
 * tolerances — the download page documents none, and adding one needs a
 * measurement.
 */
export interface ShopeeCallArquivoParams {
  readonly method: 'GET' | 'POST';
  /** API path only, e.g. `/api/v2/logistics/download_shipping_document`. */
  readonly path: string;
  readonly call: SignedCall;
  readonly surface: ShopeeSurface;
  readonly query?: Readonly<Record<string, ShopeeQueryValue>>;
  /** JSON, serialised exactly as {@link shopeeCall} serialises it. */
  readonly body?: unknown;
}

/** How much of a `Content-Type` header may reach a log line. */
const MAX_LOGGED_CONTENT_TYPE = 100;

/**
 * The ONE log line the bytes mode writes, on a refusal: path, status, length and
 * content type.
 *
 * ⚠️ NEVER a body byte, on any path — and deliberately NOT
 * {@link logarCorpoNaoJson}, which logs 500 characters of the body. A label
 * carries the buyer's name and address, and a malformed body that starts with
 * `{` is no less likely to carry them than a good one.
 */
function logarArquivoRecusado(
  path: string,
  httpStatus: number,
  tamanho: number,
  contentType: string | null,
  motivo: string,
): void {
  const tipo = contentType === null ? '(ausente)' : contentType.slice(0, MAX_LOGGED_CONTENT_TYPE);
  console.error(
    `[shopee] arquivo recusado em ${path} (HTTP ${String(httpStatus)}): ${motivo}, ${String(tamanho)} bytes, content-type ${tipo} — corpo omitido`,
  );
}

/**
 * Fetch a FILE — the shipping label — and hand back its bytes and headers.
 *
 * The decision table, IN THIS ORDER (design D1 §2.2, rows 0–8):
 *
 * | # | condition | outcome |
 * |---|---|---|
 * | 0 | request | `Accept: SHOPEE_ARQUIVO_ACCEPT`; a JSON body as in {@link shopeeCall} |
 * | 1 | read | `arrayBuffer()` — NEVER `text()`; a mid-body drop is `ShopeeNetworkError` ({@link lerCorpo}) |
 * | 2 | 0 bytes, HTTP 429 | `ShopeeRateLimitError`, kind `burst` |
 * | 3 | 0 bytes, `!res.ok` | `ShopeeHttpError` |
 * | 4 | 0 bytes, 2xx | `ShopeeArquivoVazioError` |
 * | 5 | {@link pareceCorpoJson} | the ENVELOPE verdict; a SUCCESS envelope is `ShopeeSchemaError` naming `waybill` |
 * | 6 | non-JSON, HTTP 429 | `ShopeeRateLimitError`, kind `burst` |
 * | 7 | non-JSON, `!res.ok` | `ShopeeHttpError` |
 * | 8 | non-JSON, 2xx | `{ bytes, contentType, contentDisposition, httpStatus }` |
 *
 * ⚠️ The FIRST SIGNIFICANT BYTE decides envelope vs file (row 5), never the
 * status and never the content type: a Shopee failure is routinely HTTP 200, and
 * the download page documents neither for either branch. A PDF or a ZIP can
 * never start with `{`.
 *
 * ⚠️ A SUCCESS envelope (`error === ''`) is a FAILURE here. It is never a label,
 * and returning its bytes would hand the print agent a JSON document to print.
 *
 * ⚠️ Row 8 returns the headers VERBATIM and does not sniff the format: which
 * format the bytes are — and refusing an unknown one — is
 * {@link classificarArquivoDeEnvio}'s job, at the caller.
 */
export async function shopeeCallArquivo(
  transport: ShopeeTransport,
  p: ShopeeCallArquivoParams,
): Promise<ShopeeArquivoBaixado> {
  const res = await enviarRequisicao(transport, p, SHOPEE_ARQUIVO_ACCEPT);

  // ⚠️ `arrayBuffer()`, never `text()`: decoding a PDF as UTF-8 replaces every
  // invalid sequence — its binary marker line is one — with U+FFFD, and the
  // file that comes out is not the file Shopee sent. A test pins it byte-equal.
  const bytes = new Uint8Array(await lerCorpo(p.path, () => res.arrayBuffer()));
  const httpStatus = res.status;
  const contentType = res.headers.get('content-type');
  const retryAfterSeconds = parseRetryAfter(res);
  const recusar = (motivo: string): void => {
    logarArquivoRecusado(p.path, httpStatus, bytes.byteLength, contentType, motivo);
  };

  /* --------------------------- rows 2–4: empty ---------------------------- */
  if (bytes.byteLength === 0) {
    recusar('corpo vazio');
    if (httpStatus === 429) throw limiteSemEnvelope(p.path, httpStatus, retryAfterSeconds);
    if (!res.ok) {
      throw new ShopeeHttpError(
        `Shopee ${p.path} respondeu HTTP ${String(httpStatus)} com o corpo vazio.`,
        { httpStatus, path: p.path },
      );
    }
    // ⚠️ An empty 2xx is a FAILED label, never an empty file to print.
    throw new ShopeeArquivoVazioError(
      `Shopee ${p.path} respondeu HTTP ${String(httpStatus)} com um arquivo VAZIO — uma etiqueta vazia é uma etiqueta que falhou.`,
      { httpStatus, path: p.path },
    );
  }

  /* ------------------------ row 5: an envelope ---------------------------- */
  if (pareceCorpoJson(bytes)) {
    // ⚠️ `TextDecoder` drops a leading UTF-8 BOM by default (`ignoreBOM: false`),
    // and it has to: `JSON.parse` refuses one, and `pareceCorpoJson` skipped it.
    const leitura = lerRespostaJson(new TextDecoder().decode(bytes), shopeeEnvelopeSchema);
    if (!leitura.ok) {
      recusar(leitura.motivo === 'formato' ? 'JSON que não é um envelope' : 'JSON malformado');
      if (httpStatus === 429) throw limiteSemEnvelope(p.path, httpStatus, retryAfterSeconds);
      if (!res.ok) {
        throw new ShopeeHttpError(
          `Shopee ${p.path} respondeu HTTP ${String(httpStatus)} com um corpo que não é um envelope da Shopee.`,
          { httpStatus, path: p.path },
        );
      }
      if (leitura.motivo !== 'formato') {
        throw new ShopeeSchemaError(
          `Shopee ${p.path} respondeu HTTP ${String(httpStatus)} com um corpo que parece JSON e não é — nem um arquivo, nem um envelope.`,
          { httpStatus, path: p.path },
        );
      }
      throw new ShopeeSchemaError(
        `Shopee ${p.path} respondeu sem o envelope esperado. Campos inválidos: ${resumirCampos(leitura.campos)}.`,
        { campos: leitura.campos, httpStatus, path: p.path },
      );
    }

    // ⚠️ EXACT equality with `''`, as in `shopeeCall` — and no alias: the
    // download page documents none.
    const envelope = leitura.data;
    if (envelope.error !== '') {
      throw shopeeErrorFromEnvelope(envelope, {
        path: p.path,
        httpStatus,
        surface: p.surface,
        retryAfterSeconds,
      });
    }
    throw new ShopeeSchemaError(
      `Shopee ${p.path} respondeu um envelope de SUCESSO sem arquivo — um envelope nunca é uma etiqueta.`,
      { campos: ['waybill'], httpStatus, path: p.path },
    );
  }

  /* ---------------------- rows 6–7: non-JSON failure ---------------------- */
  if (httpStatus === 429) {
    recusar('sem envelope');
    throw limiteSemEnvelope(p.path, httpStatus, retryAfterSeconds);
  }
  if (!res.ok) {
    // ⚠️ The IP-allow-list edge rejection shape (P2): HTML or a bare status.
    recusar('sem envelope');
    throw new ShopeeHttpError(
      `Shopee ${p.path} respondeu HTTP ${String(httpStatus)} sem um arquivo nem um envelope da Shopee.`,
      { httpStatus, path: p.path },
    );
  }

  /* --------------------------- row 8: the file ---------------------------- */
  return {
    bytes,
    contentType,
    contentDisposition: res.headers.get('content-disposition'),
    httpStatus,
  };
}
