/**
 * Mercado Livre webhook ingestion core (Step 6) — the persist-first resilient
 * pipeline shared by the receiver route and the nested Cloud Functions.
 *
 * Flow: the receiver persists the raw ML notification BLIND (keyed by `_id`,
 * natural dedup) and acks 200 fast; `processNotification` — driven by the
 * `onDocumentCreated` trigger AND the `onSchedule` reprocess sweep — resolves
 * the owning integração by the ML `user_id`, then dispatches by topic.
 *
 * Disposition (ports the legacy `notificationMercadoLivreRealTime` intent):
 *  - `done`     — a known topic was applied (no-op in this foundation until the
 *                 per-topic handlers land in Steps 9–14);
 *  - `parked`   — a genuinely unrecognized topic, or a still-unresolvable
 *                 account after `MAX_TENTATIVAS` sweeps: terminal, never retried
 *                 (avoids the retry-storm the foundation would otherwise cause);
 *  - `failed`   — a resolvable-later problem (no active integração yet): the
 *                 sweep re-drives it, incrementing `tentativas` up to the cap;
 *  - a THROW    — a transient infrastructure failure (Firestore/ML API/network):
 *                 the trigger's `{ retry: true }` (Eventarc) and the sweep both
 *                 retry it. `processNotification` itself never wraps these.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  integracaoCollection,
  notificacaoMercadoLivreCollection,
} from '@delfrance/data/admin/collections';

/** Local reprocess cap — after this many sweeps a `failed` doc is parked. */
export const MAX_TENTATIVAS = 5;

/**
 * The ML notification topics the pipeline recognizes. Known topics are ACKED
 * (marked `done`) even before their handler exists, so the foundation is
 * exercisable without retry-storming; only genuinely-unknown topics park.
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

/** The receiver-side extraction of a raw ML POST body. */
export interface ParsedNotification {
  /** ML notification id (`_id`/`id`) → the Firestore doc id (null ⇒ auto-id). */
  id: string | null;
  /** The fields to persist (validated + defaulted by the collection schema). */
  fields: Record<string, unknown>;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

/**
 * Extract a persistable notification from the raw ML POST body. Returns null
 * for noise (non-object, or missing `topic`/`resource` — health pings and
 * malformed bodies) so the receiver can ack without persisting. Accepts both
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
    fields: {
      id,
      resource,
      topic,
      user_id: asInt(o.user_id),
      application_id: asInt(o.application_id),
      attempts: asInt(o.attempts),
      sent: o.sent ?? null,
      received: o.received ?? null,
      status: 'pending',
      tentativas: 0,
      erro: null,
      processedAt: null,
    },
  };
}

/**
 * Resolve the owning integração id from the ML seller `user_id` — a single
 * equality query over the denormalized `user_id` field (the old
 * `getContaMercadoLivreByUser_id`: tipo == mercadoLivre, ativo). Returns null
 * when no active account maps to the seller (a `failed`/`parked` outcome, not
 * a throw).
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

export type NotificacaoOutcome =
  | 'gone' // the doc no longer exists
  | 'skip' // already terminal (done/parked)
  | 'done' // known topic acked
  | 'failed' // no active account yet — the sweep will re-drive
  | 'parked'; // terminal: unknown topic, or unresolvable after the cap

export interface ProcessResult {
  outcome: NotificacaoOutcome;
  integracaoId?: string;
  topic?: string;
}

/**
 * Process one persisted notification idempotently. Safe to call from both the
 * create trigger and the sweep: a terminal doc (`done`/`parked`) is skipped,
 * and every path is a content-only status write, so an at-least-once replay
 * never double-applies.
 */
export async function processNotification(db: Firestore, docId: string): Promise<ProcessResult> {
  const ref = notificacaoMercadoLivreCollection.docRef(db, {}, docId);
  const snap = await ref.get();
  if (!snap.exists) return { outcome: 'gone' };

  const doc = notificacaoMercadoLivreCollection.parseRead(
    snap.data(),
    notificacaoMercadoLivreCollection.docPath({}, docId),
  );
  if (doc.status === 'done' || doc.status === 'parked') return { outcome: 'skip' };

  const tentativas = (doc.tentativas ?? 0) + 1;
  const now = Date.now();

  const integracaoId = await resolveIntegracaoByUserId(db, doc.user_id ?? null);
  if (!integracaoId) {
    // No active account maps to this seller. Retry via the sweep until the cap
    // (an account may connect shortly after), then park it terminally.
    const status = tentativas >= MAX_TENTATIVAS ? 'parked' : 'failed';
    await mark(db, docId, {
      status,
      tentativas,
      erro: `integração ativa do Mercado Livre não encontrada para user_id ${doc.user_id}`,
      processedAt: now,
    });
    return { outcome: status };
  }

  if (!isKnownTopic(doc.topic)) {
    await mark(db, docId, {
      status: 'parked',
      tentativas,
      erro: `tópico não suportado: ${doc.topic}`,
      processedAt: now,
    });
    return { outcome: 'parked', integracaoId, topic: doc.topic };
  }

  // A known topic. The per-topic handlers land in later steps; here the
  // foundation acks it so the pipeline is exercisable end-to-end. A transient
  // failure inside a future handler must THROW (so the trigger/sweep retry) —
  // it must never fall through to this `done` write.
  await mark(db, docId, { status: 'done', tentativas, erro: null, processedAt: now });
  return { outcome: 'done', integracaoId, topic: doc.topic };
}

/** Content-only status write (merge — never clobbers the ML wire fields). */
async function mark(
  db: Firestore,
  docId: string,
  patch: { status: string; tentativas: number; erro: string | null; processedAt: number },
): Promise<void> {
  await notificacaoMercadoLivreCollection.merge(db, {}, docId, patch);
}

/** One hour — the legacy `manageNotificationsMercadoLivre` reprocess window. */
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ReprocessOptions {
  /** Only re-drive notifications received before `now - olderThanMs`. */
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
 * The `onSchedule` reprocess backstop — re-drives notifications still
 * `pending`/`failed` and older than the window (the create trigger may have
 * missed them, or a `failed` account has since connected). Deduplicated by
 * `resource` within a run (the old `jaFeito` set), bounded, and ISOLATED
 * per-doc so one failure never aborts the batch (the doc stays pending/failed
 * and is retried next run). The caller logs the returned counts/errors — this
 * core stays free of the functions logger so the receiver route can reuse it.
 */
export async function reprocessNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
): Promise<ReprocessResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.olderThanMs ?? ONE_HOUR_MS);
  const max = opts.limit ?? 50;

  const snap = await notificacaoMercadoLivreCollection
    .ref(db, {})
    .where('status', 'in', ['pending', 'failed'])
    .where('received', '<', cutoff)
    .orderBy('received')
    .limit(max)
    .get();

  const seenResource = new Set<string>();
  const outcomes: Record<string, number> = {};
  const errors: Array<{ docId: string; message: string }> = [];
  let processed = 0;

  for (const d of snap.docs) {
    const resource =
      typeof (d.data() as { resource?: unknown }).resource === 'string'
        ? (d.data() as { resource: string }).resource
        : '';
    if (resource && seenResource.has(resource)) continue; // dedup by resource
    if (resource) seenResource.add(resource);

    try {
      const res = await processNotification(db, d.id);
      outcomes[res.outcome] = (outcomes[res.outcome] ?? 0) + 1;
      processed += 1;
    } catch (err) {
      // Batch-isolation boundary: a transient failure on one notification must
      // not abort the sweep. Non-Error throws still propagate.
      if (!(err instanceof Error)) throw err;
      errors.push({ docId: d.id, message: err.message });
    }
  }

  return { processed, outcomes, errors };
}
