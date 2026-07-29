/**
 * `POST /api/marketplace/mercado-livre/enviar-nfe` — manually (re)send an
 * approved NF-e's authorized `nfeProc` XML to the Mercado Livre shipment
 * (`POST /shipments/{id}/invoice_data`) so it leaves `invoice_pending`
 * (Step 12, #739). Body: `{ pedidoId, nfeId }` — the `pedidos/{pedidoId}/nfev4/{nfeId}`
 * document. The route only re-checks eligibility and enqueues — it writes
 * NOTHING to Firestore (zero-write model); the actual ML call runs in the
 * `processMercadoLivreNfeUpload` task (see `lib/marketplace/nfeUpload.ts` +
 * `lib/marketplace/mlNfeUploadTasks.ts`).
 *
 * Requires `PERM.pedido.write`, NOT the `PERM.integracao.write` the sibling ML
 * admin routes use: the Step-13 callers are expedição staff acting on a pedido
 * screen, and the action is pedido-scoped (send THIS pedido's NF-e) —
 * integração credentials are resolved server-side inside the task.
 *
 * Responses: 404 `NFE_NAO_ENCONTRADA` (no such NF-e doc) · 409
 * `NFE_NAO_ELEGIVEL` + machine `reason` (doc-level: not approved / no XML /
 * homologação; pedido-level: pedido missing / frete owned by another
 * integradora / no marketplace integração) · 202 `{ enqueued: true }` · 503
 * `ML_NFE_UPLOAD_ENQUEUE_FAILED` (tasks valve shut,
 * `MERCADO_LIVRE_TASKS_DISABLED=1`).
 *
 * An eligible doc ALWAYS 202s, even if an upload already happened or is in
 * flight: repeat calls are idempotent — the task's live shipment-status gate
 * no-ops a duplicate (substatus leaves `invoice_pending` once the invoice is
 * saved) — and this route is exactly Step 13's manual retry channel.
 */
import { NextResponse } from 'next/server';
import { nfev4Collection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { MlTasksDisabledError } from '@/lib/marketplace/mlTasks';
import { createMlNfeUploadScheduler } from '@/lib/marketplace/mlNfeUploadTasks';
import {
  type NfeUploadDispatch,
  type PedidoUploadCheck,
  decideNfeUploadDispatch,
  nfeUploadTaskSchema,
  shouldUploadForPedido,
} from '@/lib/marketplace/nfeUpload';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type NfeUploadSkipReason = Extract<NfeUploadDispatch, { action: 'skip' }>['reason'];
type PedidoUploadSkipReason = Extract<PedidoUploadCheck, { action: 'skip' }>['reason'];

/** User-facing PT explanation per machine skip `reason` (409 `NFE_NAO_ELEGIVEL`). */
const SKIP_MESSAGES: Record<NfeUploadSkipReason | PedidoUploadSkipReason, string> = {
  apagada: 'A NF-e está marcada como apagada.',
  'nao-aprovada': 'A NF-e não está no estado aprovada.',
  'xml-ausente': 'A NF-e aprovada ainda não tem o XML autorizado (xml_nfe_proc) armazenado.',
  'tpamb-homologacao':
    'O XML da NF-e não é de produção (tpAmb=1 ausente ou tpAmb=2); apenas notas de produção são enviadas ao Mercado Livre.',
  'pedido-nao-encontrado': 'O pedido da NF-e não foi encontrado.',
  'nao-mercado-livre':
    'O frete deste pedido pertence a outra integradora — nada a enviar ao Mercado Livre.',
  'sem-integracao':
    'O pedido não tem integração de marketplace — não há shipment do Mercado Livre para receber a NF-e.',
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

  // `before: undefined` on purpose: no prior snapshot exists here — the route
  // judges the doc from scratch on its intrinsic eligibility (estado / XML /
  // tpAmb). There is no in-flight/already-sent state to consult (zero-write
  // model) — dedup lives in the task's shipment-status gate.
  const dispatch = decideNfeUploadDispatch(undefined, snap.data());
  if (dispatch.action === 'skip') {
    return NextResponse.json(
      { error: SKIP_MESSAGES[dispatch.reason], code: 'NFE_NAO_ELEGIVEL', reason: dispatch.reason },
      { status: 409 },
    );
  }

  // Same single pedido read the trigger performs: only an ML-integrated pedido
  // gets a task.
  const check = await shouldUploadForPedido(db, pedidoId);
  if (check.action === 'skip') {
    return NextResponse.json(
      { error: SKIP_MESSAGES[check.reason], code: 'NFE_NAO_ELEGIVEL', reason: check.reason },
      { status: 409 },
    );
  }

  try {
    await createMlNfeUploadScheduler().enqueue(body.data);
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

  // ALWAYS 202 for an eligible doc — repeat calls are idempotent (the task's
  // shipment gate no-ops a duplicate); this route is Step 13's manual retry.
  return NextResponse.json({ enqueued: true }, { status: 202 });
}
