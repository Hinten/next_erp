import { PRAZO_LI_MS } from '@delfrance/integrations-loja-integrada';
import { describe, expect, it } from 'vitest';

import { RITMO_LEITURA_LI_MS } from '../core/ritmo';
import {
  DURACAO_LEASE_POLL_MS,
  FOLGA_CONTA_MS,
  INTERVALO_DO_AGENDAMENTO_POLL_MS,
  LATENCIA_LI_ESTIMADA_MS,
  MAX_PAGINAS_POLL,
  ORCAMENTO_CONTA_MS,
  ORCAMENTO_MINIMO_CONTA_MS,
  ORCAMENTO_TICK_MS,
  custoPlanejadoDoDrenoMs,
  orcamentoDaContaMs,
  ordemDoTickLi,
} from './orcamentoPoll';

/** The poller's schedule (`every 5 minutes`); the cron string is pinned by the functions codebase's own test. */
const INTERVALO_DO_AGENDAMENTO_MS = INTERVALO_DO_AGENDAMENTO_POLL_MS;

describe('the budget constants', () => {
  it('are the planned values — a change here is a deliberate re-plan', () => {
    expect(MAX_PAGINAS_POLL).toBe(20);
    expect(ORCAMENTO_TICK_MS).toBe(220_000);
    expect(ORCAMENTO_CONTA_MS).toBe(100_000);
    expect(FOLGA_CONTA_MS).toBe(10_000);
    expect(LATENCIA_LI_ESTIMADA_MS).toBe(2_000);
    expect(DURACAO_LEASE_POLL_MS).toBe(300_000);
    expect(INTERVALO_DO_AGENDAMENTO_POLL_MS).toBe(5 * 60_000);
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

  it('a conta is started with at least one page’s planned cost PLUS the run’s slack (14 000 ms)', () => {
    // One page alone (4 000 ms) leaves nothing for the reads and the lease
    // before it, nor for an enqueue after it: a new row on that page would end
    // the run in a COUNTED orcamento-esgotado (pollPedidos.test.ts, the near-miss).
    expect(ORCAMENTO_MINIMO_CONTA_MS).toBe(custoPlanejadoDoDrenoMs(1) + FOLGA_CONTA_MS);
    expect(ORCAMENTO_MINIMO_CONTA_MS).toBe(14_000);
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

describe('ordemDoTickLi — the tick ROTATES its first conta', () => {
  const contas = ['a', 'b', 'c'] as const;
  const fatia = (k: number) => 1_800_000_000_000 + k * INTERVALO_DO_AGENDAMENTO_MS;

  it('starts at the 5-minute slot of the tick’s start, modulo the contas, and keeps their order after it', () => {
    // 1 800 000 000 000 ms is slot 6 000 000: a multiple of 3, so it starts at `a`.
    expect(ordemDoTickLi(contas, fatia(0))).toEqual(['a', 'b', 'c']);
    expect(ordemDoTickLi(contas, fatia(1))).toEqual(['b', 'c', 'a']);
    expect(ordemDoTickLi(contas, fatia(2))).toEqual(['c', 'a', 'b']);
    expect(ordemDoTickLi(contas, fatia(3))).toEqual(['a', 'b', 'c']);
  });

  it('a tick that fires late inside its slot keeps that slot; the next slot moves on', () => {
    expect(ordemDoTickLi(contas, fatia(1) + INTERVALO_DO_AGENDAMENTO_MS - 1)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(ordemDoTickLi(contas, fatia(1) + INTERVALO_DO_AGENDAMENTO_MS)).toEqual(['c', 'a', 'b']);
  });

  it('every conta runs FIRST once in as many consecutive ticks as there are contas', () => {
    const primeiras = [0, 1, 2].map((k) => ordemDoTickLi(contas, fatia(k + 7))[0]);
    expect([...primeiras].sort()).toEqual(['a', 'b', 'c']);
  });

  it('a new list, never the caller’s; and an empty list stays empty', () => {
    const lista = ['a', 'b'];
    const ordem = ordemDoTickLi(lista, fatia(1));
    expect(ordem).toEqual(['b', 'a']);
    expect(lista).toEqual(['a', 'b']);
    expect(ordemDoTickLi([], fatia(1))).toEqual([]);
  });
});
