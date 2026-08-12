import { describe, expect, it } from 'vitest';
import type { EstoqueAplicado, ItemDoPedido } from '@delfrance/schemas';
import { TIPO_MOVIMENTO_ESTOQUE } from '@delfrance/schemas';
import {
  calcularAlteracoesEstoque,
  planSincronizacaoEstoque,
  temEfeitoAplicado,
  temMovimentoAplicado,
  type ProdutoParaEstoque,
  type SincronizacaoEstoqueInput,
} from './estoquePlan';

function item(produtoUid: string | null, quantidade: number): ItemDoPedido {
  return {
    produtoUid,
    ordem: 1,
    ensureUniqueId: null,
    mktplaceId: null,
    sku: null,
    gtin: null,
    nomeDeVenda: null,
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade,
    custo: null,
    timestamp: null,
    imposto: null,
  };
}

const PRODUTO_SIMPLES: ProdutoParaEstoque = { ehKit: false, componentesKit: null };

describe('calcularAlteracoesEstoque', () => {
  it('sums quantities per produto across item lines', () => {
    const alteracoes = calcularAlteracoesEstoque(
      { p1: [item('p1', 2), item('p1', 3)], p2: [item('p2', 1)] },
      new Map([
        ['p1', PRODUTO_SIMPLES],
        ['p2', PRODUTO_SIMPLES],
      ]),
    );
    expect(alteracoes).toEqual({ p1: 5, p2: 1 });
  });

  it('skips unlinked items, missing produtos and zero quantities', () => {
    const alteracoes = calcularAlteracoesEstoque(
      {
        NONE: [item(null, 4), item('NONE', 2)],
        p1: [item('p1', 0)],
        p2: [item('p2', 1)], // produto doc missing from the map
      },
      new Map([['p1', PRODUTO_SIMPLES]]),
    );
    expect(alteracoes).toEqual({});
  });

  it('expands kits into limitarEstoque components only, kit produto untouched', () => {
    const kit: ProdutoParaEstoque = {
      ehKit: true,
      componentesKit: {
        comp1: { quantidade: 2, limitarEstoque: true, timestamp: null },
        comp2: { quantidade: 5, limitarEstoque: false, timestamp: null },
      },
    };
    const alteracoes = calcularAlteracoesEstoque(
      { kit1: [item('kit1', 3)], comp1: [item('comp1', 1)] },
      new Map([
        ['kit1', kit],
        ['comp1', PRODUTO_SIMPLES],
      ]),
    );
    // 3 kits × 2 comp1 each + 1 loose comp1; comp2 not limited; kit1 itself absent.
    expect(alteracoes).toEqual({ comp1: 7 });
  });

  it('skips a kit with no componentesKit map (legacy parity)', () => {
    const alteracoes = calcularAlteracoesEstoque(
      { k: [item('k', 2)] },
      new Map([['k', { ehKit: true, componentesKit: null }]]),
    );
    expect(alteracoes).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */

function input(overrides: Partial<SincronizacaoEstoqueInput>): SincronizacaoEstoqueInput {
  return {
    alteracoes: { p1: 5 },
    efeito: { reservar: false, remover: false, adicionar: false },
    aplicado: null,
    depositoId: 'dep1',
    operacaoId: 'op1',
    ehSaida: true,
    pedidoNumero: '123',
    agora: 1_000_000,
    ...overrides,
  };
}

function aplicadoBase(overrides: Partial<EstoqueAplicado>): EstoqueAplicado {
  return {
    depositoId: 'dep1',
    operacaoId: 'op1',
    ehSaida: true,
    reservado: null,
    removido: null,
    adicionado: null,
    atualizadoEm: 999,
    ...overrides,
  };
}

describe('planSincronizacaoEstoque — apply / release / convergence', () => {
  it('applies a reservation from scratch', () => {
    const plan = planSincronizacaoEstoque(
      input({ efeito: { reservar: true, remover: false, adicionar: false } }),
    );
    expect(plan.deltas).toEqual([
      {
        produtoId: 'p1',
        depositoId: 'dep1',
        deltaQuantidade: 0,
        deltaReservada: 5,
        tipo: 'reserva',
        motivo: 'Reserva de estoque do pedido 123',
      },
    ]);
    expect(plan.aplicadoDepois).toMatchObject({ reservado: { p1: 5 }, removido: null });
    expect(plan.reservaAtiva).toBe(true);
    expect(plan.movimentoAtivo).toBe(false);
  });

  it('is convergent: desired == applied ⇒ zero deltas (loop guard 3)', () => {
    const plan = planSincronizacaoEstoque(
      input({
        efeito: { reservar: true, remover: false, adicionar: false },
        aplicado: aplicadoBase({ reservado: { p1: 5 } }),
      }),
    );
    expect(plan.deltas).toEqual([]);
    expect(plan.aplicadoDepois).toMatchObject({ reservado: { p1: 5 } });
  });

  it('releases using the SNAPSHOT quantities, not the current items (drift fix)', () => {
    // Reserved 5, items later edited to 2, then cancelled: must release exactly 5.
    const plan = planSincronizacaoEstoque(
      input({
        alteracoes: { p1: 2 },
        efeito: { reservar: false, remover: false, adicionar: false },
        aplicado: aplicadoBase({ reservado: { p1: 5 } }),
      }),
    );
    expect(plan.deltas).toEqual([
      expect.objectContaining({ deltaReservada: -5, deltaQuantidade: 0, tipo: 'liberacaoReserva' }),
    ]);
    expect(plan.aplicadoDepois).toBeNull();
    expect(plan.reservaAtiva).toBe(false);
  });

  it('adjusts a held reservation after an item edit (legacy could not)', () => {
    const plan = planSincronizacaoEstoque(
      input({
        alteracoes: { p1: 2, p2: 1 },
        efeito: { reservar: true, remover: false, adicionar: false },
        aplicado: aplicadoBase({ reservado: { p1: 5 } }),
      }),
    );
    expect(plan.deltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ produtoId: 'p1', deltaReservada: -3, tipo: 'ajusteReserva' }),
        expect.objectContaining({ produtoId: 'p2', deltaReservada: 1, tipo: 'reserva' }),
      ]),
    );
    expect(plan.aplicadoDepois).toMatchObject({ reservado: { p1: 2, p2: 1 } });
  });

  it('converts a reservation into a removal in one atomic plan (pago → finalizado)', () => {
    const plan = planSincronizacaoEstoque(
      input({
        efeito: { reservar: false, remover: true, adicionar: false },
        aplicado: aplicadoBase({ reservado: { p1: 5 } }),
      }),
    );
    expect(plan.deltas).toEqual([
      expect.objectContaining({
        deltaQuantidade: -5,
        deltaReservada: -5,
        tipo: 'saida',
        motivo: 'Saída de estoque do pedido 123',
      }),
    ]);
    expect(plan.aplicadoDepois).toMatchObject({ reservado: null, removido: { p1: 5 } });
    expect(plan.movimentoAtivo).toBe(true);
  });

  it('returns removed stock on cancellation, from the snapshot', () => {
    const plan = planSincronizacaoEstoque(
      input({
        alteracoes: {}, // items irrelevant for the reversal
        efeito: { reservar: false, remover: false, adicionar: false },
        aplicado: aplicadoBase({ removido: { p1: 5 } }),
      }),
    );
    expect(plan.deltas).toEqual([
      expect.objectContaining({ deltaQuantidade: 5, deltaReservada: 0, tipo: 'devolucao' }),
    ]);
    expect(plan.aplicadoDepois).toBeNull();
  });

  it('applies and reverts entrada additions symmetrically', () => {
    const aplicar = planSincronizacaoEstoque(
      input({ ehSaida: false, efeito: { reservar: false, remover: false, adicionar: true } }),
    );
    expect(aplicar.deltas).toEqual([
      expect.objectContaining({ deltaQuantidade: 5, tipo: 'entrada' }),
    ]);
    const reverter = planSincronizacaoEstoque(
      input({
        ehSaida: false,
        efeito: { reservar: false, remover: false, adicionar: false },
        aplicado: aplicadoBase({ ehSaida: false, adicionado: { p1: 5 } }),
      }),
    );
    expect(reverter.deltas).toEqual([
      expect.objectContaining({ deltaQuantidade: -5, tipo: 'estorno' }),
    ]);
  });

  it('moves stock between depósitos when the integração changed mid-flight', () => {
    const plan = planSincronizacaoEstoque(
      input({
        depositoId: 'dep2',
        efeito: { reservar: true, remover: false, adicionar: false },
        aplicado: aplicadoBase({ depositoId: 'dep1', reservado: { p1: 5 } }),
      }),
    );
    expect(plan.deltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          depositoId: 'dep1',
          deltaReservada: -5,
          tipo: 'liberacaoReserva',
        }),
        expect.objectContaining({ depositoId: 'dep2', deltaReservada: 5, tipo: 'reserva' }),
      ]),
    );
    expect(plan.aplicadoDepois).toMatchObject({ depositoId: 'dep2', reservado: { p1: 5 } });
  });

  it('stamps the tipoOverride on every delta (pedido deletion)', () => {
    const plan = planSincronizacaoEstoque(
      input({
        alteracoes: {},
        efeito: { reservar: false, remover: false, adicionar: false },
        aplicado: aplicadoBase({ removido: { p1: 5 }, reservado: { p2: 1 } }),
        tipoOverride: TIPO_MOVIMENTO_ESTOQUE.exclusaoPedido,
      }),
    );
    expect(plan.deltas).toHaveLength(2);
    for (const delta of plan.deltas) {
      expect(delta.tipo).toBe('exclusaoPedido');
      expect(delta.motivo).toContain('exclusão do pedido');
    }
  });

  it('produces no snapshot and no deltas for a pedido with nothing to do', () => {
    const plan = planSincronizacaoEstoque(input({ alteracoes: {} }));
    expect(plan.deltas).toEqual([]);
    expect(plan.aplicadoDepois).toBeNull();
    expect(plan.reservaAtiva).toBe(false);
    expect(plan.movimentoAtivo).toBe(false);
  });
});

describe('snapshot inspection helpers', () => {
  it('temMovimentoAplicado / temEfeitoAplicado', () => {
    expect(temMovimentoAplicado(null)).toBe(false);
    expect(temEfeitoAplicado(null)).toBe(false);
    expect(temMovimentoAplicado(aplicadoBase({ reservado: { p1: 1 } }))).toBe(false);
    expect(temEfeitoAplicado(aplicadoBase({ reservado: { p1: 1 } }))).toBe(true);
    expect(temMovimentoAplicado(aplicadoBase({ removido: { p1: 1 } }))).toBe(true);
    expect(temMovimentoAplicado(aplicadoBase({ adicionado: { p1: 1 } }))).toBe(true);
    expect(temEfeitoAplicado(aplicadoBase({ removido: {} }))).toBe(false);
  });
});
