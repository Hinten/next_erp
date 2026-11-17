/**
 * The product import's PRODUCER (master plan step 9): the task's name, its delay, and what an
 * enqueue's rejection means. The failures are the SDK's own classes
 * (`testing/falhaDeEnfileiramento.ts`) — never a numeric gRPC stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { ZodError } from 'zod';
import { TIPO_TAREFA_IMPORTACAO_LI, type TarefaImportacaoLi } from '@delfrance/schemas';

import { tarefaJaExisteLi } from '../notificacoes/agendador';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDeConfiguracaoDoFunctions,
  falhaDoApp,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import {
  ATRASO_CONTINUACAO_IMPORTACAO_LI_S,
  ATRASO_PAUSA_429_IMPORTACAO_LI_S,
  type FilaImportacaoLi,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  type OpcoesEnfileiramentoImportacaoLi,
  criarAgendadorImportacaoLi,
} from './agendadorImportacao';

// D17, per file: nothing here may reach the global `fetch` (no client is built at all).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('agendadorImportacao.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function tarefa(over: Partial<TarefaImportacaoLi> = {}): TarefaImportacaoLi {
  return {
    tipo: TIPO_TAREFA_IMPORTACAO_LI,
    contaId: 'conta-li-importacao',
    jobId: 'jobImportacao01',
    seq: 0,
    ...over,
  };
}

function fila(falha: Error | null = null) {
  const chamadas: { payload: unknown; opcoes: OpcoesEnfileiramentoImportacaoLi }[] = [];
  const f: FilaImportacaoLi = {
    enqueue: (payload, opcoes) => {
      chamadas.push({ payload, opcoes });
      return falha === null ? Promise.resolve() : Promise.reject(falha);
    },
  };
  return { f, chamadas };
}

const aberto = (f: FilaImportacaoLi) =>
  criarAgendadorImportacaoLi({ fila: () => f, desligado: false });

describe('the task: named after (jobId, seq), the payload alone', () => {
  it('dispatch 0 goes at once: the payload, its name, NO delay key', async () => {
    const { f, chamadas } = fila();
    await aberto(f).enfileirar(tarefa(), { atrasoS: 0 });
    expect(chamadas).toEqual([
      { payload: tarefa(), opcoes: { id: 'li-importacao-jobImportacao01-0' } },
    ]);
    expect(Object.keys(chamadas[0]?.opcoes ?? {})).toEqual(['id']);
  });

  it('a hand-off waits 2 s; a 429 pause waits 60 s; the name follows the seq', async () => {
    const { f, chamadas } = fila();
    await aberto(f).enfileirar(tarefa({ seq: 7 }), { atrasoS: ATRASO_CONTINUACAO_IMPORTACAO_LI_S });
    await aberto(f).enfileirar(tarefa({ seq: 8 }), { atrasoS: ATRASO_PAUSA_429_IMPORTACAO_LI_S });
    expect(chamadas.map((c) => c.opcoes)).toEqual([
      { id: 'li-importacao-jobImportacao01-7', scheduleDelaySeconds: 2 },
      { id: 'li-importacao-jobImportacao01-8', scheduleDelaySeconds: 60 },
    ]);
    expect(ATRASO_CONTINUACAO_IMPORTACAO_LI_S).toBe(2);
    expect(ATRASO_PAUSA_429_IMPORTACAO_LI_S).toBe(60);
  });

  it('EQUAL pair: the same (jobId, seq) ⇒ the same task name, whoever enqueues it', async () => {
    const { f, chamadas } = fila();
    await aberto(f).enfileirar(tarefa({ seq: 3 }), { atrasoS: ATRASO_CONTINUACAO_IMPORTACAO_LI_S });
    await aberto(f).enfileirar(tarefa({ seq: 3 }), { atrasoS: 0 });
    expect(chamadas[0]?.opcoes.id).toBe(chamadas[1]?.opcoes.id);
  });

  it('⚠️ NEAR-MISS: another seq or another job ⇒ another name', async () => {
    const { f, chamadas } = fila();
    await aberto(f).enfileirar(tarefa({ seq: 3 }), { atrasoS: 0 });
    await aberto(f).enfileirar(tarefa({ seq: 4 }), { atrasoS: 0 });
    await aberto(f).enfileirar(tarefa({ seq: 3, jobId: 'jobImportacao02' }), { atrasoS: 0 });
    expect(new Set(chamadas.map((c) => c.opcoes.id)).size).toBe(3);
  });

  it('the payload is parsed: an extra key is stripped, never shipped', async () => {
    const { f, chamadas } = fila();
    const comExtra = { ...tarefa(), token: 'nunca-na-fila' } as TarefaImportacaoLi;
    await aberto(f).enfileirar(comExtra, { atrasoS: 0 });
    expect(chamadas[0]?.payload).toEqual(tarefa());
  });

  it.each([
    ['a jobId outside the task-id grammar', { jobId: 'job/outro' }],
    ['a negative seq', { seq: -1 }],
    ['a fractional seq', { seq: 1.5 }],
    ['a conta id outside its grammar', { contaId: 'conta com espaço' }],
  ])('%s ⇒ ZodError, and the queue is never resolved', async (_caso, over) => {
    let resolvida = false;
    const agendador = criarAgendadorImportacaoLi({
      fila: () => {
        resolvida = true;
        return fila().f;
      },
      desligado: false,
    });
    await expect(
      agendador.enfileirar(tarefa(over as Partial<TarefaImportacaoLi>), { atrasoS: 0 }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(resolvida).toBe(false);
  });

  it.each([1, 3, 30, 59, 61, -2, 2.5, Number.NaN])(
    'a delay of %s s is refused before the queue is resolved (the delay is not a knob)',
    async (atrasoS) => {
      let resolvida = false;
      const agendador = criarAgendadorImportacaoLi({
        fila: () => {
          resolvida = true;
          return fila().f;
        },
        desligado: false,
      });
      await expect(agendador.enfileirar(tarefa(), { atrasoS })).rejects.toBeInstanceOf(RangeError);
      expect(resolvida).toBe(false);
    },
  );
});

describe('what an enqueue rejection means', () => {
  it('`functions/task-already-exists` that Cloud Tasks ANSWERED is SUCCESS: the dispatch is queued', async () => {
    const { f, chamadas } = fila(falhaDoFunctions('task-already-exists', 409));
    await expect(aberto(f).enfileirar(tarefa(), { atrasoS: 0 })).resolves.toBeUndefined();
    expect(chamadas).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: the same code with NO response is not a dedup ⇒ rethrown untouched', async () => {
    const semResposta = new FirebaseFunctionsError({
      code: 'task-already-exists',
      message: 'sem resposta',
    });
    expect(tarefaJaExisteLi(semResposta)).toBe(false);
    expect(tarefaJaExisteLi(falhaDoFunctions('task-already-exists', 409))).toBe(true);
    const { f } = fila(semResposta);
    await expect(aberto(f).enfileirar(tarefa(), { atrasoS: 0 })).rejects.toBe(semResposta);
  });

  it('the sweep-only valve closed ⇒ LiTarefasDesligadasError, and the queue is never resolved', async () => {
    let resolvida = false;
    await expect(
      criarAgendadorImportacaoLi({
        fila: () => {
          resolvida = true;
          return fila().f;
        },
        desligado: true,
      }).enfileirar(tarefa(), { atrasoS: ATRASO_CONTINUACAO_IMPORTACAO_LI_S }),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    expect(resolvida).toBe(false);
  });

  it.each([
    ['a 503 answered', falhaDoFunctions('unknown-error', 503)],
    ['a 500 answered', falhaDoFunctions('internal-error', 500)],
    ['a socket failure', falhaDoApp('network-error')],
    ['a socket timeout', falhaDoApp('network-timeout')],
  ])('%s ⇒ LiTarefasTransitoriasError, never quoting the response body', async (_caso, falha) => {
    const { f } = fila(falha);
    const err: unknown = await aberto(f)
      .enfileirar(tarefa(), { atrasoS: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiTarefasTransitoriasError);
    expect((err as Error).message).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  it.each([
    ['permission denied', falhaDoFunctions('permission-denied', 403)],
    ['no queue in that region', falhaDoFunctions('not-found', 404)],
    ['the SDK cannot resolve the project', falhaDeConfiguracaoDoFunctions('projeto')],
    ['a coding bug', new TypeError('bug')],
  ])('%s ⇒ rethrown EXACTLY as thrown (a broken deploy, loud)', async (_caso, falha) => {
    const { f } = fila(falha);
    await expect(aberto(f).enfileirar(tarefa(), { atrasoS: 0 })).rejects.toBe(falha);
  });

  it('a root’s region guard thrown while resolving the queue is rethrown untouched', async () => {
    const guarda = new Error('região ausente');
    const agendador = criarAgendadorImportacaoLi({
      fila: () => {
        throw guarda;
      },
      desligado: false,
    });
    await expect(agendador.enfileirar(tarefa(), { atrasoS: 0 })).rejects.toBe(guarda);
  });
});
