/**
 * Mercado Pago webhook ingestion core (#531) — the queue-based resilient
 * pipeline shared by the receiver route, the `onTaskDispatched` task handler,
 * and the `onSchedule` reprocess sweep. Mirrors
 * `apps/mercado-livre/lib/marketplace/notificacao.ts`, adapted marketplace →
 * payments.
 *
 * Flow (see the receiver route + the future functions/DEPLOY.md):
 *   1. the receiver validates the raw MP POST (`parseNotificationBody`) and
 *      ENQUEUES the lean payload onto the Cloud Tasks queue — acking 200 fast
 *      WITHOUT writing Firestore on the happy path;
 *   2. `handleNotificationTask` (the queued task) resolves the owning
 *      `metodo_pgto` account by MP collector `user_id`, RE-FETCHES the full
 *      payment from the MP API (the webhook body is never trusted — #531), maps
 *      it to a `Pagamento` and reconciles the pedido estado;
 *   3. a document is persisted to `notificacoesMercadoPago` ONLY when the
 *      notification can't be processed (retries exhausted / no linked account /
 *      pedido not found / missing external_reference);
 *   4. `reprocessNotifications` (the sweep) re-drives persisted `failed` docs and
 *      deletes them on success.
 *
 * Disposition (`handleNotificationTask`):
 *  - `done`     — the payment was fetched, mapped and reconciled: NOTHING is
 *                 persisted (the cost win);
 *  - transient  — a transient infra failure (Firestore / MP API / network) THROWS
 *                 so the queue retries with backoff; on the FINAL attempt it
 *                 persists `failed` (so the sweep re-drives it) instead of throwing;
 *  - `failed`   — a deterministic non-retryable park: no single owning account
 *                 (the collector maps to no `metodo_pgto` yet or to more than one,
 *                 or a v1 IPN with no `user_id` that can't be pinned to one
 *                 connected account), the refetched payment's `collector_id`
 *                 disagrees with the resolved account, a dead OAuth grant (reauth
 *                 required) or a `404` on the payment refetch, a pedido that
 *                 doesn't exist yet, or a payment with no `external_reference`.
 *                 Persisted immediately; the sweep re-drives it (the account may
 *                 connect / reconnect, the pedido may be created);
 *  - `dropped`  — silently acked, never processed or persisted: a sandbox
 *                 (`live_mode === false`) event, a non-payment topic
 *                 (`merchant_order`), or a malformed task payload (a coding/enqueue
 *                 bug — logged, no persist, no retry).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { TIPO_INTEGRACAO_PGTO, nowMicros, type EstadoPedido } from '@delfrance/schemas';
import {
  metodoPagamentoCollection,
  notificacaoMercadoPagoCollection,
} from '@delfrance/data/admin/collections';
import { PedidoReconcileNotFoundError, reconcilePedidoFromPagamento } from '@delfrance/data/admin';
import {
  asMillis,
  defineNotificationPipeline,
  MAX_TENTATIVAS,
  type NotificationDisposition,
  type ReprocessOptions,
  type ReprocessResult,
  TASK_MAX_ATTEMPTS,
} from '@delfrance/data/admin/notifications';
import {
  MercadoPagoHttpError,
  MercadoPagoReauthRequiredError,
  createMercadoPagoApi,
  mpPaymentToPagamento,
  type MpPayment,
} from '@delfrance/integrations-mercado-pago';

import { loadMercadoPagoContext } from './mercadoPago';
import { type MetodoResolution, readMetodoByCollector } from './metodoCache';

/**
 * The deployed `onTaskDispatched` function name — which is ALSO its
 * auto-provisioned Cloud Tasks queue name. Single source of truth, shared by the
 * producer (`mpTasks.ts` builds the region-qualified queue path from it) and the
 * consumer (the nested `functions/` codebase — the `export const` there MUST be
 * named exactly this). Lives in this neutral shared module because the app
 * cannot import the functions-trigger file (that would pull the Functions SDK
 * into the Next bundle). Rename in BOTH places.
 */
export const MERCADO_PAGO_NOTIFICATION_QUEUE = 'processMercadoPagoNotification';

// The retry caps and the reprocess window are the SHARED pipeline's — re-exported
// here so this module stays the one import site for the channel's callers.
export { MAX_TENTATIVAS, TASK_MAX_ATTEMPTS };
export type { ReprocessOptions, ReprocessResult };

/**
 * The single MP topic the pipeline processes end-to-end. Everything else
 * (`merchant_order`, plan/subscription events, …) is dropped: the payment
 * refetch + reconcile only makes sense for a `payment` event.
 */
export const PAYMENT_TOPIC = 'payment';

/** True when the topic denotes a payment event (MP `type` or legacy `topic`). */
export function isPaymentTopic(topic: string): boolean {
  return topic === PAYMENT_TOPIC;
}

/**
 * The lean MP-wire payload the receiver enqueues onto the task queue and the
 * task handler re-validates (belt-and-suspenders across the wire boundary).
 * Tolerant (`passthrough`, nullable). `dateCreated` is already normalized to
 * epoch millis (or null) by `asMillis` before enqueue, so a persisted failure
 * doc can never be rejected on it.
 */
export const mpNotificationTaskSchema = z
  .object({
    id: z.string().nullable().default(null),
    paymentId: z.string().min(1),
    topic: z.string().min(1),
    collectorUserId: z.number().int().nullable().default(null),
    liveMode: z.boolean().nullable().default(null),
    dateCreated: z.number().nullable().default(null),
  })
  .passthrough();
export type MpNotificationPayload = z.infer<typeof mpNotificationTaskSchema>;

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) && v.trim() !== '' ? Math.trunc(n) : null;
  }
  return null;
}
function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
// `asMillis` (MP's `date_created`, ISO-8601 or epoch millis) is the shared
// receiver coercer from `@delfrance/data/admin/notifications` — normalized at the
// source so a persisted failure doc can never be rejected by the strict write
// validator. (Informational only; the sweep gates on the local `processedAt`.)

/**
 * Normalize a raw MP POST body (+ its query string) into the lean task payload.
 * Returns null for noise the receiver can ack without enqueuing: a non-object
 * body, or one with no resolvable payment id / topic.
 *
 * Handles both MP notification shapes:
 *  - **v2 (JSON Webhooks)**: `{ type:'payment', data:{ id }, user_id, live_mode }`
 *    — the payment id is `data.id`, the topic is `type`, the notification id is
 *    the top-level `id`.
 *  - **v1 (IPN)**: `?topic=payment&id=…` in the query string, with the JSON body
 *    carrying only `topic` — the payment id and topic come from the query.
 *
 * The values are never trusted (the handler re-fetches the payment from the MP
 * API); this only surfaces the routing fields.
 */
export function parseNotificationBody(
  raw: unknown,
  query: URLSearchParams,
): MpNotificationPayload | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null;

  // Topic: v2 `type`, else legacy `topic`, else the `?topic=`/`?type=` query.
  const topic =
    asString(o.type) ??
    asString(o.topic) ??
    asString(query.get('topic')) ??
    asString(query.get('type'));

  // Payment id: v2 `data.id`, else the `?data.id=`/`?id=` query. NOTE the
  // top-level body `id` is the NOTIFICATION id (v2), not the payment id.
  const paymentId =
    asString(data?.id) ?? asString(query.get('data.id')) ?? asString(query.get('id'));

  if (!topic || !paymentId) return null;

  // Notification id (doc key hint): the top-level body `id`; null ⇒ auto-id.
  const id = asString(o.id);

  return {
    id,
    paymentId,
    topic,
    collectorUserId: asInt(o.user_id),
    liveMode: asBool(o.live_mode),
    dateCreated: asMillis(o.date_created),
  };
}

/**
 * v1 IPN fallback scan cap. The legacy IPN form (`?topic=payment&id=…`) carries
 * NO `user_id`, so we page the (tiny — realistically one MP account per tenant)
 * `metodo_pgto` collection and pick the single connected account. Kept small.
 */
const V1_CONNECTED_SCAN_LIMIT = 10;

/**
 * Read a `metodo_pgto` doc's denormalized collector `user_id` from raw doc data
 * (null when the account isn't OAuth-connected yet).
 */
function readMetodoUserId(data: unknown): number | null {
  if (data != null && typeof data === 'object') {
    const v = (data as Record<string, unknown>).user_id;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Outcome of resolving the owning `metodo_pgto` account for a notification.
 * Declared in `metodoCache.ts` (the cache stores it) and re-exported here, where
 * every consumer already looks for it.
 */
export type { MetodoResolution };

/**
 * Resolve the owning `metodo_pgto` account for an inbound notification. Two
 * strategies, keyed on whether MP told us the collector:
 *
 *  - **collector known** (v2 JSON webhook `user_id`): an equality query over the
 *    denormalized `user_id` field (tipo == mercadoPago), `limit(2)` so a
 *    duplicated denorm (two accounts claiming the same collector) is detectable.
 *    Exactly one → resolved. Zero (no account maps to the collector *yet*) or
 *    more than one (ambiguous denorm) → `failed` PARK — NOT a silent drop: the
 *    account may connect later and the sweep re-drives.
 *  - **collector unknown** (v1 IPN, which carries no `user_id`): fall back to the
 *    single connected MP account. Firestore can't express `user_id != null` in
 *    one handle query, so page the tiny collection (tipo == mercadoPago,
 *    `limit`) and filter the connected accounts in memory. Exactly one connected
 *    account → resolved candidate. Zero or more than one → `failed` PARK (nothing
 *    to attach to yet, or too ambiguous to guess).
 *
 * The resolved `userId` feeds the caller's post-refetch collector safety net
 * (never reconcile a payment whose real `collector_id` differs). A transient
 * Firestore failure here propagates (throws) so the caller treats it as retryable.
 */
export function resolveMetodoByCollector(
  db: Firestore,
  collectorUserId: number | null,
): Promise<MetodoResolution> {
  // `collectorUserId` is the only variable predicate — `tipo == mercadoPago` is
  // constant on both branches and the v1 cap is a module constant — so it alone
  // keys the entry. A `failed` outcome is never cached (see `metodoCache.ts`),
  // so both reason strings below stay exact on every call.
  return readMetodoByCollector(collectorUserId, () => queryMetodoByCollector(db, collectorUserId));
}

async function queryMetodoByCollector(
  db: Firestore,
  collectorUserId: number | null,
): Promise<MetodoResolution> {
  if (collectorUserId != null) {
    const snap = await metodoPagamentoCollection
      .ref(db, {})
      .where('tipo', '==', TIPO_INTEGRACAO_PGTO.mercadoPago)
      .where('user_id', '==', collectorUserId)
      .limit(2)
      .get();
    if (snap.docs.length === 1) {
      const doc = snap.docs[0]!;
      return { kind: 'resolved', metodoId: doc.id, userId: readMetodoUserId(doc.data()) };
    }
    if (snap.docs.length > 1) {
      return {
        kind: 'failed',
        reason: `collector ${collectorUserId} resolve para mais de uma conta metodo_pgto`,
      };
    }
    return {
      kind: 'failed',
      reason: `collector ${collectorUserId} não mapeia nenhuma conta metodo_pgto conectada`,
    };
  }

  // v1 IPN — no `user_id`. Guess the single connected MP account.
  const snap = await metodoPagamentoCollection
    .ref(db, {})
    .where('tipo', '==', TIPO_INTEGRACAO_PGTO.mercadoPago)
    .limit(V1_CONNECTED_SCAN_LIMIT)
    .get();
  const connected = snap.docs.filter((d) => readMetodoUserId(d.data()) != null);
  if (connected.length === 1) {
    const doc = connected[0]!;
    return { kind: 'resolved', metodoId: doc.id, userId: readMetodoUserId(doc.data()) };
  }
  return {
    kind: 'failed',
    reason:
      connected.length === 0
        ? 'IPN v1 sem user_id e nenhuma conta Mercado Pago conectada'
        : 'IPN v1 sem user_id e múltiplas contas Mercado Pago conectadas (ambíguo)',
  };
}

/**
 * The MP-API seam the pipeline calls to VERIFY a notification by re-fetching the
 * full payment (never trusting the webhook body — #531). Injectable so the unit
 * tests pass a fake; the real one is {@link fetchPaymentViaContext}.
 */
export type PaymentFetcher = (
  db: Firestore,
  metodoId: string,
  paymentId: string,
) => Promise<MpPayment>;

/** Reconcile seam — the transactional pedido-estado writer (injectable for tests). */
export type PedidoReconciler = typeof reconcilePedidoFromPagamento;

export interface ProcessDeps {
  fetchPayment: PaymentFetcher;
  reconcile: PedidoReconciler;
}

/**
 * Real payment fetcher: load the account context, resolve a live access token
 * (refreshing on expiry) and GET the payment from the MP API. Throws on a dead
 * grant / network / HTTP failure — all transient from the pipeline's view.
 */
export const fetchPaymentViaContext: PaymentFetcher = async (db, metodoId, paymentId) => {
  const ctx = await loadMercadoPagoContext(db, metodoId);
  const accessToken = await ctx.resolveAccessToken();
  const api = createMercadoPagoApi({ getAccessToken: async () => accessToken });
  return api.getPayment(paymentId);
};

export const defaultProcessDeps: ProcessDeps = {
  fetchPayment: fetchPaymentViaContext,
  reconcile: reconcilePedidoFromPagamento,
};

/** Deterministic result of processing one payload (transient failures THROW). */
export type ProcessOutcome =
  | {
      kind: 'reconciled';
      metodoId: string;
      pedidoId: string;
      transition: EstadoPedido | null;
      skippedStale: boolean;
    }
  | { kind: 'dropped'; reason: string } // ack, never persist
  | { kind: 'failed'; reason: string }; // persist as `failed`, sweep re-drives

/**
 * Process one notification payload — drop the noise, verify by refetch, map and
 * reconcile. Pure of the notification doc (reads the account + payment, not a
 * persisted notification), so it works identically for a fresh queued task and a
 * sweep re-drive. Deterministic outcomes RETURN; a transient failure (Firestore
 * / MP API / network) THROWS so the queue/sweep retry.
 */
export async function processNotificationPayload(
  db: Firestore,
  payload: MpNotificationPayload,
  deps: ProcessDeps = defaultProcessDeps,
): Promise<ProcessOutcome> {
  // Silent drops (ack, never persist): a sandbox event or a non-payment topic.
  if (payload.liveMode === false) return { kind: 'dropped', reason: 'live_mode=false (sandbox)' };
  if (!isPaymentTopic(payload.topic)) {
    return { kind: 'dropped', reason: `tópico não suportado: ${payload.topic}` };
  }

  const resolution = await resolveMetodoByCollector(db, payload.collectorUserId);
  if (resolution.kind === 'failed') {
    // No single owning account (unknown / ambiguous collector, or a v1 IPN we
    // can't pin to one connected account). PARK — the account may connect and
    // the sweep re-drives; never a silent drop. Logged WITHOUT any token/secret.
    console.error('[mercado-pago] could not resolve owning metodo_pgto — parking', {
      collectorUserId: payload.collectorUserId,
      paymentId: payload.paymentId,
      reason: resolution.reason,
    });
    return { kind: 'failed', reason: resolution.reason };
  }
  const { metodoId, userId: resolvedUserId } = resolution;

  // VERIFY-BY-REFETCH: the webhook body is never trusted. Narrow the refetch
  // failure — a dead OAuth grant (reauth) or a `404` (the payment id doesn't
  // exist) is deterministic → PARK (a retry storm can't help; the sweep
  // re-drives after a human reconnects). Network / 5xx / 429 stay transient →
  // rethrow so the queue/sweep retry with backoff.
  let payment: MpPayment;
  try {
    payment = await deps.fetchPayment(db, metodoId, payload.paymentId);
  } catch (err) {
    if (err instanceof MercadoPagoReauthRequiredError) {
      return {
        kind: 'failed',
        reason: `conta Mercado Pago desconectada (reautenticação necessária): ${err.message}`,
      };
    }
    if (err instanceof MercadoPagoHttpError && err.status === 404) {
      return {
        kind: 'failed',
        reason: `pagamento ${payload.paymentId} inexistente na API do Mercado Pago (404)`,
      };
    }
    throw err; // MercadoPagoNetworkError + other HTTP (5xx/429) + anything else — transient
  }

  // The refetched payment is authoritative for live_mode too.
  if (payment.live_mode === false) {
    return { kind: 'dropped', reason: 'payment.live_mode=false (sandbox)' };
  }

  // Collector safety net: the refetched payment's `collector_id` is the TRUE
  // owning account. If it's known and differs from the account we resolved (a
  // wrong v1 single-account guess, or a stale denorm), never reconcile with the
  // mismatched collector — PARK for a human.
  const paymentCollectorId = asInt(payment.collector_id);
  if (
    paymentCollectorId != null &&
    resolvedUserId != null &&
    paymentCollectorId !== resolvedUserId
  ) {
    return {
      kind: 'failed',
      reason: `collector do pagamento (${paymentCollectorId}) difere da conta resolvida (user_id ${resolvedUserId})`,
    };
  }

  const pedidoId = payment.external_reference ?? null;
  if (!pedidoId) {
    // No pedido to attach to. Park (a later redelivery can't invent one), don't
    // retry-throw.
    return { kind: 'failed', reason: `pagamento ${payload.paymentId} sem external_reference` };
  }

  const { pagamentoId, pagamento } = mpPaymentToPagamento(payment, {
    metodoOuterRef: `documents/metodo_pgto/${metodoId}`,
    nowMicros: nowMicros(),
  });

  try {
    const { transition, skippedStale } = await deps.reconcile(db, {
      pedidoId,
      pagamentoId,
      pagamento,
    });
    return { kind: 'reconciled', metodoId, pedidoId, transition, skippedStale };
  } catch (err) {
    // A pedido that no longer exists is deterministic — park it (a redelivery
    // after the pedido is created can settle it), never a retry-throw. Anything
    // else (transient Firestore) propagates.
    if (err instanceof PedidoReconcileNotFoundError) {
      return { kind: 'failed', reason: err.message };
    }
    throw err;
  }
}

export interface TaskResult {
  outcome: 'done' | 'failed' | 'dropped';
  metodoId?: string;
  pedidoId?: string;
  topic?: string;
}
/**
 * The shared pipeline, bound to this channel. Built per call so the injectable
 * `deps` stay per-call (the factory only closes over config — no I/O, no state).
 *
 * Note what the persisted doc does NOT carry: any payment detail. MP's failure
 * doc keeps only the webhook's own POINTER fields, because the sweep re-FETCHES
 * the payment from the MP API rather than trusting a replayed body (#531). That
 * is the opposite of the WhatsApp channel, which has no re-fetch anchor and so
 * must carry its payload.
 */
function pipelineFor(deps: ProcessDeps) {
  return defineNotificationPipeline<MpNotificationPayload, ProcessOutcome>({
    channel: 'mercado-pago',
    collection: notificacaoMercadoPagoCollection,
    taskSchema: mpNotificationTaskSchema,
    docIdOf: (p) => p.id,
    dedupKeyOf: (p) => p.paymentId,
    toDocFields: (p) => ({
      id: p.id,
      paymentId: p.paymentId,
      topic: p.topic,
      collectorUserId: p.collectorUserId,
      liveMode: p.liveMode,
      dateCreated: p.dateCreated,
    }),
    fromDoc: (parsed) => {
      const doc = parsed as MpNotificationPayload;
      return {
        id: doc.id,
        paymentId: doc.paymentId,
        topic: doc.topic,
        collectorUserId: doc.collectorUserId,
        liveMode: doc.liveMode,
        dateCreated: doc.dateCreated,
      };
    },
    process: (db, payload) => processNotificationPayload(db, payload, deps),
    toDisposition: (outcome): NotificationDisposition => {
      // A `dropped` event (sandbox / non-payment topic) is never OURS to process
      // — in the task nothing is written at all, and in the sweep the doc leaves
      // the failures store. Same disposition in both phases.
      if (outcome.kind === 'dropped') return { kind: 'drop', reason: outcome.reason };
      if (outcome.kind === 'failed') return { kind: 'fail', reason: outcome.reason };
      return { kind: 'resolve', label: 'reconciled' };
    },
  });
}

const basePipeline = pipelineFor(defaultProcessDeps);

/**
 * Persist a notification as `failed` (the sweep will re-drive it). The receiver
 * also calls this as a fallback when the enqueue itself fails, so MP never sees
 * a 5xx during an enqueue-path outage.
 */
export function persistNotificationFailure(
  db: Firestore,
  payload: MpNotificationPayload,
  erro: string,
): Promise<void> {
  return basePipeline.persistFailure(db, payload, erro);
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
  deps: ProcessDeps = defaultProcessDeps,
): Promise<TaskResult> {
  const r = await pipelineFor(deps).handleTask(db, data, retryCount);
  // `payload` is absent only on the schema-parse drop, where there is no topic
  // to report; `result` is absent on the transient-failure path.
  const reconciled = r.result?.kind === 'reconciled' ? r.result : null;
  return {
    // MP never produces a `park` disposition, so `parked` is unreachable here —
    // mapped defensively rather than widening this channel's public union.
    outcome: r.outcome === 'parked' ? 'failed' : r.outcome,
    ...(reconciled ? { metodoId: reconciled.metodoId, pedidoId: reconciled.pedidoId } : {}),
    ...(r.payload ? { topic: r.payload.topic } : {}),
  };
}

/**
 * The `onSchedule` reprocess backstop — re-drives persisted `failed`
 * notifications older than the window (a `failed` account may have connected, or
 * the pedido may now exist, or a transient outage has cleared). A resolved
 * delivery (reconciled, or now-dropped) DELETES the doc (failures-only store); a
 * persistent failure bumps `tentativas` up to `MAX_TENTATIVAS`, then parks.
 * Deduplicated by `paymentId` within a run, bounded, and ISOLATED per-doc so one
 * failure never aborts the batch. Inline (not re-enqueued): the sweep is already
 * rate-limited by its schedule + the `limit` cap. The caller logs the returned
 * counts/errors.
 */
export function reprocessNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  deps: ProcessDeps = defaultProcessDeps,
): Promise<ReprocessResult> {
  return pipelineFor(deps).reprocess(db, opts);
}
