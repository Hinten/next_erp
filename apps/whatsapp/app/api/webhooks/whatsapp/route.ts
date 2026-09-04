/**
 * `GET|POST /api/webhooks/whatsapp` — the WhatsApp Cloud API webhook receiver (#527).
 *
 * GET — Meta's subscription verification handshake
 * (https://developers.facebook.com/docs/graph-api/webhooks/getting-started):
 * `hub.mode === 'subscribe'` AND `hub.verify_token === WHATSAPP_VERIFY_TOKEN` →
 * echo `hub.challenge` as `200 text/plain`; a wrong token → 403; a missing
 * mode/challenge → 400.
 *
 * POST — inbound events. The raw body is read ONCE (`req.text()`) and its
 * `X-Hub-Signature-256` HMAC is verified over those exact bytes BEFORE anything
 * else (byte-for-byte — never a re-serialized JSON). The app secret is
 * MANDATORY: unset → 503 (the check is never skipped); a mismatch → 401. The
 * receiver then acks `200 { received: true }` FAST by parsing the envelope into
 * one lean payload per change and ENQUEUEing each onto the
 * `processWhatsappNotification` Cloud Tasks queue — NO Firestore write on the
 * happy path. Malformed/empty bodies are also acked 200 (a retry won't parse
 * either).
 *
 * Resilience: if an enqueue fails (IAM not yet granted / transport / the
 * `WHATSAPP_TASKS_DISABLED` valve), we FALL BACK to persisting that change as
 * `failed` so the reprocess sweep drains it — rather than 5xx, which risks Meta
 * disabling the webhook. Only a TRANSIENT persist failure throws → 5xx so Meta
 * redelivers; a deterministic (validation) persist failure is dropped (acked).
 *
 * No Bearer token and OUT of the `proxy.ts` CORS matcher (`/api/whatsapp/*`) —
 * it's a server→server call from Meta, not a browser request.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { parseWebhookBody, persistNotificationFailure } from '@/lib/whatsapp/notificacao';
import { createWhatsappTaskScheduler } from '@/lib/whatsapp/waTasks';
import { verifyMetaSignature, WhatsappAppSecretMissingError } from '@/lib/signatures/hmac';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(req: Request): NextResponse {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode !== 'subscribe') {
    return NextResponse.json({ error: 'hub.mode inválido' }, { status: 400 });
  }
  // Fail closed: an unset WHATSAPP_VERIFY_TOKEN never matches a supplied token.
  if (token == null || token !== process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse('FORBIDDEN', { status: 403 });
  }
  if (!challenge) {
    return NextResponse.json({ error: 'hub.challenge ausente' }, { status: 400 });
  }
  return new NextResponse(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();

  // Signature gate over the RAW body. Secret unset → 503 (mandatory policy).
  let signatureOk: boolean;
  try {
    signatureOk = verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'));
  } catch (err) {
    if (err instanceof WhatsappAppSecretMissingError) {
      console.error('[whatsapp/webhook] WHATSAPP_APP_SECRET não configurado — 503');
      return NextResponse.json({ error: 'servidor não configurado' }, { status: 503 });
    }
    throw err;
  }
  if (!signatureOk) {
    console.warn('[whatsapp/webhook] rejeitando notificação com X-Hub-Signature-256 inválida');
    return NextResponse.json({ error: 'assinatura inválida' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Ack 200 (not 4xx) so Meta stops retrying — a malformed body won't parse
      // on a retry either.
      console.warn('[whatsapp/webhook] ignorando body não-parseável');
      return NextResponse.json({ received: true });
    }
    throw err;
  }

  // Not a WhatsApp envelope (or no changes) → ack without enqueuing.
  const payloads = parseWebhookBody(body);
  if (!payloads || payloads.length === 0) {
    // ⚠️ This branch was the ONE silent exit in the receiver — no enqueue, no
    // persist, and no log either, unlike the `JSON.parse` branch above it. It
    // acked 200 (so Meta never retries) leaving the delivery with no record
    // anywhere. `webhookEnvelopeSchema` is now a structural skeleton, so a
    // rejection here really does mean "not a WhatsApp envelope" rather than "one
    // field inside it drifted" — but a body Meta signed and we could not read is
    // exactly the thing that must not pass unnoticed.
    console.warn(
      '[whatsapp/webhook] body assinado sem mudanças processáveis — ack sem enfileirar',
      {
        // Structural only. Never the body: it carries customer message content.
        envelope: payloads ? 'sem changes' : 'não reconhecido',
      },
    );
    return NextResponse.json({ received: true });
  }

  const scheduler = createWhatsappTaskScheduler();
  for (const payload of payloads) {
    try {
      await scheduler.enqueue(payload);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      // Enqueue path failed (IAM / transport / disabled valve). Persist as
      // `failed` so the sweep drains it — never 5xx here (Meta would disable the
      // webhook).
      console.warn('[whatsapp/webhook] enqueue falhou — persistindo para o sweep', {
        message: err.message,
      });
      try {
        await persistNotificationFailure(
          getAdminFirestore(),
          payload,
          `enqueue falhou: ${err.message}`,
        );
      } catch (persistErr) {
        // Deterministic (validation) → drop (acked); a transient Firestore error
        // is genuinely retryable → 5xx so Meta redelivers.
        if (persistErr instanceof ZodError) {
          console.warn('[whatsapp/webhook] descartando notificação não-persistível', {
            message: persistErr.message,
          });
          continue;
        }
        throw persistErr;
      }
    }
  }

  return NextResponse.json({ received: true });
}
