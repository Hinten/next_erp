import type { ItemDoPedido } from '@delfrance/schemas';

/**
 * Pure mapping between the sold items (`itens` / the form's `_itensFlat`) and the
 * pedido's `itensDevolvidos` map, so the Devolução tab stays a thin view. The
 * wire shape is `Record<originId, Record<produtoUid, ItemDoPedido[]>>`
 * (`.old/packages/pedido/lib/src/models.dart:3006`); we edit it as one returned
 * quantity per produto and distribute that quantity back across the produto's
 * sold rows so each row keeps its own price/custo and the money totals stay exact.
 */

/** Origin/produto bucket for items with no produtoUid (legacy `'NONE'`). */
const NONE_KEY = 'NONE';

export interface DevolucaoRow {
  /** The `itens` map key for this produto (`'NONE'` when unknown). */
  produtoUid: string;
  /** Display name (first sold row's `nomeDeVenda`, falling back to the uid). */
  nome: string;
  /** Total quantity sold for this produto across its rows — the return cap. */
  soldQty: number;
  /** Quantity currently marked returned (prefilled from `itensDevolvidos`). */
  returnedQty: number;
  /** The produto's sold rows, used to distribute the returned quantity. */
  sourceItems: ItemDoPedido[];
}

type ItensDevolvidos = Record<string, Record<string, ItemDoPedido[]>> | null | undefined;

function keyOf(item: { produtoUid?: string | null }): string {
  return item.produtoUid && item.produtoUid !== '' ? item.produtoUid : NONE_KEY;
}

function sumQty(items: ReadonlyArray<{ quantidade?: number | null }>): number {
  return items.reduce((sum, it) => sum + (it.quantidade ?? 0), 0);
}

/** Drop the synthetic `_rowId` so it never reaches Firestore. */
function stripRowId(item: ItemDoPedido): ItemDoPedido {
  const { _rowId, ...rest } = item as ItemDoPedido & { _rowId?: string };
  return rest;
}

/** Sum the returned quantity per produto across every origin bucket. */
export function returnedQtyByProduto(itensDevolvidos: ItensDevolvidos): Record<string, number> {
  const out: Record<string, number> = {};
  for (const porProduto of Object.values(itensDevolvidos ?? {})) {
    for (const [uid, list] of Object.entries(porProduto)) {
      out[uid] = (out[uid] ?? 0) + sumQty(list);
    }
  }
  return out;
}

/**
 * One row per sold produto: total sold quantity, the source rows, and the
 * currently-returned quantity (prefilled from `itensDevolvidos`). Ordered by the
 * produto's first `ordem` so it lines up with the Principal tab.
 */
export function buildDevolucaoRows(
  soldItems: ReadonlyArray<ItemDoPedido>,
  itensDevolvidos: ItensDevolvidos,
): DevolucaoRow[] {
  const returned = returnedQtyByProduto(itensDevolvidos);
  const byProduto = new Map<string, ItemDoPedido[]>();
  for (const item of soldItems) {
    const key = keyOf(item);
    const list = byProduto.get(key) ?? [];
    list.push(item);
    byProduto.set(key, list);
  }
  const rows: DevolucaoRow[] = [];
  for (const [uid, list] of byProduto) {
    rows.push({
      produtoUid: uid,
      nome: list.find((i) => i.nomeDeVenda)?.nomeDeVenda ?? uid,
      soldQty: sumQty(list),
      returnedQty: returned[uid] ?? 0,
      sourceItems: list,
    });
  }
  rows.sort((a, b) => (a.sourceItems[0]?.ordem ?? 0) - (b.sourceItems[0]?.ordem ?? 0));
  return rows;
}

/**
 * Distribute a total returned quantity across the produto's sold rows in order,
 * each capped at its own sold quantity, producing clean `ItemDoPedido` copies
 * (price/custo preserved, `_rowId` stripped). Rows that receive nothing are
 * skipped.
 */
export function distributeReturn(
  sourceItems: ReadonlyArray<ItemDoPedido>,
  returnedQty: number,
): ItemDoPedido[] {
  let remaining = returnedQty;
  const out: ItemDoPedido[] = [];
  for (const item of sourceItems) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, item.quantidade);
    if (take > 0) {
      out.push({ ...stripRowId(item), quantidade: take });
      remaining -= take;
    }
  }
  return out;
}

/**
 * Build the `itensDevolvidos` map from the edited rows, grouped under a single
 * origin key (the current pedido). Returns `null` when nothing is returned, so
 * the field clears to the schema default.
 */
export function buildItensDevolvidos(
  rows: ReadonlyArray<DevolucaoRow>,
  originKey: string,
): Record<string, Record<string, ItemDoPedido[]>> | null {
  const porProduto: Record<string, ItemDoPedido[]> = {};
  for (const row of rows) {
    if (row.returnedQty <= 0) continue;
    const items = distributeReturn(row.sourceItems, row.returnedQty);
    if (items.length > 0) porProduto[row.produtoUid] = items;
  }
  if (Object.keys(porProduto).length === 0) return null;
  return { [originKey]: porProduto };
}
