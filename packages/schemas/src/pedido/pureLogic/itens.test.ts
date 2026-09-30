import { describe, expect, it } from 'vitest';
import { flattenPedidoItens, naOrdemDoPedido } from './itens';
import { itemDoPedidoSchema, type Pedido } from '../collection/pedido';

const mk = (produtoUid: string | null, ordem: number) =>
  itemDoPedidoSchema.parse({ produtoUid, ordem, precoDeVenda: 10, quantidade: 1 });

describe('flattenPedidoItens', () => {
  it('flattens the grouped record and sorts by ordem', () => {
    const grouped = {
      'p-b': [mk('p-b', 3)],
      'p-a': [mk('p-a', 1), mk('p-a', 2)],
    } as unknown as Pedido['itens'];
    const out = flattenPedidoItens(grouped);
    expect(out.map((i) => i.ordem)).toEqual([1, 2, 3]);
    expect(out.map((i) => i.produtoUid)).toEqual(['p-a', 'p-a', 'p-b']);
  });

  it('derives produtoUid from the map key, treating NONE / empty as unbound (null)', () => {
    const grouped = {
      NONE: [itemDoPedidoSchema.parse({ ordem: 1, precoDeVenda: 5, quantidade: 1 })],
      '': [itemDoPedidoSchema.parse({ ordem: 2, precoDeVenda: 5, quantidade: 1 })],
      'p-x': [itemDoPedidoSchema.parse({ ordem: 3, precoDeVenda: 5, quantidade: 1 })],
    } as unknown as Pedido['itens'];
    const out = flattenPedidoItens(grouped);
    expect(out.map((i) => i.produtoUid)).toEqual([null, null, 'p-x']);
  });

  it('keeps an item-level produtoUid over the key', () => {
    const grouped = { NONE: [mk('explicit', 1)] } as unknown as Pedido['itens'];
    expect(flattenPedidoItens(grouped)[0]?.produtoUid).toBe('explicit');
  });

  it('restores interleaved lines of one produto to the order they were entered', () => {
    // Entered A₁, B₁, A₂ → stored grouped by produto as {A: [A₁, A₂], B: [B₁]}.
    const grouped = {
      'p-a': [mk('p-a', 1), mk('p-a', 3)],
      'p-b': [mk('p-b', 2)],
    } as unknown as Pedido['itens'];
    expect(flattenPedidoItens(grouped).map((i) => `${i.produtoUid}:${i.ordem}`)).toEqual([
      'p-a:1',
      'p-b:2',
      'p-a:3',
    ]);
  });
});

describe('naOrdemDoPedido', () => {
  const ordem = (l: { ordem?: unknown }) => l.ordem;

  it('sorts numerically by ordem — 2 before 10, never as strings', () => {
    const linhas = [
      { id: 'dez', ordem: 10 },
      { id: 'dois', ordem: 2 },
      { id: 'um', ordem: 1 },
    ];
    expect(naOrdemDoPedido(linhas, ordem).map((l) => l.id)).toEqual(['um', 'dois', 'dez']);
  });

  it('keeps the input order on ties (legacy lines all left at the default 1)', () => {
    const linhas = [
      { id: 'x', ordem: 1 },
      { id: 'y', ordem: 1 },
      { id: 'z', ordem: 1 },
    ];
    expect(naOrdemDoPedido(linhas, ordem).map((l) => l.id)).toEqual(['x', 'y', 'z']);
  });

  it('reads an absent or non-numeric ordem as the schema default 1', () => {
    const linhas = [
      { id: 'dois', ordem: 2 },
      { id: 'ausente' },
      { id: 'texto', ordem: '0' },
      { id: 'zero', ordem: 0 },
    ];
    // Near-miss: a real 0 sorts BEFORE the defaulted ones; the string '0' does not.
    expect(naOrdemDoPedido(linhas, ordem).map((l) => l.id)).toEqual([
      'zero',
      'ausente',
      'texto',
      'dois',
    ]);
  });

  it('does not reorder its input in place', () => {
    const linhas = [
      { id: 'b', ordem: 2 },
      { id: 'a', ordem: 1 },
    ];
    naOrdemDoPedido(linhas, ordem);
    expect(linhas.map((l) => l.id)).toEqual(['b', 'a']);
  });
});
