/**
 * `POST /api/webhooks/melhor-envio`
 *
 * Melhor Envio order-status webhook. ME signs the request with
 * `X-ME-Signature = HMAC-SHA256(rawBody, app client_secret)` (hex). The signed
 * payload **is** the authority — we don't re-fetch the order from ME (so no
 * token / int_frete resolution is needed). We map the ME status to our
 * `EstadoFrete` and idempotently update the pedido found by
 * `freteInicial.printLabelId`, then answer fast so ME stops retrying.
 *
 * No Bearer token and OUT of the `proxy.ts` CORS matcher — it's a server→server
 * call from ME, not a browser request.
 */
import { NextResponse } from 'next/server';
import type { EstadoFrete } from '@delfrance/schemas';
import { pedidoCollection } from '@delfrance/data/admin/collections';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { verifyHmac } from '@/lib/signatures/hmac';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ME order status → `EstadoFrete`, ported from the legacy `tasks.dart` map.
 * Unmapped statuses return `null` (no-op — we never guess or downgrade).
 */
export function meStatusToEstadoFrete(status: string | null | undefined): EstadoFrete | null {
  switch (status) {
    case 'delivered':
      return 'entregue';
    case 'posted':
    case 'released':
    case 'received':
      return 'postado';
    case 'canceled':
    case 'cancelled':
      return 'cancelado';
    case 'suspended':
    case 'paused':
      return 'suspenso';
    case 'undelivered':
      return 'falhaNaEntrega';
    default:
      return null;
  }
}

interface MeWebhookBody {
  event?: unknown;
  data?: { id?: unknown; status?: unknown; tracking?: unknown };
}

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.MELHOR_ENVIO_CLIENT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Webhook secret não configurado.' }, { status: 500 });
  }

  // Fail fast on a missing signature — don't buffer the body for an
  // unauthenticated request. Read the RAW body only to verify the HMAC (a
  // re-serialized JSON wouldn't match).
  const signature = req.headers.get('x-me-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Assinatura ausente.' }, { status: 401 });
  }
  const raw = await req.text();
  if (!verifyHmac({ payload: raw, signature, secret, algorithm: 'sha256', encoding: 'hex' })) {
    return NextResponse.json({ error: 'Assinatura inválida.' }, { status: 401 });
  }

  let body: MeWebhookBody;
  try {
    body = JSON.parse(raw) as MeWebhookBody;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }

  const data = body.data ?? {};
  // ME's `data.id` is the **label** id — what we persisted as
  // `freteInicial.printLabelId` when buying the etiqueta, not a pedido id.
  const labelId = typeof data.id === 'string' ? data.id : null;
  // Prefer the explicit order status; fall back to the event suffix
  // (`order.posted` → `posted`).
  const meStatus =
    typeof data.status === 'string'
      ? data.status
      : typeof body.event === 'string'
        ? body.event.replace(/^order\./, '')
        : null;
  const target = meStatusToEstadoFrete(meStatus);

  // No label id, or a status we don't map → ack so ME stops retrying.
  if (!labelId || !target) {
    return NextResponse.json({ ok: true, applied: false });
  }

  const db = getAdminFirestore();
  const snap = await pedidoCollection
    .ref(db, {})
    .where('freteInicial.printLabelId', '==', labelId)
    .limit(1)
    .get();

  const doc = snap.docs[0];
  if (!doc) {
    // Unknown label (e.g. bought outside this system) — ack, don't write.
    return NextResponse.json({ ok: true, applied: false });
  }

  const frete = (
    doc.data() as { freteInicial?: { estado?: string; codRastreio?: string | null } } | undefined
  )?.freteInicial;
  const tracking = typeof data.tracking === 'string' ? data.tracking : null;

  // Idempotent over BOTH fields: only persist what would actually change, so a
  // retry that adds `tracking` to an already-applied estado still records it.
  const patch: Record<string, unknown> = {};
  if (frete?.estado !== target) patch['freteInicial.estado'] = target;
  if (tracking !== null && frete?.codRastreio !== tracking) {
    patch['freteInicial.codRastreio'] = tracking;
  }

  if (Object.keys(patch).length === 0) {
    // Nothing would change — ack idempotently.
    return NextResponse.json({ ok: true, applied: false });
  }

  await pedidoCollection.docRef(db, {}, doc.id).update(patch);
  return NextResponse.json({ ok: true, applied: true, estado: target });
}
