/**
 * Mercado Livre webhook ingestion core (Step 6) — the queue-based resilient
 * pipeline shared by the receiver route, the `onTaskDispatched` task handler,
 * and the `onSchedule` reprocess sweep.
 *
 * Flow (see the receiver route + functions/DEPLOY.md):
 *   1. the receiver validates the raw ML POST (`parseNotificationBody`) and
 *      ENQUEUES the lean payload onto the Cloud Tasks queue — acking 200 fast
 *      WITHOUT writing Firestore on the happy path;
 *   2. `handleNotificationTask` (the queued task) resolves the owning integração
 *      by ML `user_id` and dispatches by topic, controlling the ML API call rate
 *      via the queue's `rateLimits`;
 *   3. a document is persisted to `notificacoesMercadoLivre` ONLY when the
 *      notification can't be processed (retries exhausted / no account yet /
 *      unknown topic);
 *   4. `reprocessNotifications` (the sweep) re-drives persisted `failed` docs and
 *      deletes them on success.
 *
 * Disposition (`handleNotificationTask`):
 *  - `done`     — a known topic was processed: NOTHING is persisted. The `items`
 *                 topic runs the status-sync (#440); `orders_v2`/`orders` run the
 *                 Step 9 order→pedido import (see `runOrderImport` below);
 *                 `payments`/`shipments` run the Step 9 PR 3 payment/shipment
 *                 sync onto an already-imported pedido (see `runPaymentImport`/
 *                 `runShipmentImport` below); `claims` runs the Step 14 claim →
 *                 incidente/conversa import (see `runClaimImport` below); the
 *                 remaining topics (items_prices/orders_feedback/questions/
 *                 messages/stock-location) are no-ops — `items_prices`
 *                 PERMANENTLY so (#803, see `KNOWN_TOPICS`), the rest until
 *                 their per-topic handlers land in later steps;
 *  - transient  — a transient infra failure (Firestore/ML API/network) THROWS so
 *                 the queue retries with backoff; on the FINAL attempt it persists
 *                 `failed` (so the sweep re-drives it) instead of throwing;
 *  - `failed`   — no active integração for the seller yet: persisted immediately
 *                 (retrying in-task can't help within the backoff window; the
 *                 sweep re-drives it when the account connects, up to the cap);
 *  - `parked`   — an unsupported topic (terminal, never re-driven);
 *  - `dropped`  — a malformed task payload (a coding/enqueue bug — logged, no
 *                 persist, no retry).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { millisToMicros } from '@delfrance/core/datetime';
import {
  createMercadoLivreApi,
  MercadoLivreHttpError,
} from '@delfrance/integrations-mercado-livre';
import {
  integracaoCollection,
  notificacaoMercadoLivreCollection,
} from '@delfrance/data/admin/collections';
import {
  asMillis,
  defineNotificationPipeline,
  MAX_TENTATIVAS,
  type NotificationDisposition,
  type ReprocessOptions,
  type ReprocessResult,
  TASK_MAX_ATTEMPTS,
} from '@delfrance/data/admin/notifications';

import { tryGetAdminBucket } from '../firebase/admin';
import {
  type ItemsApiResolver,
  type MigrationRunner,
  resolveItemsApiFromContext,
  syncItemStatus,
} from './itemsStatusSync';
import { type ClaimImportResult, importClaimMercadoLivre } from './claimImport';
import { handleUptinMigration } from './importMigration';
import { lastSegment, parseItemIdFromResource } from './linkRefs';
import { loadMercadoLivreContext } from './mercadoLivre';
import { type OrderImportResult, importPedidoMercadoLivre } from './orderImport';
import { type PaymentImportResult, importPagamentoMercadoLivre } from './orderPaymentImport';
import { type ShipmentImportResult, importShipmentMercadoLivre } from './orderShipmentImport';

/**
 * The deployed `onTaskDispatched` function name — which is ALSO its
 * auto-provisioned Cloud Tasks queue name. Single source of truth, shared by the
 * producer (`mlTasks.ts` builds the region-qualified queue path from it) and the
 * consumer (`functions/src/processNotification.ts` — the `export const` there
 * MUST be named exactly this). Lives in this neutral shared module because the
 * app cannot import the functions-trigger file (that would pull the Functions SDK
 * into the Next bundle and run `onTaskDispatched` at load). Rename in BOTH places.
 */
export const MERCADO_LIVRE_NOTIFICATION_QUEUE = 'processMercadoLivreNotification';

// The retry caps and the reprocess window are the SHARED pipeline's — re-exported
// here so this module stays the one import site for the channel's callers.
export { MAX_TENTATIVAS, TASK_MAX_ATTEMPTS };
export type { ReprocessOptions, ReprocessResult };

/**
 * The ML notification topics the pipeline recognizes. A known topic is processed
 * (no-op until its handler exists); a genuinely-unknown topic parks.
 * (`questions`/`messages` are recognized but postponed per the port plan.)
 *
 * ⚠️ `items_prices` MUST stay in this set even though it has no handler and,
 * per #803, never will: **the ERP owns both price tables** — Mercado Livre is
 * not a writer of `produto.precos`. Membership here is what makes an
 * `items_prices` delivery ack `done` and persist NOTHING; dropping it from the
 * set instead routes it to `unknown-topic`, which PARKS a
 * `notificacaoMercadoLivre` document on EVERY delivery. Unsubscribing the topic
 * in the ML application manager stops the traffic at the source, but it is a
 * panel checkbox anyone can flip back (and `missed_feeds` replays), so this arm
 * is the durable half of the fix. Do not re-attach a handler here.
 */
export const KNOWN_TOPICS: ReadonlySet<string> = new Set([
  'orders_v2',
  'orders',
  'items',
  'shipments',
  'payments',
  'items_prices',
  'claims',
  'orders_feedback',
  'questions',
  'messages',
  'stock-location',
]);

export function isKnownTopic(topic: string): boolean {
  return KNOWN_TOPICS.has(topic);
}

/**
 * The lean ML-wire payload the receiver enqueues onto the task queue and the
 * task handler re-validates (belt-and-suspenders across the wire boundary).
 * Tolerant (`passthrough`, nullable) — ML silently renames/adds fields. `sent`
 * / `received` are already normalized to epoch millis (or null) by `asMillis`
 * before enqueue, so a persisted failure doc can never be rejected on them.
 */
export const mlNotificationTaskSchema = z
  .object({
    id: z.string().nullable().default(null),
    resource: z.string().min(1),
    topic: z.string().min(1),
    user_id: z.number().int().nullable().default(null),
    application_id: z.number().int().nullable().default(null),
    attempts: z.number().int().nullable().default(null),
    sent: z.number().nullable().default(null),
    received: z.number().nullable().default(null),
  })
  .passthrough();
export type MlNotificationPayload = z.infer<typeof mlNotificationTaskSchema>;

/** The receiver-side extraction of a raw ML POST body. */
export interface ParsedNotification {
  /** ML notification id (`_id`/`id`) — dedup/doc key hint (null ⇒ auto-id). */
  id: string | null;
  /** The lean payload enqueued onto the task queue. */
  payload: MlNotificationPayload;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}
// `asMillis` (ML's `sent`/`received`, ISO-8601 or epoch millis) is the shared
// receiver coercer from `@delfrance/data/admin/notifications` — normalized at the
// source so a persisted failure doc can never be rejected by the strict write
// validator. ML sometimes sends an empty string or a field it later renames.

/**
 * Extract a persistable notification from the raw ML POST body. Returns null
 * for noise (non-object, or missing `topic`/`resource` — health pings and
 * malformed bodies) so the receiver can ack without enqueuing. Accepts both
 * `_id` (webhook / missed_feeds) and `id` (realtime) as the notification id.
 */
export function parseNotificationBody(raw: unknown): ParsedNotification | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const resource = asString(o.resource);
  const topic = asString(o.topic);
  if (!resource || !topic) return null;

  const id = asString(o._id) ?? asString(o.id);
  return {
    id,
    payload: {
      id,
      resource,
      topic,
      user_id: asInt(o.user_id),
      application_id: asInt(o.application_id),
      attempts: asInt(o.attempts),
      sent: asMillis(o.sent),
      received: asMillis(o.received),
    },
  };
}

/**
 * Resolve the owning integração id from the ML seller `user_id` — a single
 * equality query over the denormalized `user_id` field (the old
 * `getContaMercadoLivreByUser_id`: tipo == mercadoLivre, ativo). Returns null
 * when no active account maps to the seller (a `failed`/`parked` outcome, not
 * a throw). A transient Firestore failure here propagates (throws) so the caller
 * treats it as retryable.
 */
export async function resolveIntegracaoByUserId(
  db: Firestore,
  userId: number | null,
): Promise<string | null> {
  if (userId == null) return null;
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .where('user_id', '==', userId)
    .where('ativo', '==', true)
    .limit(1)
    .get();
  return snap.docs[0]?.id ?? null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The production #441 migration runner: loads the account's live ML API (same
 * seller-token path as `resolveItemsApiFromContext`) plus the price-table /
 * deposit refs the import needs (mirrors the `/importar` route's narrowing),
 * then runs the UP-migration takeover. Wired as `processNotificationPayload`'s
 * default so an ordinary `items` notification needs no caller change; tests
 * inject their own runner.
 */
const runUptinMigration: MigrationRunner = async (db, integracaoId, itemId, sourceLink) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
  await handleUptinMigration(
    {
      db,
      api,
      integracaoId,
      sellerUserId: asNumberOrNull(ctx.conta.user_id),
      tabelaNormalOuterRef: asStringOrNull(ctx.conta.tabelaNormalOuterRef),
      depositoOuterRef: asStringOrNull(ctx.conta.depositoOuterRef),
    },
    itemId,
    sourceLink,
  );
};

/**
 * The Step 9 order-import seam invoked for `orders_v2`/`orders` notifications —
 * shaped exactly like `MigrationRunner` (topic handler → typed runner,
 * injectable for tests, defaulted to the real ML-context-backed impl below).
 * `resourceId` is the numeric ML id parsed from the notification's `resource`;
 * it may name either an order or a pack — `importPedidoMercadoLivre`
 * disambiguates internally (legacy tasks.dart:387-393's get_order-404-as-pack
 * fallback), so the dispatcher never needs to know which.
 */
export type OrderImportRunner = (
  db: Firestore,
  integracaoId: string,
  resourceId: number,
) => Promise<OrderImportResult>;

/**
 * The production Step 9 order importer: loads the account's live ML API (same
 * seller-token path as `resolveItemsApiFromContext` / `runUptinMigration`) and
 * calls A3's `importPedidoMercadoLivre` with ONE clock read for the whole
 * operation (µs + ms threaded together from a single `Date.now()`, never
 * re-read downstream). Wired as `processNotificationPayload`'s default for
 * `orders_v2`/`orders` so an ordinary notification needs no caller change;
 * tests inject their own runner.
 */
const runOrderImport: OrderImportRunner = async (db, integracaoId, resourceId) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
  const nowMs = Date.now();
  const nowUs = millisToMicros(nowMs);
  return importPedidoMercadoLivre({ db, api, integracaoId, nowUs, nowMs }, resourceId);
};

/**
 * The Step 9 PR 3 payment-sync seam invoked for `payments` notifications —
 * shaped exactly like `OrderImportRunner` (topic handler → typed runner,
 * injectable for tests, defaulted to the real ML-context-backed impl below).
 * `resourceId` is the numeric ML payment id parsed from the notification's
 * `resource` (`/payments/123` → `123`).
 */
export type PaymentImportRunner = (
  db: Firestore,
  integracaoId: string,
  resourceId: number,
) => Promise<PaymentImportResult>;

/**
 * The production Step 9 PR 3 payment importer: loads the account's live ML API
 * (same seller-token path as `runOrderImport`) and calls the payment-import
 * handler with ONE clock read for the whole operation (µs threaded from a
 * single `Date.now()`, never re-read downstream). Wired as
 * `processNotificationPayload`'s default for `payments` so an ordinary
 * notification needs no caller change; tests inject their own runner.
 */
const runPaymentImport: PaymentImportRunner = async (db, integracaoId, resourceId) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
  const nowMs = Date.now();
  const nowUs = millisToMicros(nowMs);
  return importPagamentoMercadoLivre({ db, api, contaId: integracaoId, nowUs }, resourceId);
};

/**
 * The Step 9 PR 3 shipment-sync seam invoked for `shipments` notifications —
 * shaped exactly like `OrderImportRunner`/`PaymentImportRunner` (topic handler
 * → typed runner, injectable for tests, defaulted to the real
 * ML-context-backed impl below). `resourceId` is the numeric ML shipment id
 * parsed from the notification's `resource` (`/shipments/123` → `123`).
 */
export type ShipmentImportRunner = (
  db: Firestore,
  integracaoId: string,
  resourceId: number,
) => Promise<ShipmentImportResult>;

/**
 * The production Step 9 PR 3 shipment importer: loads the account's live ML
 * API (same seller-token path as `runOrderImport`/`runPaymentImport`) and
 * calls the shipment-import handler with ONE clock read for the whole
 * operation (µs threaded from a single `Date.now()`, never re-read
 * downstream). Wired as `processNotificationPayload`'s default for `shipments`
 * so an ordinary notification needs no caller change; tests inject their own
 * runner.
 */
const runShipmentImport: ShipmentImportRunner = async (db, integracaoId, resourceId) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
  const nowMs = Date.now();
  const nowUs = millisToMicros(nowMs);
  return importShipmentMercadoLivre({ db, api, integracaoId, nowUs }, resourceId);
};

/**
 * The Step 14 claims-import seam invoked for `claims` notifications — shaped
 * exactly like `OrderImportRunner` (topic handler → typed runner, injectable
 * for tests, defaulted to the real ML-context-backed impl below). `resourceId`
 * is the numeric ML claim id parsed from the notification's `resource`
 * (`/claims/123` → `123`).
 */
export type ClaimImportRunner = (
  db: Firestore,
  integracaoId: string,
  resourceId: number,
) => Promise<ClaimImportResult>;

/**
 * The production Step 14 claim importer: loads the account's live ML API
 * (same seller-token path as `runOrderImport`) and calls the claim-import
 * handler with ONE clock read for the whole operation (µs + ms threaded
 * together from a single `Date.now()`, never re-read downstream), the conta's
 * ML seller id + etiqueta color, and the Storage bucket for attachment
 * Arquivos (`tryGetAdminBucket` — null degrades to skip-attachments inside
 * the handler rather than failing the claim). Wired as
 * `processNotificationPayload`'s default for `claims` so an ordinary
 * notification needs no caller change; tests inject their own runner.
 */
const runClaimImport: ClaimImportRunner = async (db, integracaoId, resourceId) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
  const nowMs = Date.now();
  const nowUs = millisToMicros(nowMs);
  return importClaimMercadoLivre(
    {
      db,
      api,
      integracaoId,
      conta: {
        userId: asNumberOrNull(ctx.conta.user_id),
        cor: asNumberOrNull(ctx.conta.cor),
      },
      nowUs,
      nowMs,
      bucket: tryGetAdminBucket(),
    },
    resourceId,
  );
};

/**
 * The ML order/pack/payment/shipment/claim id from a notification `resource`
 * (`/orders/123` / `/payments/123` / `/shipments/123` / `/claims/123` →
 * `123`). Tolerates a
 * bare numeric id with no path segments (`lastSegment` falls back to the whole
 * string when there's no `/`). Anything non-numeric — a coding bug or an
 * ML-side anomaly, never seen in practice — is malformed: the caller drops it
 * rather than dispatching a bogus import.
 */
function parseOrderResourceId(resource: string): number | null {
  const last = lastSegment(resource);
  if (!/^\d+$/.test(last)) return null;
  return Number(last);
}

/**
 * Wrapper for topic-specific runners (order/payment/shipment/claim import) that
 * catches ML 500 errors (N7) and converts them to a non-retryable outcome
 * instead of throwing. A known routine ML-side transient (HTTP 500) should not
 * consume the full retry envelope — persist immediately as `failed` with a note
 * that it's an ML-side issue, and the sweep re-drives it up to the cap.
 */
async function wrapImportRunner<T extends { skipped?: unknown }>(
  integracaoId: string,
  runner: () => Promise<T>,
): Promise<T | { skipped: 'ML_500'; message: string }> {
  try {
    return await runner();
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 500) {
      console.warn('[mercado-livre] import runner hit ML 500 — not retrying', {
        integracaoId,
        message: err.message,
      });
      return { skipped: 'ML_500', message: err.message } as any;
    }
    throw err;
  }
}

/** Deterministic result of processing one payload (transient failures THROW). */
export type ProcessOutcome =
  | { kind: 'done'; integracaoId: string } // known topic processed
  | { kind: 'no-account' } // no active integração for the seller
  | { kind: 'unknown-topic'; integracaoId: string } // unsupported topic
  | { kind: 'malformed-resource'; integracaoId: string } // orders_v2/orders/payments/shipments/claims resource had no parseable id
  | { kind: 'ml-500'; integracaoId: string; message: string }; // known routine ML 500 (N7) — non-retryable

/**
 * The per-topic runner seams the dispatch pipeline threads — ONE options bag
 * (each seam falls back to its production default when omitted) shared by the
 * three entry points (`processNotificationPayload` / `handleNotificationTask`
 * / `reprocessNotifications`). Production call sites pass nothing; tests
 * override only the seam under test.
 */
export interface NotificationRunners {
  resolveItemsApi?: ItemsApiResolver;
  migrationRunner?: MigrationRunner;
  orderImportRunner?: OrderImportRunner;
  paymentImportRunner?: PaymentImportRunner;
  shipmentImportRunner?: ShipmentImportRunner;
  claimImportRunner?: ClaimImportRunner;
}

/**
 * Process one notification payload — resolve the account, dispatch by topic.
 * Pure of the notification doc: it reads the integração (not a persisted
 * notification), so it works identically for a fresh queued task and a sweep
 * re-drive. Deterministic outcomes RETURN; a transient failure (Firestore / ML
 * API / network) THROWS so the queue/sweep retry.
 */
export async function processNotificationPayload(
  db: Firestore,
  payload: MlNotificationPayload,
  runners: NotificationRunners = {},
): Promise<ProcessOutcome> {
  const resolveItemsApi = runners.resolveItemsApi ?? resolveItemsApiFromContext;
  const migrationRunner = runners.migrationRunner ?? runUptinMigration;
  const orderImportRunner = runners.orderImportRunner ?? runOrderImport;
  const paymentImportRunner = runners.paymentImportRunner ?? runPaymentImport;
  const shipmentImportRunner = runners.shipmentImportRunner ?? runShipmentImport;
  const claimImportRunner = runners.claimImportRunner ?? runClaimImport;

  const integracaoId = await resolveIntegracaoByUserId(db, payload.user_id ?? null);
  if (!integracaoId) return { kind: 'no-account' };
  if (!isKnownTopic(payload.topic)) return { kind: 'unknown-topic', integracaoId };

  // `items` — status-sync of an already-linked listing (#440), including the
  // #441 UP-migration takeover for a closed `variations_migration_source`
  // listing. THROWS on a transient failure (so the queue/sweep retry) and is
  // idempotent, keyed by the item id. A malformed resource (no id segment) is
  // deterministic → drop it, logged explicitly (matches the behavior of other
  // topics below).
  if (payload.topic === 'items') {
    const itemId = parseItemIdFromResource(payload.resource);
    if (!itemId) return { kind: 'malformed-resource', integracaoId };
    // The resolver is threaded (not a pre-built API) so syncItemStatus can go
    // link-first and skip the ML call entirely for an unlinked item.
    await syncItemStatus(db, integracaoId, itemId, resolveItemsApi, migrationRunner);
    return { kind: 'done', integracaoId };
  }

  // `orders_v2` (and the legacy alias `orders`) — order → pedido import (Step 9).
  // Idempotent, keyed by the ML order/pack id (A2's discover-or-create
  // transaction inside `importPedidoMercadoLivre`). THROWS on a transient
  // failure (ML API / Firestore / network) so the queue/sweep retry. A
  // seller-mismatch or buyer-less order is a deterministic drop (legacy
  // tasks.dart:363-787) — logged, still acked `done`. A resource with no
  // parseable numeric id is malformed: dropped WITHOUT dispatching a bogus
  // import (mirrors the top-level schema-parse drop — no persist, no retry).
  // ML 500 errors (N7) are caught and converted to non-retryable outcomes.
  if (payload.topic === 'orders_v2' || payload.topic === 'orders') {
    const resourceId = parseOrderResourceId(payload.resource);
    if (resourceId == null) return { kind: 'malformed-resource', integracaoId };
    const result = await wrapImportRunner(integracaoId, () =>
      orderImportRunner(db, integracaoId, resourceId),
    );
    if (result.skipped === 'ML_500') {
      return { kind: 'ml-500', integracaoId, message: (result as any).message };
    }
    if (result.skipped) {
      console.warn('[mercado-livre] order import skipped', {
        integracaoId,
        resourceId,
        skipped: result.skipped,
      });
    }
    return { kind: 'done', integracaoId };
  }

  // `payments` — payment status/amount sync onto an already-imported pedido's
  // embedded pagamento (Step 9 PR 3). Idempotent, keyed by the ML payment id
  // (`makePagamentoIdMercadoLivre`). THROWS on a transient failure (ML API /
  // Firestore / network) so the queue/sweep retry. A permanently-404 payment,
  // a `marketplace === NONE` payment, an order/pack that resolves to no
  // pedido, or a stale update are deterministic skips (logged), still acked
  // `done`. A resource with no parseable numeric id is malformed: dropped
  // WITHOUT dispatching a bogus import (mirrors the orders_v2 malformed-
  // resource drop above). ML 500 errors (N7) are caught and converted to
  // non-retryable outcomes.
  if (payload.topic === 'payments') {
    const resourceId = parseOrderResourceId(payload.resource);
    if (resourceId == null) return { kind: 'malformed-resource', integracaoId };
    const result = await wrapImportRunner(integracaoId, () =>
      paymentImportRunner(db, integracaoId, resourceId),
    );
    if (result.skipped === 'ML_500') {
      return { kind: 'ml-500', integracaoId, message: (result as any).message };
    }
    if (result.skipped) {
      console.warn('[mercado-livre] payment import skipped', {
        integracaoId,
        resourceId,
        skipped: result.skipped,
      });
    }
    return { kind: 'done', integracaoId };
  }

  // `shipments` — shipment/freteInicial status sync onto an already-imported
  // pedido (Step 9 PR 3). Idempotent (staleness-gated merge into the pedido's
  // `freteInicial`). THROWS on a transient failure (ML API / Firestore /
  // network) so the queue/sweep retry. A permanently-404 shipment, a shipment
  // with no order id, an order/pack that resolves to no pedido, a pedido with
  // no `freteInicial` yet (only the order-import path creates it), or a stale
  // update are deterministic skips (logged), still acked `done`. A resource
  // with no parseable numeric id is malformed: dropped WITHOUT dispatching a
  // bogus import. ML 500 errors (N7) are caught and converted to
  // non-retryable outcomes.
  if (payload.topic === 'shipments') {
    const resourceId = parseOrderResourceId(payload.resource);
    if (resourceId == null) return { kind: 'malformed-resource', integracaoId };
    const result = await wrapImportRunner(integracaoId, () =>
      shipmentImportRunner(db, integracaoId, resourceId),
    );
    if (result.skipped === 'ML_500') {
      return { kind: 'ml-500', integracaoId, message: (result as any).message };
    }
    if (result.skipped) {
      console.warn('[mercado-livre] shipment import skipped', {
        integracaoId,
        resourceId,
        skipped: result.skipped,
      });
    }
    return { kind: 'done', integracaoId };
  }

  // `claims` — claim → incidente/conversa/mensagens import (Step 14).
  // Idempotent, keyed by the byte-exact legacy doc ids (`claimIds.ts`).
  // THROWS on a transient failure (ML API / Firestore / network) so the
  // queue/sweep retry. A 404'd claim, an unsupported resource, an
  // unresolvable pedido, a seller-side complaint, or a cliente-less pedido
  // are deterministic skips (logged inside the handler and here), still
  // acked `done` — a retry cannot fix any of them. A resource with no
  // parseable numeric id is malformed: dropped WITHOUT dispatching a bogus
  // import (mirrors the orders_v2 malformed-resource drop above). ML 500
  // errors (N7) are caught and converted to non-retryable outcomes.
  if (payload.topic === 'claims') {
    const resourceId = parseOrderResourceId(payload.resource);
    if (resourceId == null) return { kind: 'malformed-resource', integracaoId };
    const result = await wrapImportRunner(integracaoId, () =>
      claimImportRunner(db, integracaoId, resourceId),
    );
    if (result.skipped === 'ML_500') {
      return { kind: 'ml-500', integracaoId, message: (result as any).message };
    }
    if (result.skipped) {
      console.warn('[mercado-livre] claim import skipped', {
        integracaoId,
        resourceId,
        skipped: result.skipped,
      });
    }
    return { kind: 'done', integracaoId };
  }

  // Other known topics, acked with NOTHING persisted. Two different reasons:
  //
  //  - `items_prices` is a PERMANENT no-op (#803). The ERP owns both price
  //    tables — Mercado Livre is not a writer of `produto.precos` — so there is
  //    nothing to do with a price notification. It stays a KNOWN topic purely
  //    so it lands here instead of parking a document per delivery; see
  //    `KNOWN_TOPICS`. Do not add a handler for it.
  //  - orders_feedback/questions/messages/stock-location: their per-topic
  //    handlers land in later steps; here the foundation acks them so the
  //    pipeline is exercisable end-to-end. A future handler MUST THROW on a
  //    transient failure (so the queue/sweep retry) and be idempotent keyed by
  //    the ML resource id — it must never fall through to a silent success.
  return { kind: 'done', integracaoId };
}

export interface TaskResult {
  outcome: 'done' | 'failed' | 'parked' | 'dropped';
  integracaoId?: string;
  topic?: string;
}
/** The operator-facing reason for a seller that maps to no active integração. */
function noAccountReason(payload: MlNotificationPayload): string {
  return `integração ativa do Mercado Livre não encontrada para user_id ${payload.user_id}`;
}

/**
 * The shared pipeline, bound to this channel. Built per call so the injectable
 * runners (`NotificationRunners`) stay per-call (the factory only closes over
 * config — no I/O, no state); defaults resolve inside
 * `processNotificationPayload`.
 *
 * ⭐ This channel is the reason `toDisposition` takes a PHASE. `malformed-resource`
 * is terminal either way, but the right terminal action differs by stage:
 *  - in the TASK no document exists yet, and one is not worth creating for a
 *    coding/ML-side anomaly, so it DROPS (mirroring the schema-parse drop, just
 *    discovered a layer deeper, after account and topic are already known);
 *  - in the SWEEP a document already exists, and it is PARKED rather than
 *    deleted — an unparseable resource will never become parseable on a later
 *    sweep, so parking keeps the audit row instead of silently discarding it,
 *    and avoids bumping `tentativas` under the misleading no-account message.
 * Collapsing the two phases would make the sweep start deleting rows it parks today.
 */
function pipelineFor(runners: NotificationRunners = {}) {
  return defineNotificationPipeline<MlNotificationPayload, ProcessOutcome>({
    channel: 'mercado-livre',
    collection: notificacaoMercadoLivreCollection,
    taskSchema: mlNotificationTaskSchema,
    docIdOf: (p) => p.id,
    dedupKeyOf: (p) => p.resource,
    // Spread the whole payload: this channel's schema is `.passthrough()`, so a
    // field ML adds without telling us still rides along onto the failure doc.
    toDocFields: (p) => ({ ...p }),
    fromDoc: (parsed) => {
      const doc = parsed as MlNotificationPayload;
      // Validate that required fields are present; a concurrent delete that
      // removes channel fields would create a ghost document with undefined
      // payload fields downstream (N6).
      if (!doc.resource || !doc.topic) {
        throw new Error(
          `Notificação mercado-livre corrompida: campos obrigatórios ausentes (resource: ${doc.resource}, topic: ${doc.topic})`,
        );
      }
      return {
        id: doc.id,
        resource: doc.resource,
        topic: doc.topic,
        user_id: doc.user_id,
        application_id: doc.application_id,
        attempts: doc.attempts,
        sent: doc.sent,
        received: doc.received,
      };
    },
    process: (db, payload) => processNotificationPayload(db, payload, runners),
    toDisposition: (outcome, payload, phase): NotificationDisposition => {
      if (outcome.kind === 'no-account') return { kind: 'fail', reason: noAccountReason(payload) };
      if (outcome.kind === 'unknown-topic') {
        return { kind: 'park', reason: `tópico não suportado: ${payload.topic}` };
      }
      if (outcome.kind === 'malformed-resource') {
        if (phase === 'sweep') {
          return { kind: 'park', reason: `resource malformado: ${payload.resource}` };
        }
        console.warn('[mercado-livre] notification DROPPED — unparseable resource', {
          id: payload.id,
          resource: payload.resource,
          topic: payload.topic,
        });
        return { kind: 'drop' };
      }
      if (outcome.kind === 'ml-500') {
        // ML 500 errors (N7) are known routine transients — don't retry immediately,
        // persist as failed and let the sweep re-drive it up to the cap with backoff.
        return {
          kind: 'fail',
          reason: `ML API retornou 500 (não é erro do cliente): ${outcome.message}`,
        };
      }
      return { kind: 'resolve' }; // done
    },
  });
}

const basePipeline = pipelineFor();

/**
 * Persist a notification as `failed` (the sweep will re-drive it). The receiver
 * also calls this as a fallback when the enqueue itself fails, so ML never sees
 * a 5xx during an enqueue-path outage (which could disable the topic).
 */
export function persistNotificationFailure(
  db: Firestore,
  payload: MlNotificationPayload,
  erro: string,
): Promise<void> {
  return basePipeline.persistFailure(db, payload, erro);
}

/**
 * The `onTaskDispatched` handler body, extracted so the throw/persist
 * disposition is unit-testable. `retryCount` is the Cloud Tasks attempt index
 * (0-based); on the FINAL attempt a transient failure is persisted instead of
 * re-thrown so the sweep can re-drive it (the queue would otherwise drop it).
 *
 * The injectable runners travel as ONE `NotificationRunners` options object
 * (each key optional, defaults resolved inside `processNotificationPayload`) —
 * production call sites pass nothing.
 */
export async function handleNotificationTask(
  db: Firestore,
  data: unknown,
  retryCount: number,
  runners: NotificationRunners = {},
): Promise<TaskResult> {
  const r = await pipelineFor(runners).handleTask(db, data, retryCount);
  // `payload` is absent only on the schema-parse drop, where there is no topic
  // to report; `result` is absent on the transient-failure path. `no-account`
  // carries no integração id — it is precisely the outcome where none resolved.
  const integracaoId = r.result && r.result.kind !== 'no-account' ? r.result.integracaoId : null;
  return {
    outcome: r.outcome,
    ...(integracaoId != null ? { integracaoId } : {}),
    ...(r.payload ? { topic: r.payload.topic } : {}),
  };
}

/**
 * The `onSchedule` reprocess backstop — re-drives persisted `failed`
 * notifications older than the window (a `failed` account may have connected, or
 * a transient outage has cleared). Success DELETES the doc (failures-only store);
 * a persistent no-account/transient bumps `tentativas` up to `MAX_TENTATIVAS`,
 * then parks. Deduplicated by `resource` within a run (the old `jaFeito` set),
 * bounded, and ISOLATED per-doc so one failure never aborts the batch. Inline
 * (not re-enqueued): the sweep is already rate-limited by its schedule + the
 * `limit` cap, and inline avoids Cloud Tasks task-name dedup-window collisions.
 * The caller logs the returned counts/errors.
 */
export function reprocessNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  runners: NotificationRunners = {},
): Promise<ReprocessResult> {
  return pipelineFor(runners).reprocess(db, opts);
}
