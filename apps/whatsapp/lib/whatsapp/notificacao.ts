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
  defineNotificationPipeline,
  MAX_TENTATIVAS,
  type NotificationDisposition,
  type ReprocessOptions,
  type ReprocessResult,
  TASK_MAX_ATTEMPTS,
} from '@delfrance/data/admin/notifications';
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
import type { StatusesReport } from './processStatus';
import type { MediaCacheContext } from './media';

/**
 * The deployed `onTaskDispatched` function name — which is ALSO its
 * auto-provisioned Cloud Tasks queue name. Single source of truth, shared by the
 * producer (`waTasks.ts` builds the region-qualified queue path from it) and the
 * consumer (the nested `functions/` codebase — the `export const` there MUST be
 * named exactly this). Rename in BOTH places.
 */
export const WHATSAPP_NOTIFICATION_QUEUE = 'processWhatsappNotification';

// The retry caps and the reprocess window are the SHARED pipeline's — re-exported
// here so this module stays the one import site for the channel's callers.
export { MAX_TENTATIVAS, TASK_MAX_ATTEMPTS };
export type { ReprocessOptions, ReprocessResult };

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
  return {
    kind: 'dropped',
    reason: `campo não suportado: ${payload.field}`,
    detail: 'campo-nao-suportado',
  };
}

export interface TaskResult {
  outcome: 'done' | 'failed' | 'dropped';
  contaId?: string;
  field?: string;
  /**
   * The channel's own `ProcessOutcome` discriminant, so the caller can tell an
   * unsupported-field drop from a malformed-value drop — and both from the
   * shared pipeline's schema-parse drop, which is a CODING BUG and carries no
   * `result` at all.
   */
  kind?: ProcessOutcome['kind'];
  /**
   * What the change actually did. Widened to `string` deliberately: this is the
   * log-facing shape, and `MessagesFieldOutcome` is the narrow union the
   * PRODUCER is held to.
   */
  detail?: string;
  /**
   * What the change's `statuses[]` batch did, absent when it carried none.
   *
   * ⚠️ Counts, not a `detail` member: one batch can carry entries with DIFFERENT
   * fates, which no single enum value can express. It also rides out whichever
   * arm of the `detail` chain won, so an `echo` no longer hides applied statuses.
   */
  statuses?: StatusesReport;
}

/** Drop `undefined` (Firestore rejects it) from the replayed change value. */
function sanitizeValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * The shared pipeline, bound to this channel. Built per call so the injectable
 * `deps` stay per-call (the factory only closes over config — no I/O, no state).
 *
 * The two WhatsApp-specific choices here:
 *  - the failure doc is keyed by the WA `messageId` (auto-id when the change
 *    carries none — a template/account update has no single message subject);
 *  - it CARRIES the raw change `value`. Unlike Mercado Pago/Livre there is no
 *    re-fetch anchor — the message content exists ONLY in the webhook body — so
 *    the sweep has to REPLAY it rather than re-read it from Meta. That value was
 *    signature-verified by the receiver and the collection is admin-only /
 *    default-deny, so no client can ever read it back.
 */
function pipelineFor(deps: WhatsappProcessDeps) {
  return defineNotificationPipeline<WhatsappNotificationPayload, ProcessOutcome>({
    channel: 'whatsapp',
    collection: notificacoesWhatsappCollection,
    // The cast preserves the pre-existing one at the old `parse` call site: the
    // schema's `value: z.unknown()` infers as OPTIONAL (`unknown` includes
    // undefined), while the payload declares it required. The runtime shape is
    // identical — `parseWebhookBody` always sets it.
    taskSchema: whatsappNotificationTaskSchema as unknown as z.ZodType<WhatsappNotificationPayload>,
    docIdOf: (p) => p.messageId,
    dedupKeyOf: (p) => p.messageId,
    toDocFields: (p) => ({
      field: p.field,
      phoneNumberId: p.phoneNumberId,
      messageId: p.messageId,
      // Passthrough (untyped) — the replay payload.
      value: sanitizeValue(p.value),
    }),
    fromDoc: (parsed, raw) => {
      const doc = parsed as {
        field: string;
        phoneNumberId: string | null;
        messageId: string | null;
      };
      return {
        field: doc.field,
        phoneNumberId: doc.phoneNumberId,
        messageId: doc.messageId,
        value: raw.value, // the passthrough replay payload
      };
    },
    process: (db, payload) => processChangePayload(db, payload, deps),
    toDisposition: (outcome): NotificationDisposition => {
      if (outcome.kind === 'processed') return { kind: 'resolve', label: 'processed' };
      if (outcome.kind === 'dropped') return { kind: 'drop', reason: outcome.reason };
      return { kind: 'fail', reason: outcome.reason };
    },
  });
}

const basePipeline = pipelineFor(defaultWhatsappProcessDeps);

/**
 * Persist a notification as `failed` (the sweep will re-drive it). The receiver
 * also calls this as a fallback when the enqueue itself fails, so Meta never sees
 * a 5xx during an enqueue-path outage.
 */
export function persistNotificationFailure(
  db: Firestore,
  payload: WhatsappNotificationPayload,
  erro: string,
): Promise<void> {
  return basePipeline.persistFailure(db, payload, erro);
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
  const r = await pipelineFor(deps).handleTask(db, data, retryCount);
  // `payload` is absent only on the schema-parse drop, where there is no field
  // to report; `result` is absent on the transient-failure path.
  //
  // Structural `in` checks rather than `r.result?.kind === 'processed'`: all
  // three fields ride on one arm today, and an equality narrow silently stops
  // covering them the moment another arm gains one — whereas the `in` check keeps
  // compiling and keeps reporting.
  const contaId = r.result && 'contaId' in r.result ? r.result.contaId : null;
  const detail = r.result && 'detail' in r.result ? r.result.detail : null;
  // `statuses` is required-and-nullable on the arm, so this narrows in one step:
  // null means the change carried no `statuses` key, never "we forgot to set it".
  const statuses = r.result && 'statuses' in r.result ? r.result.statuses : null;
  return {
    // WhatsApp produces neither a `park` nor a `defer` disposition, so both
    // arms are unreachable here — mapped defensively rather than widening this
    // channel's public union with arms it cannot emit (mirrors Mercado Pago).
    outcome: r.outcome === 'parked' || r.outcome === 'deferred' ? 'failed' : r.outcome,
    ...(contaId != null ? { contaId } : {}),
    ...(r.payload ? { field: r.payload.field } : {}),
    // `kind` needs no `in` check — every arm of a discriminated union has it, so
    // the `r.result` presence guard is the whole condition.
    ...(r.result ? { kind: r.result.kind } : {}),
    ...(detail != null ? { detail } : {}),
    ...(statuses != null ? { statuses } : {}),
  };
}

/**
 * The `onSchedule` reprocess backstop — re-drives persisted `failed`
 * notifications older than the window (the account may have connected since).
 * A resolved delivery (processed, or now-dropped) DELETES the doc; a persistent
 * failure bumps `tentativas` up to `MAX_TENTATIVAS`, then parks. Deduplicated by
 * `messageId` within a run, bounded, and ISOLATED per-doc so one failure never
 * aborts the batch.
 */
export function reprocessNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  deps: WhatsappProcessDeps = defaultWhatsappProcessDeps,
): Promise<ReprocessResult> {
  return pipelineFor(deps).reprocess(db, opts);
}
