/**
 * The OPERATOR's "reconcile now" (master plan step 12, PR 12-h): the core of `POST
 * /api/marketplace/loja-integrada/conta/[id]/estoque/reconciliar`. It enqueues ONE named FULL
 * run, exactly as the depósito-change arm does (`gatilhoDepositoLi.ts`): the reads-queue producer
 * (`agendadorReconcile.ts`), `{ tipo: 'estoque-reconcile', execucaoId, seq: 0 }`, delay 0. There is
 * no light mode: every run is full, and it covers EVERY active conta with a depósito, not the one
 * the route names. Next-free, `db`, the producer and the clock are parameters; no Loja Integrada
 * call and no credential read (`estrutura.test.ts`).
 *
 * ## In order
 *
 *  1. ONE masked read of `reconcileEstoqueLojaIntegrada/atual`, its four LEASE fields only
 *     (`lerLeaseRunReconcileLi`: the document can hold about 600 KB of candidates while a run goes).
 *     A run that still HOLDS the lease (`leaseReconcileVivoLi`, the decision's own rule) ⇒
 *     `em-andamento` with its id, nothing enqueued: its first slice would only meet `ocupado` and
 *     drop. Asked BEFORE the decision's same-minute rule, so a run that took the lease seconds ago
 *     (a second click, the nightly start, a depósito arm) reads as running, never as a new run.
 *  2. Otherwise ONE enqueue, run {@link idExecucaoManualLi} of the request's MINUTE: a repeat in
 *     the same minute names the same task (`li-<execucaoId>-0`; an answered already-exists is
 *     success, so the same 202), never a second full key walk. The slice then decides as every
 *     first slice does (`decidirSliceReconcileLi`): a stored run that STARTED in this minute
 *     (past step 1, one no longer holding the lease) makes it `adiar`, so two runs never share a
 *     minute window — it throws, and the queue retries it at least 60 s later (the reads queue's
 *     `minBackoffSeconds`), when it takes the lease; a run that took the lease AFTER step 1's read
 *     (another click, the nightly start, a depósito arm) makes it drop as `ocupado` — after one
 *     `adiar` first when that run started in the same minute — and the running chain covers every
 *     conta.
 *
 * The read switch is NOT read here, as in the nightly start and the depósito arm: with it off the
 * run still rebuilds the ERP side (the snapshot, the kits map) and every store phase stops at the
 * switch — that is how the run's cost is measured on staging before the window.
 *
 * A transient Cloud Tasks failure, or anything else the producer rejects with, is rethrown: the
 * outcome is unknown (the task may exist), and a repeat inside the minute collides harmlessly.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { TIPO_TAREFA_RECONCILE_ESTOQUE_LI } from '@delfrance/schemas';

import { JANELA_ESTOQUE_LI_MS, janelaEstoqueLi } from '../agendadorEstoque';
import { PREFIXO_EXECUCAO_RECONCILE_LI } from './agendamentoReconcile';
import { type AgendadorReconcileEstoqueLi, LiTarefasDesligadasError } from './agendadorReconcile';
import { leaseReconcileVivoLi, lerLeaseRunReconcileLi } from './execucaoReconcile';

/** Every operator run's id starts so (`…-manual-<ms>`, the grammar the run schema reserves). */
export const PREFIXO_EXECUCAO_MANUAL_LI = `${PREFIXO_EXECUCAO_RECONCILE_LI}-manual`;

/**
 * The id of the operator run asked for at `agoraMs`: `estoque-reconcile-manual-<ms>`, the ms
 * FLOORED to the request's minute (module header, step 2). Never a nightly id (digits only after
 * the prefix), a depósito arm's (`…-deposito-`) or a release's (`…-redeposito-`).
 */
export function idExecucaoManualLi(agoraMs: number): string {
  // The `adiar` rule's own window function: one minute, one id.
  const minuto = janelaEstoqueLi(agoraMs) * JANELA_ESTOQUE_LI_MS;
  return `${PREFIXO_EXECUCAO_MANUAL_LI}-${String(minuto)}`;
}

/** The 202's shared opening: what the route KNOWS (a full run is queued, and what it covers). */
const RECONCILE_ENFILEIRADO_LI =
  'Reconciliação completa enfileirada: cobre todas as contas ativas com depósito.';

/**
 * The 202's pt-BR sentence, by THIS backend's read switch. Never a claim about the run's store
 * phase: that phase reads the functions codebase's OWN copy of the switch (a set-alike pair that
 * nothing cross-checks), so the sentence says only what this backend has and leaves the rest to
 * the queue.
 */
export const MENSAGEM_RECONCILE_MANUAL_LI = {
  comChamadas:
    `${RECONCILE_ENFILEIRADO_LI} As chamadas à Loja Integrada estão ligadas neste backend ` +
    '(a fila decide pela própria configuração se lê a loja).',
  semChamadas:
    `${RECONCILE_ENFILEIRADO_LI} As chamadas à Loja Integrada estão desligadas neste backend ` +
    '(a fila decide pela própria configuração se lê a loja).',
} as const;

/** What the route did. */
export type ResultadoReconcileManualLi =
  /** A run holds the lease: nothing enqueued. */
  | { readonly tipo: 'em-andamento'; readonly execucaoId: string }
  /** The sweep-only valve closed under the route's own check: nothing enqueued. */
  | { readonly tipo: 'tarefas-desligadas'; readonly execucaoId: string }
  /** The run's first slice is queued (or already was, this minute). */
  | { readonly tipo: 'enfileirado'; readonly execucaoId: string };

/** The operator's reconcile (module header). */
export async function iniciarReconcileManualLi(args: {
  readonly db: Firestore;
  /** The reads-queue producer ROOT, built only when the enqueue is due. */
  readonly agendador: () => AgendadorReconcileEstoqueLi;
  readonly agoraMs: number;
}): Promise<ResultadoReconcileManualLi> {
  const { run } = await lerLeaseRunReconcileLi(args.db);
  if (run !== null && run.execucaoId !== null && leaseReconcileVivoLi(run, args.agoraMs)) {
    return { tipo: 'em-andamento', execucaoId: run.execucaoId };
  }
  const execucaoId = idExecucaoManualLi(args.agoraMs);
  try {
    await args
      .agendador()
      .enfileirar({ tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId, seq: 0 }, { atrasoS: 0 });
  } catch (err) {
    if (!(err instanceof LiTarefasDesligadasError)) throw err;
    return { tipo: 'tarefas-desligadas', execucaoId };
  }
  return { tipo: 'enfileirado', execucaoId };
}
