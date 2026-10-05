import type { ItemDoPedido, Pedido } from '@delfrance/schemas';
import type { FlatItem } from './types';

/**
 * Whether a form row becomes an item of the saved pedido — and so a `det` of
 * its NF-e. Not a staged deletion (`_delete`) and not the blank row the
 * "Adicionar produto" button appends before a produto is picked (no produto and
 * no marketplace id). The save path and every screen that numbers the nota's
 * items filter with THIS, so a blank row never shifts a number.
 */
export function linhaViraItem(row: FlatItem): boolean {
  if (row._delete) return false;
  return !!row.produtoUid || !!row.mktplaceId;
}

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
