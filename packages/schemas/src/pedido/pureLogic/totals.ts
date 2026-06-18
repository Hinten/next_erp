import type { ItemDoPedido } from '../collection/pedido';

/**
 * Helper to compute the subtotal of an item using the same formula as
 * the Flutter ItemDoPedido.subtotal getter:
 * `(precoDeVenda - descontoUnitario) * quantidade`.
 */
export function itemSubtotal(item: ItemDoPedido): number {
  return (item.precoDeVenda - (item.descontoUnitario ?? 0)) * item.quantidade;
}

/**
 * Cost of an item line — `Pedido.somarCusto`
 * (`.old/packages/pedido/lib/src/models.dart`): `(custo ?? 0) * quantidade`.
 */
export function itemCusto(item: ItemDoPedido): number {
  return (item.custo ?? 0) * item.quantidade;
}

export function pedidoTotal(p: { itens: Record<string, ItemDoPedido[]> }): number {
  let sum = 0;
  for (const list of Object.values(p.itens)) {
    for (const item of list) {
      sum += itemSubtotal(item);
    }
  }
  return sum;
}

/**
 * Legacy `duasCasasDecimais` (`.old/packages/global/lib/src/mathExtensions.dart:4`):
 * `double.parse(toStringAsFixed(2))` — JS `toFixed` rounds the same way for
 * the 2-decimal money values this is applied to.
 */
export function round2(n: number): number {
  return Number(n.toFixed(2));
}

/** Loose view of a frete block — only the money caches the totals read. */
type FreteTotals = {
  valorCobrado?: number | null;
  custoCalculado?: number | null;
  custoFinal?: number | null;
} | null;

/**
 * Derive the pedido money caches from the items + `freteInicial`, exactly as
 * the legacy app does:
 *
 *   - `valorCobrado` — port of `Pedido.total`
 *     (`.old/packages/pedido/lib/src/models.dart:3316-3320`):
 *     `round2(round2(round2(Σ itemSubtotal) − descontoTotal) + (frete?.valorCobrado ?? 0))`.
 *     The legacy form assigns `pedidoSave.valorCobrado = pedidoSave.total` on
 *     every integral save (`cadastroPedidoProvider.dart:1186`).
 *   - `valorFreteInicial` / `custoFreteInicial` — port of the `Pedido.factory`
 *     reporting caches (`models.dart:3601-3602`):
 *     `round2(frete?.valorCobrado ?? 0)` and
 *     `round2(frete?.custoCalculado ?? frete?.custoFinal ?? 0)` — note
 *     `custoCalculado` wins over `custoFinal`, matching the factory.
 *
 * `freteInicial.valorCobrado` participates regardless of `modalidade` — the
 * legacy total has no special case for '9' (sem frete); a collapsed frete
 * block keeps its data and its charge.
 */
export function derivePedidoFreteTotals(args: {
  itens: ReadonlyArray<ItemDoPedido>;
  descontoTotal: number;
  freteInicial: FreteTotals;
}): { valorCobrado: number; valorFreteInicial: number; custoFreteInicial: number } {
  const { itens, descontoTotal, freteInicial } = args;
  const subtotal = round2(itens.reduce((sum, item) => sum + itemSubtotal(item), 0));
  const subtotalComDesconto = round2(subtotal - descontoTotal);
  return {
    valorCobrado: round2(subtotalComDesconto + (freteInicial?.valorCobrado ?? 0)),
    valorFreteInicial: round2(freteInicial?.valorCobrado ?? 0),
    custoFreteInicial: round2(freteInicial?.custoCalculado ?? freteInicial?.custoFinal ?? 0),
  };
}

/** Flatten the nested `itensDevolvidos` map into a single item list. */
export function flattenItensDevolvidos(
  itensDevolvidos: Record<string, Record<string, ReadonlyArray<ItemDoPedido>>> | null | undefined,
): ItemDoPedido[] {
  const out: ItemDoPedido[] = [];
  for (const porProduto of Object.values(itensDevolvidos ?? {})) {
    for (const lista of Object.values(porProduto)) {
      out.push(...lista);
    }
  }
  return out;
}

/** The full set of money caches the legacy factory writes back to the doc. */
export interface PedidoDerivedTotals {
  /** Σ item subtotals (not stored on the doc, but useful for the UI). */
  subtotal: number;
  valorCusto: number;
  valorFreteInicial: number;
  custoFreteInicial: number;
  valorDevolucao: number;
  valorCustoDevolvidos: number;
  valorCobrado: number;
}

/**
 * Port of `Pedido.factory.fromItensCalculados`
 * (`.old/packages/pedido/lib/src/models.dart:3528-3668`) — derives every money
 * cache the order doc stores from its items, freight and returns. The
 * pass-through inputs the factory does NOT compute from items (`impostos`,
 * `valorComissoes`, `valorDespesasIncidentes`, `valorFretesIncidentes`) are left
 * to the caller; this owns only the item/frete/devolução-derived caches so the
 * web resolver and a future MCP agent share one implementation.
 *
 * Every value is rounded with `round2` to match `.duasCasasDecimais`.
 */
export function derivePedidoTotals(args: {
  itens: ReadonlyArray<ItemDoPedido>;
  descontoTotal: number;
  freteInicial: FreteTotals;
  itensDevolvidos?: Record<string, Record<string, ReadonlyArray<ItemDoPedido>>> | null;
}): PedidoDerivedTotals {
  const { itens, descontoTotal, freteInicial, itensDevolvidos } = args;

  const subtotal = round2(itens.reduce((sum, item) => sum + itemSubtotal(item), 0));
  const valorCusto = round2(itens.reduce((sum, item) => sum + itemCusto(item), 0));
  const valorFreteInicial = round2(freteInicial?.valorCobrado ?? 0);
  const custoFreteInicial = round2(freteInicial?.custoCalculado ?? freteInicial?.custoFinal ?? 0);

  const devolvidos = flattenItensDevolvidos(itensDevolvidos);
  const valorDevolucao = round2(devolvidos.reduce((sum, item) => sum + itemSubtotal(item), 0));
  const valorCustoDevolvidos = round2(devolvidos.reduce((sum, item) => sum + itemCusto(item), 0));

  const valorCobrado = round2(round2(subtotal - descontoTotal) + valorFreteInicial);

  return {
    subtotal,
    valorCusto,
    valorFreteInicial,
    custoFreteInicial,
    valorDevolucao,
    valorCustoDevolvidos,
    valorCobrado,
  };
}
