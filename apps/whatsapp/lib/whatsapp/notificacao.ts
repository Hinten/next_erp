/**
 * WhatsApp Cloud API webhook ingestion core (#527) — the queue-based resilient
 * pipeline shared by the receiver route, the `onTaskDispatched` task handler, and
 * the `onSchedule` reprocess sweep. Mirrors `apps/mercado-pago/lib/payments/
 * notificacao.ts` structurally; the semantics are ported from the legacy Flutter
 * handler (`.old/.../whatsapp_cloud_api/lib/{functions.dart,
 * src/processar_notificacoes.dart, src/notificacoes/messages.dart}`).
 *
 * Flow:
 *   1. the receiver verifies Meta's signature over the raw body, parses the
 *      envelope into ONE lean payload PER `entry[].changes[]`
 *      ({@link parseWebhookBody}), and ENQUEUES each — acking 200 fast WITHOUT
 *      writing Firestore on the happy path;
 *   2. `handleNotificationTask` (the queued task) dispatches by `field`: the
 *      `messages` field runs the inbound message + status pipeline; any other
 *      field is dropped;
 *   3. a document is persisted to `notificacoesWhatsapp` ONLY when a change can't
 *      be processed (retries exhausted / account not linked yet / …). Unlike MP,
 *      WhatsApp has no re-fetch anchor — the message content lives only in the
 *      webhook body — so the failure doc CARRIES the change `value` (an untyped
 *      passthrough field on the admin-only, default-deny collection) so the sweep
 *      can REPLAY it;
 *   4. `reprocessNotifications` (the sweep) re-drives persisted `failed` docs and
 *      deletes them on success.
 *
 * Disposition (`handleNotificationTask`), mirroring MP:
 *  - `done`     — the change was processed: NOTHING is persisted (the cost win);
 *  - transient  — a transient infra failure (Firestore / Graph / network) THROWS
 *                 so the queue retries with backoff; on the FINAL attempt it
 *                 persists `failed` (so the sweep re-drives it) instead of throwing;
 *  - `failed`   — a deterministic non-retryable park: the `phone_number_id` maps
 *                 to no `integracao` account yet (or to more than one). Persisted
 *                 immediately; the sweep re-drives it (the account may connect);
 *  - `dropped`  — silently acked, never processed or persisted: an unsupported
 *                 `field`, a malformed `value`, or a malformed task payload (a
 *                 coding/enqueue bug — logged, no persist, no retry).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { notificacoesWhatsappCollection } from '@delfrance/data/admin/collections';
import {
  WEBHOOK_FIELD_MESSAGES,
  webhookEnvelopeSchema,
} from '@delfrance/integrations-whatsapp-cloud-api';

import { getAdminBucket } from '../firebase/admin';
import { loadWhatsappContext } from './whatsapp';
import {
  processMessagesField,
  type ProcessOutcome,
  type WhatsappProcessDeps,
} from './processMessages';
import type { MediaCacheContext } from './media';

/**
 * The deployed `onTaskDispatched` function name — which is ALSO its
 * auto-provisioned Cloud Tasks queue name. Single source of truth, shared by the
 * producer (`waTasks.ts` builds the region-qualified queue path from it) and the
 * consumer (the nested `functions/` codebase — the `export const` there MUST be
 * named exactly this). Rename in BOTH places.
 */
export const WHATSAPP_NOTIFICATION_QUEUE = 'processWhatsappNotification';

/** In-task retry cap — the Cloud Tasks `retryConfig.maxAttempts` (kept in sync). */
export const TASK_MAX_ATTEMPTS = 3;

/** Cross-sweep reprocess cap — after this many sweeps a `failed` doc is parked. */
export const MAX_TENTATIVAS = 5;

/**
 * One lean per-change payload the receiver enqueues and the task handler
 * re-validates. `value` is the raw `changes[].value` (JSON round-trips through
 * Cloud Tasks); it is re-parsed against `valuePayloadSchema` when processed.
 */
export interface WhatsappNotificationPayload {
  field: string;
  phoneNumberId: string | null;
  messageId: string | null;
  value: unknown;
}

export const whatsappNotificationTaskSchema = z
  .object({
    field: z.string().min(1),
    phoneNumberId: z.string().nullable().default(null),
    messageId: z.string().nullable().default(null),
    value: z.unknown(),
  })
  .passthrough();

/**
 * Parse a raw Meta webhook body into one payload per `entry[].changes[]`.
 * Returns null for a body that isn't a WhatsApp webhook envelope (the receiver
 * acks it without enqueuing); an empty array when the envelope carries no
 * changes.
 */
export function parseWebhookBody(raw: unknown): WhatsappNotificationPayload[] | null {
  const parsed = webhookEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;

  const out: WhatsappNotificationPayload[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      out.push({
        field: change.field,
        phoneNumberId: value.metadata?.phone_number_id ?? null,
        messageId: value.messages?.[0]?.id ?? value.statuses?.[0]?.id ?? null,
        value,
      });
    }
  }
  return out;
}

/** Real deps: resolve the account's Graph client + Storage bucket for media. */
export const defaultWhatsappProcessDeps: WhatsappProcessDeps = {
  async mediaContext(db: Firestore, contaId: string): Promise<MediaCacheContext> {
    const ctx = await loadWhatsappContext(db, contaId);
    const client = await ctx.buildClient();
    return { db, bucket: getAdminBucket(), client, contaId };
  },
};

/**
 * Dispatch one change by `field`. Only `messages` is processed end-to-end; every
 * other field (template/account/quality updates, …) is dropped with a log — the
 * inbox pipeline has nothing to do with them.
 */
export async function processChangePayload(
  db: Firestore,
  payload: WhatsappNotificationPayload,
  deps: WhatsappProcessDeps = defaultWhatsappProcessDeps,
): Promise<ProcessOutcome> {
  if (payload.field === WEBHOOK_FIELD_MESSAGES) {
    return processMessagesField(db, payload.value, deps);
  }
  console.warn('[whatsapp] campo não suportado — dropping', { field: payload.field });
  return { kind: 'dropped', reason: `campo não suportado: ${payload.field}` };
}

export interface TaskResult {
  outcome: 'done' | 'failed' | 'dropped';
  contaId?: string;
  field?: string;
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
  deps: WhatsappProcessDeps = defaultWhatsappProcessDeps,
): Promise<TaskResult> {
  let payload: WhatsappNotificationPayload;
  try {
    payload = whatsappNotificationTaskSchema.parse(data) as WhatsappNotificationPayload;
  } catch (err) {
    if (err instanceof z.ZodError) return { outcome: 'dropped' }; // coding/enqueue bug — drop
    throw err;
  }

  let result: ProcessOutcome;
  try {
    result = await processChangePayload(db, payload, deps);
  } catch (err) {
    // Transient (Firestore / Graph / network). Retry in-task until the final
    // attempt; then persist `failed` so the sweep re-drives it.
    if (!(err instanceof Error)) throw err;
    if (retryCount < TASK_MAX_ATTEMPTS - 1) throw err; // let the queue retry with backoff
    try {
      await persistNotificationFailure(db, payload, err.message);
    } catch (persistErr) {
      // A correlated Firestore outage — can't record it locally: log the dropped
      // notification and re-throw the ORIGINAL error so it surfaces in Cloud
      // Tasks' error metrics.
      if (!(persistErr instanceof Error)) throw persistErr;
      console.error(
        '[whatsapp] notification DROPPED — transient failure AND persist failed on the final attempt',
        {
          field: payload.field,
          messageId: payload.messageId,
          cause: err.message,
          persistError: persistErr.message,
        },
      );
      throw err;
    }
    return { outcome: 'failed', field: payload.field };
  }

  if (result.kind === 'dropped') {
    return { outcome: 'dropped', field: payload.field };
  }
  if (result.kind === 'failed') {
    await persistNotificationFailure(db, payload, result.reason);
    return { outcome: 'failed', field: payload.field };
  }
  return { outcome: 'done', contaId: result.contaId, field: payload.field };
}

/** Drop `undefined` (Firestore rejects it) from the replayed change value. */
function sanitizeValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Persist a notification as `failed` (the sweep will re-drive it). The receiver
 * also calls this as a fallback when the enqueue itself fails, so Meta never sees
 * a 5xx during an enqueue-path outage.
 */
export async function persistNotificationFailure(
  db: Firestore,
  payload: WhatsappNotificationPayload,
  erro: string,
): Promise<void> {
  await persistNotification(db, payload, 'failed', 0, erro);
}

/**
 * Create-only failure/parked writer keyed by the WA `messageId` (auto-id when
 * absent), stamping `processedAt = now` (the sweep's window gate) and carrying
 * the change `value` so the sweep can replay it. A duplicate delivery that also
 * failed hits ALREADY_EXISTS (gRPC 6) → already recorded, ignore.
 */
async function persistNotification(
  db: Firestore,
  payload: WhatsappNotificationPayload,
  status: 'failed' | 'parked',
  tentativas: number,
  erro: string,
): Promise<void> {
  const docId = payload.messageId ?? notificacoesWhatsappCollection.newDocId(db, {});
  const data = notificacoesWhatsappCollection.parse({
    field: payload.field,
    phoneNumberId: payload.phoneNumberId,
    messageId: payload.messageId,
    status,
    tentativas,
    erro,
    processedAt: Date.now(),
    // Passthrough (untyped) — the replay payload. Admin-only / default-deny doc.
    value: sanitizeValue(payload.value),
  });
  try {
    await notificacoesWhatsappCollection.docRef(db, {}, docId).create(data);
  } catch (err) {
    if (err instanceof Error && (err as { code?: unknown }).code === 6) return; // dup — already recorded
    throw err;
  }
}

/** Advance an existing failure doc's status/retry counter (merge). */
async function markNotification(
  db: Firestore,
  docId: string,
  status: 'failed' | 'parked',
  tentativas: number,
  erro: string,
  now: number,
): Promise<void> {
  await notificacoesWhatsappCollection.merge(db, {}, docId, {
    status,
    tentativas,
    erro,
    processedAt: now,
  });
}

/** Remove a resolved failure doc from the failures-only store (sweep success). */
async function deleteNotification(db: Firestore, docId: string): Promise<void> {
  await notificacoesWhatsappCollection.docRef(db, {}, docId).delete();
}

/** One hour — the reprocess window (mirrors the MP sweep). */
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ReprocessOptions {
  olderThanMs?: number;
  limit?: number;
  now?: number;
}

export interface ReprocessResult {
  processed: number;
  outcomes: Record<string, number>;
  errors: Array<{ docId: string; message: string }>;
}

/**
 * The `onSchedule` reprocess backstop — re-drives persisted `failed`
 * notifications older than the window (the account may have connected since).
 * A resolved delivery (processed, or now-dropped) DELETES the doc; a persistent
 * failure bumps `tentativas` up to `MAX_TENTATIVAS`, then parks. Deduplicated by
 * `messageId` within a run, bounded, and ISOLATED per-doc so one failure never
 * aborts the batch.
 */
export async function reprocessNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  deps: WhatsappProcessDeps = defaultWhatsappProcessDeps,
): Promise<ReprocessResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.olderThanMs ?? ONE_HOUR_MS);
  const max = opts.limit ?? 50;

  const snap = await notificacoesWhatsappCollection
    .ref(db, {})
    .where('status', '==', 'failed')
    .where('processedAt', '<', cutoff)
    .orderBy('processedAt')
    .limit(max)
    .get();

  const seen = new Set<string>();
  const outcomes: Record<string, number> = {};
  const errors: Array<{ docId: string; message: string }> = [];
  let processed = 0;

  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    const messageId = typeof raw.messageId === 'string' ? raw.messageId : '';
    if (messageId && seen.has(messageId)) continue; // dedup by messageId
    if (messageId) seen.add(messageId);

    const doc = notificacoesWhatsappCollection.parseRead(
      raw,
      notificacoesWhatsappCollection.docPath({}, d.id),
    );
    const payload: WhatsappNotificationPayload = {
      field: doc.field,
      phoneNumberId: doc.phoneNumberId,
      messageId: doc.messageId,
      value: raw.value, // the passthrough replay payload
    };
    const tentativas = (doc.tentativas ?? 0) + 1;

    try {
      const result = await processChangePayload(db, payload, deps);
      if (result.kind === 'processed' || result.kind === 'dropped') {
        await deleteNotification(db, d.id);
        outcomes[result.kind] = (outcomes[result.kind] ?? 0) + 1;
      } else {
        const status = tentativas >= MAX_TENTATIVAS ? 'parked' : 'failed';
        await markNotification(db, d.id, status, tentativas, result.reason, now);
        outcomes[status] = (outcomes[status] ?? 0) + 1;
      }
      processed += 1;
    } catch (err) {
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
