/**
 * The DEPÓSITO-CHANGE arm of the conta trigger (`functions/src/onIntegracaoLojaIntegradaChanged.ts`;
 * master plan step 12, PR 12-g): when a Loja Integrada conta is re-pointed at another depósito,
 * every one of its listings may now differ, so ONE full stock reconcile is enqueued at once instead
 * of waiting for the night. It reads NOTHING and calls no Loja Integrada endpoint: the decision is
 * the event payload's, the valve the environment's, and the one effect a named enqueue on the reads
 * queue (`agendadorReconcile.ts`).
 *
 * ## When it fires ({@link mudouDepositoDaContaLi}, pure — zero reads)
 *
 * Both sides of the write exist and are Loja Integrada contas (`tipo` 3), the conta is not
 * inactive after it, and its depósito AFTER — folded by the shared reader (`depositoDaContaLi`,
 * either stored form) — is a depósito, and not the one before:
 *
 *  - fires: `D1 → D2`; none → `D1` (a depósito set on an existing conta);
 *  - ⚠️ does NOT fire: a CREATE, even with a depósito — the nightly run bootstraps a new conta (and
 *    every emulator suite that seeds a conta with a depósito would otherwise start a chain);
 *    `documents/depositos/D1 → depositos/D1` (one depósito, two spellings); `D1 → none` (nothing
 *    to send to: the send runs skip a conta with no depósito); a delete; another channel's conta;
 *    a write that moves no depósito (a rename, a token save — the credential is a subcollection).
 *
 * ## What it does ({@link agendarReconcileDoDepositoLi})
 *
 *  1. The stock valve: `off` ⇒ nothing (zero reads). `dry-run` and `on` alike: the run decides
 *     itself what a dry-run means (it diffs and enqueues nothing). The read switch is NOT read
 *     here: a run with the switch off still walks the ERP side — that is how its cost is measured
 *     before the window.
 *  2. ONE task, seq 0, at once: run `estoque-reconcile-deposito-<µs>`, the µs of the AFTER side's
 *     update time (the app's one conversion module) — so an Eventarc redelivery of the same write
 *     names the same task (an answered already-exists is success), and two changes are two runs.
 *     The closed sweep-only valve is ONE WARNING; a transient Cloud Tasks failure is RETHROWN (the
 *     trigger runs under `retry: true`, and the name keeps a retry idempotent).
 *
 * ## A change that lands while a run holds the lease
 *
 * The new run's first slice meets the running chain and is refused (`ocupado`,
 * `execucaoReconcile.ts`). The running chain then catches it itself (`contasReconcile.ts`, "Does a
 * depósito change ask for a new full run?"): its queue phase reads every conta again before each
 * slice and drops what is left for a conta whose depósito is no longer the one it fixed, and the
 * slice that releases LISTS the contas once more — a conta it did not take included, a conta
 * created during the run excluded — and, after the release, enqueues ONE full run named after the
 * newest conta update time it saw. Worst case: the rest of the running chain plus one full run.
 * The reads queue dispatches one task at a time, so no arm run slips between that listing and the
 * release. Residuals: a chain RELEASED on the queue's last attempt asks only for what its queue
 * phase recorded, one a crash leaves to its lease's expiry asks for nothing, and a change undone
 * before the release that the queue phase never saw asks for nothing — what is not asked for waits
 * for the next nightly run.
 *
 * Sends already enqueued are covered by the payload: every reconcile send carries its run's
 * depósito, and the send run drops one whose conta now names another (`processarEstoque.ts`, step
 * 4, after one read past the conta cache when the cached copy differs). Within the cache's 15
 * minutes a re-point a warm instance has not seen yet still sends at the old depósito — the
 * staleness every send run has — and the change's own run, scheduled behind those sends on the
 * global slot, sends last.
 *
 * Next-free, no `db`: nothing here touches Firestore.
 */
import {
  INTEGRACAO_TIPO,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  depositoDaContaLi,
} from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../../avisos/avisos';
import {
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  lerValvula,
  registrarValvulaLi,
} from '../../core/valvulas';
import { type AgendadorReconcileEstoqueLi, LiTarefasDesligadasError } from './agendadorReconcile';

const TAG = '[loja-integrada/estoque] reconcile do depósito';

/** The id of the run a depósito change asks for (module header, step 2). */
export function idExecucaoDoDepositoLi(versaoUs: number): string {
  return `estoque-reconcile-deposito-${String(versaoUs)}`;
}

/** Whether this write re-points a Loja Integrada conta at another depósito (module header). Pure. */
export function mudouDepositoDaContaLi(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): boolean {
  if (before === null || after === null) return false;
  if (before.tipo !== INTEGRACAO_TIPO.lojaIntegrada) return false;
  if (after.tipo !== INTEGRACAO_TIPO.lojaIntegrada) return false;
  if (after.ativo === false) return false;
  const depois = depositoDaContaLi(after);
  return depois !== null && depois !== depositoDaContaLi(before);
}

/** What the arm did. */
export type ResultadoReconcileDoDepositoLi =
  | { readonly kind: 'ignorado' }
  | { readonly kind: 'desligado' }
  | { readonly kind: 'tarefas-desligadas'; readonly execucaoId: string }
  | { readonly kind: 'enfileirado'; readonly execucaoId: string };

/** The arm (module header). */
export async function agendarReconcileDoDepositoLi(args: {
  readonly integracaoId: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  /** The AFTER side's commit stamp; absent ⇒ nothing (no deterministic name). */
  readonly atualizadoEm: { readonly seconds: number; readonly nanoseconds: number } | undefined;
  readonly ambiente: AmbienteLi;
  /** The reads-queue producer ROOT, built only when the enqueue is due. */
  readonly agendador: () => AgendadorReconcileEstoqueLi;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}): Promise<ResultadoReconcileDoDepositoLi> {
  if (!mudouDepositoDaContaLi(args.before, args.after) || args.atualizadoEm === undefined) {
    return { kind: 'ignorado' };
  }
  const valvula = lerValvula(FLUXO_LI.estoque, args.ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido) registrarValvulaLi(valvula, { conta: args.integracaoId });
    return { kind: 'desligado' };
  }
  const execucaoId = idExecucaoDoDepositoLi(relogioDoDocumentoUs(args.atualizadoEm));
  const meta = { integracaoId: args.integracaoId, execucaoId };
  try {
    await args
      .agendador()
      .enfileirar({ tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId, seq: 0 }, { atrasoS: 0 });
  } catch (err) {
    if (!(err instanceof LiTarefasDesligadasError)) throw err;
    args.logger.warn(`${TAG} — tarefas desligadas, nada enfileirado`, meta);
    return { kind: 'tarefas-desligadas', execucaoId };
  }
  args.logger.info(`${TAG} — execução completa enfileirada`, meta);
  return { kind: 'enfileirado', execucaoId };
}
