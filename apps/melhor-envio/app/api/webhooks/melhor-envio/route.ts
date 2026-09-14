/**
 * `POST /api/webhooks/melhor-envio` — enqueue-first receiver (#681).
 *
 * The raw body is HMAC-verified once, normalized, enqueued and acknowledged.
 * Successful processing writes no notification document; if enqueueing fails,
 * the payload is persisted for the scheduled sweep before the same 200 ACK.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { parseNotificationBody, persistNotificationFailure } from '@/lib/freight/notificacao';
import { createMelhorEnvioTaskScheduler, isMelhorEnvioEnqueueError } from '@/lib/freight/meTasks';
import { verifyHmac } from '@/lib/signatures/hmac';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ACK = { ok: true, received: true } as const;

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.MELHOR_ENVIO_CLIENT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Webhook secret não configurado.' }, { status: 500 });
  }

  const signature = req.headers.get('x-me-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Assinatura ausente.' }, { status: 401 });
  }

  const raw = await req.text();
  if (!verifyHmac({ payload: raw, signature, secret, algorithm: 'sha256', encoding: 'hex' })) {
    return NextResponse.json({ error: 'Assinatura inválida.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }

  const payload = parseNotificationBody(body);
  if (!payload) return NextResponse.json(ACK);

  try {
    await createMelhorEnvioTaskScheduler().enqueue(payload);
  } catch (err) {
    if (!isMelhorEnvioEnqueueError(err)) throw err;
    console.warn('[melhor-envio/webhook] enqueue failed — persisting for the sweep', {
      message: err.message,
    });
    try {
      await persistNotificationFailure(
        getAdminFirestore(),
        payload,
        `enqueue falhou: ${err.message}`,
      );
    } catch (persistErr) {
      if (persistErr instanceof ZodError) {
        console.warn('[melhor-envio/webhook] dropping unpersistable notification', {
          message: persistErr.message,
        });
        return NextResponse.json(ACK);
      }
      throw persistErr;
    }
  }

  return NextResponse.json(ACK);
}
