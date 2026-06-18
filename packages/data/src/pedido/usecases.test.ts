import { describe, expect, it } from 'vitest';
import type { Pedido } from '@delfrance/schemas';
import type { PedidoDataPort, PedidoDocData } from './port';
import {
  PedidoConflictError,
  PedidoNothingChangedError,
  buildPedidoPatch,
  savePedido,
} from './usecases';

const VALUES = {
  numero: 'PED-1',
  estado: 'iniciado',
  descontoTotal: 5,
  itens: { p1: [{ quantidade: 1 }] },
  itensIds: ['p1'],
  freteInicial: { valorCobrado: 7 },
  valorCobrado: 100,
  valorCusto: 40,
  valorFreteInicial: 7,
  custoFreteInicial: 5,
  valorDevolucao: 0,
  valorCustoDevolvidos: 0,
  itensDevolvidos: { o1: { p1: [{ quantidade: 1 }] } },
  error: 'boom',
} as unknown as Pedido;

const ALL_CACHES = [
  'valorCobrado',
  'valorCusto',
  'valorFreteInicial',
  'custoFreteInicial',
  'valorDevolucao',
  'valorCustoDevolvidos',
];

describe('buildPedidoPatch', () => {
  it('returns only the touched plain field', () => {
    const patch = buildPedidoPatch(VALUES, { numero: true });
    expect(patch).toEqual({ numero: 'PED-1' });
  });

  it('is empty when nothing is dirty', () => {
    expect(buildPedidoPatch(VALUES, {})).toEqual({});
  });

  it('never writes synthetic / transient keys', () => {
    const patch = buildPedidoPatch(VALUES, {
      _itensFlat: [{ precoDeVenda: true }],
      error: true,
      id: true,
      oldEstado: true,
      ehSaidaOriginal: true,
    });
    // _itensFlat dirty → items branch; error/id/oldEstado/ehSaidaOriginal dropped
    expect(patch).not.toHaveProperty('error');
    expect(patch).not.toHaveProperty('_itensFlat');
    expect(patch).not.toHaveProperty('id');
    expect(patch).not.toHaveProperty('oldEstado');
  });

  it('pulls itens + itensIds + every cache when items change', () => {
    const patch = buildPedidoPatch(VALUES, { _itensFlat: [{ quantidade: true }] });
    expect(patch.itens).toBe(VALUES.itens);
    expect(patch.itensIds).toEqual(['p1']);
    for (const c of ALL_CACHES) expect(patch).toHaveProperty(c);
  });

  it('pulls the caches (but not itens) when only frete or desconto change', () => {
    const frete = buildPedidoPatch(VALUES, { freteInicial: true });
    expect(frete).toHaveProperty('freteInicial');
    expect(frete).not.toHaveProperty('itens');
    for (const c of ALL_CACHES) expect(frete).toHaveProperty(c);

    const desconto = buildPedidoPatch(VALUES, { descontoTotal: true });
    expect(desconto.descontoTotal).toBe(5);
    for (const c of ALL_CACHES) expect(desconto).toHaveProperty(c);
  });

  it('pulls itensDevolvidos + caches when returns change', () => {
    const patch = buildPedidoPatch(VALUES, { itensDevolvidos: true });
    expect(patch.itensDevolvidos).toBe(VALUES.itensDevolvidos);
    for (const c of ALL_CACHES) expect(patch).toHaveProperty(c);
  });
});

function fakePort(
  current: PedidoDocData,
  nowVal = 777,
): {
  port: PedidoDataPort;
  written: () => Record<string, unknown> | undefined;
} {
  let out: Record<string, unknown> | undefined;
  return {
    port: {
      now: () => nowVal,
      async updatePedido(_id, apply) {
        out = apply(current);
      },
    },
    written: () => out,
  };
}

describe('savePedido', () => {
  it('throws PedidoNothingChangedError on an empty patch', async () => {
    const { port } = fakePort({ ultimaModificacao: 1 });
    await expect(
      savePedido(port, { pedidoId: 'x', patch: {}, baseUltimaModificacao: 1 }),
    ).rejects.toBeInstanceOf(PedidoNothingChangedError);
  });

  it('writes the patch + a fresh ultimaModificacao when the base matches', async () => {
    const { port, written } = fakePort({ ultimaModificacao: 10 }, 999);
    await savePedido(port, { pedidoId: 'x', patch: { numero: 'A' }, baseUltimaModificacao: 10 });
    expect(written()).toEqual({ numero: 'A', ultimaModificacao: 999 });
  });

  it('throws PedidoConflictError when the doc moved since load', async () => {
    const current = { ultimaModificacao: 20 };
    const { port } = fakePort(current);
    await expect(
      savePedido(port, { pedidoId: 'x', patch: { numero: 'A' }, baseUltimaModificacao: 10 }),
    ).rejects.toMatchObject({ name: 'PedidoConflictError', current });
  });

  it('throws PedidoConflictError when the doc vanished', async () => {
    const { port } = fakePort(null);
    await expect(
      savePedido(port, { pedidoId: 'x', patch: { numero: 'A' }, baseUltimaModificacao: 10 }),
    ).rejects.toBeInstanceOf(PedidoConflictError);
  });

  it('skips the guard when baseUltimaModificacao is null (override)', async () => {
    const { port, written } = fakePort({ ultimaModificacao: 20 }, 5);
    await savePedido(port, { pedidoId: 'x', patch: { numero: 'A' }, baseUltimaModificacao: null });
    expect(written()).toEqual({ numero: 'A', ultimaModificacao: 5 });
  });
});
