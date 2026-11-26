/**
 * The price-queue PRODUCER, pure (master plan step 13, PR 13-d): what an enqueue onto
 * `filaPrecoLojaIntegrada` means, with the transport handed in, and how a price task is NAMED and
 * SCHEDULED. Today its only caller is the send run's ONE `deriva` follow-up
 * (`preco/processarPreco.ts`); the price trigger, the nightly reconcile, the manual push and
 * "Atualizar preços" (later PRs of step 13) enqueue through it too.
 *
 * The queue itself is bound by a composition root, never here — the functions codebase's
 * (`functions/src/agendadorPreco.ts`), which resolves the region-qualified queue path and reads the
 * sweep-only valve and passes both in as {@link OpcoesAgendadorPrecoLi}. Nothing in this module
 * reads the environment (`estrutura.test.ts`).
 *
 * ## Windows, names, schedules (root `CLAUDE.md` rule 7, tier 0)
 *
 *  - **Window and schedule: the stock producer's, by import** ({@link janelaPrecoLi},
 *    {@link agendamentoPrecoLi} ARE `janelaEstoqueLi` and `agendamentoEstoqueLi`), so the naming
 *    proof of `estoque/agendadorEstoque.ts` (an enqueue either creates its task or collides with
 *    one that dispatches after it and reads the ERP as the enqueue left it) has one copy. The
 *    window is ⌊now / 60 s⌋ of a clock read IMMEDIATELY before the enqueue, never an event's.
 *  - **Name.** `preco-` + sha256 of `preco:<origem>:<conta>:<produto>:<b|n>:<janela>`
 *    ({@link idDaTarefaPrecoLi}), `b` when the task may lower a price (`baixar`). So a burst of
 *    edits inside one window enqueues ONE task per (origin, conta, produto, `baixar`); a task that
 *    may NOT lower never swallows one that may (they are two tasks); a `deriva` follow-up never
 *    collides with the event that caused it. The digest keeps the id inside
 *    `[A-Za-z0-9_-]{1,500}` whatever the ids hold.
 *  - **A bulk producer** (the nightly, "Atualizar preços": later PRs) names every send by its
 *    RUN's window and passes a not-before bound, exactly as the stock reconcile does
 *    ({@link OpcoesEnvioPrecoLi}); the stock producer's header carries that proof.
 *
 * ## The payload is PARSED before it leaves
 *
 * {@link enfileirarTarefaPrecoLi} builds the task and parses it with the strict
 * `tarefaPrecoLiSchema`, so a price — or any key the consumer would refuse — can never be enqueued
 * (a `ZodError`, nothing sent). The price is always derived when the task RUNS.
 *
 * ## What a rejection MEANS — the stock producer's contract
 *
 *  - `functions/task-already-exists` WITH an answered `httpResponse` is SUCCESS: the same task is
 *    already queued for this window;
 *  - {@link LiTarefasDesligadasError}: the sweep-only valve is closed, nothing was enqueued and the
 *    queue was never resolved;
 *  - {@link LiTarefasTransitoriasError}: Cloud Tasks hiccupped — the caller rethrows, so its own
 *    retry enqueues again (the same name, so never twice);
 *  - anything else is rethrown EXACTLY as thrown: a broken deploy, a root's region guard, a bug.
 */
import { sha256Hex } from '@delfrance/data/admin';
import { TIPO_TAREFA_PRECO_LI, type TarefaPrecoLi, tarefaPrecoLiSchema } from '@delfrance/schemas';

import { agendamentoEstoqueLi, janelaEstoqueLi } from '../estoque/agendadorEstoque';
import {
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  enfileirarNomeandoFalhaTransitoriaLi,
  tarefaJaExisteLi,
} from '../notificacoes/agendador';

export { LiTarefasDesligadasError, LiTarefasTransitoriasError };

/** The price queue, and the name of the function that serves it (the export name IS the queue name). */
export const FILA_PRECO_LI = 'filaPrecoLojaIntegrada';

/** `⌊agoraMs / 60 s⌋`: the stock producer's window function itself (module header). */
export const janelaPrecoLi: (agoraMs: number) => number = janelaEstoqueLi;

/** When a task of `janela` for `produtoId` may dispatch: the stock producer's schedule itself. */
export const agendamentoPrecoLi: (janela: number, produtoId: string) => number =
  agendamentoEstoqueLi;

/** The Cloud Tasks task id of a price task (module header, "Name"). */
export function idDaTarefaPrecoLi(
  t: Pick<TarefaPrecoLi, 'origem' | 'contaId' | 'produtoId' | 'baixar' | 'janela'>,
): string {
  const baixar = t.baixar ? 'b' : 'n';
  return `preco-${sha256Hex(`preco:${t.origem}:${t.contaId}:${t.produtoId}:${baixar}:${String(t.janela)}`)}`;
}

/** What the enqueue takes besides the payload: the task's own id, and when it may dispatch. */
export interface OpcoesEnfileiramentoPrecoLi {
  readonly id: string;
  /** In ms since the epoch. */
  readonly agendarParaMs: number;
}

/**
 * The transport, as a root binds it — structurally, the Admin SDK's `TaskQueue<TarefaPrecoLi>`,
 * of which only `enqueue(data, { id, scheduleTime })` is used.
 */
export interface FilaPrecoLi {
  enqueue(
    tarefa: TarefaPrecoLi,
    opcoes: { readonly id: string; readonly scheduleTime: Date },
  ): Promise<void>;
}

/** The enqueue seam a producer depends on: a fake in tests, {@link criarAgendadorPrecoLi} for real. */
export interface AgendadorPrecoLi {
  enfileirar(tarefa: TarefaPrecoLi, opcoes: OpcoesEnfileiramentoPrecoLi): Promise<void>;
}

export interface OpcoesAgendadorPrecoLi {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's region guard then
   * rejects that enqueue (rethrown untouched) instead of failing the whole module load.
   */
  readonly fila: () => FilaPrecoLi;
  /** The sweep-only valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link LiTarefasDesligadasError} and the queue is never resolved; otherwise each enqueue sends
 * the payload ALONE with its task id and schedule, treats an answered already-exists as success,
 * and names a transient failure.
 */
export function criarAgendadorPrecoLi(opcoes: OpcoesAgendadorPrecoLi): AgendadorPrecoLi {
  if (opcoes.desligado) {
    return {
      async enfileirar() {
        throw new LiTarefasDesligadasError();
      },
    };
  }
  return {
    enfileirar: (tarefa, { id, agendarParaMs }) =>
      enfileirarNomeandoFalhaTransitoriaLi(async () => {
        try {
          await opcoes.fila().enqueue(tarefa, { id, scheduleTime: new Date(agendarParaMs) });
        } catch (err) {
          if (tarefaJaExisteLi(err)) return;
          throw err;
        }
      }),
  };
}

/** A price task's ids, everything but the window (read here, at the enqueue). */
export type TarefaPrecoSemJanelaLi = Omit<TarefaPrecoLi, 'tipo' | 'janela'>;

/** What a BULK producer adds to one enqueue (module header, "A bulk producer"). */
export interface OpcoesEnvioPrecoLi {
  /** The window that NAMES the task, in place of the clock's — then the clock is not read at all. */
  readonly janela?: number;
  /** A not-before bound, in ms since the epoch: the schedule is the later of the window's and it. */
  readonly naoAntesDeMs?: number;
}

/**
 * Enqueue ONE `preco` task: the clock read right here, IMMEDIATELY before the enqueue (never
 * before the caller's own reads) — unless `opcoes.janela` names the window instead — the payload
 * built and PARSED (strict: a price or an extra key throws `ZodError`, and nothing is sent), then
 * named and scheduled (module header; `opcoes.naoAntesDeMs` can only move the schedule later).
 * Rejects as the agendador does.
 */
export async function enfileirarTarefaPrecoLi(
  agendador: AgendadorPrecoLi,
  agoraMs: () => number,
  semJanela: TarefaPrecoSemJanelaLi,
  opcoes: OpcoesEnvioPrecoLi = {},
): Promise<void> {
  const janela = opcoes.janela ?? janelaPrecoLi(agoraMs());
  const tarefa = tarefaPrecoLiSchema.parse({ ...semJanela, tipo: TIPO_TAREFA_PRECO_LI, janela });
  const agendamento = agendamentoPrecoLi(tarefa.janela, tarefa.produtoId);
  await agendador.enfileirar(tarefa, {
    id: idDaTarefaPrecoLi(tarefa),
    agendarParaMs:
      opcoes.naoAntesDeMs === undefined ? agendamento : Math.max(agendamento, opcoes.naoAntesDeMs),
  });
}
