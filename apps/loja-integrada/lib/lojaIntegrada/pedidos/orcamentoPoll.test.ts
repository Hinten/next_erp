import { PRAZO_LI_MS } from '@delfrance/integrations-loja-integrada';
import { describe, expect, it } from 'vitest';

import { RITMO_LEITURA_LI_MS } from '../core/ritmo';
import {
  DURACAO_LEASE_POLL_MS,
  FOLGA_CONTA_MS,
  LATENCIA_LI_ESTIMADA_MS,
  MAX_PAGINAS_POLL,
  ORCAMENTO_CONTA_MS,
  ORCAMENTO_MINIMO_CONTA_MS,
  ORCAMENTO_TICK_MS,
  custoPlanejadoDoDrenoMs,
  orcamentoDaContaMs,
} from './orcamentoPoll';

/** The poller's schedule (`every 5 minutes`), pinned by the functions codebase's own test. */
const INTERVALO_DO_AGENDAMENTO_MS = 5 * 60_000;

describe('the budget constants', () => {
  it('are the planned values — a change here is a deliberate re-plan', () => {
    expect(MAX_PAGINAS_POLL).toBe(20);
    expect(ORCAMENTO_TICK_MS).toBe(220_000);
    expect(ORCAMENTO_CONTA_MS).toBe(100_000);
    expect(FOLGA_CONTA_MS).toBe(10_000);
    expect(LATENCIA_LI_ESTIMADA_MS).toBe(2_000);
    expect(DURACAO_LEASE_POLL_MS).toBe(300_000);
  });

  it('THE INVARIANT: the drain cap fits the conta budget, slack kept', () => {
    // MAX_PAGINAS_POLL × (RITMO_LEITURA_LI_MS + LATENCIA_LI_ESTIMADA_MS)
    //   ≤ ORCAMENTO_CONTA_MS − FOLGA_CONTA_MS
    expect(MAX_PAGINAS_POLL * (RITMO_LEITURA_LI_MS + LATENCIA_LI_ESTIMADA_MS)).toBeLessThanOrEqual(
      ORCAMENTO_CONTA_MS - FOLGA_CONTA_MS,
    );
    expect(custoPlanejadoDoDrenoMs(MAX_PAGINAS_POLL)).toBe(80_000);
  });

  it('near-miss of the invariant: 22 pages would still fit, 23 would not', () => {
    // So raising the cap past 22 turns the invariant above red.
    expect(custoPlanejadoDoDrenoMs(22)).toBeLessThanOrEqual(ORCAMENTO_CONTA_MS - FOLGA_CONTA_MS);
    expect(custoPlanejadoDoDrenoMs(23)).toBeGreaterThan(ORCAMENTO_CONTA_MS - FOLGA_CONTA_MS);
  });

  it('a conta budget fits a tick, and a tick ends before the next one starts', () => {
    expect(ORCAMENTO_CONTA_MS).toBeLessThanOrEqual(ORCAMENTO_TICK_MS);
    // The last conta may overshoot its budget by one pacer interval.
    expect(ORCAMENTO_TICK_MS + RITMO_LEITURA_LI_MS).toBeLessThan(INTERVALO_DO_AGENDAMENTO_MS);
  });

  it('a conta is started with at least one page’s planned cost (4 000 ms)', () => {
    expect(ORCAMENTO_MINIMO_CONTA_MS).toBe(custoPlanejadoDoDrenoMs(1));
    expect(ORCAMENTO_MINIMO_CONTA_MS).toBe(4_000);
    // Never more than a whole conta budget: a fresh tick always starts its first conta.
    expect(ORCAMENTO_MINIMO_CONTA_MS).toBeLessThanOrEqual(ORCAMENTO_CONTA_MS);
  });

  it("the lease outlives a run's longest life: budget + one interval + one whole request", () => {
    expect(DURACAO_LEASE_POLL_MS).toBeGreaterThanOrEqual(
      ORCAMENTO_CONTA_MS + RITMO_LEITURA_LI_MS + PRAZO_LI_MS.leitura,
    );
  });
});

describe('orcamentoDaContaMs', () => {
  const inicio = 1_000_000;

  it('a full conta budget while the tick has more than that left', () => {
    expect(orcamentoDaContaMs(inicio, inicio)).toBe(ORCAMENTO_CONTA_MS);
    expect(orcamentoDaContaMs(inicio, inicio + 120_000)).toBe(ORCAMENTO_CONTA_MS);
  });

  it('what the tick has left, once that is less', () => {
    expect(orcamentoDaContaMs(inicio, inicio + 120_001)).toBe(99_999);
    expect(orcamentoDaContaMs(inicio, inicio + 150_000)).toBe(70_000);
  });

  it('0 at and past the deadline (sem-tempo), never negative', () => {
    expect(orcamentoDaContaMs(inicio, inicio + ORCAMENTO_TICK_MS)).toBe(0);
    expect(orcamentoDaContaMs(inicio, inicio + ORCAMENTO_TICK_MS + 5_000)).toBe(0);
  });
});
