/**
 * The NIGHTLY start of the daily stock reconcile (master plan step 12, PR 12-g): what one firing
 * of the `reconciliarEstoqueLojaIntegrada` schedule does. It reads NO Firestore document and calls
 * no Loja Integrada endpoint — it decides from the environment alone, and enqueues at most ONE
 * named task, the run's first slice, onto the reads queue. Pure apart from that enqueue: the
 * environment, the schedule time, the clock and the producer are all handed in.
 *
 * ## In order
 *
 *  1. The valve `LOJA_INTEGRADA_MODO_ESTOQUE`: `off` (unset, blank, a typo — one WARNING) ⇒
 *     nothing.
 *  2. ONE enqueue: `{ tipo: 'estoque-reconcile', execucaoId: 'estoque-reconcile-<AAAAMMDD>',
 *     seq: 0 }` at once, the date the SCHEDULE TIME's civil date in São Paulo — so a Cloud
 *     Scheduler retry of the same night names the same run, and its task id
 *     (`idTarefaReconcileEstoqueLi`) collides: one run per night. Only a schedule time that does
 *     not parse falls back to the clock, with ONE WARNING.
 *
 * An answered already-exists is success (the producer says so). The closed sweep-only valve is
 * ONE WARNING (nothing to retry: it is a decision). A transient Cloud Tasks failure is RETHROWN,
 * so the schedule's own retry tries the same name again — the night is not lost to one hiccup.
 *
 * ⚠️ The read switch `LOJA_INTEGRADA_CHAMADAS` is NOT read here: the approved design is "valve off
 * ⇒ nothing, otherwise ONE task". With the switch off every conta's store phase stops at its
 * context with zero reads (`faseLi.ts`), but the ERP phase still runs, and it rebuilds the snapshot
 * and the KITS MAP every night. The stock trigger's eager kit sends and its zero-crossing fan-out
 * read that map (`gatilhoEstoque.ts`: no header ⇒ `nenhum`), so gating this start on the switch
 * would leave every kit listing without event-driven sends from the moment the switch goes `on`
 * until a run completed after it. The nightly ERP phase is also how its cost is measured before
 * the window.
 */
import { dataCivilNoFuso, parseIsoToMillis } from '@delfrance/core/datetime';
import { FUSO_FISCAL, TIPO_TAREFA_RECONCILE_ESTOQUE_LI } from '@delfrance/schemas';

import {
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  lerValvula,
  registrarValvulaLi,
} from '../../core/valvulas';
import { type AgendadorReconcileEstoqueLi, LiTarefasDesligadasError } from './agendadorReconcile';

const TAG = '[loja-integrada/estoque] reconcile agendado';

/** Every scheduled run's id starts so; a run id is `estoque-reconcile-<AAAAMMDD>`. */
export const PREFIXO_EXECUCAO_RECONCILE_LI = 'estoque-reconcile';

/** The id of the run scheduled at `ms`: its civil date in São Paulo, digits only. */
export function idDaExecucaoAgendadaLi(ms: number): string {
  return `${PREFIXO_EXECUCAO_RECONCILE_LI}-${dataCivilNoFuso(ms, FUSO_FISCAL).replaceAll('-', '')}`;
}

/** What one firing did. */
export type ResultadoAgendamentoReconcileLi =
  | { readonly kind: 'desligado' }
  | { readonly kind: 'tarefas-desligadas'; readonly execucaoId: string }
  | { readonly kind: 'enfileirado'; readonly execucaoId: string };

/** One firing (module header). */
export async function agendarReconcileEstoqueLi(args: {
  readonly ambiente: AmbienteLi;
  /** The firing's `scheduleTime` (RFC 3339), as Cloud Scheduler hands it. */
  readonly horaAgendada: string | undefined;
  readonly agoraMs: () => number;
  /** The producer ROOT, built only when the enqueue is due. */
  readonly agendador: () => AgendadorReconcileEstoqueLi;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}): Promise<ResultadoAgendamentoReconcileLi> {
  const valvula = lerValvula(FLUXO_LI.estoque, args.ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido) registrarValvulaLi(valvula, { conta: null });
    return { kind: 'desligado' };
  }
  const doTick = args.horaAgendada === undefined ? null : parseIsoToMillis(args.horaAgendada);
  let ms = doTick ?? Number.NaN;
  if (doTick === null) {
    ms = args.agoraMs();
    args.logger.warn(`${TAG} — hora agendada ilegível, usando o relógio`, {
      motivo: 'hora-agendada-ilegivel',
    });
  }
  const execucaoId = idDaExecucaoAgendadaLi(ms);
  try {
    await args
      .agendador()
      .enfileirar({ tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId, seq: 0 }, { atrasoS: 0 });
  } catch (err) {
    if (!(err instanceof LiTarefasDesligadasError)) throw err;
    args.logger.warn(`${TAG} — tarefas desligadas, nada enfileirado`, { execucaoId });
    return { kind: 'tarefas-desligadas', execucaoId };
  }
  args.logger.info(`${TAG} — primeira fatia enfileirada`, { execucaoId });
  return { kind: 'enfileirado', execucaoId };
}
