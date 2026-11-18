/**
 * The reconcile's NIGHTLY start (master plan step 12, PR 12-g): decided from the environment alone,
 * at most ONE named enqueue, the run named by the schedule time's civil date in São Paulo. No
 * Firestore at all — there is no `db` to hand it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agendadorGravador, loggerGravador } from '../../testing/reconcileEstoqueLi';
import { LiTarefasDesligadasError, LiTarefasTransitoriasError } from './agendadorReconcile';
import { agendarReconcileEstoqueLi, idDaExecucaoAgendadaLi } from './agendamentoReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('agendamentoReconcile.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const LIGADO = { LOJA_INTEGRADA_MODO_ESTOQUE: 'dry-run', LOJA_INTEGRADA_CHAMADAS: 'on' };
/** 04:23 in São Paulo on 2026-11-19 (UTC−3). */
const TICK = '2026-11-19T07:23:00Z';
const RELOGIO = Date.UTC(2027, 5, 1, 12, 0, 0);

function rodar(
  ambiente: Record<string, string>,
  horaAgendada: string | undefined,
  falha?: () => unknown,
) {
  const fila = agendadorGravador(falha);
  const log = loggerGravador();
  const construir = vi.fn(() => fila.agendador);
  return {
    fila,
    log,
    construir,
    r: agendarReconcileEstoqueLi({
      ambiente,
      horaAgendada,
      agoraMs: () => RELOGIO,
      agendador: construir,
      logger: log.logger,
    }),
  };
}

describe('agendarReconcileEstoqueLi', () => {
  it('dry-run and on: exactly ONE enqueue — the run named by the schedule time’s São Paulo date, seq 0, at once', async () => {
    for (const modo of ['dry-run', 'on']) {
      const x = rodar({ ...LIGADO, LOJA_INTEGRADA_MODO_ESTOQUE: modo }, TICK);
      expect(await x.r).toEqual({ kind: 'enfileirado', execucaoId: 'estoque-reconcile-20261119' });
      expect(x.fila.enfileirados).toEqual([
        { execucaoId: 'estoque-reconcile-20261119', seq: 0, atrasoS: 0 },
      ]);
    }
  });

  it('⚠️ a Scheduler retry of the same tick names the SAME run (the date from the schedule time, never the clock)', async () => {
    const a = rodar(LIGADO, TICK);
    const b = rodar(LIGADO, TICK);
    await Promise.all([a.r, b.r]);
    expect(a.fila.enfileirados).toEqual(b.fila.enfileirados);
    // The clock (2027-06-01) is never the run's date while the tick parses.
    expect(a.fila.enfileirados[0]?.execucaoId).not.toContain('20270601');
  });

  it('⚠️ NEAR-MISS: the civil date is São Paulo’s — 02:59 UTC on the 20th is still the 19th there', () => {
    expect(idDaExecucaoAgendadaLi(Date.parse('2026-11-20T02:59:59Z'))).toBe(
      'estoque-reconcile-20261119',
    );
    expect(idDaExecucaoAgendadaLi(Date.parse('2026-11-20T03:00:00Z'))).toBe(
      'estoque-reconcile-20261120',
    );
  });

  it('the valve off — unset, blank, a typo — does nothing, and builds no producer', async () => {
    for (const modo of [undefined, '', 'On']) {
      const ambiente: Record<string, string> = { LOJA_INTEGRADA_CHAMADAS: 'on' };
      if (modo !== undefined) ambiente.LOJA_INTEGRADA_MODO_ESTOQUE = modo;
      const x = rodar(ambiente, TICK);
      expect(await x.r).toEqual({ kind: 'desligado' });
      expect(x.construir).not.toHaveBeenCalled();
    }
  });

  it('⚠️ NEAR-MISS: the read switch not EXACTLY on does nothing either — one INFO line, no producer', async () => {
    for (const chave of [undefined, 'off', 'ON', 'on ']) {
      const ambiente: Record<string, string> = { LOJA_INTEGRADA_MODO_ESTOQUE: 'on' };
      if (chave !== undefined) ambiente.LOJA_INTEGRADA_CHAMADAS = chave;
      const x = rodar(ambiente, TICK);
      expect(await x.r).toEqual({ kind: 'chamadas-desligadas' });
      expect(x.construir).not.toHaveBeenCalled();
      expect(x.log.linhas.map((l) => l.nivel)).toEqual(['info']);
    }
  });

  it('a schedule time that does not parse falls back to the clock, with ONE WARNING', async () => {
    const x = rodar(LIGADO, 'ontem');
    expect(await x.r).toEqual({ kind: 'enfileirado', execucaoId: 'estoque-reconcile-20270601' });
    expect(x.log.linhas.filter((l) => l.nivel === 'warn')).toHaveLength(1);
    const y = rodar(LIGADO, undefined);
    expect(await y.r).toEqual({ kind: 'enfileirado', execucaoId: 'estoque-reconcile-20270601' });
  });

  it('the closed sweep-only valve is ONE WARNING; a transient failure is RETHROWN for the Scheduler’s retry', async () => {
    const desligada = rodar(LIGADO, TICK, () => new LiTarefasDesligadasError());
    expect(await desligada.r).toEqual({
      kind: 'tarefas-desligadas',
      execucaoId: 'estoque-reconcile-20261119',
    });
    expect(desligada.log.linhas.filter((l) => l.nivel === 'warn')).toHaveLength(1);
    const transitoria = rodar(
      LIGADO,
      TICK,
      () => new LiTarefasTransitoriasError('FirebaseFunctionsError', 'unknown-error', 503),
    );
    await expect(transitoria.r).rejects.toBeInstanceOf(LiTarefasTransitoriasError);
  });
});
