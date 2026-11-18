/**
 * The stock-queue PRODUCER, pure (master plan step 12, PR 12-e): what an enqueue onto
 * `filaEstoqueLojaIntegrada` means, with the transport handed in, and how a stock task is NAMED
 * and SCHEDULED. Shared by every producer of the queue: the send run's one `deriva` follow-up,
 * the stock trigger (an `estoque` task per child and per flagged kit, and the ONE `estoque-kits`
 * fan-out of a component with more store kits than the eager ceiling), and later the reconcile
 * and the manual push.
 *
 * The queue itself is bound by a composition root in the functions codebase, never here: it
 * resolves the region-qualified queue path and reads the sweep-only valve, and passes both in
 * as {@link OpcoesAgendadorEstoqueLi}. Nothing in this module reads the process environment
 * (`estrutura.test.ts`).
 *
 * ## Windows, names, schedules (root `CLAUDE.md` rule 7, tier 0)
 *
 *  - **Window.** `janela = ⌊now / 60 s⌋` ({@link janelaEstoqueLi}), the clock read IMMEDIATELY
 *    before the enqueue ({@link enfileirarTarefaEstoqueLi}), never an event's own time.
 *  - **Name.** `estoque-` + sha256 of `estoque:<origem>:<conta>:<produto>:<d|w>:<janela>`
 *    ({@link idDaTarefaEstoqueLi}): a burst of movements inside one window enqueues ONE task per
 *    (origin, conta, produto, delete flag); a create and a delete in one window are two tasks, and
 *    a `deriva` follow-up never collides with the event that caused it. The window is in the
 *    name, so Cloud Tasks' ban on re-using a name for about an hour never bites. The digest keeps
 *    the id inside `[A-Za-z0-9_-]{1,500}` whatever the ids hold. A fan-out task is
 *    `estoque-kits-` + sha256 of `estoque-kits:<conta>:<componente>:<janela>`
 *    ({@link idDaTarefaEstoqueKitsLi}): its own prefix AND its own tag, so it can never take the
 *    name of a send task, whatever the ids hold.
 *  - **Schedule.** `(janela + 1) · 60 s + 60 s + (hash(produto) mod 30 s)`
 *    ({@link agendamentoEstoqueLi}): the task cannot dispatch before the window has closed AND a
 *    margin at least as long as an enqueue's own deadline has passed, so an enqueue at `t` either
 *    creates its task or collides with one that dispatches after `t` and reads the ERP as `t` left
 *    it. A late redelivery lands in a later window — one more run costing one store read, never a
 *    loss. The spread keeps one conta's produtos from all dispatching on the same second. A
 *    fan-out task is scheduled the same way, spread by its component.
 *
 * ## The payload is PARSED before it leaves
 *
 * {@link enfileirarTarefaEstoqueLi} builds the task and parses it with the strict
 * `tarefaEstoqueLiSchema`, so a quantity — or any key the consumer would refuse — can never be
 * enqueued (a `ZodError`, nothing sent). The quantity is always derived when the task RUNS.
 *
 * ## What a rejection MEANS — the writes producer's contract (`rastreio/agendadorEscrita.ts`)
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
import {
  TIPO_TAREFA_ESTOQUE_LI,
  type TarefaEstoqueKitsLi,
  type TarefaEstoqueLi,
  type TarefaFilaEstoqueLi,
  tarefaEstoqueKitsLiSchema,
  tarefaEstoqueLiSchema,
} from '@delfrance/schemas';

import {
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  enfileirarNomeandoFalhaTransitoriaLi,
  tarefaJaExisteLi,
} from '../notificacoes/agendador';

export { LiTarefasDesligadasError, LiTarefasTransitoriasError };

/** The stock queue, and the name of the function that serves it (the export name IS the queue name). */
export const FILA_ESTOQUE_LI = 'filaEstoqueLojaIntegrada';

/** One window, in ms. */
export const JANELA_ESTOQUE_LI_MS = 60_000;

/** The margin after a window closes before its task may dispatch, in ms: at least an enqueue's deadline. */
export const MARGEM_AGENDAMENTO_ESTOQUE_LI_MS = 60_000;

/** The spread of one window's tasks across produtos, in ms. */
export const DISPERSAO_ESTOQUE_LI_MS = 30_000;

/** `⌊agoraMs / 60 s⌋`: the window an enqueue at `agoraMs` belongs to. */
export function janelaEstoqueLi(agoraMs: number): number {
  return Math.floor(agoraMs / JANELA_ESTOQUE_LI_MS);
}

/** The Cloud Tasks task id of a stock task (module header, "Name"). */
export function idDaTarefaEstoqueLi(
  t: Pick<TarefaEstoqueLi, 'origem' | 'contaId' | 'produtoId' | 'apagado' | 'janela'>,
): string {
  const apagado = t.apagado ? 'd' : 'w';
  return `estoque-${sha256Hex(`estoque:${t.origem}:${t.contaId}:${t.produtoId}:${apagado}:${String(t.janela)}`)}`;
}

/** The Cloud Tasks task id of a fan-out task (module header, "Name"). */
export function idDaTarefaEstoqueKitsLi(
  t: Pick<TarefaEstoqueKitsLi, 'contaId' | 'componenteId' | 'janela'>,
): string {
  return `estoque-kits-${sha256Hex(`estoque-kits:${t.contaId}:${t.componenteId}:${String(t.janela)}`)}`;
}

/** When a task of `janela` for `produtoId` may dispatch, in ms since the epoch (module header). */
export function agendamentoEstoqueLi(janela: number, produtoId: string): number {
  const dispersao = Number.parseInt(sha256Hex(produtoId).slice(0, 8), 16) % DISPERSAO_ESTOQUE_LI_MS;
  return (janela + 1) * JANELA_ESTOQUE_LI_MS + MARGEM_AGENDAMENTO_ESTOQUE_LI_MS + dispersao;
}

/** What the enqueue takes besides the payload: the task's own id, and when it may dispatch. */
export interface OpcoesEnfileiramentoEstoqueLi {
  readonly id: string;
  /** In ms since the epoch. */
  readonly agendarParaMs: number;
}

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<TarefaFilaEstoqueLi>`, of which only `enqueue(data, { id, scheduleTime })` is used.
 */
export interface FilaEstoqueLi {
  enqueue(
    tarefa: TarefaFilaEstoqueLi,
    opcoes: { readonly id: string; readonly scheduleTime: Date },
  ): Promise<void>;
}

/** The enqueue seam a producer depends on: a fake in tests, {@link criarAgendadorEstoqueLi} for real. */
export interface AgendadorEstoqueLi {
  enfileirar(tarefa: TarefaFilaEstoqueLi, opcoes: OpcoesEnfileiramentoEstoqueLi): Promise<void>;
}

export interface OpcoesAgendadorEstoqueLi {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's region guard then
   * rejects that enqueue (rethrown untouched) instead of failing the whole module load.
   */
  readonly fila: () => FilaEstoqueLi;
  /** The sweep-only valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link LiTarefasDesligadasError} and the queue is never resolved; otherwise each enqueue sends
 * the payload ALONE with its task id and schedule, treats an answered already-exists as success,
 * and names a transient failure.
 */
export function criarAgendadorEstoqueLi(opcoes: OpcoesAgendadorEstoqueLi): AgendadorEstoqueLi {
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

/** A stock task's ids, everything but the window (read here, at the enqueue). */
export type TarefaEstoqueSemJanelaLi = Omit<TarefaEstoqueLi, 'tipo' | 'janela'>;

/**
 * Enqueue ONE `estoque` task: the clock read right here, IMMEDIATELY before the enqueue (never
 * before the caller's own reads), the payload built and PARSED (strict: a quantity or an extra
 * key throws `ZodError`, and nothing is sent), then named and scheduled (module header). Rejects
 * as the agendador does.
 */
export async function enfileirarTarefaEstoqueLi(
  agendador: AgendadorEstoqueLi,
  agoraMs: () => number,
  semJanela: TarefaEstoqueSemJanelaLi,
): Promise<void> {
  const janela = janelaEstoqueLi(agoraMs());
  const tarefa = tarefaEstoqueLiSchema.parse({
    ...semJanela,
    tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
    janela,
  });
  await agendador.enfileirar(tarefa, {
    id: idDaTarefaEstoqueLi(tarefa),
    agendarParaMs: agendamentoEstoqueLi(janela, tarefa.produtoId),
  });
}

/** A fan-out task's ids, everything but the window (read here, at the enqueue). */
export type TarefaEstoqueKitsSemJanelaLi = Omit<TarefaEstoqueKitsLi, 'tipo' | 'janela'>;

/**
 * Enqueue ONE `estoque-kits` fan-out task, exactly as {@link enfileirarTarefaEstoqueLi} enqueues a
 * send task: the clock read right here, immediately before the enqueue; the payload built and
 * PARSED strict (`ZodError` on an extra key, nothing sent); named by
 * {@link idDaTarefaEstoqueKitsLi} and scheduled by {@link agendamentoEstoqueLi} over the
 * COMPONENT, so the naming proof of the module header holds for it too — the fan-out reads the
 * component's stock when it RUNS, never what the event saw. Rejects as the agendador does.
 */
export async function enfileirarTarefaEstoqueKitsLi(
  agendador: AgendadorEstoqueLi,
  agoraMs: () => number,
  semJanela: TarefaEstoqueKitsSemJanelaLi,
): Promise<void> {
  const janela = janelaEstoqueLi(agoraMs());
  const tarefa = tarefaEstoqueKitsLiSchema.parse({
    ...semJanela,
    tipo: TIPO_TAREFA_ESTOQUE_LI.estoqueKits,
    janela,
  });
  await agendador.enfileirar(tarefa, {
    id: idDaTarefaEstoqueKitsLi(tarefa),
    agendarParaMs: agendamentoEstoqueLi(janela, tarefa.componenteId),
  });
}
