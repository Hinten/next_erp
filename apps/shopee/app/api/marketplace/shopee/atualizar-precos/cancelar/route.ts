/**
 * `POST /api/marketplace/shopee/atualizar-precos/cancelar` — stop one Shopee
 * price update (#1521, step 13). Body: `{ integracaoId, jobId }`, both
 * document ids. Requires `PERM.integracao.write`.
 *
 * The cancel is ONE terminal stamp through the job's single transaction
 * (`cancelarEnvioPrecoShopee`), which re-derives "still running" and "this
 * conta's job" from its own read; there is nothing to tell the queue. An
 * in-flight dispatch finishes the listing it is sending (its checkpoint writes
 * no `status`) and its next status read answers `noop`, so tasks already queued
 * drain as no-ops. The abandoned queue is recorded as `filaRestante` plus ONE
 * `job-cancelado` report row.
 *
 * ⚠️ It is also the recovery for a job that is `running` with NO worker — an
 * enqueue that succeeded and never dispatched (a region mismatch, a missing
 * `run.invoker` grant) — short of the start's six-hour orphan reclaim.
 *
 * 200 `{status:'cancelled'}` · 409 `SHOPEE_PRICE_SYNC_NOT_RUNNING` for a job
 * already terminal · 404 for a missing job AND for another conta's job — one
 * leak, one answer: whether this id exists at all is a fact about another
 * account.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { cancelarEnvioPrecoShopee } from '@/lib/shopee/precos/atualizarPrecos';
import { MSG_BODY_INVALIDO, lerJsonDoCorpo } from '@/lib/shopee/produtos/corpoImportacao';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The code a job that already reached a terminal state answers. */
export const CODIGO_ENVIO_PRECO_NAO_EM_ANDAMENTO = 'SHOPEE_PRICE_SYNC_NOT_RUNNING';

/** One sentence for both leaks, because they are the same leak. */
export const MSG_ENVIO_PRECO_NAO_ENCONTRADO = 'Atualização de preços não encontrada.';

const MSG_INTEGRACAO_ID_INVALIDO = 'integracaoId deve ser um id de documento (sem "/" nem "..").';
const MSG_JOB_ID_INVALIDO = 'jobId deve ser um id de documento (sem "/" nem "..").';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const json = await lerJsonDoCorpo(req);
  if (!json.ok) return NextResponse.json({ error: json.erro }, { status: 400 });
  const bruto = json.valor;
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return NextResponse.json({ error: MSG_BODY_INVALIDO }, { status: 400 });
  }
  const body = bruto as Record<string, unknown>;

  // TYPE-checked, never truthiness-checked: a separator in either id would
  // address another document through `.doc(id)`.
  if (naoDocId(body['integracaoId'])) {
    return NextResponse.json({ error: MSG_INTEGRACAO_ID_INVALIDO }, { status: 400 });
  }
  if (naoDocId(body['jobId'])) {
    return NextResponse.json({ error: MSG_JOB_ID_INVALIDO }, { status: 400 });
  }
  const integracaoId = body['integracaoId'] as string;
  const jobId = body['jobId'] as string;

  // ⚠️ ONE clock read, handed down as the terminal stamp's instant.
  const nowMs = Date.now();

  const resultado = await cancelarEnvioPrecoShopee(getAdminFirestore(), {
    jobId,
    integracaoId,
    nowMs,
  });

  switch (resultado) {
    case 'stamped':
      return NextResponse.json({ status: 'cancelled' });
    case 'not-running':
      return NextResponse.json(
        {
          error: 'Esta atualização de preços já foi finalizada.',
          code: CODIGO_ENVIO_PRECO_NAO_EM_ANDAMENTO,
        },
        { status: 409 },
      );
    // Both leaks are the same leak: whether this id exists at all.
    case 'not-found':
    case 'wrong-integracao':
      return NextResponse.json({ error: MSG_ENVIO_PRECO_NAO_ENCONTRADO }, { status: 404 });
  }
}
