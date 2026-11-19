/**
 * `POST /api/marketplace/loja-integrada/conta/[id]/estoque/reconciliar` — the operator's "reconcile
 * now" (master plan step 12, PR 12-h): ONE named FULL stock reconcile run, enqueued at once on the
 * reads queue. No body. Requires `PERM.integracao.write`, the bit this app's conta writes use.
 * Answers 202 `respostaReconcileEstoqueLiSchema` (`{ execucaoId, modo, chamadas, mensagem }`), or
 * the `erroContaLojaIntegradaSchema` envelope. The run is GLOBAL: it covers every active conta with
 * a depósito, not only the one in the path. The work is
 * `lib/lojaIntegrada/estoque/reconcile/reconcileManualLi.ts`.
 *
 * In order:
 *
 *  1. the caller (401/403) and the id (400 `LI_ID_INVALIDO`), before any read;
 *  2. the stock valve `LOJA_INTEGRADA_MODO_ESTOQUE`: `off` ⇒ 503 `LI_ESTOQUE_DESLIGADO` (nothing
 *     would run; one valve line when the value is unrecognised); `dry-run` and `on` alike (the run
 *     decides what a dry-run means: it diffs and enqueues no send);
 *  3. this backend's Cloud Tasks valve `LOJA_INTEGRADA_TASKS_DISABLED=1` ⇒ 503
 *     `LI_TAREFAS_DESLIGADAS`; then the queues' region (unset ⇒ `MissingRegionError`, a 500) —
 *     zero Firestore reads up to here;
 *  4. the conta, read UNCACHED (one read): missing or not `tipo` 3 ⇒ 404, inactive ⇒ 409
 *     `LI_CONTA_INATIVA`, no depósito ⇒ 409 `LI_CONTA_SEM_DEPOSITO` — the run would skip it;
 *  5. ONE masked read of the run document's lease fields: a run holding the lease ⇒ 409
 *     `LI_RECONCILE_EM_ANDAMENTO` with its `execucaoId`, nothing enqueued; otherwise ONE enqueue,
 *     `estoque-reconcile-manual-<ms of the request's minute>`, seq 0, delay 0 ⇒ 202. A repeat in
 *     the same minute names the same task (the same 202); a run released this minute makes the
 *     slice wait a minute (`adiar`), and the queue retries it.
 *
 * ⚠️ The read switch `LOJA_INTEGRADA_CHAMADAS` is NOT a gate here, exactly as for the nightly start
 * and the depósito arm: with it off the run still rebuilds the ERP side and every store phase stops
 * at the switch — the staging measurement path. The 202 reports it (`chamadas`), informational.
 *
 * A 500 (a Firestore failure, a Cloud Tasks failure of any kind) leaves the outcome unknown: the
 * task may exist, and a repeat within the minute collides with it harmlessly. ONE structured INFO
 * line per answer the core gave (`core/log.ts`'s writer), ids only.
 */
import { NextResponse } from 'next/server';
import {
  CONTA_ID_LI_REGEX,
  type RespostaReconcileEstoqueLi,
  respostaReconcileEstoqueLiSchema,
} from '@delfrance/schemas';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  agendadorReconcileLiDoAppHosting,
  regiaoDasFilasLiAppHosting,
  tarefasLiDesligadasNoAppHosting,
} from '@/lib/firebase/filasLi';
import { escritorPadrao } from '@/lib/lojaIntegrada/core/log';
import {
  respostaDaContaDoEstoqueLi,
  respostaEstoqueDesligado,
  respostaIdInvalido,
  respostaReconcileEmAndamento,
  respostaTarefasDesligadas,
} from '@/lib/lojaIntegrada/core/respond';
import {
  FLUXO_LI,
  MODO_LI,
  lerChaveDeChamadas,
  lerValvula,
  registrarValvulaLi,
} from '@/lib/lojaIntegrada/core/valvulas';
import { contaDoEstoqueLi } from '@/lib/lojaIntegrada/estoque/contaDoEstoqueLi';
import { iniciarReconcileManualLi } from '@/lib/lojaIntegrada/estoque/reconcile/reconcileManualLi';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG = '[loja-integrada/estoque] reconcile manual';

/** The 202's sentence, by whether the read switch is on. */
const MENSAGEM_RECONCILE_LI = {
  comChamadas:
    'Reconciliação completa enfileirada: confere o estoque de todas as contas ativas com ' +
    'depósito com o da loja.',
  semChamadas:
    'Reconciliação completa enfileirada só do lado do ERP: as chamadas à Loja Integrada estão ' +
    'desligadas neste backend, então nenhuma loja é lida.',
} as const;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.integracao.write);
  if ('error' in auth) return auth.error;
  const { id } = await params;
  if (!CONTA_ID_LI_REGEX.test(id)) return respostaIdInvalido();

  // The environment, read once, before any read.
  const ambiente = process.env;
  const valvula = lerValvula(FLUXO_LI.estoque, ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido) registrarValvulaLi(valvula, { conta: id });
    return respostaEstoqueDesligado();
  }
  if (tarefasLiDesligadasNoAppHosting()) return respostaTarefasDesligadas();
  // Resolved here once, before any read; the producer resolves it again per enqueue.
  regiaoDasFilasLiAppHosting();
  const chamadas = lerChaveDeChamadas(ambiente);

  const db = getAdminFirestore();
  const conta = await contaDoEstoqueLi(db, id);
  if (conta.tipo !== 'ok') return respostaDaContaDoEstoqueLi(id, conta);

  const r = await iniciarReconcileManualLi({
    db,
    agendador: agendadorReconcileLiDoAppHosting,
    agoraMs: Date.now(),
  });
  // ONE structured INFO line (Cloud Logging severity), ids only.
  escritorPadrao('INFO', `${LOG} ${r.tipo}`, {
    integracaoId: id,
    execucaoId: r.execucaoId,
    modo: valvula.modo,
  });
  switch (r.tipo) {
    case 'em-andamento':
      return respostaReconcileEmAndamento(r.execucaoId);
    case 'tarefas-desligadas':
      return respostaTarefasDesligadas();
    case 'enfileirado':
      break;
  }
  const corpo: RespostaReconcileEstoqueLi = respostaReconcileEstoqueLiSchema.parse({
    execucaoId: r.execucaoId,
    modo: valvula.modo,
    chamadas,
    mensagem: chamadas ? MENSAGEM_RECONCILE_LI.comChamadas : MENSAGEM_RECONCILE_LI.semChamadas,
  });
  return NextResponse.json(corpo, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}
