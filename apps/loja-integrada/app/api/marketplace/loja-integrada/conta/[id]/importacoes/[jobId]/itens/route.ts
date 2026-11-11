/**
 * `GET /api/marketplace/loja-integrada/conta/[id]/importacoes/[jobId]/itens?depois=<item id>` — one
 * page of a product import's report (master plan step 9): what the run did, or under Simular would
 * do, for each store parent or simple product, with its pendências. Requires
 * `PERM.integracao.read`.
 *
 * - 200 `{ itens, proximo }` (`respostaItensImportacaoLiSchema`): at most
 *   `LIMITE_ITENS_IMPORTACAO_LI` (500) items in DOCUMENT-KEY order after `depois` (exclusive);
 *   `proximo` is the `depois` of the next page, `null` on the last. Absent or empty `depois` = the
 *   first page. The report of a running job grows while it is read: a page reflects the items
 *   stored when it was read. `Cache-Control: no-store`.
 * - 400 `LI_ID_INVALIDO` for either id, and for a `depois` that is not an item id or is given
 *   twice — all before anything is read; 401/403 (the caller).
 * - 404 `LI_IMPORTACAO_NAO_ENCONTRADA` for a missing job AND for another conta's (one answer): the
 *   job is read first, so another conta's report is never paged.
 * - Anything else (Firestore, a stored item that no longer parses) is rethrown: a 500 (root rule 6).
 *
 * The read is the job's own `itens` subcollection in key order with no filter, riding the declared
 * `itens (__name__ ASC)` index (`importacao/job.ts` says why Enterprise needs it). ⚠️ It
 * calls nothing outside the ERP (`estrutura.test.ts` walks its closure with the label routing
 * route's rules).
 */
import { NextResponse } from 'next/server';
import { CONTA_ID_LI_REGEX, ID_IMPORTACAO_LI_REGEX } from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  respostaCursorDeItensInvalido,
  respostaIdDeImportacaoInvalido,
  respostaIdInvalido,
  respostaImportacaoNaoEncontrada,
} from '@/lib/lojaIntegrada/core/respond';
import {
  ehCursorDeItensLi,
  lerItensDaImportacaoLi,
  lerJobDaContaLi,
} from '@/lib/lojaIntegrada/importacao/job';

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

  // Absent or empty ⇒ the first page; present ⇒ an item id, once, or a 400.
  const valores = new URL(req.url).searchParams.getAll('depois');
  if (valores.length > 1) return respostaCursorDeItensInvalido();
  const bruto = valores[0] ?? '';
  const depois = bruto === '' ? null : bruto;
  if (depois !== null && !ehCursorDeItensLi(depois)) return respostaCursorDeItensInvalido();

  const db = getAdminFirestore();
  // The job first: another conta's report is never paged.
  if ((await lerJobDaContaLi(db, id, jobId)) === null) return respostaImportacaoNaoEncontrada();
  return NextResponse.json(await lerItensDaImportacaoLi(db, jobId, depois), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
