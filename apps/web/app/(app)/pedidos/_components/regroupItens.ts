import type { ItemDoPedido, Pedido } from '@delfrance/schemas';

/**
 * Re-group a flat list of items back into the
 * `Record<produtoUid, ItemDoPedido[]>` shape Pedido stores. Items
 * without a produtoUid bind to the literal key 'NONE' (matching the
 * Flutter convention).
 */
export function regroupItens(items: ItemDoPedido[]): Pedido['itens'] {
  const out: Pedido['itens'] = {};
  for (const item of items) {
    const key = item.produtoUid && item.produtoUid !== '' ? item.produtoUid : 'NONE';
    (out[key] ??= []).push(item);
  }
  return out;
}
