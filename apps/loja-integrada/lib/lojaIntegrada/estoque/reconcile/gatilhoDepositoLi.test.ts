/**
 * `gatilhoDepositoLi.ts` (master plan step 12, PR 12-g): the depósito-change arm's pure decision
 * and its one enqueue. Nothing here touches Firestore (no `db` exists to touch) or the network
 * (`fetch` throws). The trigger's binding and the arm inside it: `functions/src/
 * onIntegracaoLojaIntegradaChanged.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { VALVULA_ENV_LI } from '../../core/valvulas';
import { agendadorGravador, loggerGravador } from '../../testing/reconcileEstoqueLi';
import { LiTarefasDesligadasError } from './agendadorReconcile';
import {
  agendarReconcileDoDepositoLi,
  idExecucaoDoDepositoLi,
  mudouDepositoDaContaLi,
} from './gatilhoDepositoLi';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('gatilhoDepositoLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const conta = (depositoOuterRef: unknown, over: Record<string, unknown> = {}) => ({
  tipo: INTEGRACAO_TIPO.lojaIntegrada,
  nome: 'Loja',
  ativo: true,
  depositoOuterRef,
  ...over,
});
const QUANDO = { seconds: 1_800_000_000, nanoseconds: 5_000 };

describe('mudouDepositoDaContaLi (pure)', () => {
  it('fires on D1 → D2 and on none → D1', () => {
    expect(mudouDepositoDaContaLi(conta('documents/depositos/D1'), conta('depositos/D2'))).toBe(
      true,
    );
    expect(mudouDepositoDaContaLi(conta(null), conta('depositos/D1'))).toBe(true);
    expect(mudouDepositoDaContaLi(conta('junk'), conta('depositos/D1'))).toBe(true);
  });

  it('⚠️ NEAR-MISS: never on a create, a same depósito in the other spelling, a removal, a delete, an inactive or other conta', () => {
    expect(mudouDepositoDaContaLi(null, conta('depositos/D1'))).toBe(false);
    expect(mudouDepositoDaContaLi(conta('documents/depositos/D1'), conta('depositos/D1'))).toBe(
      false,
    );
    expect(mudouDepositoDaContaLi(conta('depositos/D1'), conta('/documents/depositos/D1'))).toBe(
      false,
    );
    expect(mudouDepositoDaContaLi(conta('depositos/D1'), conta(null))).toBe(false);
    expect(mudouDepositoDaContaLi(conta('depositos/D1'), null)).toBe(false);
    expect(
      mudouDepositoDaContaLi(conta('depositos/D1'), conta('depositos/D2', { ativo: false })),
    ).toBe(false);
    expect(
      mudouDepositoDaContaLi(
        conta('depositos/D1', { tipo: 99 }),
        conta('depositos/D2', { tipo: 99 }),
      ),
    ).toBe(false);
    expect(
      mudouDepositoDaContaLi(conta('depositos/D1'), conta('depositos/D2', { tipo: '3' })),
    ).toBe(false);
  });
});

describe('agendarReconcileDoDepositoLi', () => {
  const ambiente = (modo: string | undefined) => ({ [VALVULA_ENV_LI.estoque]: modo });

  it('ONE named task, seq 0, delay 0: the run named by the µs of the after side’s update time', async () => {
    const fila = agendadorGravador();
    const log = loggerGravador();
    const r = await agendarReconcileDoDepositoLi({
      integracaoId: 'C1',
      before: conta('depositos/D1'),
      after: conta('depositos/D2'),
      atualizadoEm: QUANDO,
      ambiente: ambiente('on'),
      agendador: () => fila.agendador,
      logger: log.logger,
    });
    const execucaoId = idExecucaoDoDepositoLi(1_800_000_000_000_005);
    expect(r).toEqual({ kind: 'enfileirado', execucaoId });
    expect(fila.enfileirados).toEqual([{ execucaoId, seq: 0, atrasoS: 0 }]);
    expect(log.linhas).toHaveLength(1);
  });

  it('the valve off, or no stamp: nothing, the producer never built', async () => {
    const raiz = vi.fn();
    const log = loggerGravador();
    for (const [modo, atualizadoEm] of [
      [undefined, QUANDO],
      ['ON', QUANDO],
      ['on', undefined],
    ] as const) {
      const r = await agendarReconcileDoDepositoLi({
        integracaoId: 'C1',
        before: conta('depositos/D1'),
        after: conta('depositos/D2'),
        atualizadoEm,
        ambiente: ambiente(modo),
        agendador: raiz,
        logger: log.logger,
      });
      expect(r.kind).not.toBe('enfileirado');
    }
    expect(raiz).not.toHaveBeenCalled();
  });

  it('the sweep-only valve closed ⇒ ONE WARNING, no throw', async () => {
    const fila = agendadorGravador(() => new LiTarefasDesligadasError());
    const log = loggerGravador();
    const r = await agendarReconcileDoDepositoLi({
      integracaoId: 'C1',
      before: conta('depositos/D1'),
      after: conta('depositos/D2'),
      atualizadoEm: QUANDO,
      ambiente: ambiente('dry-run'),
      agendador: () => fila.agendador,
      logger: log.logger,
    });
    expect(r.kind).toBe('tarefas-desligadas');
    expect(log.linhas.map((l) => l.nivel)).toEqual(['warn']);
  });
});
