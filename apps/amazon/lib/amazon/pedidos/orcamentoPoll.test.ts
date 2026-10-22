import { describe, expect, it } from 'vitest';
import { PRAZO_AMAZON_MS } from '@delfrance/integrations-amazon-sp-api';

import {
  CAP_INICIO_MS,
  CUSTO_MAXIMO_DAS_LEITURAS_MS,
  FOLGA_CONTA_MS,
  INTERVALO_POLL_AMAZON_MS,
  JANELA_VISTOS_MS,
  LEASE_POLL_MS,
  MAX_LINHAS_POR_EXECUCAO,
  MAX_PAGINAS_POLL_AMAZON,
  MAX_PAGINAS_POR_JANELA_AMAZON,
  MAX_RESULTADOS_POR_PAGINA_AMAZON,
  MAX_VISTOS,
  ORCAMENTO_CONTA_MS,
  ORCAMENTO_MINIMO_CONTA_MS,
  ORCAMENTO_TICK_MS,
  PRAZO_ENFILEIRAMENTO_POLL_MS,
  RAJADA_SEARCH_ORDERS,
  SOBREPOSICAO_MS,
  TAXA_SEARCH_ORDERS_RPS,
  TEMPO_LIMITE_POLL_AMAZON_S,
  VIDA_TOKEN_MS,
  orcamentoDaContaMs,
  ordemDoTickAmazon,
  prazoDaContaMs,
} from './orcamentoPoll';
import { LOOKBACK_POLL_H_MAXIMO } from './janelaPoll';

const HORA_MS = 60 * 60 * 1000;

/** D8: one conta, at most ≈ 50 orders a day. */
const PEDIDOS_POR_DIA_D8 = 50;

describe('the numbers are the planned ones — a change here is a deliberate re-plan', () => {
  it('pins every constant', () => {
    expect(MAX_PAGINAS_POLL_AMAZON).toBe(5);
    expect(MAX_RESULTADOS_POR_PAGINA_AMAZON).toBe(100);
    expect(MAX_PAGINAS_POR_JANELA_AMAZON).toBe(200);
    expect(TAXA_SEARCH_ORDERS_RPS).toBe(0.0056);
    expect(RAJADA_SEARCH_ORDERS).toBe(20);
    expect(INTERVALO_POLL_AMAZON_MS).toBe(15 * 60_000);
    expect(TEMPO_LIMITE_POLL_AMAZON_S).toBe(300);
    expect(ORCAMENTO_TICK_MS).toBe(240_000);
    expect(ORCAMENTO_CONTA_MS).toBe(200_000);
    expect(FOLGA_CONTA_MS).toBe(20_000);
    expect(ORCAMENTO_MINIMO_CONTA_MS).toBe(30_000);
    expect(PRAZO_ENFILEIRAMENTO_POLL_MS).toBe(5_000);
    expect(LEASE_POLL_MS).toBe(360_000);
    expect(SOBREPOSICAO_MS).toBe(10 * 60_000);
    expect(CAP_INICIO_MS).toBe(5 * 60_000);
    expect(VIDA_TOKEN_MS).toBe(23 * HORA_MS);
    expect(JANELA_VISTOS_MS).toBe(25 * 60_000);
    expect(MAX_VISTOS).toBe(2_000);
  });
});

describe('the arithmetic pins', () => {
  it('a capped run never throttles itself: five pages fit the bucket’s refill per tick', () => {
    const recargaPorTick = (TAXA_SEARCH_ORDERS_RPS * INTERVALO_POLL_AMAZON_MS) / 1000;
    expect(recargaPorTick).toBeCloseTo(5.04, 2);
    expect(MAX_PAGINAS_POLL_AMAZON).toBeLessThanOrEqual(recargaPorTick);
    // Near-miss: a sixth page would not refill in one tick.
    expect(MAX_PAGINAS_POLL_AMAZON + 1).toBeGreaterThan(recargaPorTick);
    // …and the burst absorbs a resumed drain on top.
    expect(MAX_PAGINAS_POLL_AMAZON).toBeLessThan(RAJADA_SEARCH_ORDERS);
  });

  it('steady state: one page per tick is 96 searchOrders a day, ≈ 20 % of the sustained bucket', () => {
    const porDia = (24 * HORA_MS) / INTERVALO_POLL_AMAZON_MS;
    expect(porDia).toBe(96);
    const sustentadoPorDia = TAXA_SEARCH_ORDERS_RPS * 24 * 60 * 60;
    expect(porDia / sustentadoPorDia).toBeGreaterThan(0.19);
    expect(porDia / sustentadoPorDia).toBeLessThan(0.21);
  });

  it('THE READS fit the conta’s deadline: MAX_PAGINAS × leitura + lwa ≤ budget − slack', () => {
    expect(CUSTO_MAXIMO_DAS_LEITURAS_MS).toBe(
      MAX_PAGINAS_POLL_AMAZON * PRAZO_AMAZON_MS.leitura + PRAZO_AMAZON_MS.lwa,
    );
    expect(CUSTO_MAXIMO_DAS_LEITURAS_MS).toBe(120_000);
    expect(CUSTO_MAXIMO_DAS_LEITURAS_MS).toBeLessThanOrEqual(ORCAMENTO_CONTA_MS - FOLGA_CONTA_MS);
  });

  it('a conta budget fits a tick, and a tick fits the function timeout', () => {
    expect(ORCAMENTO_CONTA_MS).toBeLessThanOrEqual(ORCAMENTO_TICK_MS);
    expect(ORCAMENTO_TICK_MS).toBeLessThan(TEMPO_LIMITE_POLL_AMAZON_S * 1000);
    // The last conta may overshoot its deadline by one page in flight and one
    // refresh; with the final write's slack it still ends before the timeout.
    expect(
      ORCAMENTO_TICK_MS - FOLGA_CONTA_MS + PRAZO_AMAZON_MS.leitura + PRAZO_AMAZON_MS.lwa,
    ).toBeLessThan(TEMPO_LIMITE_POLL_AMAZON_S * 1000);
  });

  it('a FACT, not a goal: the enqueues alone can outlast any budget — the deadline check, not the timeout, bounds a slow run', () => {
    expect(MAX_LINHAS_POR_EXECUCAO).toBe(500);
    expect(PRAZO_ENFILEIRAMENTO_POLL_MS * MAX_LINHAS_POR_EXECUCAO).toBeGreaterThan(
      ORCAMENTO_CONTA_MS,
    );
    expect(PRAZO_ENFILEIRAMENTO_POLL_MS * MAX_LINHAS_POR_EXECUCAO).toBeGreaterThan(
      TEMPO_LIMITE_POLL_AMAZON_S * 1000,
    );
  });

  it('the lease outlives the timeout, and the interval outlives the lease', () => {
    expect(LEASE_POLL_MS).toBeGreaterThan(TEMPO_LIMITE_POLL_AMAZON_S * 1000);
    expect(INTERVALO_POLL_AMAZON_MS).toBeGreaterThan(LEASE_POLL_MS);
  });

  it('a conta is started with at least one page and one refresh before its deadline', () => {
    expect(ORCAMENTO_MINIMO_CONTA_MS - FOLGA_CONTA_MS).toBeGreaterThanOrEqual(0);
    expect(ORCAMENTO_MINIMO_CONTA_MS).toBeLessThanOrEqual(ORCAMENTO_CONTA_MS);
  });

  it('the window page bound sits far above D8, and is reached within half a day', () => {
    // The widest legitimate window: the look-back cap, at TEN times D8's volume.
    const linhas = (LOOKBACK_POLL_H_MAXIMO / 24) * PEDIDOS_POR_DIA_D8 * 10;
    expect(Math.ceil(linhas / MAX_RESULTADOS_POR_PAGINA_AMAZON)).toBe(150);
    expect(MAX_PAGINAS_POR_JANELA_AMAZON).toBeGreaterThan(
      linhas / MAX_RESULTADOS_POR_PAGINA_AMAZON,
    );
    // A chain that never ends is first counted after bound ÷ 5 ticks.
    const ticks = Math.ceil(MAX_PAGINAS_POR_JANELA_AMAZON / MAX_PAGINAS_POLL_AMAZON);
    expect(ticks).toBe(40);
    expect(ticks * INTERVALO_POLL_AMAZON_MS).toBeLessThanOrEqual(12 * HORA_MS);
  });

  it('the token is discarded an hour before Amazon expires it (24 h)', () => {
    expect(VIDA_TOKEN_MS).toBeLessThan(24 * HORA_MS);
  });

  it('vistos outlive the overlap and the cap: a re-listed overlap row is still known', () => {
    expect(JANELA_VISTOS_MS).toBeGreaterThan(SOBREPOSICAO_MS + CAP_INICIO_MS);
    // Five full pages fit the cap many times over.
    expect(MAX_VISTOS).toBeGreaterThan(MAX_LINHAS_POR_EXECUCAO);
  });
});

describe('orcamentoDaContaMs / prazoDaContaMs', () => {
  it('min(conta budget, what the tick has left), never below 0', () => {
    expect(orcamentoDaContaMs(0, 0)).toBe(ORCAMENTO_CONTA_MS);
    expect(orcamentoDaContaMs(0, 100_000)).toBe(140_000);
    expect(orcamentoDaContaMs(0, ORCAMENTO_TICK_MS)).toBe(0);
    expect(orcamentoDaContaMs(0, ORCAMENTO_TICK_MS + 1)).toBe(0);
  });

  it('the deadline keeps the slack', () => {
    expect(prazoDaContaMs(1_000, ORCAMENTO_CONTA_MS)).toBe(1_000 + 180_000);
  });
});

describe('ordemDoTickAmazon', () => {
  it('rotates by the 15-minute slot, so every conta runs first once in n ticks', () => {
    const contas = ['a', 'b', 'c'];
    const primeiros = [0, 1, 2].map(
      (slot) => ordemDoTickAmazon(contas, slot * INTERVALO_POLL_AMAZON_MS + 7_000)[0],
    );
    expect(primeiros).toEqual(['a', 'b', 'c']);
    expect(ordemDoTickAmazon(contas, 4 * INTERVALO_POLL_AMAZON_MS)).toEqual(['b', 'c', 'a']);
    // A tick late inside its slot keeps that slot (near-miss of the boundary).
    expect(ordemDoTickAmazon(contas, 2 * INTERVALO_POLL_AMAZON_MS - 1)[0]).toBe('b');
    expect(ordemDoTickAmazon([], 0)).toEqual([]);
    expect(contas).toEqual(['a', 'b', 'c']);
  });
});
