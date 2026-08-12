import { describe, expect, it } from 'vitest';
import { flattenPedidoItens } from './itens';
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
});
