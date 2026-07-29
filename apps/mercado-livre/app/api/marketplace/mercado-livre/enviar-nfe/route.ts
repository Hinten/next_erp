/**
 * `POST /api/marketplace/mercado-livre/enviar-nfe` — manually (re)send an
 * approved NF-e's authorized `nfeProc` XML to the Mercado Livre shipment
 * (`POST /shipments/{id}/invoice_data`) so it leaves `invoice_pending`
 * (Step 12, #739). Body: `{ pedidoId, nfeId }` — the `pedidos/{pedidoId}/nfev4/{nfeId}`
 * document. The route only re-checks eligibility and enqueues; the actual ML
 * call runs in the `processMercadoLivreNfeUpload` task (see
 * `lib/marketplace/nfeUpload.ts` + `lib/marketplace/mlNfeUploadTasks.ts`).
 *
 * Requires `PERM.pedido.write`, NOT the `PERM.integracao.write` the sibling ML
 * admin routes use: the Step-13 callers are expedição staff acting on a pedido
 * screen, and the route mutates pedido-scoped state only (the `mlEnvio` marker
 * on the NF-e doc) — integração credentials are resolved server-side inside
 * the task.
 *
 * Responses: 404 `NFE_NAO_ENCONTRADA` (no such NF-e doc) · 409
 * `NFE_NAO_ELEGIVEL` + machine `reason` (not approved / no XML / homologação /
 * already sent…) · 202 `{ enqueued: false, emAndamento: true }` (a fresh
 * `pendente` marker — a task is already on the queue) · 202
 * `{ enqueued: true }` · 503 `ML_NFE_UPLOAD_ENQUEUE_FAILED` (tasks valve shut,
 * `MERCADO_LIVRE_TASKS_DISABLED=1`).
 */
import { NextResponse } from 'next/server';
import { nfev4Collection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { MlTasksDisabledError } from '@/lib/marketplace/mlTasks';
import { createMlNfeUploadScheduler } from '@/lib/marketplace/mlNfeUploadTasks';
import {
  type NfeUploadDispatch,
  decideNfeUploadDispatch,
  enqueueNfeUpload,
  nfeUploadTaskSchema,
} from '@/lib/marketplace/nfeUpload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type NfeUploadSkipReason = Extract<NfeUploadDispatch, { action: 'skip' }>['reason'];

/** User-facing PT explanation per machine skip `reason` (409 `NFE_NAO_ELEGIVEL`). */
const SKIP_MESSAGES: Record<NfeUploadSkipReason, string> = {
  apagada: 'A NF-e está marcada como apagada.',
  'nao-aprovada': 'A NF-e não está no estado aprovada.',
  'xml-ausente': 'A NF-e aprovada ainda não tem o XML autorizado (xml_nfe_proc) armazenado.',
  'tpamb-homologacao':
    'O XML da NF-e é de homologação (tpAmb=2); apenas notas de produção são enviadas ao Mercado Livre.',
  'marker-write': 'Nada a enviar: a última alteração foi apenas o marcador de envio.',
  'ja-resolvida': 'O envio desta NF-e ao Mercado Livre já foi concluído (enviado ou descartado).',
  'em-andamento': 'Já existe um envio desta NF-e ao Mercado Livre em andamento.',
};

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.pedido.write);
  if ('error' in auth) return auth.error;

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: 'Body JSON inválido.' }, { status: 400 });
    }
    throw err;
  }
  // The task-payload schema IS the body shape — one source of truth.
  const body = nfeUploadTaskSchema.safeParse(parsed);
  if (!body.success) {
    return NextResponse.json(
      { error: 'Body inválido: pedidoId e nfeId são obrigatórios.' },
      { status: 400 },
    );
  }
  const { pedidoId, nfeId } = body.data;

  const db = getAdminFirestore();
  const snap = await nfev4Collection.docRef(db, { pedidoId }, nfeId).get();
  if (!snap.exists) {
    return NextResponse.json(
      { error: 'NF-e não encontrada.', code: 'NFE_NAO_ENCONTRADA' },
      { status: 404 },
    );
  }

  // `before: undefined` on purpose: the route judges the doc from scratch, so a
  // marker stuck in 'erro' (attempts exhausted) or a stale 'pendente' (older
  // than NFE_UPLOAD_PENDENTE_TTL_MS) becomes eligible again — this route IS the
  // manual retry path for those. Only a FRESH 'pendente' reads as em-andamento.
  const nowMs = Date.now();
  const dispatch = decideNfeUploadDispatch(undefined, snap.data(), nowMs);

  if (dispatch.action === 'skip') {
    if (dispatch.reason === 'em-andamento') {
      // A task is already on the queue — nothing to do, but not an error
      // either: the caller just waits for the marker to resolve.
      return NextResponse.json({ enqueued: false, emAndamento: true }, { status: 202 });
    }
    return NextResponse.json(
      { error: SKIP_MESSAGES[dispatch.reason], code: 'NFE_NAO_ELEGIVEL', reason: dispatch.reason },
      { status: 409 },
    );
  }

  try {
    await enqueueNfeUpload(db, createMlNfeUploadScheduler(), body.data, nowMs);
  } catch (err) {
    // Tasks valve shut (MERCADO_LIVRE_TASKS_DISABLED=1) — there is no sweep to
    // fall back on for this queue, so surface the outage; anything else is
    // unexpected and rethrows as a 500.
    if (err instanceof MlTasksDisabledError) {
      return NextResponse.json(
        { error: err.message, code: 'ML_NFE_UPLOAD_ENQUEUE_FAILED' },
        { status: 503 },
      );
    }
    throw err;
  }

  return NextResponse.json({ enqueued: true }, { status: 202 });
}
