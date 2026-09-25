/**
 * `GET /api/marketplace/shopee/atualizar-precos/status?integracaoId=…&jobId=…`
 * — poll one Shopee price update (#1521, step 13). Requires
 * `PERM.integracao.write` (the step's ruling for all five job routes: the
 * poller is the operator who pressed the button).
 *
 * ## ⚠️ `fila` never leaves Firestore
 *
 * The job is read through a `fieldMask` ({@link CAMPOS_STATUS}), not merely
 * dropped from the body. `fila` holds a whole plan page of listings with their
 * models, rewritten after every drained item, and the UI polls this every few
 * seconds; what the operator needs from it is its SIZE, which the job writes
 * beside it as `filaRestante` on every checkpoint. The plan's cursor and the
 * run's owner (`afterAnchorId`, `startedBy`) stay inside too.
 *
 * ## ⚠️ A missing job and another conta's job get the SAME answer
 *
 * Both are 404 with one sentence — splitting them would make this endpoint an
 * oracle for "does this job id exist at all", a fact about another account.
 *
 * ## The samples carry their sentence
 *
 * `skips` / `failures` are capped samples; each entry's `code` is a price
 * motivo and gains its pt-BR `mensagem`, RENDERED here and never stored — a
 * fixed wording then applies to runs already recorded. Every entry is rebuilt
 * BY NAME, so a key added to the stored sample upstream cannot leak.
 */
import { NextResponse } from 'next/server';
import { envioPrecoShopeeCollection } from '@delfrance/data/admin/collections';
import type { EnvioPrecoFailure, EnvioPrecoSkip } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { naoDocId } from '@/lib/shopee/anuncios/corpoPublicacao';
import { mensagemDoMotivoDePreco } from '@/lib/shopee/precos/errosPreco';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One sentence for both leaks, because they are the same leak. */
const MSG_NAO_ENCONTRADO = 'Atualização de preços não encontrada.';

const MSG_INTEGRACAO_ID_INVALIDO = 'integracaoId deve ser um id de documento (sem "/" nem "..").';
const MSG_JOB_ID_INVALIDO = 'jobId deve ser um id de documento (sem "/" nem "..").';

/**
 * The job fields this route reads, applied as a `fieldMask` so the rest never
 * leaves Firestore. Exported so its test can pin the set against the schema:
 * a field with no schema default dropped from here fails every parse, and one
 * the body reads but the mask omits silently reads as its DEFAULT.
 */
export const CAMPOS_STATUS = [
  'integracaoId',
  'status',
  'baixarPreco',
  'planejados',
  'enviados',
  'pulados',
  'falhas',
  'pausas',
  'parques',
  'retomarEm',
  'filaRestante',
  'relatorioCompleto',
  'relatorioShards',
  'skips',
  'failures',
  'startedAt',
  'updatedAt',
  'finishedAt',
  'erro',
] as const;

/** A skip sample entry, by name, with its rendered sentence. */
function pulo(s: EnvioPrecoSkip) {
  return {
    itemId: s.itemId,
    produtoId: s.produtoId,
    code: s.code,
    linkDocId: s.linkDocId,
    precoAnterior: s.precoAnterior,
    mensagem: mensagemDoMotivoDePreco(s.code),
  };
}

/** A failure sample entry — a skip plus Shopee's own code in `error`. */
function falha(f: EnvioPrecoFailure) {
  return { ...pulo(f), error: f.error };
}

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;

  const params = new URL(req.url).searchParams;
  const integracaoId = params.get('integracaoId');
  if (integracaoId === null || naoDocId(integracaoId)) {
    return NextResponse.json({ error: MSG_INTEGRACAO_ID_INVALIDO }, { status: 400 });
  }
  const jobId = params.get('jobId');
  if (jobId === null || naoDocId(jobId)) {
    return NextResponse.json({ error: MSG_JOB_ID_INVALIDO }, { status: 400 });
  }

  const db = getAdminFirestore();
  const [snap] = await db.getAll(envioPrecoShopeeCollection.docRef(db, {}, jobId), {
    fieldMask: [...CAMPOS_STATUS],
  });
  if (!snap?.exists) return NextResponse.json({ error: MSG_NAO_ENCONTRADO }, { status: 404 });

  const job = envioPrecoShopeeCollection.parseRead(
    snap.data(),
    envioPrecoShopeeCollection.docPath({}, jobId),
  );
  if (job.integracaoId !== integracaoId) {
    return NextResponse.json({ error: MSG_NAO_ENCONTRADO }, { status: 404 });
  }

  return NextResponse.json({
    jobId,
    status: job.status,
    baixarPreco: job.baixarPreco,
    planejados: job.planejados,
    enviados: job.enviados,
    pulados: job.pulados,
    falhas: job.falhas,
    pausas: job.pausas,
    parques: job.parques,
    /** MILLISECONDS — set while the job is PARKED on the daily quota. */
    retomarEm: job.retomarEm,
    /** The queue's SIZE, written beside it on every checkpoint — never its contents. */
    filaRestante: job.filaRestante,
    relatorioCompleto: job.relatorioCompleto,
    relatorioShards: job.relatorioShards,
    skips: job.skips.map(pulo),
    failures: job.failures.map(falha),
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    erro: job.erro,
  });
}
