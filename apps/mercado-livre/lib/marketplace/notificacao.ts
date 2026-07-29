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
 *                 `runShipmentImport` below); the remaining topics
 *                 (items_prices/claims/orders_feedback/questions/messages/
 *                 stock-location) are no-ops until their per-topic handlers
 *                 land in later steps;
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
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import {
  integracaoCollection,
  notificacaoMercadoLivreCollection,
} from '@delfrance/data/admin/collections';

import { isAlreadyExists } from './grpcErrors';
import {
  type ItemsApiResolver,
  type MigrationRunner,
  resolveItemsApiFromContext,
  syncItemStatus,
} from './itemsStatusSync';
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

/** In-task retry cap — the Cloud Tasks `retryConfig.maxAttempts` (kept in sync). */
export const TASK_MAX_ATTEMPTS = 3;

/** Cross-sweep reprocess cap — after this many sweeps a `failed` doc is parked. */
export const MAX_TENTATIVAS = 5;

/**
 * The ML notification topics the pipeline recognizes. A known topic is processed
 * (no-op until its handler exists); a genuinely-unknown topic parks.
 * (`questions`/`messages` are recognized but postponed per the port plan.)
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
/**
 * Coerce an ML timestamp (`sent`/`received`, ISO-8601 or epoch millis) to epoch
 * millis or null — NORMALIZED at the source so a persisted failure doc can never
 * be rejected by the strict write validator. ML sometimes sends an empty string
 * or a value it later renames; anything unparseable becomes null (the field is
 * informational and the sweep gates on the local `processedAt`, not on these).
 */
function asMillis(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const iso = Date.parse(s); // ISO-8601
    if (Number.isFinite(iso)) return iso;
    const n = Number(s); // numeric string (epoch millis)
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

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
      tabelaPromocionalOuterRef: asStringOrNull(ctx.conta.tabelaPromocionalOuterRef),
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
 * The ML order/pack/payment/shipment id from a notification `resource`
 * (`/orders/123` / `/payments/123` / `/shipments/123` → `123`). Tolerates a
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

/** Deterministic result of processing one payload (transient failures THROW). */
export type ProcessOutcome =
  | { kind: 'done'; integracaoId: string } // known topic processed
  | { kind: 'no-account' } // no active integração for the seller
  | { kind: 'unknown-topic'; integracaoId: string } // unsupported topic
  | { kind: 'malformed-resource'; integracaoId: string }; // orders_v2/orders/payments/shipments resource had no parseable id

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
  resolveItemsApi: ItemsApiResolver = resolveItemsApiFromContext,
  migrationRunner: MigrationRunner = runUptinMigration,
  orderImportRunner: OrderImportRunner = runOrderImport,
  paymentImportRunner: PaymentImportRunner = runPaymentImport,
  shipmentImportRunner: ShipmentImportRunner = runShipmentImport,
): Promise<ProcessOutcome> {
  const integracaoId = await resolveIntegracaoByUserId(db, payload.user_id ?? null);
  if (!integracaoId) return { kind: 'no-account' };
  if (!isKnownTopic(payload.topic)) return { kind: 'unknown-topic', integracaoId };

  // `items` — status-sync of an already-linked listing (#440), including the
  // #441 UP-migration takeover for a closed `variations_migration_source`
  // listing. THROWS on a transient failure (so the queue/sweep retry) and is
  // idempotent, keyed by the item id. A malformed resource (no id segment) is
  // deterministic → ack it.
  if (payload.topic === 'items') {
    const itemId = parseItemIdFromResource(payload.resource);
    // The resolver is threaded (not a pre-built API) so syncItemStatus can go
    // link-first and skip the ML call entirely for an unlinked item.
    if (itemId) await syncItemStatus(db, integracaoId, itemId, resolveItemsApi, migrationRunner);
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
  if (payload.topic === 'orders_v2' || payload.topic === 'orders') {
    const resourceId = parseOrderResourceId(payload.resource);
    if (resourceId == null) return { kind: 'malformed-resource', integracaoId };
    const result = await orderImportRunner(db, integracaoId, resourceId);
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
  // resource drop above).
  if (payload.topic === 'payments') {
    const resourceId = parseOrderResourceId(payload.resource);
    if (resourceId == null) return { kind: 'malformed-resource', integracaoId };
    const result = await paymentImportRunner(db, integracaoId, resourceId);
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
  // bogus import.
  if (payload.topic === 'shipments') {
    const resourceId = parseOrderResourceId(payload.resource);
    if (resourceId == null) return { kind: 'malformed-resource', integracaoId };
    const result = await shipmentImportRunner(db, integracaoId, resourceId);
    if (result.skipped) {
      console.warn('[mercado-livre] shipment import skipped', {
        integracaoId,
        resourceId,
        skipped: result.skipped,
      });
    }
    return { kind: 'done', integracaoId };
  }

  // Other known topics (items_prices/claims/orders_feedback/questions/
  // messages/stock-location): their per-topic handlers land in later steps;
  // here the foundation acks them so the pipeline is exercisable end-to-end. A
  // future handler MUST THROW on a transient failure (so the queue/sweep
  // retry) and be idempotent keyed by the ML resource id — it must never fall
  // through to a silent success.
  return { kind: 'done', integracaoId };
}

export interface TaskResult {
  outcome: 'done' | 'failed' | 'parked' | 'dropped';
  integracaoId?: string;
  topic?: string;
}

/**
 * The `onTaskDispatched` handler body, extracted so the throw/persist
 * disposition is unit-testable. `retryCount` is the Cloud Tasks attempt index
 * (0-based); on the FINAL attempt a transient failure is persisted instead of
 * re-thrown so the sweep can re-drive it (the queue would otherwise drop it).
 */
export async function handleNotificationTask(
  db: Firestore,
  data: unknown,
  retryCount: number,
  resolveItemsApi: ItemsApiResolver = resolveItemsApiFromContext,
  migrationRunner: MigrationRunner = runUptinMigration,
  orderImportRunner: OrderImportRunner = runOrderImport,
  paymentImportRunner: PaymentImportRunner = runPaymentImport,
  shipmentImportRunner: ShipmentImportRunner = runShipmentImport,
): Promise<TaskResult> {
  let payload: MlNotificationPayload;
  try {
    payload = mlNotificationTaskSchema.parse(data);
  } catch (err) {
    if (err instanceof z.ZodError) return { outcome: 'dropped' }; // coding/enqueue bug — drop
    throw err;
  }

  let result: ProcessOutcome;
  try {
    result = await processNotificationPayload(
      db,
      payload,
      resolveItemsApi,
      migrationRunner,
      orderImportRunner,
      paymentImportRunner,
      shipmentImportRunner,
    );
  } catch (err) {
    // Transient (Firestore / ML API / network). Retry in-task until the final
    // attempt; then persist `failed` so the sweep re-drives it (a throw on the
    // last attempt would drop the notification).
    if (!(err instanceof Error)) throw err;
    if (retryCount < TASK_MAX_ATTEMPTS - 1) throw err; // let the queue retry with backoff
    // Final attempt: persist so the sweep re-drives it. If the persist ALSO
    // fails — a *correlated* outage of the SAME Firestore whose failure we're
    // recovering from — we can't record it locally: log the dropped notification
    // and re-throw the ORIGINAL error so the failed final attempt surfaces in
    // Cloud Tasks' error metrics (the residual loss window for a Firestore outage
    // longer than the retry backoff is covered by the deferred `missed_feeds`
    // backstop). See functions/DEPLOY.md.
    try {
      await persistNotificationFailure(db, payload, err.message);
    } catch (persistErr) {
      if (!(persistErr instanceof Error)) throw persistErr;
      console.error(
        '[mercado-livre] notification DROPPED — transient failure AND persist failed on the final attempt',
        {
          id: payload.id,
          resource: payload.resource,
          topic: payload.topic,
          cause: err.message,
          persistError: persistErr.message,
        },
      );
      throw err; // surface the original failure to Cloud Tasks
    }
    return { outcome: 'failed', topic: payload.topic };
  }

  if (result.kind === 'no-account') {
    await persistNotificationFailure(
      db,
      payload,
      `integração ativa do Mercado Livre não encontrada para user_id ${payload.user_id}`,
    );
    return { outcome: 'failed', topic: payload.topic };
  }
  if (result.kind === 'unknown-topic') {
    await persistNotification(db, payload, 'parked', 0, `tópico não suportado: ${payload.topic}`);
    return { outcome: 'parked', integracaoId: result.integracaoId, topic: payload.topic };
  }
  if (result.kind === 'malformed-resource') {
    // A coding/ML-side anomaly (an orders_v2/orders/payments/shipments
    // resource with no parseable numeric id) — nothing to retry, nothing
    // worth persisting (same disposition as the schema-parse drop above, just
    // discovered one layer deeper, after the account/topic are already known).
    console.warn('[mercado-livre] notification DROPPED — unparseable resource', {
      id: payload.id,
      resource: payload.resource,
      topic: payload.topic,
    });
    return { outcome: 'dropped', integracaoId: result.integracaoId, topic: payload.topic };
  }
  // done — NOTHING persisted (the cost win).
  return { outcome: 'done', integracaoId: result.integracaoId, topic: payload.topic };
}

/**
 * Persist a notification as `failed` (the sweep will re-drive it). The receiver
 * also calls this as a fallback when the enqueue itself fails, so ML never sees
 * a 5xx during an enqueue-path outage (which could disable the topic).
 */
export async function persistNotificationFailure(
  db: Firestore,
  payload: MlNotificationPayload,
  erro: string,
): Promise<void> {
  await persistNotification(db, payload, 'failed', 0, erro);
}

/**
 * Create-only failure/parked writer keyed by the ML `_id` (auto-id when absent),
 * stamping `processedAt = now` (the sweep's window gate). A duplicate delivery
 * that also failed hits ALREADY_EXISTS (gRPC 6) → the notification is already
 * recorded, so we ignore it rather than clobber its retry state.
 */
async function persistNotification(
  db: Firestore,
  payload: MlNotificationPayload,
  status: 'failed' | 'parked',
  tentativas: number,
  erro: string,
): Promise<void> {
  const docId = payload.id ?? notificacaoMercadoLivreCollection.newDocId(db, {});
  const data = notificacaoMercadoLivreCollection.parse({
    ...payload,
    status,
    tentativas,
    erro,
    processedAt: Date.now(),
  });
  try {
    await notificacaoMercadoLivreCollection.docRef(db, {}, docId).create(data);
  } catch (err) {
    if (isAlreadyExists(err)) return; // dup — already recorded
    throw err;
  }
}

/** Advance an existing failure doc's status/retry counter (merge — keeps the wire fields). */
async function markNotification(
  db: Firestore,
  docId: string,
  status: 'failed' | 'parked',
  tentativas: number,
  erro: string,
  now: number,
): Promise<void> {
  await notificacaoMercadoLivreCollection.merge(db, {}, docId, {
    status,
    tentativas,
    erro,
    processedAt: now,
  });
}

/** Remove a resolved failure doc from the failures-only store (sweep success). */
async function deleteNotification(db: Firestore, docId: string): Promise<void> {
  await notificacaoMercadoLivreCollection.docRef(db, {}, docId).delete();
}

/** One hour — the legacy `manageNotificationsMercadoLivre` reprocess window. */
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ReprocessOptions {
  /** Only re-drive notifications last attempted before `now - olderThanMs`. */
  olderThanMs?: number;
  limit?: number;
  /** Injectable clock (tests). */
  now?: number;
}

export interface ReprocessResult {
  processed: number;
  outcomes: Record<string, number>;
  errors: Array<{ docId: string; message: string }>;
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
export async function reprocessNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  resolveItemsApi: ItemsApiResolver = resolveItemsApiFromContext,
  migrationRunner: MigrationRunner = runUptinMigration,
  orderImportRunner: OrderImportRunner = runOrderImport,
  paymentImportRunner: PaymentImportRunner = runPaymentImport,
  shipmentImportRunner: ShipmentImportRunner = runShipmentImport,
): Promise<ReprocessResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.olderThanMs ?? ONE_HOUR_MS);
  const max = opts.limit ?? 50;

  const snap = await notificacaoMercadoLivreCollection
    .ref(db, {})
    .where('status', '==', 'failed')
    .where('processedAt', '<', cutoff)
    .orderBy('processedAt')
    .limit(max)
    .get();

  const seenResource = new Set<string>();
  const outcomes: Record<string, number> = {};
  const errors: Array<{ docId: string; message: string }> = [];
  let processed = 0;

  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    const resource = typeof raw.resource === 'string' ? raw.resource : '';
    if (resource && seenResource.has(resource)) continue; // dedup by resource
    if (resource) seenResource.add(resource);

    const doc = notificacaoMercadoLivreCollection.parseRead(
      raw,
      notificacaoMercadoLivreCollection.docPath({}, d.id),
    );
    const payload: MlNotificationPayload = {
      id: doc.id,
      resource: doc.resource,
      topic: doc.topic,
      user_id: doc.user_id,
      application_id: doc.application_id,
      attempts: doc.attempts,
      sent: doc.sent,
      received: doc.received,
    };
    const tentativas = (doc.tentativas ?? 0) + 1;

    try {
      const result = await processNotificationPayload(
        db,
        payload,
        resolveItemsApi,
        migrationRunner,
        orderImportRunner,
        paymentImportRunner,
        shipmentImportRunner,
      );
      if (result.kind === 'done') {
        await deleteNotification(db, d.id); // resolved → leave the failures store
        outcomes.done = (outcomes.done ?? 0) + 1;
      } else if (result.kind === 'unknown-topic') {
        await markNotification(
          db,
          d.id,
          'parked',
          tentativas,
          `tópico não suportado: ${payload.topic}`,
          now,
        );
        outcomes.parked = (outcomes.parked ?? 0) + 1;
      } else if (result.kind === 'malformed-resource') {
        // Terminal, same as unknown-topic: an unparseable resource will never
        // become parseable on a later sweep — park it instead of bumping
        // tentativas under the (misleading) "no active account" message below.
        await markNotification(
          db,
          d.id,
          'parked',
          tentativas,
          `resource malformado: ${payload.resource}`,
          now,
        );
        outcomes.parked = (outcomes.parked ?? 0) + 1;
      } else {
        // still no active account — re-drive until the cap, then park.
        const status = tentativas >= MAX_TENTATIVAS ? 'parked' : 'failed';
        await markNotification(
          db,
          d.id,
          status,
          tentativas,
          `integração ativa do Mercado Livre não encontrada para user_id ${payload.user_id}`,
          now,
        );
        outcomes[status] = (outcomes[status] ?? 0) + 1;
      }
      processed += 1;
    } catch (err) {
      // Batch-isolation boundary: a transient failure on one notification must
      // not abort the sweep. Bump tentativas (park at the cap); if even the mark
      // write fails, collect and move on. Non-Error throws still propagate.
      if (!(err instanceof Error)) throw err;
      try {
        const status = tentativas >= MAX_TENTATIVAS ? 'parked' : 'failed';
        await markNotification(db, d.id, status, tentativas, err.message, now);
      } catch (markErr) {
        if (!(markErr instanceof Error)) throw markErr;
      }
      errors.push({ docId: d.id, message: err.message });
    }
  }

  return { processed, outcomes, errors };
}
