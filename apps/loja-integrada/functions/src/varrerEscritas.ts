import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
} from '../../lib/lojaIntegrada/notificacoes/agendador';
import {
  type AgendadorEscritaLi,
  TIPO_TAREFA_VARREDURA_ESCRITA_LI,
  idDaTarefaVarreduraEscritaLi,
} from '../../lib/lojaIntegrada/rastreio/agendadorEscrita';
import { criarAgendadorEscritaLiDoAmbiente } from './agendadorEscrita';

/** The scheduler's lines: one per tick. */
interface LoggerDaVarreduraLi {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * The task id of this tick's varredura: from the tick's own schedule time, so a
 * redelivery of the same tick collides; from the clock's instant only when the
 * schedule time carries no digit (never a bare `varredura-`, which would
 * collide with every tick for as long as Cloud Tasks keeps the name).
 */
function idDoTick(horaAgendada: string | undefined, agoraMs: () => number): string {
  const doTick = idDaTarefaVarreduraEscritaLi(horaAgendada ?? '');
  if (doTick !== null) return doTick;
  const doRelogio = idDaTarefaVarreduraEscritaLi(new Date(agoraMs()).toISOString());
  if (doRelogio === null) {
    throw new TypeError('varredura de escritas: nenhum instante utilizável para o id da tarefa');
  }
  return doRelogio;
}

/**
 * ONE tick: enqueue exactly one `varredura` task onto the writes queue, named
 * after the tick. Already queued (an answered `task-already-exists`) is success
 * — the producer says so. Tasks switched off, or a transient Cloud Tasks
 * failure: ONE WARNING and return, because the next tick (30 minutes later)
 * simply tries again and nothing was lost — the rows wait in the store and do
 * not age while no varredura runs. Anything else is a broken deploy and is
 * rethrown, loud.
 */
export async function enfileirarVarreduraEscritaLi(
  agendador: AgendadorEscritaLi,
  horaAgendada: string | undefined,
  agoraMs: () => number,
  log: LoggerDaVarreduraLi,
): Promise<void> {
  const id = idDoTick(horaAgendada, agoraMs);
  try {
    await agendador.enfileirar({ tipo: TIPO_TAREFA_VARREDURA_ESCRITA_LI }, { id });
  } catch (err) {
    if (err instanceof LiTarefasDesligadasError || err instanceof LiTarefasTransitoriasError) {
      log.warn(
        '[loja-integrada] varredura de escritas não enfileirada — o próximo tick tenta de novo',
        { id, classe: err.name },
      );
      return;
    }
    throw err;
  }
  log.info('[loja-integrada] varredura de escritas enfileirada', { id });
}

/**
 * The writes queue's BACKSTOP timer (master plan step 7, PR 7-e). Every 30
 * minutes, at :15 and :45 (offset from the reads sweep's `*\/30`), it enqueues
 * ONE `varredura` task onto `filaEscritaLojaIntegrada` — and that is all it
 * does. The sweep itself runs inside the writes queue's single dispatch slot
 * (`./filaEscrita`): the shared core's sweep runs `process` inline, so running
 * it HERE would put a second writer beside the queue, and a retry could then
 * race a fresh write of the same order.
 *
 * It does not read the write valve: the varredura task does, first, and at `off`
 * returns before touching either lane (so `off` keeps the backlog). It reads no
 * Firestore document and calls no platform.
 *
 * 60 s: one enqueue. Cloud Scheduler's own retry of a tick carries the same
 * schedule time, so it names the same task and collides.
 */
export const varrerEscritasLojaIntegrada = onSchedule(
  {
    schedule: '15,45 * * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: 60,
  },
  async (evento) => {
    await enfileirarVarreduraEscritaLi(
      criarAgendadorEscritaLiDoAmbiente(),
      evento.scheduleTime,
      () => Date.now(),
      logger,
    );
  },
);
