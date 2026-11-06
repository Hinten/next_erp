/**
 * `…/conta/[id]/importacoes` — the conta's product imports (master plan step 9): start one, or
 * list the newest. The wire contract (the strict start body, the non-strict answers) is
 * `packages/schemas/src/importacaoLojaIntegrada.ts`; every answer is built through its schema.
 *
 * ## `POST` — start an import (`PERM.integracao.write`)
 *
 * The id, then the STRICT body (`opcoesImportacaoLiSchema`: an unknown key, a contradictory option
 * or a selection outside `alvo: selecionados` is a 400 with the field paths), then the core
 * (`lib/lojaIntegrada/importacao/inicio.ts`):
 *
 *  - the context loader FIRST — whose first act is the read switch: off (everywhere until the
 *    migration window, D17) ⇒ 503 `LI_CHAMADAS_DESLIGADAS` with ZERO Firestore reads and ZERO
 *    calls, and no job; then the conta and its credential (404 / 409, the conta routes' shared
 *    mapper);
 *  - the guard: a job of this conta still `pendente` or `executando` ⇒ 409
 *    `LI_IMPORTACAO_EM_ANDAMENTO` with that `jobId`, so the web attaches to it;
 *  - the create ⇒ 202 `{ jobId }`.
 *
 * It makes NO Loja Integrada call and touches no queue: the job-creation trigger in the functions
 * codebase enqueues the first dispatch. `prazos.test.ts` counts ONE context load in the core and no
 * package read anywhere here; `estrutura.test.ts` walks this file's closure as a read route's (the
 * context loader is the only way out, and it is behind the switch).
 *
 * ## `GET` — the newest jobs (`PERM.integracao.read`)
 *
 * The conta's newest `LIMITE_IMPORTACOES_LISTADAS_LI` (10), newest first, through the one declared
 * index (`importacao/job.ts`), each projected (`respostaImportacaoLiSchema`: never the continuation
 * `seq`, the cursors or the selection's ids). No context, no switch: it reads only the ERP, so it
 * answers with the switch off too. A conta with no job — or no conta at all — is an empty list.
 *
 * Both answer 400 `LI_ID_INVALIDO` for an id outside the conta grammar the import's task carries
 * (`CONTA_ID_LI_REGEX`) before anything is read, and 401/403 for the caller. Anything else
 * (Firestore, a stored job that no longer parses) is rethrown, so it surfaces as a 500 (root rule 6).
 */
import { NextResponse } from 'next/server';
import {
  CONTA_ID_LI_REGEX,
  opcoesImportacaoLiSchema,
  respostaImportacoesLiSchema,
  respostaInicioImportacaoLiSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  isLiAppError,
  lerCorpoLi,
  respostaDeErroLi,
  respostaIdInvalido,
  respostaImportacaoEmAndamento,
} from '@/lib/lojaIntegrada/core/respond';
import { ritmoDeLeituraLi } from '@/lib/lojaIntegrada/core/ritmo';
import { iniciarImportacaoLi } from '@/lib/lojaIntegrada/importacao/inicio';
import { listarImportacoesDaContaLi } from '@/lib/lojaIntegrada/importacao/job';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The pacer's sleep, which the context requires. Never spent: the start calls nothing. */
function esperar(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (!CONTA_ID_LI_REGEX.test(id)) return respostaIdInvalido();

  const corpo = await lerCorpoLi(req, opcoesImportacaoLiSchema);
  if (!corpo.ok) return corpo.resposta;

  try {
    const r = await iniciarImportacaoLi(
      {
        db: getAdminFirestore(),
        ambiente: process.env,
        ritmo: ritmoDeLeituraLi(esperar),
        agoraMs: () => Date.now(),
      },
      id,
      corpo.dados,
      { uid: auth.caller.uid },
    );
    if (r.tipo === 'em-andamento') return respostaImportacaoEmAndamento(r.jobId);
    return NextResponse.json(respostaInicioImportacaoLiSchema.parse({ jobId: r.jobId }), {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (isLiAppError(err)) return respostaDeErroLi(err);
    throw err;
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.read);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (!CONTA_ID_LI_REGEX.test(id)) return respostaIdInvalido();

  const importacoes = await listarImportacoesDaContaLi(getAdminFirestore(), id);
  // A job's state is never served from a cache: the web polls it.
  return NextResponse.json(respostaImportacoesLiSchema.parse({ importacoes }), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
