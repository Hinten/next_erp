/**
 * `POST /api/webhooks/mercado-pago` — #531
 *
 * Mercado Pago payment-notification receiver. MP posts tiny event pointers
 * (`{ type:'payment', data:{ id }, user_id, live_mode }`, or the legacy
 * `?topic=payment&id=…` IPN) to the URL registered for the connected account.
 *
 * Security: MP's `x-signature` is verified ONLY when
 * `MERCADO_PAGO_WEBHOOK_SECRET` is set (invalid → 401); when unset the check is
 * skipped because the real anchor is that the handler RE-FETCHES the full
 * payment from the MP API (with the account's own token) before mutating
 * anything — the webhook body is never trusted (see lib/payments/notificacao.ts).
 *
 * The receiver must answer `200` FAST so MP stops retrying, and do the heavy work
 * asynchronously: validate the body and ENQUEUE the lean payload onto the
 * `processMercadoPagoNotification` Cloud Tasks queue, then ack. The happy path
 * writes NO Firestore document (a document is persisted only when processing
 * fails — the task handler / the enqueue fallback below).
 *
 * Idempotency: handler idempotency keyed by the MP payment id (the pagamento doc
 * id is `String(payment.id)` and the reconcile upserts it, with an update-if-newer
 * guard), so a rare double-delivery is harmless.
 *
 * Resilience: if the enqueue fails (IAM not yet granted / transport / the
 * `MERCADO_PAGO_TASKS_DISABLED` valve), we FALL BACK to persisting the
 * notification as `failed` so the reprocess sweep drains it — rather than 5xx,
 * which risks MP disabling the webhook. Only if that persist ALSO fails with a
 * transient error do we throw → 5xx so MP redelivers.
 *
 * No Bearer token and OUT of the `proxy.ts` CORS matcher — it's a server→server
 * call from MP, not a browser request.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { parseNotificationBody, persistNotificationFailure } from '@/lib/payments/notificacao';
import { createMpTaskScheduler } from '@/lib/payments/mpTasks';
import { verifyMpSignature } from '@/lib/signatures/hmac';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();

  // Signature gate — enforced only when a webhook secret is configured. When it
  // is unset, `verifyMpSignature` returns true (skip): the refetch is the anchor.
  if (!verifyMpSignature(req, raw)) {
    console.warn('[mercado-pago/webhook] rejecting notification with an invalid x-signature');
    return NextResponse.json({ error: 'assinatura inválida' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Ack 200 (not 4xx) so MP stops retrying — a malformed body won't parse on
      // a retry either. Logged for observability.
      console.warn('[mercado-pago/webhook] ignoring unparseable body');
      return NextResponse.json({ received: true });
    }
    throw err;
  }

  // Noise (missing payment id / topic) → ack without enqueuing. The semantic
  // drops (sandbox / merchant_order / unknown collector) are decided in the
  // handler, keyed off the enqueued payload.
  const payload = parseNotificationBody(body, new URL(req.url).searchParams);
  if (!payload) {
    return NextResponse.json({ received: true });
  }

  // Enqueue the lean payload; the queue processes it out-of-band at a bounded
  // rate. No Firestore write on this path.
  try {
    await createMpTaskScheduler().enqueue(payload);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    // The enqueue path failed (IAM not granted / transport / disabled). Persist
    // as `failed` so the reprocess sweep drains it — never 5xx here (MP would
    // disable the webhook).
    console.warn('[mercado-pago/webhook] enqueue failed — persisting for the sweep', {
      message: err.message,
    });
    try {
      await persistNotificationFailure(
        getAdminFirestore(),
        payload,
        `enqueue falhou: ${err.message}`,
      );
    } catch (persistErr) {
      // A validation error is DETERMINISTIC — a 5xx would make MP redeliver the
      // identical body forever and eventually disable the webhook. Ack 200 and
      // drop it. A transient Firestore error is genuinely retryable → 5xx so MP
      // redelivers (which may succeed once Firestore recovers).
      if (persistErr instanceof ZodError) {
        console.warn('[mercado-pago/webhook] dropping unpersistable notification', {
          message: persistErr.message,
        });
        return NextResponse.json({ received: true });
      }
      throw persistErr;
    }
  }

  return NextResponse.json({ received: true });
}
