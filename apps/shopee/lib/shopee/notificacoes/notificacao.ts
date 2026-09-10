/**
 * Shopee push ingestion core (step 3) — the queue-based resilient pipeline
 * shared by the receiver route, the `onTaskDispatched` task handler and the
 * `onSchedule` reprocess sweep. Mirrors
 * `apps/mercado-pago/lib/payments/notificacao.ts`, adapted payments →
 * marketplace push.
 *
 * Flow:
 *   1. the receiver verifies the `Authorization` HMAC over the RAW body,
 *      normalizes it here (`parseNotificationBody`) and ENQUEUES the lean
 *      payload — answering **204 with an empty body**, WITHOUT writing
 *      Firestore on the happy path. ⚠️ Shopee counts `200 {"ok":true}` as a
 *      FAILED push (`guide 18`), so the ack shape is not a style choice;
 *   2. `handleNotificationTask` routes on the push `code` and runs the arm;
 *   3. a document is persisted to `notificacoesShopee` ONLY when the push
 *      cannot be processed (enqueue failed, retries exhausted, no handler yet,
 *      or a shop that maps to no active integração yet);
 *   4. `reprocessNotifications` / `reprocessDeferredNotifications` re-drive the
 *      persisted docs and delete them on success.
 *
 * ## Three Shopee facts that shape this module
 *
 * - **`code` is the `push_code`, NOT the `push_api_id`** from the doc URL.
 *   `shop_authorization_push` is `push_api_id=15` and arrives as `code: 1`;
 *   `order_status_push` is `push_api_id=1` and arrives as `code: 3`. Routing on
 *   the wrong number silently mis-dispatches, so {@link DISPATCH} is keyed on
 *   the push code and says so on every row.
 * - **There is NO event id of any kind** — no message id, no delivery id
 *   (`get_lost_push_message`'s `last_message_id` is a cursor for the recovery
 *   API and never rides on a live push). So the failure doc id is DERIVED from
 *   the payload, routed through {@link asDocId}; without that every persist
 *   mints a fresh auto id, `create`'s ALREADY_EXISTS never fires, and one
 *   repeatedly-failing resource leaves one dead document per delivery.
 * - **The envelope `timestamp` is SECONDS**, and every stamp on this side of
 *   the channel is MILLIS. The conversion happens ONCE, in
 *   {@link parseNotificationBody}, so nothing downstream has to remember which
 *   unit it is holding.
 */
import { type Firestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { notificacaoShopeeCollection } from '@delfrance/data/admin/collections';
import {
  asInt,
  asMillis,
  defineNotificationPipeline,
  MAX_TENTATIVAS,
  MAX_TENTATIVAS_DEFERRED,
  type NotificationDisposition,
  type ReprocessOptions,
  type ReprocessResult,
  TASK_MAX_ATTEMPTS,
} from '@delfrance/data/admin/notifications';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeePartnerClient,
  createShopeePartnerClient,
} from '@delfrance/integrations-shopee';

import { shopeeConfig } from '../env';
import { avisarDesautorizacao, resolverAvisosDeAutorizacao } from '../avisos/autorizacao';
import { findIntegracaoByShopId, readConta } from '../core/contaCache';
import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError } from '../core/shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '../core/tokenStore';
import { describeValidationFailure } from '../core/validationIssues';
import { runShopeeAuthorizationExpirySweep } from '../conta/expiracaoSweep';
// ⚠️ TYPE-ONLY, and it has to stay that way: `import type` is erased at compile
// time, so naming the importer's shapes here costs the Next bundle nothing. The
// VALUE arrives through the dynamic import in `defaultProcessDeps`.
import type {
  AcaoImportacaoPedidoShopee,
  AlvoDeImportacaoShopee,
  ResultadoImportacaoPedidoShopee,
} from '../pedidos/importarPedido';

/**
 * The deployed `onTaskDispatched` function name — which is ALSO its
 * auto-provisioned Cloud Tasks queue name. Single source of truth, shared by
 * the producer (`shopeeTasks.ts` builds the region-qualified queue path from
 * it) and the consumer (the nested `functions/` codebase — the `export const`
 * there MUST be named exactly this). Lives in this neutral shared module
 * because the app cannot import the functions-trigger file (that would pull the
 * Functions SDK into the Next bundle). Rename in BOTH places.
 */
export const SHOPEE_NOTIFICATION_QUEUE = 'processShopeeNotification';

// The retry caps are the SHARED pipeline's — re-exported here so this module
// stays the one import site for the channel's callers.
export { MAX_TENTATIVAS, MAX_TENTATIVAS_DEFERRED, TASK_MAX_ATTEMPTS };
export type { ReprocessOptions, ReprocessResult };

// ── the wire payload ────────────────────────────────────────────────────────

/**
 * The lean payload the receiver enqueues and the task handler re-validates
 * (belt-and-suspenders across the Cloud Tasks wire boundary). Tolerant
 * (`passthrough`, nullable): `timestamp` is already epoch MILLIS and `data` is
 * already bounded by {@link sanitizarData}, so a persisted failure doc can never
 * be rejected by the collection's strict write validator.
 */
export const shopeeNotificationTaskSchema = z
  .object({
    /** Shopee's `push_code` — see the module header. */
    code: z.number().int(),
    /** Lifted from the top level or out of `data`; null for a partner-level push. */
    shopId: z.number().int().nullable().default(null),
    /** MILLIS (the wire carries SECONDS). */
    timestamp: z.number().nullable().default(null),
    data: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .passthrough();
export type ShopeeNotificationPayload = z.infer<typeof shopeeNotificationTaskSchema>;

/** Firestore refuses a field named `__anything__`, and an empty field name. */
const RESERVED_FIELD_NAME = /^__.*__$/;

/**
 * `data` budget. A real Shopee push is a few hundred bytes; this exists because
 * the body is unauthenticated until the HMAC gate has passed and because an
 * oversized document is rejected by Firestore INSIDE `persistFailure`, which
 * sits outside `handleTask`'s catch — the throw would escape, every queue
 * attempt would fail identically, and the push would be lost.
 */
const DATA_MAX_BYTES = 64 * 1024;

/**
 * Reduce Shopee's `data` object to something Firestore is guaranteed to store.
 *
 * Three branches, and each one is a real failure it prevents:
 *
 *  1. **not an object** (a string, an array, `null`) ⇒ `null`. `data` is
 *     declared as a map; anything else is not the shape any handler reads.
 *  2. **arrays directly inside arrays are stringified.** Firestore rejects a
 *     nested array outright, and that rejection lands inside `persistFailure`,
 *     outside `handleTask`'s catch. An array inside an OBJECT inside an array
 *     is legal and is kept as-is — the walk resets the flag when it descends
 *     into an object.
 *  3. **over the budget** ⇒ `{ _truncado: true, _bytes }`, so the dead-letter
 *     row still records that something arrived and how big it was.
 *
 * A JSON round trip runs first, which is also what drops `undefined` and turns
 * any exotic value into something the write validator accepts.
 */
export function sanitizarData(v: unknown): Record<string, unknown> | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;

  let texto: string;
  try {
    texto = JSON.stringify(v) ?? 'null';
  } catch (err) {
    // Circular structures and BigInt. Not reachable from a parsed JSON body;
    // reachable from a Firestore `data()` value on the sweep's re-read.
    if (!(err instanceof TypeError)) throw err;
    return null;
  }

  const bytes = Buffer.byteLength(texto, 'utf8');
  if (bytes > DATA_MAX_BYTES) return { _truncado: true, _bytes: bytes };

  let redondo: unknown;
  try {
    redondo = JSON.parse(texto);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  if (redondo == null || typeof redondo !== 'object' || Array.isArray(redondo)) return null;
  return normalizarObjeto(redondo as Record<string, unknown>);
}

function normalizarObjeto(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(o)) {
    // Firestore rejects both, and the rejection would escape `handleTask`.
    if (key === '' || RESERVED_FIELD_NAME.test(key)) continue;
    const normalizado = normalizarValor(value, false);
    if (normalizado !== undefined) out[key] = normalizado;
  }
  return out;
}

function normalizarValor(v: unknown, dentroDeArray: boolean): unknown {
  if (Array.isArray(v)) {
    // Nested directly inside another array — Firestore refuses it.
    if (dentroDeArray) return JSON.stringify(v);
    return v.map((item) => normalizarValor(item, true));
  }
  if (v != null && typeof v === 'object') {
    // An object resets the flag: an array inside it is legal again.
    return normalizarObjeto(v as Record<string, unknown>);
  }
  return v;
}

/**
 * Normalize a raw Shopee push body into the lean task payload. Returns null for
 * anything that is not a push envelope — a non-object body, or one with no
 * integer `code` — which the receiver acks without enqueuing.
 *
 * ⚠️ **The `shopid` misspelling is not optional tolerance.** Three of the five
 * documented `push 16` samples spell it without the underscore while the
 * parameter table documents `shop_id`, and the two spellings appear at TWO
 * levels (top level on the order pushes, inside `data` on the authorization
 * ones). All four placements are lifted into one field.
 *
 * ⚠️ **`timestamp` is SECONDS on the wire.** `asMillis` truncates any finite
 * number AS millis, so the `* 1000` has to happen before it — and it stays
 * wrapped in `asMillis` so the upper-bound clamp still applies (an unclamped
 * value reaches `millisSinceEpoch()` as `NaN` and throws a ZodError from inside
 * `persistFailure`, outside `handleTask`'s catch).
 */
export function parseNotificationBody(raw: unknown): ShopeeNotificationPayload | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const code = asInt(o.code);
  if (code == null) return null;

  const d = o.data != null && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : {};
  const shopId = asInt(o.shop_id) ?? asInt(o.shopid) ?? asInt(d.shop_id) ?? asInt(d.shopid) ?? null;

  const segundos = asInt(o.timestamp);
  const timestamp = segundos == null ? null : asMillis(segundos * 1000);

  return { code, shopId, timestamp, data: sanitizarData(o.data) };
}

// ── doc id + dedup key ──────────────────────────────────────────────────────

/**
 * A push id safe to use as a Firestore DOCUMENT ID — `docIdOf` feeds it
 * straight into `docRef(...).create()`, so an unvalidated one is a PATH, not a
 * name. `"a/b/c"` resolves into a nested subcollection the sweep's top-level
 * query can never see (a silent black hole), and `"a/b"` throws a plain `Error`
 * the receiver would rethrow as 5xx — which is how Shopee's success rate drops
 * and the subscription auto-disables. Anything refused degrades to null ⇒ an
 * auto id: losing redelivery dedup for a bogus id costs far less.
 *
 * Copied verbatim from the Mercado Livre channel — the same five refusals.
 */
const MAX_DOC_ID_CHARS = 1500;
export function asDocId(v: string | null): string | null {
  if (v == null) return null;
  if (v === '.' || v === '..') return null;
  if (v.includes('/') || RESERVED_FIELD_NAME.test(v)) return null;
  return v.length <= MAX_DOC_ID_CHARS ? v : null;
}

/** `-` for every segment we do not have — never an omitted segment. */
const VAZIO = '-';

function texto(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function lista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A nested object inside `data`, or `{}` — never a throw on a scalar. */
function objeto(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * The identity of the WORK a push describes, split into the part that survives
 * a redelivery (`entidade`) and the part that does not (`carimbo`).
 *
 * The split is the whole point: `dedupKeyOf` uses only `entidade` (two
 * deliveries about the same order are one job for the sweep's in-run dedup),
 * while `docIdOf` appends `carimbo` so two genuinely different events about the
 * same resource keep separate dead-letter rows.
 *
 * ⚠️ Shopee puts the resource key in a different field on almost every code,
 * and `shop_id` in a different PLACE. This table is the only place that is
 * written down; a code that is not in it falls to the last row rather than
 * losing its id.
 */
export function identidadeDoPush(p: ShopeeNotificationPayload): {
  entidade: string;
  carimbo: string;
} {
  const d = p.data ?? {};
  const loja = p.shopId == null ? VAZIO : String(p.shopId);
  const stamp = p.timestamp == null ? VAZIO : String(p.timestamp);
  const updateTime = texto(asInt(d.update_time));

  switch (p.code) {
    // 3 — order status. `shop_id` is TOP level and `data.update_time` (push 1
    // returns it by default) is the event clock, so two status changes of one
    // order never collide. When it is absent the ENVELOPE stamp stands in, and
    // only a push carrying neither falls to `-`. Code 3 used to fall straight
    // to `-`, which made every clock-less delivery about one order share ONE
    // dead-letter row — the second overwriting the first, silently.
    // ⚠️ The two clocks are in different UNITS on purpose and are never
    // compared: `update_time` is the wire's SECONDS, the envelope stamp is our
    // MILLIS. The carimbo is an opaque segment; the magnitudes cannot collide.
    // ⚠️ A SYNTHESIZED code 3 (`notificacaoSintetica.ts`, the order backfill and
    // the stuck-reserve sweep) carries NO `update_time` at all, so it lands on
    // the envelope-stamp fallback by construction — the synthesis clock. Two
    // synthetic producers of one order therefore share a dedup KEY, and share a
    // row only when they share a tick's stamp.
    case 3:
      return {
        entidade: `${loja}:${texto(d.ordersn) ?? VAZIO}`,
        carimbo: updateTime ?? stamp,
      };
    // 4 — tracking number. `push 2` documents NO `update_time`, so its clock is
    // the envelope stamp — SECONDS — and it always carries `package_number`,
    // which is the resource: two packages of one order arranged in the same
    // `ship_order` get their tracking numbers in the same second, and an
    // order-only identity handed them ONE create-only row (the second lost).
    case 4: {
      const pedido = texto(d.ordersn) ?? VAZIO;
      const pacote = texto(d.package_number) ?? VAZIO;
      return { entidade: `${loja}:${pedido}:${pacote}`, carimbo: updateTime ?? stamp };
    }
    // 30 / 47 — package fulfillment status / package info. Both document
    // `data.update_time` (push 44's sample even differs from the envelope by a
    // second), so it is the clock, with the same fallback as code 3.
    case 30:
    case 47:
      return {
        entidade: `${loja}:${texto(d.package_number) ?? VAZIO}`,
        carimbo: updateTime ?? stamp,
      };
    // 15 — shipping document status. A shipping document belongs to a PACKAGE
    // (`create_shipping_document` takes one `package_number` per entry), so the
    // package leads and the order id is only the fallback, in both spellings —
    // `push 17`'s parameter table says `order_sn`, its sample says `ordersn`.
    // Order-first handed two packages of one order, READY in the same second,
    // ONE create-only row.
    case 15: {
      const pacote = texto(d.package_number) ?? texto(d.ordersn) ?? texto(d.order_sn) ?? VAZIO;
      return { entidade: `${loja}:${pacote}`, carimbo: stamp };
    }
    // 29 — return updates.
    case 29:
      return { entidade: `${loja}:${texto(d.return_sn) ?? VAZIO}`, carimbo: stamp };
    // 16 / 22 / 27 — item violation, price echo, scheduled-publish failure.
    // 7 / 8 / 9 — promotion and reserved-stock changes.
    case 16:
    case 22:
    case 27:
    case 7:
    case 8:
    case 9:
      return { entidade: `${loja}:${texto(d.item_id) ?? VAZIO}`, carimbo: stamp };
    // 10 — webchat (an ERP System app cannot even subscribe to it; parked).
    // ⚠️ The ids live one level DOWN, under `data.content` — `data` itself
    // carries only `type`, `region` and `content`. A flat read answered `-` for
    // every real message, so every chat push of one shop shared one dedup key
    // and same-second messages shared one create-only row. The MESSAGE leads
    // (`message_id` when `type` = message, `msg_id` when it is a notification —
    // and a `msg_id` of 0, which the notification sample carries, is not an
    // id): a conversation id repeats across every message in the thread, so
    // it is only the fallback.
    case 10: {
      const c = objeto(d.content);
      const msgId = asInt(c.msg_id);
      const mensagem =
        texto(c.message_id) ??
        (msgId != null && msgId !== 0 ? String(msgId) : null) ??
        texto(c.conversation_id) ??
        VAZIO;
      return { entidade: `${loja}:${mensagem}`, carimbo: stamp };
    }
    // 5 / 11 / 13 — shopee updates, video, brand.
    case 5:
    case 11:
    case 13:
      return {
        entidade: `${loja}:${texto(d.video_id) ?? texto(d.brand_id) ?? VAZIO}`,
        carimbo: stamp,
      };
    // 1 / 2 — authorization granted / cancelled. The subject may be a shop, a
    // merchant, a main account or a LIST of shops. `p.shopId` carries the
    // lifted single-shop case — from any of the four placements the parser
    // accepts, including a TOP-LEVEL `shop_id` the authorization samples have
    // not shown but `lojasDoPushDeConta` already routes on — so it leads
    // exactly as on every other row, and `data` supplies the subjects that
    // have no envelope form. Identity follows routing: with the leading
    // segment fixed at `-`, two pushes about two different top-level-only
    // shops in the same SECOND would share one doc id (create-only ⇒ the
    // second deferred row never exists) and one dedup key (the sweep re-drives
    // one of them per run). A shop lifted from `data` appears in both
    // segments; redundant, never ambiguous.
    case 1:
    case 2: {
      const sujeito =
        texto(d.shop_id) ??
        texto(d.shopid) ??
        texto(d.merchant_id) ??
        texto(d.main_account_id) ??
        (lista(d.shop_id_list).length > 0
          ? lista(d.shop_id_list)
              .map((v) => texto(v) ?? VAZIO)
              .join('_')
          : null) ??
        VAZIO;
      return { entidade: `${loja}:${sujeito}`, carimbo: stamp };
    }
    // 24 / 25 — booking tracking number / booking shipping document status
    // (push_api_id 27 and 28, both "New Push" of 2024-07-02). The resource is
    // the BOOKING, never the order: `data` carries only `booking_sn` plus the
    // tracking number (24) or the READY/FAILED status (25), and `booking_sn` is
    // what `v2.logistics.get_booking_tracking_number` itself takes. Neither
    // page documents an `update_time`, so the clock is the envelope stamp.
    // ⚠️ The codes come from the page HEADER (`push_code`) and from the sandbox
    // deliveries of 2026-09-09 — NOT from the parameter tables, which sample
    // `code` as 4 and 15, the codes of their non-booking siblings.
    case 24:
    case 25:
      return { entidade: `${loja}:${texto(d.booking_sn) ?? VAZIO}`, carimbo: stamp };
    // 12 — authorization expiry. Partner-level and PAGINATED: the page number
    // is part of the identity, or page 2 would overwrite page 1's dead-letter
    // row and the shops on it would be lost silently.
    case 12:
      return {
        entidade: `${VAZIO}:${texto(d.expire_before) ?? VAZIO}:${texto(d.page_no) ?? VAZIO}`,
        carimbo: stamp,
      };
    // CODIGO_AUSENTE (-1) — a lost-push queue entry whose `data` STRING this
    // channel could not read at all. It has no resource key of any kind, so its
    // identity is the provider's own POSITION in the queue, which
    // `lostPushSweep.ts` writes as `data._lostPush.ref` =
    // `<last_message_id>_<index in the page>`.
    //
    // ⚠️ Load-bearing. Without this row two unreadable PARTNER-LEVEL entries
    // lost in the same second both key `-1:-:-:<carimbo>`; `store.create`
    // narrows ALREADY_EXISTS and returns SILENTLY, so the sweep would confirm
    // past an entry whose payload was never stored — the #1488
    // whole-delivery-drop shape, arriving through the escape hatch that exists
    // to prevent it.
    //
    // ⚠️ The ref is STABLE under a re-read of an UNCONFIRMED page (same
    // `last_message_id`, same order), so a replay collapses onto one row instead
    // of duplicating. It is NOT stable if entries ahead of it expire between
    // ticks — that costs one extra parked row, never a loss.
    //
    // A STORED document whose `code` is merely unreadable (`payloadDeDocumento`'s
    // fallback) carries no `_lostPush`, so `texto(...)` answers null and it keeps
    // the `${loja}:-` identity the default branch already gave it. This row
    // changes nothing for that producer.
    case CODIGO_AUSENTE:
      return { entidade: `${loja}:${texto(objeto(d._lostPush).ref) ?? VAZIO}`, carimbo: stamp };
    // 28 (`shop_penalty_update_push`) and every code we have never seen.
    default:
      return { entidade: `${loja}:${VAZIO}`, carimbo: stamp };
  }
}

/** `<code>:<entidade>:<carimbo>`, through the doc-id guard. */
export function docIdOf(p: ShopeeNotificationPayload): string | null {
  const { entidade, carimbo } = identidadeDoPush(p);
  return asDocId([String(p.code), entidade, carimbo].join(':'));
}

/**
 * The sweep's in-run dedup key — the doc id WITHOUT the stamp, so two
 * redeliveries about the same resource count as one job in a run. Including the
 * stamp would defeat the dedup it exists to create (the `missedFeedsSweep`
 * reasoning, one channel over).
 */
export function dedupKeyOf(p: ShopeeNotificationPayload): string | null {
  return [String(p.code), identidadeDoPush(p).entidade].join(':');
}

// ── the dispatch table ──────────────────────────────────────────────────────

/**
 * What this channel does with each Shopee **push code** — one table, one place.
 *
 * | destino | writes | means |
 * |---|---|---|
 * | `conta` | maybe an aviso | an authorization event: codes 1, 2 and 12 |
 * | `ack`   | nothing | recognised, and there is genuinely nothing to do |
 * | `pedido`| a pedido | the order import (step 5) — code 3, the only one |
 * | `parado`| one doc | data-bearing, the owning step is not built yet |
 *
 * ⚠️ **Keyed on the push code, never on `push_api_id`.** The comment beside
 * each row names both so a reader checking against Shopee's doc URL cannot
 * conclude the table is wrong.
 *
 * ⚠️ **An unbuilt handler PARKS, it never DEFERS.** `defer` is for a
 * precondition a human can clear (a shop that has not been linked yet); a
 * handler that does not exist is cleared by shipping a step, and deferring it
 * would burn the daily lane's seven re-drives and then park anyway — a week
 * later, with the same outcome.
 *
 * ⚠️ **A code ABSENT from this table still parks, deliberately.** That parked
 * document is the only signal a genuinely new push code appeared — and it has
 * already been exactly that: the sandbox push test of **2026-09-09** delivered
 * codes **24** and **25** (the booking pair, `push_api_id` 27/28), which no
 * revision of this table had ever listed. They arrived as `desconhecido`,
 * parked, and are listed below because of it.
 */
export type DestinoPush = 'conta' | 'ack' | 'pedido' | 'parado' | 'desconhecido';

const DISPATCH: Readonly<Record<number, DestinoPush>> = {
  // ---- authorization (the conta arms) ------------------------------------
  1: 'conta', // push_api_id 15 — shop_authorization_push
  2: 'conta', // push_api_id 16 — shop_authorization_canceled_push
  12: 'conta', // push_api_id 12 — open_api_authorization_expiry

  // ---- recognised, nothing to do -----------------------------------------
  // ⚠️ Code 0 has no push_api_id and is not an event: it is the console's own
  // callback-URL verification message (`data.verify_info`), sent SIGNED by
  // "Verify and Save". It must NEVER park — one operator click would otherwise
  // leave one dead-letter row per click.
  0: 'ack',
  5: 'ack', // push_api_id 3  — shopee_updates
  7: 'ack', // promotion updates — step 12 reads get_item_promotion live
  8: 'ack', // reserved stock change
  9: 'ack', // promotion/reserved stock (the third of the trio)
  11: 'ack', // video upload
  13: 'ack', // brand register result
  22: 'ack', // push_api_id 25 — item_price_update_push, the ERP's OWN echo
  28: 'ack', // push_api_id 31 — shop_penalty_update_push (no ERP surface yet)

  // ---- the pedido arm (step 5) -------------------------------------------
  // ⚠️ This row is what ARMS `runShopeeOrderBackfill`: its structural guard
  // reads this table (`destinoDoCodigo(3) === 'parado'`) rather than a literal,
  // so flipping the row here is what lets the sweep synthesize code-3 pushes.
  // After the flip `SHOPEE_ORDER_BACKFILL_ENABLED=1` is the ONLY remaining gate,
  // and turning it on is migration-window work (root CLAUDE.md rule 8).
  3: 'pedido', // push_api_id 1  — order_status_push

  // ---- data-bearing, handler pending -------------------------------------
  4: 'parado', // push_api_id 2  — order_trackingno_push
  30: 'parado', // push_api_id 33 — package_fulfillment_status_push
  47: 'parado', // package info
  15: 'parado', // shipping document status
  16: 'parado', // item violation
  27: 'parado', // scheduled publish failed
  29: 'parado', // push_api_id 32 — return_updates_push
  10: 'parado', // webchat — an ERP System app cannot subscribe to it at all
  24: 'parado', // push_api_id 27 — booking_trackingno_push
  25: 'parado', // push_api_id 28 — booking_shipping_document_status_push
};

/**
 * Why a parked code is parked, naming the step that will build it.
 *
 * ⚠️ There is deliberately no row for **3** any more: the order import IS built
 * (step 5), so a `motivoDoParque(3)` could only answer the "código novo"
 * fallback — a sentence that would be false about the one code this channel
 * handles most.
 */
const MOTIVO_PARADO: Readonly<Record<number, string>> = {
  4: 'código de rastreio — o handler é o passo 7',
  30: 'status de fulfillment do pacote — o handler é o passo 7',
  47: 'informação do pacote — o handler é o passo 7',
  15: 'status do documento de envio — o handler é o passo 15',
  16: 'violação de anúncio — o handler é o passo 11',
  27: 'publicação agendada falhou — o handler é o passo 11',
  29: 'atualização de devolução — o handler é o passo 17',
  10: 'chat — o handler é o passo 16, condicionado à liberação da Chat API',
  24: 'código de rastreio da reserva (booking) — o handler é o passo 7',
  25: 'status do documento de envio da reserva (booking) — o handler é o passo 15',
};

/**
 * The stand-in code for a persisted document that no longer carries a readable
 * one. Deliberately negative: Shopee's codes are non-negative, so no row of
 * {@link DISPATCH} can ever claim it and the document parks instead of being
 * settled by whatever code happens to sit at the fallback.
 */
export const CODIGO_AUSENTE = -1;

/** The destination for a push code — `'desconhecido'` for anything unlisted. */
export function destinoDoCodigo(code: number): DestinoPush {
  return DISPATCH[code] ?? 'desconhecido';
}

/** The operator-facing `erro` written onto a parked document. */
export function motivoDoParque(code: number): string {
  // The sentinel is not a push code and nothing new appeared: the stored
  // document itself is unreadable, and this text is all a human ever sees of it
  // (a parked row is terminal). Point them at the document, not at the table.
  if (code === CODIGO_AUSENTE) {
    return 'documento persistido sem `code` legível — nada a despachar; inspecione o documento';
  }
  const nota = MOTIVO_PARADO[code];
  if (nota != null) return `push_code ${String(code)}: ${nota}`;
  return `push_code ${String(code)} desconhecido — nenhum handler; primeiro sinal de um código novo`;
}

/**
 * The persisted-document → payload mapper behind `fromDoc`, named and exported
 * so the sweep's re-read is testable without a Firestore.
 *
 * ⚠️ `code` falls to {@link CODIGO_AUSENTE}, NOT to `0`. Since 2026-09-09 zero
 * is a LISTED code (`ack` ⇒ the sweep would DELETE the row), so a stored
 * document whose `code` is missing or unreadable — `parseRead` is soft and hands
 * back the raw doc — must fall to something no table row can claim, which parks
 * it and leaves it visible. Never written back: the park path updates
 * `status`/`erro`, not `code`.
 */
export function payloadDeDocumento(doc: Record<string, unknown>): ShopeeNotificationPayload {
  return {
    code: asInt(doc.code) ?? CODIGO_AUSENTE,
    shopId: asInt(doc.shop_id),
    timestamp: asMillis(doc.timestamp),
    data: sanitizarData(doc.data),
  };
}

// ── processing ──────────────────────────────────────────────────────────────

/** Deterministic result of processing one push (transient failures THROW). */
export type ShopeeProcessOutcome =
  /** Recognised, nothing to do. Persists nothing in either phase. */
  | { kind: 'ack'; reason: string; detail: string }
  /** An authorization arm ran. The counts are what an operator reads. */
  | { kind: 'aviso'; lojas: number; avisados: number; resolvidos: number }
  /**
   * The order import ran (step 5). `pedidoId`/`orderStatus` are non-null HERE
   * although the importer declares them nullable: the one action that answers
   * `null` for both is `ignorado-inexistente`, and the arm turns that into a
   * `parado` before building this outcome. Narrowing at the arm is what keeps
   * the importer honest instead of making it promise a pedido it never wrote.
   */
  | {
      kind: 'pedido';
      acao: AcaoImportacaoPedidoShopee;
      orderSn: string;
      pedidoId: string;
      orderStatus: string;
      itensSemProduto: number;
      detail: string;
    }
  /**
   * The order import hit a PRECONDITION (a dead grant, an unreadable or absent
   * credential, a conta that vanished, an exhausted daily quota). Deferred —
   * daily × 7, then park. Its own kind rather than `sem-conta`, because `kind`
   * is what the task log prints.
   */
  | { kind: 'pedido-adiado'; shopId: number; orderSn: string; reason: string }
  /** Exactly one named shop maps to no active integração YET — a defer. */
  | { kind: 'sem-conta'; shopId: number; reason: string }
  /** Terminal: no handler for this code yet, or a permanent import failure. */
  | { kind: 'parado'; motivo: string };

export interface ShopeeProcessDeps {
  /**
   * Built per call so a missing `SHOPEE_PARTNER_KEY` throws where the pipeline
   * can park it, rather than at module load.
   */
  partnerClient: () => ShopeePartnerClient;
  /** `(by) => FieldValue.increment(by)` — `packages/data` may not import it. */
  increment: (by: number) => unknown;
  /** Injectable clock, MILLIS. */
  nowMs: () => number;
  /**
   * The code-3 arm (step 5). OPTIONAL so every conta-arm test stays drivable
   * without a shop-scoped client, and so the default can stay LAZY — see
   * {@link defaultProcessDeps}.
   */
  importarPedido?: (
    db: Firestore,
    alvo: AlvoDeImportacaoShopee,
  ) => Promise<ResultadoImportacaoPedidoShopee>;
}

export const defaultProcessDeps: ShopeeProcessDeps = {
  partnerClient: () => createShopeePartnerClient(shopeeConfig()),
  // ⚠️ `escreverAviso` takes `increment` as a dependency because
  // `packages/data/src/admin/**` may only `import type` from firebase-admin.
  // That restriction is the PACKAGE's, not this app's — so the app-level
  // default is the real transform, and the injection point stays open for the
  // tests and for the functions codebase.
  increment: (by) => FieldValue.increment(by),
  nowMs: () => Date.now(),
  // ⚠️ A LAZY arrow over a DYNAMIC import, not a module-scope reference, and the
  // laziness is the point. This module is imported by the push receiver ROUTE,
  // so a static `import { importarPedidoShopee }` would pull the whole pedido
  // tree — the mappers, the produto cascade, the buyer capture, every schema
  // they reach — into the Next bundle of an endpoint that only enqueues. The
  // functions bundle pays for it (it dispatches the task, and the `grep` in
  // `apps/shopee/functions/DEPLOY.md` proves the importer is inlined there);
  // the receiver does not.
  importarPedido: async (db, alvo) => {
    const { importarPedidoShopee } = await import('../pedidos/importarPedido');
    return importarPedidoShopee(db, alvo);
  },
};

// ── the code-3 arm: a failure → a disposition ───────────────────────────────

/**
 * The one action the importer answers instead of throwing. Typed against the
 * union rather than written as a bare literal, so the day that member is
 * renamed this file fails to compile instead of silently never matching.
 */
const ACAO_INEXISTENTE: AcaoImportacaoPedidoShopee = 'ignorado-inexistente';

/** Every park/defer reason from this arm starts here, so one log filter finds them all. */
const PREFIXO_MOTIVO_CODE3 = 'push_code 3:';

/**
 * Admin-SDK Firestore and Cloud Tasks failures surface as `Error`s carrying a
 * numeric gRPC status `code`. Narrowed to the real status range (1–16; 0 = OK
 * never rides an error) so a coding-bug `Error` that happens to expose some
 * other numeric `code` is NOT swallowed as transient. Verbatim from
 * `orderBackfill.ts`, which took it from `conta/expiracaoSweep.ts`.
 */
function isGrpcCodedError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/** Field PATHS only, capped — never a value, never a body (#1015). */
const MAX_CAMPOS_NO_MOTIVO = 6;
function resumirCampos(err: unknown): string {
  const campos = describeValidationFailure(err);
  if (campos == null || campos.length === 0) return 'sem campos legíveis';
  const mostrados = campos.slice(0, MAX_CAMPOS_NO_MOTIVO).join(', ');
  return campos.length > MAX_CAMPOS_NO_MOTIVO
    ? `${mostrados} (+${String(campos.length - MAX_CAMPOS_NO_MOTIVO)})`
    : mostrados;
}

/** What the arm does about a failure raised inside {@link ShopeeProcessDeps.importarPedido}. */
export type DisposicaoDaFalha =
  | { tipo: 'throw' }
  | { tipo: 'defer'; reason: string }
  | { tipo: 'park'; reason: string };

/**
 * Classify a failure of the order import. Pure, exported and table-shaped so it
 * is testable without a Firestore and without a Shopee.
 *
 * ⚠️ **`throw` is not "give up" — it is the TRANSIENT path**, and it costs about
 * five hours before anything is visible: Cloud Tasks retries
 * {@link TASK_MAX_ATTEMPTS} times with backoff, the final attempt persists the
 * delivery as `failed`, the hourly sweep re-drives it up to
 * {@link MAX_TENTATIVAS} times and only then parks it. `defer` is the DAILY
 * lane (`MAX_TENTATIVAS_DEFERRED` days, then park) and `park` is terminal and
 * immediate.
 *
 * ⚠️ **Order matters here in a way `instanceof` hides.**
 * `ShopeeReauthRequiredError` and `ShopeeRateLimitError` both EXTEND
 * `ShopeeApiError`, so the base-class arm has to come last or it would answer
 * for all three. The same trap is written down in `orderBackfill.ts`'s
 * containment boundary.
 *
 * ⚠️ **No aviso is raised on this path, deliberately.** `avisos/autorizacao.ts`
 * is the ONE producer of `shopeeDesautorizado`; a second producer forks the row,
 * and the operator is already told by the code-2 arm and the weekly sweep.
 */
export function disposicaoDaFalhaDeImportacao(err: unknown): DisposicaoDaFalha {
  // --- the queue's own ladder: retry, and only then become visible ---------
  if (err instanceof ShopeeRateLimitError) {
    // ⚠️ The two rate limits want OPPOSITE answers. `burst` is a short window,
    // and the queue's 30–300 s backoff is exactly the right instrument;
    // `retryAfterSeconds` is advisory, and deferring a 60-second problem would
    // cost a day. `daily` (`error_limit`) resets at 00:00 UTC+8 = 13:00 BRT, so
    // three attempts in ~10 minutes plus five hourly re-drives all land inside
    // the same exhausted quota and park a perfectly importable order. The
    // deferred lane's cadence — daily × 7 — brackets a DAILY quota exactly.
    // ⚠️ The pipeline documents `defer` as "a precondition a human can clear";
    // a quota clears itself. The load-bearing property is the CADENCE, not who
    // clears it, and this comment says so rather than pretending otherwise.
    if (err.kind === SHOPEE_ERROR_KIND.daily) {
      return {
        tipo: 'defer',
        reason: `${PREFIXO_MOTIVO_CODE3} cota diária da Shopee (${err.code}) — reinicia 00:00 UTC+8`,
      };
    }
    return { tipo: 'throw' };
  }
  // A dead grant is a PRECONDITION: only a human re-consenting clears it, and a
  // week of daily re-drives is the grace period before a terminal row.
  if (err instanceof ShopeeReauthRequiredError) {
    return {
      tipo: 'defer',
      reason: `${PREFIXO_MOTIVO_CODE3} ShopeeReauthRequiredError (${err.code}) — a conta precisa de novo consentimento`,
    };
  }
  if (err instanceof ShopeeSchemaError) {
    // A shape we cannot read does not become readable by retrying. PATHS only.
    return {
      tipo: 'park',
      reason: `${PREFIXO_MOTIVO_CODE3} ShopeeSchemaError em ${err.path} — campos: ${resumirCampos(err)}`,
    };
  }
  if (err instanceof ShopeeApiError) {
    // `transient` is Shopee's own side (`error_server`, `error_network`).
    if (err.kind === SHOPEE_ERROR_KIND.transient) return { tipo: 'throw' };
    // Everything else Shopee named — `error_sign` (OUR signing/clock bug; a
    // retry re-sends the same bad signature), `error_param`, `error_data`, and
    // `order_not_found` when it arrives as a THROW rather than as the
    // importer's outcome. Terminal, and the row carries the code so a Cloud
    // Logging filter separates "Shopee denied the order" from "our schema
    // drifted" without opening a document.
    return {
      tipo: 'park',
      reason: `${PREFIXO_MOTIVO_CODE3} ShopeeApiError ${err.code} em ${err.path}`,
    };
  }
  // No response at all, or an edge that answered something other than a Shopee
  // envelope — the IP-whitelist shape once P2 lands. Retryable if the whitelist
  // is right and the edge blipped; if it is wrong, the retries park it, and a
  // parked row naming the path is what says "we are calling from an undeclared
  // address".
  if (err instanceof ShopeeNetworkError || err instanceof ShopeeHttpError) return { tipo: 'throw' };
  // Another instance holds the refresh lease past our poll budget. Transient by
  // construction — the conta route answers this one 503 + Retry-After.
  if (err instanceof ShopeeRefreshEmAndamentoError) return { tipo: 'throw' };
  // ⚠️ OURS (#778). The execution that names a missing binding is the one that
  // has to fail; the honest observable is log lines plus accumulating `failed`
  // rows, not an aborted deploy.
  if (err instanceof ShopeeConfigError) return { tipo: 'throw' };
  // A main-account conta cannot sign a shop call, and nothing about THIS order
  // will change that. Terminal.
  if (err instanceof ShopeeContaSemShopIdError) {
    return {
      tipo: 'park',
      reason: `${PREFIXO_MOTIVO_CODE3} ShopeeContaSemShopIdError — a conta não tem shop_id para assinar a chamada`,
    };
  }
  // The three per-conta credential states the conta route already renders, plus
  // the genuine race where `findIntegracaoByShopId` named an id and
  // `loadShopeeContext` then found nothing. All four are cleared by a human (or
  // by the very next delivery), never by a retry inside ten minutes.
  if (err instanceof ShopeeSemCredencialError) {
    return {
      tipo: 'defer',
      reason: `${PREFIXO_MOTIVO_CODE3} ShopeeSemCredencialError — a conta nunca foi conectada, ou a credencial foi apagada`,
    };
  }
  if (err instanceof ShopeeCredencialInvalidaError) {
    return {
      tipo: 'defer',
      reason: `${PREFIXO_MOTIVO_CODE3} ShopeeCredencialInvalidaError — credencial ilegível: ${err.campos.join(', ') || 'sem campos legíveis'}`,
    };
  }
  if (err instanceof ShopeeContaNotConfiguredError) {
    return {
      tipo: 'defer',
      reason: `${PREFIXO_MOTIVO_CODE3} ShopeeContaNotConfiguredError — a integração sumiu entre a resolução da loja e a leitura da conta`,
    };
  }
  // Firestore / Cloud Tasks, transient by construction.
  if (isGrpcCodedError(err)) return { tipo: 'throw' };
  // A pedido the write refused. ⚠️ #1087 one channel over: a `ZodError` inside a
  // write reads as transient and retries forever. It is a MAPPER bug — park it
  // with the paths, values stripped.
  if (err instanceof z.ZodError) {
    return {
      tipo: 'park',
      reason: `${PREFIXO_MOTIVO_CODE3} ZodError na escrita do pedido — campos: ${resumirCampos(err)}`,
    };
  }
  // Rule 6: anything unrecognised is a coding bug and deserves to fail loudly.
  return { tipo: 'throw' };
}

/**
 * What lands on the aviso's `motivo` when a `code 2` push carries no
 * `authorize_type`. Every documented sample has one, so this is tolerance, not
 * a default — and it says so on the aviso rather than pretending the seller
 * revoked, which is only one of that field's five meanings.
 */
export const MOTIVO_SEM_AUTHORIZE_TYPE = 'authorize_type não informado pela Shopee';

/** Every shop id a code-1/2 push names, de-duplicated, order preserved. */
export function lojasDoPushDeConta(p: ShopeeNotificationPayload): number[] {
  const d = p.data ?? {};
  const vistos = new Set<number>();
  const out: number[] = [];
  const add = (v: unknown): void => {
    const n = asInt(v);
    if (n == null || vistos.has(n)) return;
    vistos.add(n);
    out.push(n);
  };
  add(p.shopId);
  add(d.shop_id);
  add(d.shopid);
  for (const v of lista(d.shop_id_list)) add(v);
  return out;
}

/** The shop ids `push 12` says are expiring, de-duplicated (its own samples repeat). */
export function lojasExpirandoDoPush12(p: ShopeeNotificationPayload): number[] {
  const d = p.data ?? {};
  const vistos = new Set<number>();
  const out: number[] = [];
  for (const v of lista(d.shop_expire_soon)) {
    const n = asInt(v);
    if (n == null || vistos.has(n)) continue;
    vistos.add(n);
    out.push(n);
  }
  return out;
}

interface LojaMapeada {
  shopId: number;
  integracaoId: string;
}

async function mapearLojas(db: Firestore, shopIds: readonly number[]): Promise<LojaMapeada[]> {
  const out: LojaMapeada[] = [];
  for (const shopId of shopIds) {
    const integracaoId = await findIntegracaoByShopId(db, shopId);
    if (integracaoId != null) out.push({ shopId, integracaoId });
  }
  return out;
}

/**
 * The name an operator recognises. The integração document's `nome`, falling
 * back to the shop id — `get_shop_info` is SHOP-signed, so the real store name
 * is not reachable from a push about an authorization that may already be dead.
 */
async function nomeDaLoja(db: Firestore, loja: LojaMapeada): Promise<string | null> {
  const conta = await readConta(db, loja.integracaoId);
  const nome = conta?.nome;
  return typeof nome === 'string' && nome.length > 0 ? nome : null;
}

/**
 * Process one push. Pure of the notification document (it reads the integração
 * and writes avisos, never the failure row), so it behaves identically for a
 * fresh queued task and a sweep re-drive. Deterministic outcomes RETURN;
 * transient failures (Firestore, the Shopee API, the network) THROW so the
 * queue and the sweep retry with backoff.
 *
 * ⚠️ **The order of the three gates is load-bearing.** `ack` and `parado` are
 * decided from the code ALONE, before any Firestore read: a push for a code we
 * do not handle must not cost an integração lookup per delivery, and a spy in
 * the tests pins that `findIntegracaoByShopId` is never called for them.
 */
export async function processNotificationPayload(
  db: Firestore,
  payload: ShopeeNotificationPayload,
  deps: ShopeeProcessDeps = defaultProcessDeps,
): Promise<ShopeeProcessOutcome> {
  const destino = destinoDoCodigo(payload.code);

  if (destino === 'ack') {
    // ⚠️ Code 0 is the ONE ack that is not an event at all: the Shopee console
    // sends it — signed, twice per click — when an operator presses "Verify and
    // Save" on the push callback URL. Its whole body is
    // `{"code":0,"data":{"verify_info":"…"}}`: no `shop_id`, no `timestamp`, so
    // its identity is the default branch (`0:-:-:-`). Its own reason/detail
    // keeps a console click distinguishable in the logs from a recognised
    // BUSINESS event that we deliberately do nothing about.
    if (payload.code === 0) {
      return {
        kind: 'ack',
        reason: 'mensagem de verificação do callback URL (console)',
        detail: 'verificacao-callback',
      };
    }
    return {
      kind: 'ack',
      reason: `push_code ${String(payload.code)} reconhecido, sem ação`,
      detail: 'reconhecido',
    };
  }
  if (destino === 'parado' || destino === 'desconhecido') {
    return { kind: 'parado', motivo: motivoDoParque(payload.code) };
  }

  const nowMs = deps.nowMs();

  // ---- code 3 — the order import (step 5) --------------------------------
  if (destino === 'pedido') {
    const shopId = payload.shopId;
    if (shopId == null) {
      // ⚠️ PARK, never defer. A push that names no shop is not a precondition a
      // human can clear — there is nothing to look up and nothing to wait for.
      // `push 1` documents `shop_id` at the TOP level and every synthetic code 3
      // carries it by construction, so this is a provider or a producer defect
      // and the parked row is the only thing that says so.
      return {
        kind: 'parado',
        motivo: `${PREFIXO_MOTIVO_CODE3} push de pedido sem shop_id — nada a resolver`,
      };
    }
    // ⚠️ BOTH spellings. `push 1`'s own sample says `ordersn`, while
    // `get_order_list` — and therefore anyone writing a payload by hand — says
    // `order_sn`. `identidadeDoPush` reads only `ordersn`, so a payload carrying
    // the other spelling already arrives with a `-` in its identity; accepting
    // both HERE is what stops it from being unprocessable as well as
    // unidentifiable.
    const d = payload.data ?? {};
    const orderSn = texto(d.ordersn) ?? texto(d.order_sn);
    if (orderSn == null) {
      return {
        kind: 'parado',
        motivo: `${PREFIXO_MOTIVO_CODE3} push de pedido sem ordersn — nada a importar`,
      };
    }

    const integracaoId = await findIntegracaoByShopId(db, shopId);
    if (integracaoId == null) {
      // DEFER — and the code-2 inversion does NOT apply here, which is the whole
      // reason this branch is written out instead of shared. For a code 2 the
      // event that clears the precondition (an operator connecting the shop) is
      // the event that makes the news FALSE. For a code 3 it makes the order
      // ACTIONABLE: it still exists at Shopee and `get_order_detail` will still
      // return it. Without the defer, every order placed before a late
      // connection is reachable only through the backfill's initial 24-hour
      // lookback — so a conta linked more than a day after the first sale would
      // lose those orders in silence. Daily × 7, then a visible terminal row.
      return {
        kind: 'sem-conta',
        shopId,
        reason: `loja ${String(shopId)} não mapeia nenhuma integração Shopee ativa`,
      };
    }

    let resultado: ResultadoImportacaoPedidoShopee;
    try {
      // `deps.importarPedido` is optional in the interface so the conta arms stay
      // drivable without it; on this arm it is always present (the default is
      // the real importer) and a caller that removed it should fail loudly.
      const importar = deps.importarPedido ?? defaultProcessDeps.importarPedido!;
      resultado = await importar(db, { integracaoId, shopId, orderSn, nowMs });
    } catch (err) {
      // ⚠️ ONE narrow catch, and it narrows in `disposicaoDaFalhaDeImportacao`
      // (rule 6): every class it does not name is RETHROWN from there, so this
      // block cannot swallow a coding bug.
      const disposicao = disposicaoDaFalhaDeImportacao(err);
      if (disposicao.tipo === 'throw') throw err;
      if (disposicao.tipo === 'park') return { kind: 'parado', motivo: disposicao.reason };
      // ⚠️ Its OWN kind, not `sem-conta`. Both defer, but `kind` is what the
      // task log prints and what an operator filters on: reporting a dead grant
      // or an exhausted daily quota as "this shop maps to no integração" is the
      // #1087 shape — one label covering two different facts. The reason string
      // names the class either way.
      return { kind: 'pedido-adiado', shopId, orderSn, reason: disposicao.reason };
    }

    if (resultado.acao === ACAO_INEXISTENTE) {
      // ⚠️ The importer RETURNS this rather than throwing, because "this shop has
      // no such order" is a permanent fact about ONE order — and the disposition
      // is ours. `detail` distinguishes the two ways it happens
      // (`order_not_found` = Shopee's own 404; `ausente-no-order_list` = the list
      // denied a row it had just returned, a provider self-contradiction that
      // only a synthetic backfill push can produce), so BOTH stay readable on
      // the parked row.
      return {
        kind: 'parado',
        motivo: `${PREFIXO_MOTIVO_CODE3} pedido ${orderSn} inexistente na Shopee (${resultado.detail})`,
      };
    }

    if (resultado.pedidoId == null || resultado.orderStatus == null) {
      // The narrowing, done HERE rather than by widening the outcome or by
      // making the importer promise a pedido it may not have written. Its
      // contract is "null only on `ignorado-inexistente`" — which the branch
      // above already took — so this park is unreachable while that holds, and
      // is a visible terminal row the day it stops holding.
      return {
        kind: 'parado',
        motivo: `${PREFIXO_MOTIVO_CODE3} importação devolveu "${resultado.acao}" sem pedidoId/orderStatus — contrato do importador violado`,
      };
    }

    return {
      kind: 'pedido',
      acao: resultado.acao,
      orderSn,
      pedidoId: resultado.pedidoId,
      orderStatus: resultado.orderStatus,
      itensSemProduto: resultado.itensSemProduto,
      detail: resultado.detail,
    };
  }

  // ---- code 12 — the partner-level expiry batch --------------------------
  if (payload.code === 12) {
    const candidatas = lojasExpirandoDoPush12(payload);
    const mapeadas = await mapearLojas(db, candidatas);
    if (mapeadas.length === 0) {
      return {
        kind: 'ack',
        reason: 'nenhuma das lojas expirando pertence a uma integração ativa',
        detail: 'nenhuma-loja-mapeada',
      };
    }
    // ⚠️ `data.expire_before` is a BATCH cutoff, not a per-shop expiry, so the
    // aviso cannot be built from it. The sweep re-enumerates through
    // `get_shops_by_partner` and reads each shop's real `expire_time` — one
    // producer, two triggers, and the weekly sweep collapses onto the same row.
    const resultado = await runShopeeAuthorizationExpirySweep(db, {
      partnerClient: deps.partnerClient(),
      increment: deps.increment,
      nowMs,
      apenasShopIds: new Set(mapeadas.map((l) => l.shopId)),
      // ⚠️ The push's OWN clock, so a stale redelivery of this batch is dropped
      // by the watermark instead of re-alerting. OMITTED when unknown — an
      // explicit `null` would RESET the watermark, and a reset watermark never
      // rejects anything again (`camposInformados`, root CLAUDE.md rule 7). The
      // weekly cron omits it for the same reason: it has no delivery clock.
      ...(payload.timestamp == null ? {} : { relogioEventoMs: payload.timestamp }),
    });
    // ⚠️ The scoped sweep CONTAINS per-shop failures into `erros` and keeps
    // walking — right for the weekly cron, whose trigger logs `result.erros`.
    // This arm settles the delivery (`aviso` ⇒ `resolve`), so without this line
    // a batch whose writes all failed would be reported as done with nothing on
    // the task's own summary. The counts only; never a body, never a token.
    if (resultado.erros.length > 0 || resultado.truncado) {
      console.warn('[shopee] push 12 — varredura de expiração incompleta', {
        lojas: mapeadas.length,
        avisados: resultado.avisados,
        resolvidos: resultado.resolvidos,
        erros: resultado.erros.length,
        truncado: resultado.truncado,
      });
    }
    return {
      kind: 'aviso',
      lojas: mapeadas.length,
      avisados: resultado.avisados,
      resolvidos: resultado.resolvidos,
    };
  }

  // ---- codes 1 and 2 — authorization granted / cancelled ------------------
  const candidatas = lojasDoPushDeConta(payload);
  const mapeadas = await mapearLojas(db, candidatas);

  if (mapeadas.length === 0) {
    // On a code 1, exactly one named shop that maps to nothing is a PRECONDITION
    // a human can clear by connecting the conta — the one and only defer in this
    // channel, and harmless because the re-drive only RESOLVES rows.
    //
    // ⚠️ For a code 2 the same defer is INVERTED, which is why it is gated on the
    // code. The event that clears the precondition — an operator connecting the
    // shop, i.e. a fresh consent — is exactly the event that makes the news
    // FALSE, so a re-drive up to 7 days later would raise `shopeeDesautorizado`
    // ("nada será sincronizado") for a shop that is authorized and syncing. No
    // watermark can reject it either: nothing was written when the shop was
    // unmapped, so there is no stored `relogioEvento` to compare against. A
    // de-authorization for a shop this ERP does not track is not work a human
    // can make actionable later — ack it.
    //
    // Several unmapped shops are acked for both codes: `sem-conta` can only name
    // one shop by construction.
    if (payload.code === 1 && candidatas.length === 1) {
      const shopId = candidatas[0]!;
      return {
        kind: 'sem-conta',
        shopId,
        reason: `loja ${String(shopId)} não mapeia nenhuma integração Shopee ativa`,
      };
    }
    console.warn('[shopee] push de autorização sem loja mapeada — ack', {
      code: payload.code,
      lojasNoPush: candidatas.length,
    });
    return {
      kind: 'ack',
      reason:
        candidatas.length === 0
          ? // ⚠️ NOT necessarily a merchant/main-account event: Shopee's own
            // `push 16` sample 1 is a SHOP cancellation whose shop id appears
            // only in the free-text `data.extra`. The envelope carries no shop
            // identifier either way, so there is nothing to act on.
            'push de autorização sem shop_id no envelope (merchant/main account, ou uma loja que a Shopee só cita em data.extra)'
          : 'nenhuma das lojas do push pertence a uma integração ativa',
      detail: 'nenhuma-loja-mapeada',
    };
  }

  if (payload.code === 1) {
    // Re-authorization: RESOLVE both open avisos for the shop. Nothing is
    // written to the conta document — the conta screen derives its clocks live.
    let resolvidos = 0;
    for (const loja of mapeadas) {
      const r = await resolverAvisosDeAutorizacao(
        db,
        { integracaoId: loja.integracaoId, shopId: loja.shopId },
        { nowMs },
      );
      // ⚠️ Count what was actually CLOSED, not how many shops we asked about:
      // `resolverAviso` reports a TRANSITION, so a shop with no standing aviso —
      // or one already resolved — is a no-op, and reporting it as resolved would
      // make the counter read as "we fixed four problems" on a re-consent that
      // fixed none.
      if (r.expiracao || r.desautorizacao) resolvidos += 1;
    }
    return { kind: 'aviso', lojas: mapeadas.length, avisados: 0, resolvidos };
  }

  // code 2 — de-authorization. ⚠️ NOT always the seller's doing: `authorize_type`
  // also carries `expiry`, `App status is abnormal` (the shop is FROZEN) and
  // `shop and main account is disconnected`, so it rides along as `motivo` —
  // five reasons, five different operator remedies.
  const motivo = texto((payload.data ?? {}).authorize_type) ?? MOTIVO_SEM_AUTHORIZE_TYPE;
  for (const loja of mapeadas) {
    const lojaNome = await nomeDaLoja(db, loja);
    await avisarDesautorizacao(
      db,
      {
        integracaoId: loja.integracaoId,
        shopId: loja.shopId,
        lojaNome,
        motivo,
        // ⚠️ OMITTED when unknown. An explicit `null` would RESET the stored
        // watermark, and a watermark that is reset is worse than one that never
        // advances (`camposInformados`, root CLAUDE.md rule 7).
        ...(payload.timestamp == null ? {} : { relogioEventoMs: payload.timestamp }),
      },
      { increment: deps.increment, nowMs },
    );
  }
  return { kind: 'aviso', lojas: mapeadas.length, avisados: mapeadas.length, resolvidos: 0 };
}

/**
 * Map this channel's outcome onto the shared disposition vocabulary.
 *
 * ⚠️ The `phase` argument is deliberately IGNORED here, and that is a decision
 * rather than an omission. Mercado Livre uses it because an unparseable
 * `resource` is worth keeping as an audit row once a document exists; every
 * outcome below already answers the same way in both phases — an `ack` is never
 * ours, an `aviso` settled it, a `parado` code is still unbuilt on the sweep's
 * re-drive, and a shop that maps to nothing is still unmapped. Reading `phase`
 * to produce the same answer twice would only invite a future divergence.
 */
export function toDisposition(outcome: ShopeeProcessOutcome): NotificationDisposition {
  switch (outcome.kind) {
    // Recognised and settled — identical writes, different counters: `drop`
    // says "never ours", `resolve` says "we did the work".
    case 'ack':
      return { kind: 'drop', reason: outcome.reason, label: 'ack' };
    case 'aviso':
      return { kind: 'resolve', label: 'aviso' };
    // ⚠️ Its own LABEL, so the sweep's `outcomes` map separates an imported
    // order from an aviso — the same reason the aviso arm carries one, and the
    // #1087 lesson that one label over two meanings reports success for work
    // that never happened.
    case 'pedido':
      return { kind: 'resolve', label: 'pedido' };
    // The defers: a human connecting the conta (or re-consenting, or fixing a
    // credential) clears it, and that may be tomorrow — the hourly lane would
    // park it ~6 h in (#808). A daily Shopee quota rides the same lane because
    // its CADENCE matches, not because a human clears it.
    case 'sem-conta':
    case 'pedido-adiado':
      return { kind: 'defer', reason: outcome.reason };
    case 'parado':
      return { kind: 'park', reason: outcome.motivo };
  }
}

// ── the pipeline ────────────────────────────────────────────────────────────

export interface TaskResult {
  outcome: 'done' | 'failed' | 'parked' | 'dropped' | 'deferred';
  code?: number;
  shopId?: number;
  /** The channel's own discriminant, so a schema-parse drop stays distinguishable. */
  kind?: ShopeeProcessOutcome['kind'];
  /** Filterable token for the arms that persist NOTHING. */
  detail?: string;
  lojas?: number;
  /**
   * The Shopee `order_sn` of a code-3 delivery.
   *
   * ⚠️ It is NOT buyer data, which is why it may be logged while the push body
   * may not: it is the pedido's `numero`, an operator's only search handle, and
   * it is already stored in the clear as a segment of the `notificacoesShopee`
   * doc id (`3:<shop>:<ordersn>:<carimbo>`).
   */
  orderSn?: string;
  /** Lines the import could not bind to a produto — the number an operator acts on. */
  itensSemProduto?: number;
}

/**
 * The shared pipeline, bound to this channel. Built per call so the injectable
 * `deps` stay per-call (the factory only closes over config — no I/O).
 *
 * ⚠️ `collection: notificacaoShopeeCollection` is written EXPLICITLY, not as
 * property shorthand: `notificationGuardrails.test.ts` (guard B) ignores the
 * shorthand form on purpose, so a shorthand here would read as "this channel
 * hand-rolled its own store" and red the `@delfrance/data` suite.
 */
function pipelineFor(deps: ShopeeProcessDeps) {
  return defineNotificationPipeline<ShopeeNotificationPayload, ShopeeProcessOutcome>({
    channel: 'shopee',
    collection: notificacaoShopeeCollection,
    taskSchema: shopeeNotificationTaskSchema,
    docIdOf,
    dedupKeyOf,
    toDocFields: (p) => ({
      code: p.code,
      shop_id: p.shopId,
      timestamp: p.timestamp,
      data: p.data,
    }),
    fromDoc: (parsed) => payloadDeDocumento((parsed ?? {}) as Record<string, unknown>),
    process: (db, payload) => processNotificationPayload(db, payload, deps),
    toDisposition: (outcome) => toDisposition(outcome),
  });
}

const basePipeline = pipelineFor(defaultProcessDeps);

/**
 * The operator-facing message of a failure, read STRUCTURALLY.
 *
 * ⚠️ Deliberately not `err instanceof Error`: root CLAUDE.md rule 6 is right
 * that `Error` narrows nothing, and at the two call sites there is nothing to
 * narrow TO — both catches are total on purpose (the receiver's enqueue and the
 * lost-push sweep's, which must never turn a transport failure into a lost
 * entry). Reading the message off the shape keeps the intent honest instead of
 * dressing a total catch as a narrow one.
 *
 * ⚠️ It lives HERE rather than in the receiver route because the sweep needs the
 * same reading. A rule duplicated is a rule that drifts, and these two callers
 * write the same `erro` string onto the same collection.
 */
export function mensagemDoErro(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return String(err);
}

/**
 * Persist a push as `failed` so the sweep re-drives it. The RECEIVER calls this
 * when the enqueue itself fails, so Shopee never sees a 5xx during an
 * enqueue-path outage — a run of non-2xx answers is what disables the
 * subscription.
 */
export function persistNotificationFailure(
  db: Firestore,
  payload: ShopeeNotificationPayload,
  erro: string,
): Promise<void> {
  return basePipeline.persistFailure(db, payload, erro);
}

/**
 * Persist a push as `parked` — TERMINAL. Nothing re-drives it, and it is
 * operator-visible.
 *
 * ⚠️ The RECEIVER must not reach for this: an inbound push it cannot read is
 * ACKED (a retry will not parse either), and parking one would leave a row per
 * delivery of a body Shopee keeps re-sending. The lost-push sweep is the
 * opposite case — its entry leaves the provider's queue only through an ACK WE
 * SEND, so an entry we can never process has to become a durable, terminal row
 * BEFORE that ack is safe. Without it, one unreadable entry blocks every later
 * one in a queue ordered "earliest first" for three days.
 */
export function persistNotificationParked(
  db: Firestore,
  payload: ShopeeNotificationPayload,
  erro: string,
): Promise<void> {
  return basePipeline.persistParked(db, payload, erro);
}

/**
 * The `onTaskDispatched` handler body, extracted so the throw/persist
 * disposition is unit-testable. `retryCount` is the Cloud Tasks attempt index
 * (0-based); on the FINAL attempt a transient failure is persisted instead of
 * re-thrown so the sweep can re-drive it.
 */
export async function handleNotificationTask(
  db: Firestore,
  data: unknown,
  retryCount: number,
  deps: ShopeeProcessDeps = defaultProcessDeps,
): Promise<TaskResult> {
  const r = await pipelineFor(deps).handleTask(db, data, retryCount);
  // Structural `in` checks rather than an arm enumeration: an equality narrow
  // silently stops covering an arm the moment another one gains the field.
  const detail = r.result && 'detail' in r.result ? r.result.detail : null;
  const lojas = r.result && 'lojas' in r.result ? r.result.lojas : null;
  const shopId = r.payload?.shopId ?? (r.result && 'shopId' in r.result ? r.result.shopId : null);
  const orderSn = r.result && 'orderSn' in r.result ? r.result.orderSn : null;
  const itensSemProduto =
    r.result && 'itensSemProduto' in r.result ? r.result.itensSemProduto : null;
  return {
    outcome: r.outcome,
    ...(r.payload ? { code: r.payload.code } : {}),
    ...(shopId != null ? { shopId } : {}),
    ...(r.result ? { kind: r.result.kind } : {}),
    ...(detail != null ? { detail } : {}),
    ...(lojas != null ? { lojas } : {}),
    ...(orderSn != null ? { orderSn } : {}),
    ...(itensSemProduto != null ? { itensSemProduto } : {}),
  };
}

/** The `onSchedule` backstop over the HOT lane (`failed`, hourly window). */
export function reprocessNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  deps: ShopeeProcessDeps = defaultProcessDeps,
): Promise<ReprocessResult> {
  return pipelineFor(deps).reprocess(db, opts);
}

/** The `onSchedule` backstop over the DEFERRED lane (`deferred`, daily window). */
export function reprocessDeferredNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  deps: ShopeeProcessDeps = defaultProcessDeps,
): Promise<ReprocessResult> {
  return pipelineFor(deps).reprocessDeferred(db, opts);
}
