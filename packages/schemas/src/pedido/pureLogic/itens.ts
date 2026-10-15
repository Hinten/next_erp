import type { ItemDoPedido, Pedido } from '../collection/pedido';

/** `itemDoPedidoSchema.ordem`'s default — what a line without a usable `ordem` sorts as. */
const ORDEM_PADRAO = 1;

/**
 * The pedido's LINE order: `ordem` ascending (the "#" column of the pedido
 * screen), stable on ties, with an absent or non-numeric `ordem` read as the
 * schema default. `ordemDe` reads it, so a caller holding raw, unparsed
 * entries (apps/nfe) sorts exactly like one holding parsed items.
 *
 * ⚠️ ONE definition on purpose. It is the order the print and the checkout
 * list items in (`flattenPedidoItens`), the order apps/nfe numbers the NF-e
 * `det/@nItem` in, and the order the pedido screen labels its per-item
 * references with — so "Item 2" in a panel warning and "item 2" in the
 * emission's 400 name the same line. Grouping by produto (the `itens` map) is
 * NOT an order: `{A: [A₁, A₂], B: [B₁]}` stores the lines `A₁, B₁, A₂` in a
 * different sequence than they were entered.
 */
export function naOrdemDoPedido<T>(itens: readonly T[], ordemDe: (item: T) => unknown): T[] {
  const chave = (item: T): number => {
    const ordem = ordemDe(item);
    return typeof ordem === 'number' && Number.isFinite(ordem) ? ordem : ORDEM_PADRAO;
  };
  // Array.prototype.sort is stable (ES2019), so ties keep their input order.
  return [...itens].sort((a, b) => chave(a) - chave(b));
}

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
  return naOrdemDoPedido(out, (item) => item.ordem);
}
