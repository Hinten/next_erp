/**
 * The reconcile's NIGHTLY start under the both-valve gate (master plan step 13, PR 13-f1): the run
 * is enqueued when EITHER valve is set — a price valve alone starts it — and nothing happens only
 * when both are `off`. No Firestore at all; the producer is built only when the enqueue is due.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AmbienteLi, VALVULA_ENV_LI } from '../../core/valvulas';
import { espiarStdout } from '../../testing/fixtures';
import { agendadorGravador, loggerGravador } from '../../testing/reconcileEstoqueLi';
import { agendarReconcileEstoqueLi } from './agendamentoReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('agendamentoReconcile.preco.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const TICK = '2026-11-19T07:23:00Z';

async function rodar(ambiente: AmbienteLi) {
  const fila = agendadorGravador();
  const construir = vi.fn(() => fila.agendador);
  const r = await agendarReconcileEstoqueLi({
    ambiente,
    horaAgendada: TICK,
    agoraMs: () => 0,
    agendador: construir,
    logger: loggerGravador().logger,
  });
  return { r, fila, construir };
}

describe('the nightly start and the both-valve gate', () => {
  it.each([['dry-run'], ['on']])(
    'the price valve %s with the stock valve unset ⇒ the run is enqueued',
    async (modo) => {
      const { r, fila } = await rodar({ [VALVULA_ENV_LI.preco]: modo });
      expect(r).toEqual({ kind: 'enfileirado', execucaoId: 'estoque-reconcile-20261119' });
      expect(fila.enfileirados).toEqual([
        { execucaoId: 'estoque-reconcile-20261119', seq: 0, atrasoS: 0 },
      ]);
    },
  );

  it('both valves off ⇒ nothing, the producer never built; NEAR-MISS: `OFF` and ` on` read as off', async () => {
    for (const ambiente of [
      {},
      { [VALVULA_ENV_LI.estoque]: 'off', [VALVULA_ENV_LI.preco]: 'off' },
      { [VALVULA_ENV_LI.preco]: 'OFF' },
      { [VALVULA_ENV_LI.preco]: ' on', [VALVULA_ENV_LI.estoque]: 'ON' },
    ]) {
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

  it('an unrecognised value is ONE valve WARNING per flow, exactly as the stock valve’s always was', async () => {
    const espiao = espiarStdout();
    try {
      await rodar({ [VALVULA_ENV_LI.estoque]: 'ON', [VALVULA_ENV_LI.preco]: 'OFF' });
      const valvulas = espiao
        .escritas()
        .map((linha) => JSON.parse(linha) as Record<string, unknown>)
        .filter((l) => l.evento === 'valvula')
        .map((l) => l.fluxo);
      expect(valvulas.sort()).toEqual(['estoque', 'preco']);
    } finally {
      espiao.restaurar();
    }
  });
});
