/**
 * `POST /api/webhooks/mercado-livre` — #290
 *
 * Mercado Livre notification receiver. ML posts `topic` + `resource` callbacks
 * to the URL registered per connected account (the legacy
 * `distribuidorDeNotificacoes` ran `--allow-unauthenticated`); the trust anchor
 * is re-fetching the resource from the ML API with the account token before
 * acting on it — ML does NOT HMAC-sign the body (contrast Shopee, which does —
 * see lib/signatures/hmac.ts for that path), so there is no signature to verify.
 *
 * Origin (#811): the only inbound check available is `checkApplicationId` —
 * a payload announcing a foreign `application_id` is refused 403 before anything
 * is enqueued or written, which removes the anonymous amplification (an enqueue,
 * a Firestore create on the failure path, up to 5 sweep re-drives and one
 * rate-limited ML API call per POST). It fails OPEN when unconfigured or when
 * the field is absent — see lib/marketplace/notificacoes/webhookOrigin.ts for why, and for
 * why ML's published source-IP list was declined. A header-inventory probe used
 * to run first, to settle from live traffic whether ML ever sends a signature
 * header; the first live run answered NO and the probe was removed, so the
 * remaining follow-up is a secret path segment on the callback URL.
 *
 * The receiver must answer `200` FAST so ML stops retrying, and do the heavy
 * work asynchronously. Step 6 (#290/#360): validate the body and ENQUEUE the
 * lean payload onto the `processMercadoLivreNotification` Cloud Tasks queue —
 * which controls the ML API call rate and retries with backoff — then ack. The
 * happy path writes NO Firestore document (the persist-first design cost a write
 * per notification); a document is persisted only when processing fails (the
 * task handler / the enqueue fallback below).
 *
 * Idempotency / dedup: NOT at enqueue time (we ack 200 fast so ML redelivery is
 * rare, and Cloud Tasks task-name dedup carries a latency penalty and collides
 * with the sweep's re-drives). The contract is **handler idempotency keyed by
 * the ML resource id** (every per-topic handler upserts by ML order/item id), so
 * a rare double-delivery is harmless.
 *
 * Resilience: if the enqueue fails (IAM not yet granted / transport / the
 * `MERCADO_LIVRE_TASKS_DISABLED` valve), we FALL BACK to persisting the
 * notification as `failed` so the reprocess sweep drains it — rather than 5xx,
 * which risks ML disabling the topic. Only if that persist ALSO fails do we throw
 * → 5xx so ML redelivers.
 *
 * No Bearer token and OUT of the `proxy.ts` CORS matcher — it's a server→server
 * call from ML, not a browser request.
 *
 * ⚠️ CUTOVER: a seller's ML callback URL is ONE registration. Switching it here
 * MUST be paired with disabling the legacy Flutter notification functions (see
 * functions/DEPLOY.md), or the same notification is ingested by both systems.
 */
import { NextResponse } from 'next/server';
import { logger } from 'firebase-functions/logger';
import { ZodError } from 'zod';

import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  MERCADO_LIVRE_NOTIFICATION_QUEUE,
  parseNotificationBody,
  persistNotificationFailure,
  shouldEnqueueTopic,
} from '@/lib/marketplace/notificacoes/notificacao';
import { createMlTaskScheduler, mlTasksRegion } from '@/lib/marketplace/notificacoes/mlTasks';
import { checkApplicationId } from '@/lib/marketplace/notificacoes/webhookOrigin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Topics whose handlers re-fetch the very resource the notification announces
 * (order/payment/shipment/claim + its messages) — ML is eventually consistent,
 * so an immediate GET can 404 or return data predating the change the
 * notification is about; a short scheduling delay avoids racing ML's own write.
 * Legacy delayed EVERY topic 10s before dispatch (`functions.dart:17-48`); we
 * scope the delay to the topics that actually need it (approved deviation —
 * `items` and the rest keep today's immediate dispatch).
 *
 * `items_prices` was here until #803 removed its handler: with no GET to race,
 * the delay only postponed an ack-and-drop.
 */
const REFETCH_DELAY_TOPICS: ReadonlySet<string> = new Set([
  'orders_v2',
  'orders',
  'payments',
  'shipments',
  'claims',
  // #532 — the handler re-fetches `GET /questions/{id}`, and ML is eventually
  // consistent: an immediate read can 404, or return the status from BEFORE the
  // change the notification is about. Reading a stale `ANSWERED` would classify
  // a freshly-asked question as unanswerable and refuse to open its thread.
  'questions',
  // #532 — the handler re-fetches the announced message and then its pack;
  // ML is eventually consistent, so an immediate read can 404 on a message it
  // has only just accepted.
  'messages',
]);
const REFETCH_SCHEDULE_DELAY_SECONDS = 10;

/**
 * One line per delivery, on EVERY path — including the ones that succeed.
 *
 * ⚠️ Without this the receiver is only observable when it FAILS: the happy path
 * writes nothing to Firestore (by design — `notificacoesMercadoLivre` is
 * failures-only) and logged nothing either, so "ML delivered and we acked 200"
 * and "ML delivered and we deliberately ignored it" were indistinguishable
 * from the outside. During the first live run that ambiguity cost two rounds of
 * guessing: an empty failures collection is the GOOD outcome and the
 * everything-is-broken outcome at the same time, and nothing on the box could
 * tell them apart.
 *
 * Deliberately NOT the request body: the callback URL is a leak surface (#811)
 * and a notification body is provider data. Topic, resource, the seller's
 * `user_id` and the outcome are what a human actually needs, and `resource` is
 * already a bare path like `/items/MLB123`.
 *
 * ⚠️ **`logger`, not `console`** — and this is the ONLY route in the repo that
 * crosses that line, so the reason is written down rather than left to look like
 * an accident. `console.x(msg, obj)` goes through Node's `util.inspect`, which
 * wraps at a ~128-char break length; this context object is past it, so Cloud
 * Run split ONE delivery across several Cloud Logging entries and `regiao` could
 * land apart from the `topic` it belongs to. The repo's 100-odd
 * `console.warn('[prefix]', {…})` calls are fine only because their context
 * objects are small — the convention has a size limit nobody had hit yet.
 * `firebase-functions/logger` writes a single structured JSON line instead, so
 * the entry count no longer depends on how long the payload happens to be, the
 * severity is real INFO rather than a `no-console` compromise, and the fields
 * land in `jsonPayload` where they can be filtered:
 * `jsonPayload.regiao != "us-east1"` finds every misrouted enqueue directly.
 *
 * ⚠️ Import the `firebase-functions/logger` SUBPATH, never the package root —
 * the root pulls the Functions runtime into an App Hosting server bundle.
 */
function logDelivery(
  disposition: 'enfileirado' | 'persistido' | 'ignorado' | 'ruido' | 'descartado',
  payload: { topic: string; resource: string; user_id?: number | null } | null,
  extra?: Readonly<Record<string, unknown>>,
): void {
  logger.info('[mercado-livre/webhook] entrega', {
    disposition,
    topic: payload?.topic ?? null,
    resource: payload?.resource ?? null,
    user_id: payload?.user_id ?? null,
    ...extra,
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Ack 200 (not 4xx) so ML stops retrying — a malformed body won't parse
      // on a retry either. Logged for observability.
      console.warn('[mercado-livre/webhook] ignoring unparseable body');
      return NextResponse.json({ ok: true, accepted: false });
    }
    throw err;
  }

  // Origin gate (#811). A foreign `application_id` cannot have come from ML, so
  // ML never observes this 403 and the topic-disable risk does not apply —
  // unlike the acks above, which exist precisely because ML IS watching.
  const origin = checkApplicationId(body);
  if (origin === 'foreign') {
    console.warn('[mercado-livre/webhook] rejecting notification from a foreign application_id');
    return NextResponse.json({ error: 'application_id desconhecido' }, { status: 403 });
  }
  if (origin === 'absent') {
    // Accepted (see webhookOrigin.ts), but ML documents this field on every
    // topic — if this ever fires for genuine traffic we want to know.
    console.warn('[mercado-livre/webhook] notification without application_id — origin unverified');
  }

  // Noise (health ping / missing topic+resource) → ack without enqueuing.
  const payload = parseNotificationBody(body);
  if (!payload) {
    logDelivery('ruido', null);
    return NextResponse.json({ ok: true, accepted: false });
  }

  // Topics the business decided to ignore never become a Cloud Task (#813).
  // The dispatch also drops them — that arm is the belt-and-braces for a
  // `missed_feeds` replay or an already-queued task — but stopping here is what
  // actually saves the money: an enqueue, a function invocation and a conta
  // lookup, on a topic like `user-products-families` that fires on every family
  // change for a User-Products seller. An UNKNOWN topic still enqueues, so it
  // parks and stays visible.
  if (!shouldEnqueueTopic(payload.topic)) {
    logDelivery('ignorado', payload);
    return NextResponse.json({ ok: true, accepted: false, ignored: true });
  }

  // Enqueue the lean payload; the queue processes it out-of-band at a bounded
  // rate. No Firestore write on this path. Refetch-delay topics get a 10s
  // scheduling delay (see the const above); every other topic is unchanged.
  const enqueueOpts = REFETCH_DELAY_TOPICS.has(payload.topic)
    ? { scheduleDelaySeconds: REFETCH_SCHEDULE_DELAY_SECONDS }
    : undefined;
  let disposition: 'enfileirado' | 'persistido' = 'enfileirado';
  try {
    await createMlTaskScheduler().enqueue(payload, enqueueOpts);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    // The enqueue path failed (IAM not granted / transport / disabled). Persist
    // as `failed` so the reprocess sweep drains it — never 5xx here (ML would
    // disable the topic).
    console.warn('[mercado-livre/webhook] enqueue failed — persisting for the sweep', {
      message: err.message,
    });
    try {
      await persistNotificationFailure(
        getAdminFirestore(),
        payload,
        `enqueue falhou: ${err.message}`,
      );
    } catch (persistErr) {
      // A validation error is DETERMINISTIC — a 5xx would make ML redeliver the
      // identical body forever and eventually disable the topic. Ack 200 and
      // drop it. A transient Firestore error is genuinely retryable → 5xx so ML
      // redelivers (which may succeed once Firestore recovers).
      if (persistErr instanceof ZodError) {
        console.warn('[mercado-livre/webhook] dropping unpersistable notification', {
          message: persistErr.message,
        });
        logDelivery('descartado', payload, { motivo: 'persist ZodError' });
        return NextResponse.json({ ok: true, accepted: false });
      }
      throw persistErr;
    }
    // The enqueue lost, but the notification is durable and the sweep owns it.
    disposition = 'persistido';
  }

  logDelivery(disposition, payload, {
    fila: MERCADO_LIVRE_NOTIFICATION_QUEUE,
    regiao: mlTasksRegion(),
    delaySeconds: enqueueOpts?.scheduleDelaySeconds ?? 0,
  });
  return NextResponse.json({ ok: true, accepted: true });
}
