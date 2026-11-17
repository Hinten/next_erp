/**
 * The Easy Ship scheduling queue the suites hand their deps (step 15, PR 15-c)
 * — **for tests only**, the same rule as `fakeDb.ts`: nothing outside a
 * `*.test.ts` imports this (`estrutura.test.ts`).
 *
 * The REAL producer (`agendamento/agendadorAgendamento.ts`) over a RECORDING
 * transport that behaves like Cloud Tasks where it matters to the entries: it
 * remembers every task NAME it ever accepted — a name stays held after its task
 * ran (a tombstone, about an hour in production) — and refuses a held one with
 * the SDK's own 409 (`falhaDeTarefaJaExistente`). So a suite drives the real
 * naming, the real `ja-enfileirada` and the real transient naming, and a test
 * can seed a tombstone before an entry runs.
 *
 * ⚠️ D11: it reaches no network and no Firestore; the enqueue is the whole
 * effect.
 */
import {
  type AgendadorAgendamentoAmazon,
  criarAgendadorAgendamentoAmazon,
} from '../agendamento/agendadorAgendamento';
import type { TarefaAgendamentoAmazon } from '../agendamento/tarefaAgendamento';
import { falhaDeTarefaJaExistente } from './falhaDeEnfileiramento';

/** One enqueue the recording queue accepted. */
export interface EnfileiradaAgendamentoDeTeste {
  readonly tarefa: TarefaAgendamentoAmazon;
  /** The task name, or `null` (unnamed). */
  readonly id: string | null;
  /** The delay handed to the queue, in seconds (0: none). */
  readonly atrasoS: number;
}

export interface FilaAgendamentoDeTeste {
  /** Every enqueue the queue ACCEPTED, in order. */
  readonly enfileiradas: EnfileiradaAgendamentoDeTeste[];
  /** Every enqueue ATTEMPTED (accepted, refused as held, or failed), in order. */
  readonly tentativas: { readonly tarefa: TarefaAgendamentoAmazon; readonly id: string | null }[];
  /** The names Cloud Tasks holds: every accepted name, and any tombstone a test seeds. */
  readonly nomes: Set<string>;
  /** Make the transport reject every NEXT enqueue with this (an SDK error, a bug). */
  falha: (() => unknown) | null;
  /** Called at every enqueue the transport receives, before it answers (a test's snapshot point). */
  aoEnfileirar: (() => void) | null;
  /** The queue valve the producer is built with (`AMAZON_TASKS_DISABLED=1`). */
  desligado: boolean;
  /** How many producers were built (one per entry that ran). */
  readonly construcoes: number;
  /** The producer, as a composition root builds it: the REAL one, over this queue. */
  produtor(): AgendadorAgendamentoAmazon;
}

export function filaAgendamentoDeTeste(): FilaAgendamentoDeTeste {
  let construcoes = 0;
  const f: FilaAgendamentoDeTeste = {
    enfileiradas: [],
    tentativas: [],
    nomes: new Set(),
    falha: null,
    aoEnfileirar: null,
    desligado: false,
    get construcoes() {
      return construcoes;
    },
    produtor: () => {
      construcoes += 1;
      return criarAgendadorAgendamentoAmazon({
        desligado: f.desligado,
        fila: () => ({
          enqueue: (tarefa, opcoes) => {
            const id = opcoes?.id ?? null;
            f.aoEnfileirar?.();
            f.tentativas.push({ tarefa, id });
            if (f.falha !== null) return Promise.reject(f.falha());
            if (id !== null) {
              if (f.nomes.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
              f.nomes.add(id);
            }
            f.enfileiradas.push({ tarefa, id, atrasoS: opcoes?.scheduleDelaySeconds ?? 0 });
            return Promise.resolve();
          },
        }),
      });
    },
  };
  return f;
}
