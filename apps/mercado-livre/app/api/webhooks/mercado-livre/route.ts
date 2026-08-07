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
 * the field is absent — see lib/marketplace/webhookOrigin.ts for why, and for
 * why ML's published source-IP list was declined. `logWebhookHeaders` runs first
 * so the migration window produces evidence of whether ML ever sends a signature
 * header; that verdict decides the follow-up (real check vs secret path segment).
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
 * ⚠️ DUAL-RUN: switching a seller's ML callback URL here MUST be paired with
 * disabling the legacy Flutter notification functions (see functions/DEPLOY.md)
 * or every notification is double-processed.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { parseNotificationBody, persistNotificationFailure } from '@/lib/marketplace/notificacao';
import { createMlTaskScheduler } from '@/lib/marketplace/mlTasks';
import { checkApplicationId, logWebhookHeaders } from '@/lib/marketplace/webhookOrigin';

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
]);
const REFETCH_SCHEDULE_DELAY_SECONDS = 10;

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();

  // Before any rejection, so a refused request's headers are still captured.
  logWebhookHeaders(req);

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
  const parsed = parseNotificationBody(body);
  if (!parsed) {
    return NextResponse.json({ ok: true, accepted: false });
  }

  // Enqueue the lean payload; the queue processes it out-of-band at a bounded
  // rate. No Firestore write on this path. Refetch-delay topics get a 10s
  // scheduling delay (see the const above); every other topic is unchanged.
  const enqueueOpts = REFETCH_DELAY_TOPICS.has(parsed.payload.topic)
    ? { scheduleDelaySeconds: REFETCH_SCHEDULE_DELAY_SECONDS }
    : undefined;
  try {
    await createMlTaskScheduler().enqueue(parsed.payload, enqueueOpts);
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
        parsed.payload,
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
        return NextResponse.json({ ok: true, accepted: false });
      }
      throw persistErr;
    }
  }

  return NextResponse.json({ ok: true, accepted: true });
}
