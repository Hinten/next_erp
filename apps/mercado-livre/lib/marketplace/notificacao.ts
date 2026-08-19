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
 *      deletes them on success, and `reprocessDeferredNotifications` does the
 *      same daily over the ones waiting on a seller to connect.
 *
 * Disposition (`handleNotificationTask`):
 *  - `done`     — the work was performed (or the topic is `ack`): NOTHING is
 *                 persisted. **Which topic does what is stated ONCE, in
 *                 {@link TOPIC_DISPOSITION}** — restating it here is how this
 *                 header and that table drifted apart in the first place;
 *  - transient  — a transient infra failure (Firestore/ML API/network) THROWS so
 *                 the queue retries with backoff; on the FINAL attempt it persists
 *                 `failed` (so the sweep re-drives it) instead of throwing;
 *  - `failed`   — the work itself failed and is worth retrying shortly (a known
 *                 routine ML 500, a final-attempt transient): the hourly sweep
 *                 re-drives it up to `MAX_TENTATIVAS`, then parks it;
 *  - `deferred` — no active integração for the seller YET (#808). This is not a
 *                 failure but a precondition, and the only actor who can clear it
 *                 is a human connecting the account — which may be tomorrow. So
 *                 the doc leaves the hourly pool entirely: it is re-driven once a
 *                 DAY for `MAX_TENTATIVAS_DEFERRED` days, and `redriveDeferredForUserId`
 *                 pulls it back into the hot lane the moment the seller's
 *                 `user_id` lands on an active integração. It used to be `failed`,
 *                 which parked it ~6h in and lost every notification a
 *                 next-business-day connect would have imported;
 *  - `parked`   — terminal, never re-driven. Three causes: a topic absent from
 *                 {@link TOPIC_DISPOSITION}; a `park` topic (data-bearing, importer
 *                 pending); or a notification with no `user_id` at all, which
 *                 nothing can ever make resolvable;
 *  - `dropped`  — two very different things, told apart by the outcome LABEL.
 *                 Unlabelled: a malformed task payload — a coding/enqueue bug,
 *                 logged, no persist, no retry. Labelled `ignorado`: an `ignore`
 *                 topic, which is neither a bug nor logged. Reading a bare
 *                 `dropped` as "coding bug" is exactly the misreading the
 *                 `ack`/`ignore` split exists to prevent.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  INTEGRACAO_TIPO,
  NOTIFICACAO_RESILIENCIA_STATUS,
  notificationResilienceFields,
} from '@delfrance/schemas';
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

import { tryGetAdminBucket } from '../firebase/admin';
import {
  type ItemsApiResolver,
  type MigrationRunner,
  resolveItemsApiFromContext,
  syncItemStatus,
} from './itemsStatusSync';
import { type ClaimImportResult, importClaimMercadoLivre } from './claimImport';
import { type QuestionImportResult, importQuestionMercadoLivre } from './questionImport';
import { resolveContaAtivaPorUserId } from './contaCache';
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
export { MAX_TENTATIVAS, MAX_TENTATIVAS_DEFERRED, TASK_MAX_ATTEMPTS };
export type { ReprocessOptions, ReprocessResult };

/**
 * How many deferred docs one `redriveDeferredForUserId` call moves. A cap rather
 * than a full drain because it runs inside a Firestore TRIGGER, whose job is to
 * cut latency, not to be the only mechanism: whatever it leaves behind the daily
 * deferred sweep picks up. Hitting it is logged, never silent.
 */
export const REDRIVE_PAGE_LIMIT = 500;

/**
 * **Every ML notification topic and what this channel does with it — one table,
 * one place** (#813). Four dispositions, each meaning something an operator can
 * act on differently:
 *
 * | disposition | writes | means |
 * |---|---|---|
 * | `handled` | per handler | a real branch below imports it |
 * | `ack`     | nothing | recognised, and there is genuinely nothing to do |
 * | `park`    | one doc  | data-bearing, handler not written yet — keep a replayable record |
 * | `ignore`  | nothing | ML delivers it routinely, the business decided not to care |
 *
 * The distinction that motivated this table is `ack` vs `ignore`. Both persist
 * nothing, but `ack` reports as `done` — indistinguishable from a notification
 * we actually processed — while `ignore` reports as `dropped/ignorado`, so the
 * outcome counters stop lying about how much work the channel is doing.
 *
 * ⚠️ `items_prices` is `ack` and must STAY in this table even though it has no
 * handler and, per #803, never will: **the ERP owns both price tables** — ML is
 * not a writer of `produto.precos`. Membership is what makes a delivery persist
 * NOTHING; removing it routes the topic to `unknown-topic`, which PARKS a
 * document on EVERY delivery. Do not re-attach a handler.
 *
 * ⚠️ The three `ignore` topics were the expensive half of #813: absent from this
 * table they parked one permanent Firestore document per delivery, and
 * `user-products-families` fires on every family change for a User-Products
 * seller. Unsubscribing them in the ML application manager stops the traffic at
 * the source, but that is a panel checkbox anyone can flip back — and
 * `missed_feeds` replays regardless — so this table is the durable half.
 *
 * ⚠️ A topic ABSENT from this table still parks, deliberately. That is the audit
 * trail for a genuinely new ML topic, and the only signal that one appeared.
 */
export const TOPIC_DISPOSITION = {
  orders_v2: 'handled',
  orders: 'handled',
  items: 'handled',
  shipments: 'handled',
  payments: 'handled',
  claims: 'handled',

  // Recognised, nothing to do.
  //
  // ⚠️ The line between `ack` and `park` is NOT "does a handler exist yet" — it
  // is **does the notification carry content that is lost if we drop it**.
  // A question or a buyer message is a one-time payload: miss the delivery and
  // the text is gone from our side forever, which is why they `park`. The three
  // below announce STATE we can re-read from ML at any time, so a dropped
  // delivery costs nothing but freshness.
  items_prices: 'ack', // #803 — the ERP owns both price tables; nothing to read back
  orders_feedback: 'ack', // legacy's handler was `return;` before any work — dead code
  // Announces that a user_product's stock moved. The quantity is always
  // re-readable at `/user-products/{id}/stock`, and the ERP is the source of
  // truth that PUSHES stock to ML in the first place — so this is a hint about
  // state, not an event carrying content. If a stock feature ever consumes it,
  // it becomes `handled`; it never needs to become `park`.
  'stock-location': 'ack',

  // Data-bearing, handler pending (#532/#533). NOT `ack`: acking these is the
  // data loss #813 was filed about — at the callback cutover they would stop
  // being ingested with no failure doc, no parked doc and no warn line. Parking
  // costs a document per delivery and buys a replayable record until the
  // importers land; the whole stack deploys together, so that window is a
  // review cycle, not production time.
  questions: 'handled',
  messages: 'park',

  // Delivered routinely, deliberately not our business.
  public_offers: 'ignore',
  public_candidates: 'ignore',
  'user-products-families': 'ignore',
} as const satisfies Record<string, 'handled' | 'ack' | 'park' | 'ignore'>;

export type TopicDisposition = (typeof TOPIC_DISPOSITION)[keyof typeof TOPIC_DISPOSITION];

/** Topics this channel recognises at all — the table's keys. */
export const KNOWN_TOPICS: ReadonlySet<string> = new Set(Object.keys(TOPIC_DISPOSITION));

export function isKnownTopic(topic: string): boolean {
  return KNOWN_TOPICS.has(topic);
}

/** Recognised AND deliberately uninteresting — never enqueued, never persisted. */
export function isIgnoredTopic(topic: string): boolean {
  return TOPIC_DISPOSITION[topic as keyof typeof TOPIC_DISPOSITION] === 'ignore';
}

/**
 * Whether a delivery is worth a Cloud Task at all.
 *
 * Used by BOTH producers — the webhook receiver and the `missed_feeds` sweep —
 * because a dispatch-only ignore still pays for the enqueue, the function
 * invocation and the conta lookup before deciding to do nothing. An UNKNOWN
 * topic still enqueues: parking it is how a new ML topic becomes visible.
 */
export function shouldEnqueueTopic(topic: string): boolean {
  return !isIgnoredTopic(topic);
}

/**
 * The lean ML-wire payload the receiver enqueues onto the task queue.
 * Tolerant (`passthrough`, nullable) — ML silently renames/adds fields, and the
 * remainder is what makes a dead-letter row worth reading. `sent`/`received`
 * are already normalized to epoch millis (or null) by `asMillis` before
 * enqueue, so a persisted failure doc can never be rejected on them.
 *
 * This is the SHAPE. Everything that produces one runs {@link normalizeMlWire}
 * first — see {@link mlNotificationTaskSchema} for why the queue boundary binds
 * the two together instead of trusting its input.
 */
const mlNotificationWireSchema = z
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
export type MlNotificationPayload = z.infer<typeof mlNotificationWireSchema>;

/**
 * What the task handler re-validates with on the far side of the Cloud Tasks
 * wire (belt-and-suspenders) — the shape above, preceded by the same
 * normalization the receiver applies.
 *
 * The preprocess is not decoration. `handleTask` DROPS a payload that fails
 * this parse, silently and with no retry, because a failure there is by
 * contract an enqueue bug. That makes "every enqueue site normalized its
 * payload" a load-bearing invariant enforced by nothing: `MlNotificationPayload`
 * is `{…} & Record<string, unknown>`, so TypeScript accepts a raw body at every
 * `enqueue` call, and there are already two producers (the receiver and the
 * order backfill). Normalizing HERE converts that silent drop into a correct
 * parse, and is free when the producer already did it — every coercer in
 * `normalizeMlWire` is idempotent.
 */
export const mlNotificationTaskSchema = z.preprocess(
  (v) =>
    v != null && typeof v === 'object' && !Array.isArray(v)
      ? normalizeMlWire(v as Record<string, unknown>)
      : v,
  mlNotificationWireSchema,
);

// `asInt` (ML's `user_id`/`application_id`/`attempts`) and `asMillis` (its
// `sent`/`received`, ISO-8601 or epoch millis) are the shared receiver coercers
// from `@delfrance/data/admin/notifications` — normalized at the source so a
// persisted failure doc can never be rejected by the strict write validator. ML
// sometimes sends an empty string or a field it later renames. Both live there
// rather than here BECAUSE of #810: the private `asInt` this file used to carry
// had drifted strict (numbers only) while its sibling `asMillis` accepted
// numeric strings, and a `user_id` arriving as a string would have nulled the
// seller id on every delivery — stopping ingestion repo-wide with no error.
function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The wire keys this module owns outright — everything else is the remainder. */
const KNOWN_WIRE_KEYS: ReadonlySet<string> = new Set([
  '_id',
  'id',
  'resource',
  'topic',
  'user_id',
  'application_id',
  'attempts',
  'sent',
  'received',
]);

/**
 * The LOCAL resilience field names, read off the shared builder so they cannot
 * drift from what the pipeline writes. They are stripped from the remainder in
 * BOTH directions: a provider-controlled `status`/`tentativas` must never enter
 * a payload, and a doc being rehydrated by the sweep must not carry its own
 * bookkeeping back into the wire shape.
 */
const RESILIENCE_KEYS: ReadonlySet<string> = new Set(Object.keys(notificationResilienceFields()));

/** Firestore refuses a field named `__anything__`, and an empty field name. */
const RESERVED_FIELD_NAME = /^__.*__$/;

/**
 * Remainder budget. ML's real notification body is ~200 bytes of flat scalars,
 * so in practice nothing here ever fires; it exists because the remainder is
 * unauthenticated attacker-controlled JSON (the origin check in
 * `webhookOrigin.ts` fails OPEN when unconfigured or when `application_id` is
 * absent) and it lands in two places that reject oversize input by THROWING:
 * the Cloud Tasks enqueue and a Firestore document. The byte figure is far
 * below both limits (1 MiB each). It can stay this generous only because
 * Firestore Enterprise auto-creates no single-field indexes — on Standard the
 * per-index-entry limit would bite first.
 */
const REMAINDER_MAX_VALUE_CHARS = 512;
const REMAINDER_MAX_BYTES = 8 * 1024;

function truncate(s: string, max = REMAINDER_MAX_VALUE_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Reduce one remainder value to something Firestore is guaranteed to store.
 * Scalars pass; everything else becomes its JSON text. That is deliberately
 * lossy in shape but never in evidence — a dead-letter row is read by a human,
 * and a legible `{"a":[[1]]}` beats an `INVALID_ARGUMENT` that 5xxes the
 * receiver (which is how ML disables a topic). Returns `undefined` to drop.
 */
function scalarize(v: unknown): string | number | boolean | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return truncate(v);
  try {
    return truncate(JSON.stringify(v) ?? 'null');
  } catch (err) {
    // Circular structures and BigInt — reachable from a Firestore doc value
    // (a DocumentReference is circular), not from a parsed JSON body.
    if (!(err instanceof TypeError)) throw err;
    return null;
  }
}

/**
 * Bound the passthrough remainder so it can never be the reason a notification
 * fails to enqueue or to persist. Keys are sorted first so the budget spends
 * deterministically — a Firestore `data()` does not preserve write order.
 */
function sanitizeRemainder(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let budget = REMAINDER_MAX_BYTES;
  let dropped = 0;
  for (const key of Object.keys(o).sort()) {
    if (key === '' || RESERVED_FIELD_NAME.test(key)) {
      dropped += 1;
      continue;
    }
    const value = scalarize(o[key]);
    if (value === undefined) continue;
    const cost = key.length + (typeof value === 'string' ? value.length : 8);
    if (cost > budget) {
      dropped += 1;
      continue;
    }
    budget -= cost;
    out[key] = value;
  }
  if (dropped > 0) {
    console.warn('[mercado-livre] notification remainder truncated', {
      dropped,
      kept: Object.keys(out).length,
    });
  }
  return out;
}

/**
 * A notification id safe to use as a Firestore DOCUMENT ID — `docIdOf` feeds it
 * straight into `docRef(...).create()`, so an unvalidated one is a PATH, not a
 * name. `"a/b/c"` resolves into a nested subcollection the sweep's top-level
 * query can never see (a silent black hole), and `"a/b"` throws a plain `Error`
 * the receiver rethrows as 5xx — which is how ML disables a topic. Anything
 * refused falls back to null ⇒ an auto id: losing redelivery dedup for a bogus
 * id costs nothing, since no genuine ML id has this shape.
 */
const MAX_DOC_ID_CHARS = 1500;
function asDocId(v: string | null): string | null {
  if (v == null) return null;
  if (v === '.' || v === '..') return null;
  if (v.includes('/') || RESERVED_FIELD_NAME.test(v)) return null;
  return v.length <= MAX_DOC_ID_CHARS ? v : null;
}

/**
 * The failure-doc id for a payload ML gave us no usable `_id`/`id` for — **#807**.
 * Three producers reach that state: the order-backfill sweep (its `orders_v2`
 * notifications are synthesised, so there is no ML event behind them), a
 * `missed_feeds` entry whose `_id` is absent or refused by {@link asDocId}, and a
 * webhook body carrying neither key. Without a fallback each persist mints a
 * fresh auto id, `store.create`'s ALREADY_EXISTS collision — the whole dedup
 * mechanism — never fires, and a repeatedly-failing resource accumulates one dead
 * document per attempt instead of converging on one.
 *
 * `topic` is part of the key because `orders_v2` and `orders` share the
 * `/orders/<id>` resource and are different work; the composite mirrors
 * `missedFeedsSweep.ts`'s in-tick `dedupKeyOf`, minus its `sent` component, which
 * varies per delivery and would defeat the dedup this exists to create. The WHOLE
 * resource rides, not just its last segment: `orders_v2:123` would let
 * `/orders/123` and `/shipments/123` collide into one doc and silently drop a
 * genuinely different notification.
 *
 * The composite is routed back through {@link asDocId}, so a malformed or hostile
 * `topic`/`resource` degrades to an auto id exactly as today rather than becoming
 * a Firestore PATH.
 *
 * ⚠️ Deliberate consequence: a doc that reaches `parked` under a derived id is a
 * terminal tombstone for that `(topic, resource)` — a later failure for the same
 * pair collides and is ignored. That IS the convergence being bought, and the
 * parked doc already records the condition. `resolve`/`drop` DELETE the doc, so a
 * successful re-drive frees the id again.
 *
 * ⚠️ And the key is built from UNTRUSTED wire fields, so it is PREDICTABLE. ML
 * does not sign its callbacks, and the receiver accepts a body whose
 * `application_id` is absent — only a FOREIGN one is 403'd (`route.ts`, #811) —
 * so anyone who can reach the endpoint may post `{topic, resource}` with no id
 * and take `<topic>:<resource>` first. A later genuine failure for that pair then
 * collides and is dropped, leaving the squatter's `erro`/`user_id`/wire fields on
 * the surviving document: a doc under a derived id is NOT guaranteed to be ours.
 * Weigh that against what it replaces rather than against nothing — the same body
 * used to fork a fresh auto-id doc on EVERY delivery, so that endpoint bought
 * unbounded writes instead of one squatted key. Tightening it means tightening
 * the RECEIVER (an origin the id-less path can be trusted from), not this helper.
 */
function derivedDocId(p: MlNotificationPayload): string | null {
  const resource = p.resource.replace(/\/+/g, '_').replace(/^_+|_+$/g, '');
  return asDocId(`${p.topic}:${resource}`);
}

/**
 * Coerce a raw ML body (or a stored failure doc) onto the shapes
 * {@link mlNotificationTaskSchema} accepts, **preserving every other key** as
 * the passthrough remainder.
 *
 * Coercion runs BEFORE the parse, which is what makes the parse total: for any
 * body that clears the `resource`/`topic` gate, the schema cannot fail. It is
 * therefore the TYPE gate, not the trust boundary — the trust boundary is
 * re-fetching the resource from ML with the account token.
 *
 * ⚠️ The `_id` → `id` alias is load-bearing and must survive any refactor here.
 * ML sends `_id` on webhook / `missed_feeds` deliveries and `id` only on
 * realtime, while `docIdOf` keys the failure doc off `id`. Handing the raw body
 * straight to the schema would leave `id` null for every real delivery and mint
 * an auto id instead, silently destroying redelivery dedup. `_id` is dropped
 * afterwards rather than kept in the remainder — it is pure duplication.
 */
function normalizeMlWire(o: Record<string, unknown>): Record<string, unknown> {
  const remainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(o)) {
    if (!KNOWN_WIRE_KEYS.has(key) && !RESILIENCE_KEYS.has(key)) remainder[key] = value;
  }
  return {
    ...sanitizeRemainder(remainder),
    id: asDocId(asString(o._id) ?? asString(o.id)),
    resource: asString(o.resource),
    topic: asString(o.topic),
    user_id: asInt(o.user_id),
    application_id: asInt(o.application_id),
    attempts: asInt(o.attempts),
    sent: asMillis(o.sent),
    received: asMillis(o.received),
  };
}

/** Compact, value-free rendering of a parse failure — safe for an `erro` column. */
const MAX_ISSUE_CHARS = 300;
function describeIssues(issues: readonly { path: PropertyKey[]; code: string }[]): string {
  return truncate(
    issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.code}`).join('; '),
    MAX_ISSUE_CHARS,
  );
}

/**
 * A coercion that discarded a value ML actually sent is the early warning for a
 * wire-format change on their side. Logged by TYPE, never by value — the body
 * is untrusted and this goes to Cloud Logging.
 */
const COERCED_FIELDS = ['user_id', 'application_id', 'attempts', 'sent', 'received'] as const;
function warnOnLossyCoercion(
  raw: Record<string, unknown>,
  normalized: Record<string, unknown>,
): void {
  for (const key of COERCED_FIELDS) {
    if (raw[key] != null && normalized[key] == null) {
      console.warn('[mercado-livre] notification field dropped by coercion', {
        key,
        receivedType: typeof raw[key],
      });
    }
  }
}

/**
 * Extract a persistable notification from the raw ML POST body. Returns null
 * for noise (non-object, or missing `topic`/`resource` — health pings and
 * malformed bodies) so the receiver can ack without enqueuing. Accepts both
 * `_id` (webhook / missed_feeds) and `id` (realtime) as the notification id.
 *
 * The payload is the SCHEMA's output, not a hand-built literal (#810): the
 * literal enumerated eight keys, so every field ML added was stripped here and
 * the `.passthrough()` on both this channel's schemas was dead for anything the
 * receiver produced — making the dead-letter record lossy exactly when it is
 * the only surviving evidence.
 */
export function parseNotificationBody(raw: unknown): MlNotificationPayload | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const normalized = normalizeMlWire(o);

  // The inner shape, since `normalized` already is what the task schema's
  // preprocess would produce — normalizing twice is harmless but re-logs.
  const parsed = mlNotificationWireSchema.safeParse(normalized);
  if (!parsed.success) {
    // A missing `resource`/`topic` is ordinary noise (health pings) — ack
    // quietly. Anything else is unreachable after normalization, so it means
    // the schema and this function have diverged. It must be LOUD: a silent
    // null here is indistinguishable from a ping, which is precisely how #810's
    // second failure mode would have stopped ingestion with no signal at all.
    if (normalized.resource != null && normalized.topic != null) {
      console.error('[mercado-livre] notification failed its own schema after normalization', {
        issues: describeIssues(parsed.error.issues),
      });
    }
    return null;
  }
  warnOnLossyCoercion(o, parsed.data);
  return parsed.data;
}

/**
 * Resolve the owning integração id from the ML seller `user_id` — a single
 * equality query over the denormalized `user_id` field (the old
 * `getContaMercadoLivreByUser_id`: tipo == mercadoLivre, ativo). Returns null
 * when no active account maps to the seller (a `deferred`/`parked` outcome, not
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

/**
 * The seller id an `integracao` document makes RESOLVABLE, or null when it makes
 * none — the same three predicates {@link resolveIntegracaoByUserId} queries on,
 * evaluated against a document in hand instead of against Firestore.
 *
 * That mirroring is the point: `onIntegracaoMercadoLivreChanged` compares this
 * over the event's before/after snapshots to decide whether a write just made a
 * seller resolvable, and it must agree exactly with what the notification pipeline
 * would find a moment later. Keep the two in step — a drift here is a re-drive
 * that fires for an account the sweep will still refuse (or, worse, one that never
 * fires for an account that just connected).
 *
 * Pure and read-free by design, so the trigger can gate on it before touching
 * Firestore at all.
 */
export function userIdResolvivel(doc: Record<string, unknown> | null): number | null {
  if (doc == null) return null;
  if (doc.tipo !== INTEGRACAO_TIPO.mercadoLivre) return null;
  if (doc.ativo !== true) return null;
  return typeof doc.user_id === 'number' ? doc.user_id : null;
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
/**
 * The #532 questions-import seam invoked for `questions` notifications —
 * shaped exactly like {@link ClaimImportRunner}. `resourceId` is the numeric
 * ML question id parsed from the notification's `resource`
 * (`/questions/123` → `123`).
 */
export type QuestionImportRunner = (
  db: Firestore,
  integracaoId: string,
  resourceId: number,
  /** The notification's `sent` (ms), so the importer can tell a 404 race from a deletion. */
  enviadaMs: number | null,
) => Promise<QuestionImportResult>;

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
/**
 * The production #532 question importer. Same seller-token path as
 * `runClaimImport`, with ONE clock read for the whole operation.
 *
 * ⚠️ Milliseconds only — a question touches `chat`/`mensagem`, which are ms,
 * and never the incidente/pedido side, which is µs. There is deliberately no
 * µs twin here to pick the wrong one from.
 */
const runQuestionImport: QuestionImportRunner = async (db, integracaoId, resourceId, enviadaMs) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
  return importQuestionMercadoLivre(
    {
      db,
      api,
      integracaoId,
      conta: {
        userId: asNumberOrNull(ctx.conta.user_id),
        cor: asNumberOrNull(ctx.conta.cor),
      },
      nowMs: Date.now(),
      notificacaoEnviadaMs: enviadaMs,
    },
    resourceId,
  );
};

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
      const message = err.message ?? 'ML HTTP 500';
      console.warn('[mercado-livre] import runner hit ML 500 — not retrying', {
        integracaoId,
        message,
      });
      return { skipped: 'ML_500', message };
    }
    throw err;
  }
}

/** Deterministic result of processing one payload (transient failures THROW). */
export type ProcessOutcome =
  | { kind: 'done'; integracaoId: string } // known topic processed
  | { kind: 'no-account' } // no active integração for the seller
  | { kind: 'unknown-topic'; integracaoId: string } // unsupported topic
  | { kind: 'ignored-topic' } // TOPIC_DISPOSITION says `ignore` — no account resolved, nothing written
  | { kind: 'handler-pendente'; integracaoId: string } // TOPIC_DISPOSITION says `park` — data-bearing, importer not written yet
  | { kind: 'malformed-resource'; integracaoId: string } // items/orders_v2/orders/payments/shipments/claims resource had no parseable id
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
  questionImportRunner?: QuestionImportRunner;
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
  const questionImportRunner = runners.questionImportRunner ?? runQuestionImport;

  // Ignored topics settle BEFORE the account lookup — the cheapest possible
  // answer to "this is not our business". Resolving the conta first would cost a
  // Firestore read on every `user-products-families` delivery, and for a seller
  // who has not connected yet it would return `no-account` and DEFER, writing a
  // document for a topic we have decided to ignore entirely.
  if (isIgnoredTopic(payload.topic)) return { kind: 'ignored-topic' };

  // The query above stays uncached and directly unit-tested;
  // `resolveContaAtivaPorUserId` wraps it with the shared conta cache and the
  // reconnect-drift cross-check (see `contaCache.ts`). It also PRE-WARMS the
  // conta entry that every runner below reads microseconds later.
  const userId = payload.user_id ?? null;
  const integracaoId =
    userId == null
      ? null
      : await resolveContaAtivaPorUserId(db, userId, () => resolveIntegracaoByUserId(db, userId));
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
      return { kind: 'ml-500', integracaoId, message: result.message };
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
      return { kind: 'ml-500', integracaoId, message: result.message };
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
      return { kind: 'ml-500', integracaoId, message: result.message };
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
      return { kind: 'ml-500', integracaoId, message: result.message };
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

  // `questions` — a pre-sale buyer question (#532). Idempotent by ML question
  // id. A question we cannot answer never OPENS a thread, but a delivery for a
  // thread that already exists is still processed: that is the only event that
  // can close the conversa we opened while it was unanswered.
  if (payload.topic === 'questions') {
    const resourceId = parseOrderResourceId(payload.resource);
    if (resourceId == null) return { kind: 'malformed-resource', integracaoId };
    const result = await wrapImportRunner(integracaoId, () =>
      questionImportRunner(db, integracaoId, resourceId, payload.sent ?? null),
    );
    if (result.skipped === 'ML_500') {
      return { kind: 'ml-500', integracaoId, message: result.message };
    }
    if (result.skipped) {
      console.warn('[mercado-livre] question import skipped', {
        integracaoId,
        resourceId,
        skipped: result.skipped,
      });
    }
    return { kind: 'done', integracaoId };
  }

  // Data-bearing, importer not written yet (#532/#533). Parked rather than
  // acked so the delivery leaves a replayable record: the alternative is the
  // silent `done` that #813 was filed about, which at the callback cutover
  // stops ingesting questions and messages with no failure doc, no parked doc
  // and no warn line — indistinguishable from working.
  //
  // ⚠️ When the importer lands, its branch goes ABOVE this line and its topic
  // flips to `handled` in TOPIC_DISPOSITION. That handler MUST THROW on a
  // transient failure (so the queue and sweep retry) and be idempotent keyed by
  // the ML resource id — it must never fall through to a silent success.
  // Only `ack` may reach the end of this function. A `handled` topic that gets
  // here has LOST ITS BRANCH — renamed, deleted, or never written — and acking
  // it would reintroduce #813 through the very table meant to prevent it: no
  // failure doc, no parked doc, no warn line, and an outcome indistinguishable
  // from the import having run. Park instead, so the delivery survives.
  const disposition = TOPIC_DISPOSITION[payload.topic as keyof typeof TOPIC_DISPOSITION];
  if (disposition !== 'ack') {
    return { kind: 'handler-pendente', integracaoId };
  }

  // `ack` — recognised, and there is genuinely nothing to do. Persists nothing.
  return { kind: 'done', integracaoId };
}

export interface TaskResult {
  outcome: 'done' | 'failed' | 'parked' | 'dropped' | 'deferred';
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
    // ML's own event id when it sent one; otherwise a deterministic composite so
    // the id-less producers still dedup on ALREADY_EXISTS — see `derivedDocId`.
    docIdOf: (p) => p.id ?? derivedDocId(p),
    dedupKeyOf: (p) => p.resource,
    // The whole payload, re-normalized: this channel's schema is
    // `.passthrough()`, so a field ML adds without telling us rides along onto
    // the failure doc — true since #810, when the receiver stopped hand-building
    // an 8-key literal. Re-running the normalizer is idempotent (every value is
    // already coerced and bounded) and is what makes that safety a GATE rather
    // than a claim about provenance: `MlNotificationPayload` is
    // `{…} & Record<string, unknown>`, so TypeScript cannot stop a future third
    // enqueue site from handing us something unsanitized.
    toDocFields: (p) => normalizeMlWire(p),
    fromDoc: (parsed, raw) => {
      // `parseRead` is SOFT — it logs and returns the raw document on a schema
      // mismatch — so `parsed` is not to be trusted, and casting it was the one
      // TypeScript assertion left on a message payload in this path (#810).
      // Parse it through the same normalizer + schema the receiver uses.
      const doc =
        parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : raw;
      const result = mlNotificationWireSchema.safeParse(normalizeMlWire(doc));
      if (!result.success) {
        // Subsumes the old hand-rolled N6 ghost check: when a notification doc
        // is concurrently deleted, the sweep's `store.mark()` merge recreates it
        // carrying only {status, tentativas, erro, processedAt}, and
        // `resource: z.string().min(1)` refuses exactly that. Throwing here
        // parks the row with an audit trail instead of letting an undefined
        // `resource` reach `lastSegment` as a TypeError.
        //
        // ⚠️ Keep this message SHORT and value-free. It is written verbatim to
        // the doc's `erro` by `store.mark`; an oversize one makes that write
        // fail, which leaves `processedAt` unadvanced — and a doc whose cursor
        // never moves is re-picked by every single sweep, forever, eating the
        // batch limit.
        throw new Error(
          `Notificação mercado-livre corrompida: campos inválidos (${describeIssues(result.error.issues)})`,
        );
      }
      return result.data;
    },
    process: (db, payload) => processNotificationPayload(db, payload, runners),
    toDisposition: (outcome, payload, phase): NotificationDisposition => {
      if (outcome.kind === 'no-account') {
        // No `user_id` on the wire ⇒ no seller to ever resolve, and nothing the
        // connect re-drive could key on (it queries `user_id ==`). Terminal, and
        // deferring it would only pretend otherwise for a week.
        if (payload.user_id == null) {
          return {
            kind: 'park',
            reason: 'notificação sem user_id — nenhuma conta pode resolvê-la',
          };
        }
        // The seller just has not connected yet (#808). A PRECONDITION, not a
        // failure: the slow lane holds it for days and the `integracao` trigger
        // re-drives it the moment the account lands.
        return { kind: 'defer', reason: noAccountReason(payload) };
      }
      if (outcome.kind === 'unknown-topic') {
        return { kind: 'park', reason: `tópico não suportado: ${payload.topic}` };
      }
      if (outcome.kind === 'ignored-topic') {
        // `drop`, not `resolve`: both persist nothing in the task and both
        // delete in the sweep, but the outcome LABEL is the whole point. As
        // `done` an ignored delivery is indistinguishable from a processed one
        // in the operator counters, which is half of what #813 reports.
        return { kind: 'drop', label: 'ignorado' };
      }
      if (outcome.kind === 'handler-pendente') {
        // Two causes, and the reason has to distinguish them for an operator:
        // a `park` topic is waiting on work we know is unwritten, while a
        // `handled` topic reaching here means a dispatch branch went missing —
        // a regression, not a plan.
        const disposition = TOPIC_DISPOSITION[payload.topic as keyof typeof TOPIC_DISPOSITION];
        return {
          kind: 'park',
          reason:
            disposition === 'handled'
              ? `tópico marcado como 'handled' mas sem branch de dispatch: ${payload.topic}`
              : `tópico com dados e sem importador ainda: ${payload.topic} (#532)`,
        };
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
  // to report; `result` is absent on the transient-failure path.
  //
  // Two outcomes carry no integração id, for opposite reasons: `no-account` is
  // where none resolved, and `ignored-topic` is where we never looked. A
  // structural `in` check covers both and keeps covering any future arm —
  // enumerating the exceptions is what made this a type error when
  // `ignored-topic` was added.
  const integracaoId = r.result && 'integracaoId' in r.result ? r.result.integracaoId : null;
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

/**
 * The DEFERRED lane's backstop (#808) — the same re-drive over the notifications
 * waiting on a seller to connect, on a 24h window instead of 1h and a cap of
 * `MAX_TENTATIVAS_DEFERRED` days instead of `MAX_TENTATIVAS` hours.
 *
 * Call it from the SAME `onSchedule` as `reprocessNotifications`: the window is
 * the cadence, so at a 30-minute schedule this is one indexed query returning
 * nothing 47 runs out of 48. It is also far cheaper per doc than the hot lane —
 * a still-unconnected seller costs one `resolveIntegracaoByUserId` lookup and no
 * ML API call at all — so it cannot threaten the sweep's timeout.
 */
export function reprocessDeferredNotifications(
  db: Firestore,
  opts: ReprocessOptions = {},
  runners: NotificationRunners = {},
): Promise<ReprocessResult> {
  return pipelineFor(runners).reprocessDeferred(db, opts);
}

/** What one connect-time re-drive did, for the caller's log line. */
export interface RedriveResult {
  /** Deferred docs found for this seller. */
  encontradas: number;
  /** Of those, the ones actually moved back into the hot lane. */
  redirecionadas: number;
  /** True when the page cap was hit — the daily sweep drains the remainder. */
  truncado: boolean;
}

/**
 * Pull every notification deferred on THIS seller back into the hot lane, so the
 * next 30-minute sweep imports it (#808). Called from
 * `onIntegracaoMercadoLivreChanged` the moment an `integracao` becomes resolvable
 * for a `user_id` — the OAuth exchange stamping it, an `ativo` flip, or the
 * still-running Flutter app writing it directly.
 *
 * A LATENCY optimisation over `reprocessDeferredNotifications`, never a
 * replacement: everything it misses (a doc past the page cap, a seller whose
 * trigger never fired) still drains daily. That is why hitting the cap only logs.
 *
 * Idempotent, which the trigger's `retry: true` at-least-once delivery requires:
 * it writes fixed values, and a replay finds no deferred docs left to move. A doc
 * deleted between the query and the write resolves `false` from `mergeIfExists`
 * and is simply not counted — never resurrected as a ghost.
 *
 * ⚠️ Its query needs the `(status ASC, user_id ASC)` composite index on
 * `notificacoesMercadoLivre`. Firestore Enterprise auto-creates none and silently
 * full-scans (billing the scan) rather than failing.
 */
export async function redriveDeferredForUserId(
  db: Firestore,
  userId: number,
  limit: number = REDRIVE_PAGE_LIMIT,
): Promise<RedriveResult> {
  const snap = await notificacaoMercadoLivreCollection
    .ref(db, {})
    .where('status', '==', NOTIFICACAO_RESILIENCIA_STATUS.deferred)
    .where('user_id', '==', userId)
    .limit(limit)
    .get();

  const erro = `conta Mercado Livre user_id ${userId} conectada — reprocessando`;
  let redirecionadas = 0;
  for (const d of snap.docs) {
    if (await basePipeline.redrive(db, d.id, erro)) redirecionadas += 1;
  }

  const truncado = snap.docs.length >= limit;
  if (truncado) {
    console.warn(
      '[mercado-livre] redrive atingiu o limite da página — o restante sai na varredura diária',
      {
        userId,
        limit,
      },
    );
  }
  return { encontradas: snap.docs.length, redirecionadas, truncado };
}
