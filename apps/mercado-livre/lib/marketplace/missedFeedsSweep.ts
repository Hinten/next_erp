/**
 * Flag-gated Mercado Livre **`missed_feeds` backstop sweep** (#812) — the core
 * behind the `sweepMercadoLivreMissedFeeds` 05:00 `onSchedule` job. Pulls the
 * notifications ML gave up delivering to our callback and re-drives each one
 * through the EXISTING notification queue, i.e. the same idempotent,
 * staleness-gated path a real webhook takes.
 *
 * This closes the port's only unrecoverable loss path. The reprocess sweep can
 * only re-drive notifications that were RECEIVED and persisted; a delivery that
 * never landed leaves no document, so before this sweep a blown ack — a cold
 * start past ML's ~500 ms window, a receiver 5xx, an enqueue outage — lost the
 * event permanently and silently.
 *
 * ⚠️ **What it does NOT recover.** An entry is filed only after ML failed to get
 * a 200 through its ~8 retries (~1h). So the correlated-outage residual window
 * (`functions/DEPLOY.md`, "Durability") is out of reach by construction: there
 * the receiver already ACKED 200, so ML never files the notification as missed.
 * That also dictates how to test it — a deliberate drop must make the receiver
 * answer non-200. `MERCADO_LIVRE_TASKS_DISABLED=1` is NOT a usable drop lever:
 * it still acks 200 (it persists a failure doc instead).
 *
 * Flag-gated OFF: runs ONLY when `MERCADO_LIVRE_MISSED_FEEDS_ENABLED === '1'`
 * (mirrors `ORDER_BACKFILL_FLAG_ENV`). Until the flag is flipped the deployed
 * function ticks, logs one info line and does nothing.
 *
 * ---- **NO CURSOR, and that absence is the design.** `GET /missed_feeds` has no
 * time-filter parameter — only `topic`/`limit`/`offset` — so a cursor could only
 * filter a set we already paid to fetch: zero saved calls, zero saved reads, and
 * a fatal failure mode. An entry is filed ~1h AFTER ML gives up, so one sent at
 * 04:55 lands in the feed at ~05:55, after the 05:00 run; a `sent`-based cursor
 * advanced at 05:00 would sit above it forever. The `OVERLAP_US` trick in
 * `orderBackfill.ts` does not transfer — there the cursor is what BOUNDS a
 * server-side query; here ML's retention is the bound. What replaces it:
 *
 *     SCHEDULE_PERIOD (24h) × 2  ≤  MISSED_FEEDS_RETENTION_HOURS (48h)
 *
 * so every entry is visible on at least one run and usually two. Only an outage
 * longer than the retention loses anything. ⚠️ Whoever changes the cron must
 * re-check that inequality — `functions/src/index.test.ts` asserts the literal.
 *
 * ---- Duplicates are ACCEPTED, not ledgered. With a daily run and 2-day
 * retention each entry surfaces 2–3 times. The cost of one duplicate is a Cloud
 * Task, one indexed `integracao` lookup and one ML refetch; the import is
 * idempotent and staleness-gated, and a duplicate that FAILS re-creates the same
 * failure doc keyed by ML's `_id`, where the store narrows `ALREADY_EXISTS` and
 * keeps the first retry state. A per-`_id` ledger would cost more Firestore ops
 * than the tasks it saves and would make the common case — nothing missed — no
 * cheaper. An in-tick `Set` (shared across contas) is the whole dedup story.
 *
 * ---- Unknown topics are SKIPPED, not enqueued. This is deliberately stricter
 * than the live receiver, which enqueues everything and lets the pipeline park.
 * The receiver must ack within ~500 ms and cannot afford to decide; this sweep
 * replays entries that are already ≥1h old, and the webhook path has ALREADY
 * parked those same `_id`s. Re-driving them daily would only re-touch terminal
 * documents — one new parked doc per unknown topic per day, forever (#813). The
 * per-topic counters are that issue's evidence.
 *
 * ---- Per-conta failure isolation, identical to `orderBackfill`: the catch
 * CONTAINS the expected families (`MercadoLivreError`,
 * `MercadoLivreContaNotConfiguredError`, `MlTasksDisabledError`, and any
 * gRPC-coded transport error) and records them on the conta's health doc;
 * anything unclassifiable is a coding bug and RETHROWS, failing the tick loudly.
 *
 * ---- No `scheduleDelaySeconds`. The receiver delays order-family topics 10s
 * because ML is eventually consistent on FRESH events; a missed feed is ≥1h old
 * by construction, so a delay would only slow the drain.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { millisToMicros } from '@delfrance/core/datetime';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  MercadoLivreError,
  type MlMissedFeed,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import {
  integracaoCollection,
  missedFeedsMercadoLivreCollection,
} from '@delfrance/data/admin/collections';

import { type MlTaskScheduler, MlTasksDisabledError } from './mlTasks';
import { MercadoLivreContaNotConfiguredError, loadMercadoLivreContext } from './mercadoLivre';
import { isKnownTopic, parseNotificationBody, shouldEnqueueTopic } from './notificacao';

/** The env flag gating the sweep — runs ONLY when it is exactly `'1'`. */
export const MISSED_FEEDS_FLAG_ENV = 'MERCADO_LIVRE_MISSED_FEEDS_ENABLED';

/**
 * ML's documented retention for a missed feed. Not read by the code — it is the
 * other half of the scheduling invariant in the module doc, kept here so the
 * number and its consequence live together.
 */
export const MISSED_FEEDS_RETENTION_HOURS = 48;

/** `GET /missed_feeds` page size (ML's own default is 10). */
export const PAGE_LIMIT = 50;

/**
 * Page cap per conta per tick — 1000 entries. Twice `orderBackfill`'s cap
 * because a page here is far cheaper: this sweep does no per-entry ML refetch
 * (that happens downstream, on the rate-limited queue). Hitting it means the
 * receiver was down for hours; the honest recourse is the loud warn, not a
 * resume offset (the feed mutates under expiry, so tomorrow's offset N does not
 * point at today's entry N — a stored offset would SKIP entries as the head
 * expires, which is the late-arrival trap in another coordinate system).
 */
export const MAX_PAGES_PER_TICK = 20;

/** Recorded (and stamped) for an active conta whose ML app id is unusable. */
export const APP_ID_INVALIDO_ERROR = 'MERCADO_LIVRE_CLIENT_ID ausente ou inválido';

/** The sweep's injectable dependencies — production defaults live in the FUNCTIONS wrapper. */
export interface MissedFeedsDeps {
  /** The notification-queue enqueue seam (`createMlTaskScheduler()` in prod). */
  scheduler: MlTaskScheduler;
  /** ONE clock read for the whole tick (`Date.now()` in prod, never re-read here). */
  nowMs: number;
}

/** Per-conta outcome of one sweep tick. */
export interface MissedFeedsContaResult {
  integracaoId: string;
  /** Entries this conta's paged read returned (duplicates included). */
  found: number;
  /** Of those, the ones whose dedup key was first seen in this tick. */
  novos: number;
  /** Enqueueable, newly-seen, parseable entries actually enqueued. */
  enqueued: number;
  /**
   * Rejected by `isKnownTopic` — a topic absent from `TOPIC_DISPOSITION`.
   *
   * ⚠️ Kept SEPARATE from {@link skippedIgnorado} on purpose. This one rising
   * means **a new ML topic appeared** and someone should classify it; the other
   * means the ignore list did its job and is pure noise. Summed into one
   * counter, an operator cannot tell which, and the number that should prompt
   * action gets buried under the number that never should. (Per-topic detail is
   * in the tick summary either way.)
   */
  skippedTopic: number;
  /** Recognised but `ignore` — never enqueued, by design (#813). */
  skippedIgnorado: number;
  /** `parseNotificationBody` returned null (no usable `resource`/`topic`). */
  skippedInvalid: number;
  /** Entries whose `user_id` differs from this conta's — the scope probe. */
  userIdEstranhos: number;
  pages: number;
  /** `true` when `MAX_PAGES_PER_TICK` was hit with backlog remaining. */
  truncated: boolean;
  /** The contained per-conta error message (`null` on success). */
  error: string | null;
}

/**
 * Which scoping `GET /missed_feeds` appears to use — ML does not document
 * whether the response covers the whole application or only the token's seller.
 * The sweep is correct either way (attribution rides each entry's `user_id`),
 * so rather than guessing we OBSERVE it — the same move that settled the webhook
 * signature question from live traffic instead of from the docs. Once this reads `'app-wide'` for a week, a
 * follow-up can collapse to one call on the first healthy conta's token.
 */
export type MissedFeedsEscopo = 'app-wide' | 'per-seller' | 'indeterminado';

/** Whole-tick summary (the `onSchedule` wrapper logs it). */
export interface MissedFeedsSweepResult {
  /** `false` ⇒ the flag is off — nothing was read, nothing was enqueued. */
  enabled: boolean;
  /** `false` ⇒ no usable ML app id — the tick failed closed before any conta. */
  configured: boolean;
  contas: MissedFeedsContaResult[];
  /** Unknown topics seen, by name — the #813 evidence. */
  topicosPulados: Record<string, number>;
  /** ML's recorded HTTP code for OUR endpoint, by code — why the delivery failed. */
  httpCodes: Record<string, number>;
  escopoAparente: MissedFeedsEscopo;
}

/** Narrow a raw doc field to a finite number (tolerates legacy/missing data). */
function numericField(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Admin-SDK Firestore and Cloud Tasks enqueue transport failures surface as
 * `Error`s carrying a numeric gRPC status `code`. Narrowed to the actual gRPC
 * status range (integers 1–16; 0 = OK never rides an error): a coding-bug
 * `Error` that happens to expose some other numeric `code` must NOT be
 * contained — it has to fail the tick loudly. Mirrors `orderBackfill.ts`.
 */
function isGrpcCodedError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/**
 * The per-conta containment boundary (see the module doc): the expected failure
 * families are contained and recorded on the conta's health doc; anything else
 * is a coding bug and must rethrow out of the sweep loop.
 */
function isPerContaContainable(err: unknown): err is Error {
  return (
    err instanceof MercadoLivreError ||
    err instanceof MercadoLivreContaNotConfiguredError ||
    err instanceof MlTasksDisabledError ||
    isGrpcCodedError(err)
  );
}

/**
 * Record a contained per-conta failure: `lastSweepAtUs` + `lastError` are merged
 * WITHOUT the counters, so a stale count can never be read as this run's. A
 * secondary failure while stamping (a correlated Firestore outage) is
 * tolerated-but-logged when it is itself classifiable; an unclassifiable one
 * still rethrows. Mirrors `orderBackfill.recordContaError`.
 */
async function recordContaError(
  db: Firestore,
  integracaoId: string,
  nowUs: number,
  message: string,
): Promise<MissedFeedsContaResult> {
  console.error('[mercado-livre] missed-feeds: conta contida', { integracaoId, error: message });
  try {
    await missedFeedsMercadoLivreCollection.merge(db, {}, integracaoId, {
      lastSweepAtUs: nowUs,
      lastError: message,
    });
  } catch (stampErr) {
    if (!isPerContaContainable(stampErr)) throw stampErr;
    console.error('[mercado-livre] missed-feeds: falha secundária ao registrar lastError', {
      integracaoId,
      cause: message,
      stampError: stampErr.message,
    });
  }
  return {
    integracaoId,
    found: 0,
    novos: 0,
    enqueued: 0,
    skippedTopic: 0,
    skippedIgnorado: 0,
    skippedInvalid: 0,
    userIdEstranhos: 0,
    pages: 0,
    truncated: false,
    error: message,
  };
}

/**
 * The dedup key for one entry — the in-tick `Set` only; the failure doc's own
 * identity is `docIdOf`'s business. ML's `_id` when usable; otherwise a composite
 * of the fields that identify the WORK, because two entries ML filed without an
 * `_id` are indistinguishable by id yet may still be the same job. Worth a warn,
 * not a drop: an entry with no `_id` is a shape ML is not supposed to send.
 *
 * ⚠️ `sent` rides this key but deliberately NOT `docIdOf`'s #807 fallback, which
 * is `<topic>:<resource>` — it varies per delivery, which is what makes it right
 * for "did I already handle this entry in THIS tick" and wrong for "is this the
 * same failure I already recorded".
 */
function dedupKeyOf(entry: MlMissedFeed): string {
  const id = typeof entry._id === 'string' && entry._id.length > 0 ? entry._id : null;
  if (id != null) return id;
  console.warn('[mercado-livre] missed-feeds: entrada sem _id — dedup por composto', {
    topic: entry.topic,
    resource: entry.resource,
  });
  return `${String(entry.topic)}|${String(entry.resource)}|${String(entry.sent)}`;
}

/**
 * The wire object handed to `parseNotificationBody` — ONLY the notification
 * pointer fields, so a replayed payload is shape-identical to a live delivery's.
 *
 * ⚠️ `request`/`response` are dropped on purpose. `sanitizeRemainder` would
 * otherwise JSON-stringify each into a ~512-char string, putting ~1 KB of noise
 * on every enqueued payload AND every persisted failure doc — and `request.url`
 * / `request.headers` is a live leak surface, since #811's named follow-up is a
 * secret path segment on the callback URL, which would then ride into Cloud
 * Logging and Firestore on every replay. `request.data` is deliberately NOT
 * parsed either: it is the same notification as a JSON string, so it buys a
 * `JSON.parse` failure mode and a truncation risk for zero new fields.
 * `response.http_code` is genuinely useful, so it goes into the tick log as a
 * histogram — the whole value at a fraction of the cost.
 *
 * `origem` is the one deliberate addition: a short scalar, not a
 * `notificationResilienceFields()` name, so it survives `sanitizeRemainder` and
 * rides `.passthrough()` onto a failure doc — making a recovered notification
 * greppable. It breaks byte-identity with a live delivery by exactly one key,
 * which is harmless: the failure doc is keyed by `_id` and created under an
 * `ALREADY_EXISTS` guard, so first-writer-wins and the field is informational.
 */
function toWire(entry: MlMissedFeed): Record<string, unknown> {
  return {
    _id: entry._id,
    resource: entry.resource,
    topic: entry.topic,
    user_id: entry.user_id,
    application_id: entry.application_id,
    attempts: entry.attempts,
    sent: entry.sent,
    received: entry.received,
    origem: 'missed_feeds',
  };
}

/** Mutable per-tick accumulators shared across contas. */
interface TickState {
  vistos: Set<string>;
  topicosPulados: Record<string, number>;
  httpCodes: Record<string, number>;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * Sweep ONE conta: page `GET /missed_feeds` and enqueue every known-topic entry
 * not already seen this tick. Throws on any failure — the caller's containment
 * boundary classifies it.
 */
async function sweepConta(
  db: Firestore,
  deps: MissedFeedsDeps,
  appId: string,
  integracaoId: string,
  contaUserId: number | null,
  nowUs: number,
  tick: TickState,
): Promise<Omit<MissedFeedsContaResult, 'error'>> {
  // Account context → live ML API (the exact chain every consumer uses).
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });

  let offset = 0;
  let pages = 0;
  let found = 0;
  let novos = 0;
  let enqueued = 0;
  let skippedTopic = 0;
  let skippedIgnorado = 0;
  let skippedInvalid = 0;
  let userIdEstranhos = 0;
  let truncated = false;

  for (;;) {
    const page = await api.getMissedFeeds({ appId, limit: PAGE_LIMIT, offset });
    pages += 1;
    const messages = page.messages ?? [];
    // ⚠️ Terminate on an EMPTY page, never on a short one. ML documents no max
    // `limit` and no `paging` envelope; if it silently clamps `limit` to 10,
    // every page is "short" and a short-page rule would stop after page 1 —
    // under-reading the feed silently, which is the one failure this whole
    // sweep exists to prevent. One extra empty call is the cheap, correct rule.
    if (messages.length === 0) break;

    found += messages.length;
    for (const entry of messages) {
      const httpCode = entry.response?.http_code;
      if (typeof httpCode === 'number') bump(tick.httpCodes, String(httpCode));

      // The scope probe. Never a FILTER: attribution rides the entry's own
      // `user_id` through `resolveIntegracaoByUserId`, so if the response is
      // app-wide, filtering by the calling conta would discard other sellers'
      // recoverable entries — and an unconnected seller's entry lands in the
      // deferred lane (#808) rather than being lost.
      const entryUserId = entry.user_id == null ? null : String(entry.user_id);
      if (entryUserId != null && contaUserId != null && entryUserId !== String(contaUserId)) {
        userIdEstranhos += 1;
      }

      const key = dedupKeyOf(entry);
      if (tick.vistos.has(key)) continue;
      tick.vistos.add(key);
      novos += 1;

      // Two reasons to skip, counted SEPARATELY because they mean opposite
      // things to an operator.
      //
      // UNKNOWN — a topic absent from TOPIC_DISPOSITION. Enqueuing it would park
      // a fresh document every morning (#813), and the count is the signal that
      // a new ML topic needs classifying.
      //
      // IGNORED — the receiver already refuses these; replaying them here would
      // reintroduce exactly the per-delivery cost the ignore list removes. This
      // sweep is the SECOND producer the `shouldEnqueueTopic` gate exists for.
      //
      // Both clauses are load-bearing and neither implies the other: an unknown
      // topic is not ignored (`shouldEnqueueTopic` returns true for it), and an
      // ignored topic IS known.
      const topic = typeof entry.topic === 'string' ? entry.topic : null;
      if (topic == null || !isKnownTopic(topic)) {
        bump(tick.topicosPulados, topic ?? '(sem topic)');
        skippedTopic += 1;
        continue;
      }
      if (!shouldEnqueueTopic(topic)) {
        bump(tick.topicosPulados, topic);
        skippedIgnorado += 1;
        continue;
      }

      const payload = parseNotificationBody(toWire(entry));
      if (payload == null) {
        skippedInvalid += 1;
        continue;
      }

      // No enqueue options: a missed feed is ≥1h old, so the receiver's 10s
      // refetch delay for fresh order-family events would only slow the drain.
      await deps.scheduler.enqueue(payload);
      enqueued += 1;
    }

    offset += messages.length;
    if (pages >= MAX_PAGES_PER_TICK) {
      truncated = true;
      console.warn('[mercado-livre] missed-feeds TRUNCADO — backlog restante após o cap', {
        integracaoId,
        pages,
        found,
        enqueued,
      });
      break;
    }
  }

  // A truncated tick is a CAPACITY signal, not an error — `lastError` stays
  // null. There is no cursor to hold back: the entries are still in the feed
  // tomorrow (retention ≥ 2× the schedule period).
  await missedFeedsMercadoLivreCollection.merge(db, {}, integracaoId, {
    lastSweepAtUs: nowUs,
    lastError: null,
    lastFoundCount: found,
    lastEnqueuedCount: enqueued,
    lastSkippedCount: skippedTopic + skippedIgnorado + skippedInvalid,
    lastTruncated: truncated,
  });

  return {
    integracaoId,
    found,
    novos,
    enqueued,
    skippedTopic,
    skippedIgnorado,
    skippedInvalid,
    userIdEstranhos,
    pages,
    truncated,
  };
}

/**
 * Derive the apparent scoping of ML's response — purely diagnostic, never a
 * control-flow input (see {@link MissedFeedsEscopo}).
 */
function deriveEscopo(contas: MissedFeedsContaResult[]): MissedFeedsEscopo {
  const ok = contas.filter((c) => c.error == null);
  const comEntradas = ok.filter((c) => c.found > 0);
  if (comEntradas.length === 0) return 'indeterminado';
  // Every conta AFTER the first returned entries it had all already seen ⇒ the
  // contas are being served the same app-wide set.
  if (ok.length >= 2 && ok.slice(1).every((c) => c.found > 0 && c.novos === 0)) return 'app-wide';
  // No entry ever named a seller other than the conta that fetched it.
  if (comEntradas.every((c) => c.userIdEstranhos === 0)) return 'per-seller';
  return 'indeterminado';
}

/**
 * The whole sweep tick: enumerate every ACTIVE Mercado Livre `integracao` and
 * sweep each, failure-isolated per conta. The flag check comes first — off ⇒
 * NOTHING is read or enqueued.
 */
export async function runMissedFeedsSweep(
  db: Firestore,
  deps: MissedFeedsDeps,
): Promise<MissedFeedsSweepResult> {
  const tick: TickState = { vistos: new Set(), topicosPulados: {}, httpCodes: {} };

  if (process.env[MISSED_FEEDS_FLAG_ENV] !== '1') {
    return {
      enabled: false,
      configured: false,
      contas: [],
      topicosPulados: {},
      httpCodes: {},
      escopoAparente: 'indeterminado',
    };
  }

  // The registered ML application id — the same value the webhook origin check
  // compares against, doing double duty as the `app_id` query param.
  //
  // ⚠️ Fail CLOSED, once, and stamp NOTHING. Contrast `webhookOrigin.ts`, which
  // fails OPEN when this is unset: there a wrong rejection would let ML disable
  // a topic, so an unconfigured backend must not be able to stall the stream.
  // Here the only consequence is an idle backstop, and one misconfiguration
  // must not write N per-conta error rows — that buries the real signal.
  const appId = (process.env.MERCADO_LIVRE_CLIENT_ID ?? '').trim();
  if (!/^[1-9]\d*$/.test(appId)) {
    console.error(`[mercado-livre] missed-feeds: ${APP_ID_INVALIDO_ERROR} — tick abortado`);
    return {
      enabled: true,
      configured: false,
      contas: [],
      topicosPulados: {},
      httpCodes: {},
      escopoAparente: 'indeterminado',
    };
  }

  const nowUs = millisToMicros(deps.nowMs);

  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .where('ativo', '==', true)
    .get();

  const contas: MissedFeedsContaResult[] = [];
  for (const doc of snap.docs) {
    const integracaoId = doc.id;
    // The denormalized ML seller id, read raw off the enumerated doc (a soft
    // parseRead of every conta would warn-spam each tick on legacy partial
    // docs). Unlike the order backfill, a missing `user_id` is NOT fatal here:
    // the call needs only a token and the app id, and every entry carries its
    // own seller id. It only costs this conta its scope-probe reference.
    const contaUserId = numericField(doc.data(), 'user_id');

    try {
      const result = await sweepConta(db, deps, appId, integracaoId, contaUserId, nowUs, tick);
      contas.push({ ...result, error: null });
    } catch (err) {
      // The deliberate per-conta containment boundary (module doc): expected
      // failure families are recorded + the loop continues; anything
      // unclassifiable is a coding bug and rethrows out of the sweep.
      if (!isPerContaContainable(err)) throw err;
      contas.push(await recordContaError(db, integracaoId, nowUs, err.message));
    }
  }

  return {
    enabled: true,
    configured: true,
    contas,
    topicosPulados: tick.topicosPulados,
    httpCodes: tick.httpCodes,
    escopoAparente: deriveEscopo(contas),
  };
}
