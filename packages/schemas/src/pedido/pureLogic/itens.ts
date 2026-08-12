import type { ItemDoPedido, Pedido } from '../collection/pedido';

/**
 * Flatten the grouped `pedido.itens` record into a single ordem-sorted list,
 * deriving each item's `produtoUid` from its map key when the item itself omits
 * it. Port of `apps/web/lib/pedido-print/assemble.ts:149-159` (`flattenItens`),
 * lifted here so both the print assembler and the checkout engine share one
 * implementation.
 *
 * The `itens` map is keyed by produto id, with the sentinel `'NONE'` (or `''`)
 * for unbound line items; those keys resolve to a `null` produtoUid so the
 * engine treats the line as inert (never scannable, skipped at save — legacy
 * `checkout.dart:1121`).
 */
export function flattenPedidoItens(grouped: Pedido['itens']): ItemDoPedido[] {
  const out: ItemDoPedido[] = [];
  for (const [key, list] of Object.entries(grouped)) {
    const keyUid = key && key !== 'NONE' ? key : null;
    for (const item of list) {
      out.push({ ...item, produtoUid: item.produtoUid ?? keyUid });
    }
  }
  out.sort((a, b) => a.ordem - b.ordem);
  return out;
}
