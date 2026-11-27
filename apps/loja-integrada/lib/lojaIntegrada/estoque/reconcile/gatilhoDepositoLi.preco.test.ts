/**
 * The conta trigger's DEPÓSITO arm under the both-valve gate (master plan step 13, PR 13-f1): a
 * full run carries the price arm too, so a re-pointed depósito starts one when EITHER valve is set;
 * nothing happens only when both are `off`. No Firestore; the producer built only when due.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { type AmbienteLi, VALVULA_ENV_LI } from '../../core/valvulas';
import { espiarStdout } from '../../testing/fixtures';
import { agendadorGravador, loggerGravador } from '../../testing/reconcileEstoqueLi';
import { agendarReconcileDoDepositoLi, idExecucaoDoDepositoLi } from './gatilhoDepositoLi';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('gatilhoDepositoLi.preco.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const conta = (depositoOuterRef: string) => ({
  tipo: INTEGRACAO_TIPO.lojaIntegrada,
  nome: 'Loja',
  ativo: true,
  depositoOuterRef,
});
const QUANDO = { seconds: 1_800_000_000, nanoseconds: 5_000 };

async function rodar(ambiente: AmbienteLi) {
  const fila = agendadorGravador();
  const construir = vi.fn(() => fila.agendador);
  const r = await agendarReconcileDoDepositoLi({
    integracaoId: 'C1',
    before: conta('documents/depositos/D1'),
    after: conta('documents/depositos/D2'),
    atualizadoEm: QUANDO,
    ambiente,
    agendador: construir,
    logger: loggerGravador().logger,
  });
  return { r, fila, construir };
}

describe('the depósito arm and the both-valve gate', () => {
  it('the price valve set with the stock valve unset ⇒ ONE full run enqueued', async () => {
    const { r, fila } = await rodar({ [VALVULA_ENV_LI.preco]: 'dry-run' });
    const execucaoId = idExecucaoDoDepositoLi(1_800_000_000_000_005);
    expect(r).toEqual({ kind: 'enfileirado', execucaoId });
    expect(fila.enfileirados).toEqual([{ execucaoId, seq: 0, atrasoS: 0 }]);
  });

  it('both valves off ⇒ nothing, zero reads, the producer never built; NEAR-MISS: `OFF` reads as off', async () => {
    for (const ambiente of [{}, { [VALVULA_ENV_LI.preco]: 'OFF' }]) {
      const espiao = espiarStdout();
      try {
        const { r, construir } = await rodar(ambiente);
        expect(r, JSON.stringify(ambiente)).toEqual({ kind: 'desligado' });
        expect(construir).not.toHaveBeenCalled();
      } finally {
        espiao.restaurar();
      }
    }
  });
});
