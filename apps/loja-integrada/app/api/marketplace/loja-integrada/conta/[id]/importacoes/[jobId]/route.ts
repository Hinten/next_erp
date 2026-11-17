/**
 * `GET /api/marketplace/loja-integrada/conta/[id]/importacoes/[jobId]` — one product import's
 * status (master plan step 9), for the web's progress card. Requires `PERM.integracao.read`.
 *
 * - 200: the job projected through `respostaImportacaoLiSchema` (`importacao/job.ts`): status,
 *   phase, motivo, options, counters, the listing's totals. Never the continuation `seq`, the
 *   cursors, the category and brand maps or the selection's ids. `Cache-Control: no-store`: the
 *   web polls it while the job runs.
 * - 400 `LI_ID_INVALIDO` for a conta id outside its grammar or a job id outside the job-id grammar,
 *   before anything is read; 401/403 (the caller).
 * - 404 `LI_IMPORTACAO_NAO_ENCONTRADA` for a missing job AND for another conta's job: one answer,
 *   so a caller of one conta cannot probe another's ids.
 * - Anything else (Firestore, a stored job that no longer parses) is rethrown: a 500 (root rule 6).
 *
 * ⚠️ It calls nothing outside the ERP: no context, no switch, no package client — it answers with
 * the read switch off too. `estrutura.test.ts` walks its closure with the label routing route's
 * rules, and `prazos.test.ts` counts zero context loads.
 */
import { NextResponse } from 'next/server';
import { CONTA_ID_LI_REGEX, ID_IMPORTACAO_LI_REGEX } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  respostaIdDeImportacaoInvalido,
  respostaIdInvalido,
  respostaImportacaoNaoEncontrada,
} from '@/lib/lojaIntegrada/core/respond';
import { lerJobDaContaLi, projetarImportacaoLi } from '@/lib/lojaIntegrada/importacao/job';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;
  const { id, jobId } = await params;
  if (!CONTA_ID_LI_REGEX.test(id)) return respostaIdInvalido();
  if (!ID_IMPORTACAO_LI_REGEX.test(jobId)) return respostaIdDeImportacaoInvalido();

  const lido = await lerJobDaContaLi(getAdminFirestore(), id, jobId);
  if (lido === null) return respostaImportacaoNaoEncontrada();
  return NextResponse.json(projetarImportacaoLi(jobId, lido.job), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
