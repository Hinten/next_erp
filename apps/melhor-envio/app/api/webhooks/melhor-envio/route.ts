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
import { ESTADO_FRETE } from '@delfrance/schemas';
import type { EstadoFrete } from '@delfrance/schemas';
import {
  historicoFreteInicialCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';

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
      return ESTADO_FRETE.entregue;
    case 'released':
      // The label was just printed and is still in the warehouse — the pedido
      // has NOT been posted yet, so we deliberately do nothing (matches the
      // legacy `tasks.dart`, which skips `released`). Only `posted`/`received`
      // mean the parcel actually left for the carrier.
      return null;
    case 'posted':
    case 'received':
      return ESTADO_FRETE.postado;
    case 'canceled':
    case 'cancelled':
      return ESTADO_FRETE.cancelado;
    case 'suspended':
    case 'paused':
      return ESTADO_FRETE.suspenso;
    case 'undelivered':
      return ESTADO_FRETE.falhaNaEntrega;
    default:
      return null;
  }
}

/**
 * Estados a webhook must never re-open. The legacy polling job got this for
 * free: it only queried pedidos whose estado was still "in transit"
 * (`estadosVerificarRastreio`, which excludes `entregue`/`cancelado`), so a
 * terminal pedido was never re-processed. A push webhook has no such filter, so
 * a late or out-of-order event (e.g. a delayed `posted` after `delivered`)
 * could otherwise regress the estado — we guard against that explicitly.
 */
const TERMINAL_ESTADOS: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.entregue,
  ESTADO_FRETE.cancelado,
]);

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
  const currentEstado = frete?.estado;
  const tracking = typeof data.tracking === 'string' ? data.tracking : null;

  // A pedido already in a terminal estado is never re-opened — a late `posted`
  // after `delivered` must not regress it. Tracking-only updates are still
  // allowed (a late event may carry the final tracking code).
  const isTerminal = currentEstado != null && TERMINAL_ESTADOS.has(currentEstado as EstadoFrete);

  // Idempotent over BOTH fields: only persist what would actually change, so a
  // retry that adds `tracking` to an already-applied estado still records it.
  const patch: Record<string, unknown> = {};
  if (!isTerminal && currentEstado !== target) patch['freteInicial.estado'] = target;
  if (tracking !== null && frete?.codRastreio !== tracking) {
    patch['freteInicial.codRastreio'] = tracking;
  }

  if (Object.keys(patch).length === 0) {
    // Nothing would change (terminal estado and/or same tracking) — ack idempotently.
    return NextResponse.json({ ok: true, applied: false });
  }

  // A genuine estado transition gets one `historicoFtIni` audit row, written
  // atomically with the `freteInicial` patch — a crash between the two would
  // otherwise leave state and history diverged. A tracking-only patch (no
  // `freteInicial.estado` key) does NOT append a row, matching the legacy
  // `tasks.dart` worker.
  const batch = db.batch();
  const estadoChanged = typeof patch['freteInicial.estado'] === 'string';
  if (estadoChanged) {
    const historyId = historicoFreteInicialCollection.newDocId(db, { pedidoId: doc.id });
    const historyRef = historicoFreteInicialCollection.docRef(db, { pedidoId: doc.id }, historyId);
    batch.set(
      historyRef,
      historicoFreteInicialCollection.parse({ estado: target, obs: null, data: Date.now() }),
    );
  }
  batch.update(pedidoCollection.docRef(db, {}, doc.id), patch);
  await batch.commit();

  // Report the estado actually in effect (unchanged when terminal).
  const appliedEstado = (patch['freteInicial.estado'] as EstadoFrete | undefined) ?? currentEstado;
  return NextResponse.json({ ok: true, applied: true, estado: appliedEstado ?? null });
}
