/**
 * The reconcile's reads-queue PRODUCER, pure (master plan step 12, PR 12-g): the derived task name,
 * the three delays, and what a rejection means — against a recording queue, the SDK's error class
 * real. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { TIPO_TAREFA_RECONCILE_ESTOQUE_LI } from '@delfrance/schemas';

import { falhaDoFunctions } from '../../testing/falhaDeEnfileiramento';
import {
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  criarAgendadorReconcileEstoqueLi,
} from './agendadorReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('agendadorReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const FATIA = {
  tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  execucaoId: 'estoque-reconcile-20270115',
  seq: 2,
};

function filaGravadora(falha?: () => unknown) {
  const chamadas: unknown[][] = [];
  return {
    chamadas,
    fila: () => ({
      async enqueue(...args: unknown[]) {
        chamadas.push(args);
        if (falha !== undefined) throw falha();
      },
    }),
  };
}

describe('criarAgendadorReconcileEstoqueLi', () => {
  it('names every task from its payload, and sends a delay only when it is not 0', async () => {
    const q = filaGravadora();
    const agendador = criarAgendadorReconcileEstoqueLi({ fila: q.fila, desligado: false });
    await agendador.enfileirar(FATIA, { atrasoS: 2 });
    await agendador.enfileirar({ ...FATIA, seq: 0 }, { atrasoS: 0 });
    await agendador.enfileirar(FATIA, { atrasoS: 60 });
    expect(q.chamadas).toEqual([
      [FATIA, { id: 'li-estoque-reconcile-20270115-2', scheduleDelaySeconds: 2 }],
      [{ ...FATIA, seq: 0 }, { id: 'li-estoque-reconcile-20270115-0' }],
      [FATIA, { id: 'li-estoque-reconcile-20270115-2', scheduleDelaySeconds: 60 }],
    ]);
  });

  it('⚠️ NEAR-MISS: any delay but 0, 2 and 60 s is refused before the queue is resolved', async () => {
    const q = filaGravadora();
    const agendador = criarAgendadorReconcileEstoqueLi({ fila: q.fila, desligado: false });
    await expect(agendador.enfileirar(FATIA, { atrasoS: 1 })).rejects.toThrow(RangeError);
    await expect(agendador.enfileirar(FATIA, { atrasoS: 59 })).rejects.toThrow(RangeError);
    expect(q.chamadas).toEqual([]);
  });

  it('the payload is strict and ids only: an extra key or a bad run id never leaves', async () => {
    const q = filaGravadora();
    const agendador = criarAgendadorReconcileEstoqueLi({ fila: q.fila, desligado: false });
    await expect(
      agendador.enfileirar({ ...FATIA, quantidade: 1 } as typeof FATIA, { atrasoS: 0 }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      agendador.enfileirar({ ...FATIA, execucaoId: 'a b' }, { atrasoS: 0 }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(q.chamadas).toEqual([]);
  });

  it('an answered task-already-exists is SUCCESS; a 503 is named transient; anything else is rethrown as thrown', async () => {
    const jaExiste = criarAgendadorReconcileEstoqueLi({
      fila: filaGravadora(() => falhaDoFunctions('task-already-exists', 409)).fila,
      desligado: false,
    });
    await jaExiste.enfileirar(FATIA, { atrasoS: 2 });
    const transitoria = criarAgendadorReconcileEstoqueLi({
      fila: filaGravadora(() => falhaDoFunctions('unknown-error')).fila,
      desligado: false,
    });
    await expect(transitoria.enfileirar(FATIA, { atrasoS: 2 })).rejects.toBeInstanceOf(
      LiTarefasTransitoriasError,
    );
    const bug = new TypeError('bug');
    const outra = criarAgendadorReconcileEstoqueLi({
      fila: filaGravadora(() => bug).fila,
      desligado: false,
    });
    await expect(outra.enfileirar(FATIA, { atrasoS: 2 })).rejects.toBe(bug);
  });

  it('the closed sweep-only valve rejects every enqueue named, and never resolves the queue', async () => {
    const fila = vi.fn();
    const agendador = criarAgendadorReconcileEstoqueLi({ fila, desligado: true });
    await expect(agendador.enfileirar(FATIA, { atrasoS: 2 })).rejects.toBeInstanceOf(
      LiTarefasDesligadasError,
    );
    expect(fila).not.toHaveBeenCalled();
  });
});
