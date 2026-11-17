/**
 * `GET /api/marketplace/loja-integrada/conta/[id]/importacoes/[jobId]/revisao` — a product import's
 * TAX-REVIEW LIST (master plan step 9): the produtos whose taxes the import may have changed, the
 * list the `lojaIntegradaRevisaoFiscal` aviso names by its newest job. Requires
 * `PERM.integracao.read`.
 *
 * - 200 `{ entradas, proximo }` (`respostaRevisaoFiscalLiSchema`): the job's WHOLE `revisao` list
 *   in the produto ids' code-unit order, in ONE answer (`proximo` is always `null` here; the schema
 *   says why it exists). A Simular job's list is empty: a simulation never writes one. A running
 *   job's list grows and shrinks while it is read: the answer reflects the list when it was read.
 *   `Cache-Control: no-store`.
 * - 400 `LI_ID_INVALIDO` for either id, before anything is read; 401/403 (the caller).
 * - 404 `LI_IMPORTACAO_NAO_ENCONTRADA` for a missing job AND for another conta's (one answer): the
 *   job is read first, so another conta's list is never read.
 * - Anything else (Firestore, a stored job that no longer parses) is rethrown: a 500 (root rule 6).
 *   A stored ENTRY that does not parse is not a failure: it is answered with its produto id (the
 *   document's key) and whatever of it reads (`importacao/listaRevisaoFiscal.ts`), so the operator
 *   still sees that produto, and every other one.
 *
 * The read (root rule 1): the job by id, then its `revisao` subcollection WHOLE — unfiltered,
 * unordered, no limit, so no index — sorted in memory. Never a document-key range: on Enterprise,
 * with no `__name__` index declared for it, every such page would scan the whole list.
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
import { lerJobDaContaLi } from '@/lib/lojaIntegrada/importacao/job';
import { lerRevisaoFiscalDaImportacaoLi } from '@/lib/lojaIntegrada/importacao/listaRevisaoFiscal';

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

  const db = getAdminFirestore();
  // The job first: another conta's list is never read.
  if ((await lerJobDaContaLi(db, id, jobId)) === null) return respostaImportacaoNaoEncontrada();
  return NextResponse.json(await lerRevisaoFiscalDaImportacaoLi(db, jobId), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
