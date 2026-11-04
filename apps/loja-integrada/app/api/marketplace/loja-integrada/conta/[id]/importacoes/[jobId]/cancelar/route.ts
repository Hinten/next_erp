/**
 * `POST /api/marketplace/loja-integrada/conta/[id]/importacoes/[jobId]/cancelar` — stop one product
 * import (master plan step 9). Requires `PERM.integracao.write`. No body is read.
 *
 * The cancel is ONE terminal stamp on the job document (`cancelarImportacaoLi`,
 * `importacao/job.ts`): tier 1 on this route's own read (`update(…, { lastUpdateTime })`, root rule
 * 7), re-read and re-decided on a lost precondition, at most three attempts. There is nothing to
 * tell the queue: the running dispatch's next checkpoint loses ITS precondition to this write,
 * re-reads, sees `cancelado` and stops, and a queued dispatch finds the job ended and does nothing.
 * It is also the recovery for a job that is running with no worker at all.
 *
 * - 200: the job as written (`cancelado`), projected through `respostaImportacaoLiSchema`.
 * - 400 `LI_ID_INVALIDO` (either id), before anything is read; 401/403 (the caller).
 * - 404 `LI_IMPORTACAO_NAO_ENCONTRADA` for a missing job AND for another conta's (one answer).
 * - 409 `LI_IMPORTACAO_ENCERRADA` for a job already `concluido`, `falhou` or `cancelado`: nothing
 *   written, a finished job is never relabelled.
 * - 503 `LI_IMPORTACAO_EM_ANDAMENTO` (with its `jobId`) when the job wrote its progress between the
 *   read and the write on every attempt: nothing written, still running; a retry re-decides. ONE
 *   warn line, ids only.
 * - Anything else (Firestore, a stored job that no longer parses) is rethrown: a 500 (root rule 6).
 *
 * ⚠️ It calls nothing outside the ERP (`estrutura.test.ts` walks its closure with the label routing
 * route's rules), so it works with the read switch off — as everywhere until the window.
 */
import { NextResponse } from 'next/server';
import { CONTA_ID_LI_REGEX, ID_IMPORTACAO_LI_REGEX } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  respostaCancelamentoEmConflito,
  respostaIdDeImportacaoInvalido,
  respostaIdInvalido,
  respostaImportacaoEncerrada,
  respostaImportacaoNaoEncontrada,
} from '@/lib/lojaIntegrada/core/respond';
import {
  LiCancelamentoEmConflitoError,
  cancelarImportacaoLi,
} from '@/lib/lojaIntegrada/importacao/job';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG = '[loja-integrada/importacao]';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;
  const { id, jobId } = await params;
  if (!CONTA_ID_LI_REGEX.test(id)) return respostaIdInvalido();
  if (!ID_IMPORTACAO_LI_REGEX.test(jobId)) return respostaIdDeImportacaoInvalido();

  try {
    // ONE clock read: the terminal stamp's instant.
    const r = await cancelarImportacaoLi(getAdminFirestore(), id, jobId, Date.now());
    switch (r.tipo) {
      case 'cancelado':
        return NextResponse.json(r.resposta, { headers: { 'Cache-Control': 'no-store' } });
      case 'nao-encontrada':
        return respostaImportacaoNaoEncontrada();
      case 'encerrada':
        return respostaImportacaoEncerrada();
    }
  } catch (err) {
    if (err instanceof LiCancelamentoEmConflitoError) {
      console.warn(`${LOG} cancelamento perdeu a precondição em todas as tentativas`, {
        conta: id,
        jobId,
        uid: auth.caller.uid,
      });
      return respostaCancelamentoEmConflito(jobId);
    }
    throw err;
  }
}
