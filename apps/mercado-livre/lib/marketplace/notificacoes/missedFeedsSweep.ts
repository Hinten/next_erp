/**
 * Daily app-scoped recovery (#812, #1292). Discover a connected account able
 * to read the feed, then drain it ONCE, not once per seller. Routing remains
 * the notification processor's job: preserve each entry's own user_id.
 *
 * No cursor or persistent dedup ledger. Entries arrive late and expire after
 * 48h, so coverage rests on daily scheduling and complete, bounded drains.
 * All expected failures are returned in health; the scheduled wrapper fails an
 * incomplete invocation. Unknown exceptions propagate. Nothing here deploys.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { millisToMicros } from '@delfrance/core/datetime';
import type { MissedFeedsStream } from '@delfrance/schemas';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import { missedFeedsMercadoLivreCollection } from '@delfrance/data/admin/collections';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
  type MercadoLivreApi,
  type MlMissedFeed,
  type MlMissedFeeds,
} from '@delfrance/integrations-mercado-livre';
import { MercadoLivreConfigError } from '../core/mercadoLivre';
import { type MlTaskScheduler, MlTasksDisabledError } from './mlTasks';
import { isKnownTopic, KNOWN_TOPICS, parseNotificationBody, shouldEnqueueTopic } from './notificacao';
import {
  findMissedFeedsAccess, isMissedFeedsSiteRequired, missedFeedsSites,
  MissedFeedsConfigError, PAGE_LIMIT,
} from './missedFeedsAccess';
export { PAGE_LIMIT } from './missedFeedsAccess';

export const MISSED_FEEDS_FLAG_ENV = 'MERCADO_LIVRE_MISSED_FEEDS_ENABLED';
export const MISSED_FEEDS_RETENTION_HOURS = 48;
export const MAX_PAGES_PER_TICK = 20;
/** Leave a minute for durable health and function shutdown (540s endpoint). */
export const MAX_SWEEP_DURATION_MS = 480_000;
export const APP_ID_INVALIDO_ERROR = 'MERCADO_LIVRE_CLIENT_ID ausente ou inválido';
export const NO_ACCESS_ERROR = 'NO_FEED_ACCESS: connect an application-owner account';

export class MissedFeedsBudgetError extends Error {
  constructor() { super('SWEEP_TIME_BUDGET_EXHAUSTED'); this.name = 'MissedFeedsBudgetError'; }
}
export class MissedFeedsIncompleteError extends Error {
  constructor() { super('Mercado Livre missed-feeds coverage is incomplete; inspect app health.'); this.name = 'MissedFeedsIncompleteError'; }
}
export interface MissedFeedsDeps {
  scheduler: MlTaskScheduler;
  /** One wall-clock stamp for this attempt; elapsed time uses a separate clock. */
  nowMs: number;
  monotonicNow?: () => number;
}
export interface MissedFeedsSweepResult {
  enabled: boolean;
  configured: boolean;
  appId: string | null;
  complete: boolean;
  selectedIntegracaoId: string | null;
  examined: number;
  rejected: number;
  queryMode: 'unfiltered' | 'topics' | null;
  streams: MissedFeedsStream[];
  errors: string[];
  topicosPulados: Record<string, number>;
  httpCodes: Record<string, number>;
  healthRecorded: boolean;
}

/** Codes only: error messages/bodies may contain callback URLs or credentials. */
export function missedFeedsErrorCode(err: unknown): string | null {
  if (err instanceof MercadoLivreReauthRequiredError) return err.status == null ? 'ML_REAUTH_REQUIRED' : 'ML_AUTH_' + err.status;
  if (err instanceof MercadoLivreHttpError) return 'ML_HTTP_' + err.status;
  if (err instanceof MercadoLivreNetworkError) return 'ML_NETWORK';
  if (err instanceof MercadoLivreValidationError) return 'ML_BAD_RESPONSE';
  if (err instanceof MercadoLivreConfigError) return 'ML_APP_CREDENTIALS_MISSING';
  if (err instanceof MissedFeedsConfigError) return 'ML_SITE_CONFIG_INVALID';
  if (err instanceof MissedFeedsBudgetError) return 'SWEEP_TIME_BUDGET_EXHAUSTED';
  if (err instanceof MlTasksDisabledError) return 'MERCADO_LIVRE_TASKS_DISABLED';
  if (isGrpcStatusError(err)) return 'GRPC_' + err.code;
  if (err instanceof MercadoLivreError) return 'ML_PROVIDER_ERROR';
  return null;
}

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
    // ⚠️ The SUBTOPIC array, and it is not optional detail (#1322). A replay is
    // supposed to be the same event the webhook lost; dropping `actions` makes
    // it a DIFFERENT one, because two topics dispatch on it. `messages` used to
    // absorb the omission harmlessly (absent ⇒ treated as `created` ⇒ import,
    // so a replayed read receipt merely re-imported), which is why it went
    // unnoticed — but `post_purchase` degrades the other way: absent ⇒ past the
    // unknown-subtopic guard ⇒ an unparseable resource then DROPS in the task
    // phase instead of parking. That is the silent loss #813 exists to prevent,
    // arriving through the one mechanism whose whole job is recovering
    // deliveries nothing else can.
    actions: entry.actions,
    origem: 'missed_feeds',
  };
}

interface TickState {
  vistos: Set<string>;
  topicosPulados: Record<string, number>;
  httpCodes: Record<string, number>;
}
function bump(counter: Record<string, number>, key: string): void {
  const previous = Object.hasOwn(counter, key) ? counter[key]! : 0;
  Object.defineProperty(counter, key, { value: previous + 1, enumerable: true, writable: true, configurable: true });
}
function streamResult(topic: string | null, siteId: string | null): MissedFeedsStream {
  return { topic, siteId, found: 0, novos: 0, enqueued: 0,
    skippedTopic: 0, skippedIgnorado: 0, skippedInvalid: 0,
    pages: 0, complete: false, truncated: false, error: null };
}

async function drainStream(
  api: MercadoLivreApi, appId: string, stream: MissedFeedsStream,
  scheduler: MlTaskScheduler, tick: TickState, checkBudget: () => void,
  firstPage?: MlMissedFeeds,
): Promise<void> {
  let offset = 0;
  let pending = firstPage;
  try {
    for (;;) {
      checkBudget();
      const page = pending ?? await api.getMissedFeeds({
        appId, topic: stream.topic ?? undefined, siteId: stream.siteId ?? undefined,
        limit: PAGE_LIMIT, offset,
      });
      pending = undefined;
      stream.pages += 1;
      if (page.messages.length === 0) { stream.complete = true; return; }
      stream.found += page.messages.length;
      for (const entry of page.messages) {
        checkBudget();
        const httpCode = entry.response?.http_code;
        if (typeof httpCode === 'number') bump(tick.httpCodes, String(httpCode));
        const key = dedupKeyOf(entry);
        if (tick.vistos.has(key)) continue;
        // Mark only after a successful enqueue (or a deliberate skip). A failed
        // enqueue must remain recoverable if the same entry appears elsewhere.
        const topic = entry.topic;
        if (topic == null || !isKnownTopic(topic)) {
          bump(tick.topicosPulados, topic ?? '(sem topic)');
          stream.skippedTopic += 1;
        } else if (!shouldEnqueueTopic(topic)) {
          bump(tick.topicosPulados, topic);
          stream.skippedIgnorado += 1;
        } else {
          const payload = parseNotificationBody(toWire(entry));
          if (payload == null) stream.skippedInvalid += 1;
          else { await scheduler.enqueue(payload); stream.enqueued += 1; }
        }
        tick.vistos.add(key);
        stream.novos += 1;
      }
      offset += page.messages.length;
      if (stream.pages >= MAX_PAGES_PER_TICK) {
        stream.truncated = true;
        stream.error = 'PAGE_BUDGET_EXHAUSTED';
        return;
      }
    }
  } catch (err) {
    const code = missedFeedsErrorCode(err);
    if (code == null) throw err;
    stream.error = code;
  }
}

/** Monotonic attempt watermark (µs); all provider I/O is outside the callback. */
export async function recordMissedFeedsHealth(
  db: Firestore, result: MissedFeedsSweepResult, nowUs: number,
): Promise<boolean> {
  const ref = missedFeedsMercadoLivreCollection.docRef(db, {}, 'app-' + (result.appId ?? 'unconfigured'));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const previous = snap.data();
    if (typeof previous?.lastSweepAtUs === 'number' && previous.lastSweepAtUs >= nowUs) return false;
    const sum = (key: 'found' | 'enqueued' | 'skippedTopic' | 'skippedIgnorado' | 'skippedInvalid') =>
      result.streams.reduce((total, stream) => total + stream[key], 0);
    tx.set(ref, missedFeedsMercadoLivreCollection.parse({
      appId: result.appId, selectedIntegracaoId: result.selectedIntegracaoId,
      lastSweepAtUs: nowUs,
      lastSuccessAtUs: result.complete ? nowUs : previous?.lastSuccessAtUs ?? null,
      complete: result.complete,
      lastError: result.errors.length > 0 ? result.errors.join('; ') : null,
      lastFoundCount: sum('found'), lastEnqueuedCount: sum('enqueued'),
      lastSkippedCount: sum('skippedTopic') + sum('skippedIgnorado') + sum('skippedInvalid'),
      lastTruncated: result.streams.some((stream) => stream.truncated), streams: result.streams,
    }));
    return true;
  });
}

export async function runMissedFeedsSweep(
  db: Firestore, deps: MissedFeedsDeps,
): Promise<MissedFeedsSweepResult> {
  const result: MissedFeedsSweepResult = {
    enabled: process.env[MISSED_FEEDS_FLAG_ENV] === '1', configured: false,
    appId: null, complete: false, selectedIntegracaoId: null, examined: 0, rejected: 0,
    queryMode: null, streams: [], errors: [], topicosPulados: {}, httpCodes: {}, healthRecorded: false,
  };
  if (!result.enabled) return result;
  const clock = deps.monotonicNow ?? (() => performance.now());
  const deadline = clock() + MAX_SWEEP_DURATION_MS;
  const checkBudget = () => { if (clock() >= deadline) throw new MissedFeedsBudgetError(); };
  const tick: TickState = { vistos: new Set(), topicosPulados: result.topicosPulados, httpCodes: result.httpCodes };
  const appId = (process.env.MERCADO_LIVRE_CLIENT_ID ?? '').trim();
  if (!/^[1-9]\d*$/.test(appId)) result.errors.push(APP_ID_INVALIDO_ERROR);
  else {
    result.appId = appId;
    try {
      const sites = missedFeedsSites();
      result.configured = true;
      const access = await findMissedFeedsAccess(db, appId, sites[0]!, checkBudget, (examined, rejected) => {
        result.examined = examined;
        result.rejected = rejected;
      });
      result.examined = access.examined;
      result.rejected = access.rejected;
      if (access.selected == null) result.errors.push(NO_ACCESS_ERROR);
      else {
        const { api, integracaoId, firstItemsPage } = access.selected;
        result.selectedIntegracaoId = integracaoId;
        // Always recover items explicitly; an unfiltered 200 proves no item
        // coverage. Reuse the access probe instead of requesting page 0 twice.
        for (const site of sites) {
          const stream = streamResult('items', site);
          result.streams.push(stream);
          await drainStream(api, appId, stream, deps.scheduler, tick, checkBudget,
            site === sites[0] ? firstItemsPage : undefined);
        }
        let globalPage: MlMissedFeeds | undefined;
        const globalStream = streamResult(null, null);
        try {
          checkBudget();
          globalPage = await api.getMissedFeeds({ appId, limit: PAGE_LIMIT, offset: 0 });
          result.queryMode = 'unfiltered';
        } catch (err) {
          if (!isMissedFeedsSiteRequired(err)) {
            const code = missedFeedsErrorCode(err);
            if (code == null) throw err;
            globalStream.error = code;
            result.streams.push(globalStream);
            throw err;
          }
          result.queryMode = 'topics';
        }
        if (globalPage != null) {
          result.streams.push(globalStream);
          await drainStream(api, appId, globalStream, deps.scheduler, tick, checkBudget, globalPage);
        } else {
          const topics = [...KNOWN_TOPICS].filter((topic) => topic !== 'items' && shouldEnqueueTopic(topic)).sort();
          for (const topic of topics) {
            const stream = streamResult(topic, null);
            result.streams.push(stream);
            await drainStream(api, appId, stream, deps.scheduler, tick, checkBudget);
          }
        }
        for (const stream of result.streams) if (!stream.complete) {
          result.errors.push((stream.topic ?? 'all') + '/' + (stream.siteId ?? '-') + ': ' + (stream.error ?? 'INCOMPLETE'));
        }
        result.complete = result.errors.length === 0 && result.streams.every((stream) => stream.complete);
      }
    } catch (err) {
      const code = missedFeedsErrorCode(err);
      if (code == null) throw err;
      result.errors.push(code);
    }
  }
  result.healthRecorded = await recordMissedFeedsHealth(db, result, millisToMicros(deps.nowMs));
  return result;
}
