import { roundReais } from '@delfrance/core/money';
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
 *     `roundReais(roundReais(roundReais(Σ itemSubtotal) − descontoTotal) + (frete?.valorCobrado ?? 0))`.
 *     The legacy form assigns `pedidoSave.valorCobrado = pedidoSave.total` on
 *     every integral save (`cadastroPedidoProvider.dart:1186`).
 *   - `valorFreteInicial` / `custoFreteInicial` — port of the `Pedido.factory`
 *     reporting caches (`models.dart:3601-3602`):
 *     `roundReais(frete?.valorCobrado ?? 0)` and
 *     `roundReais(frete?.custoCalculado ?? frete?.custoFinal ?? 0)` — note
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
  const subtotal = roundReais(itens.reduce((sum, item) => sum + itemSubtotal(item), 0));
  const subtotalComDesconto = roundReais(subtotal - descontoTotal);
  return {
    valorCobrado: roundReais(subtotalComDesconto + (freteInicial?.valorCobrado ?? 0)),
    valorFreteInicial: roundReais(freteInicial?.valorCobrado ?? 0),
    custoFreteInicial: roundReais(freteInicial?.custoCalculado ?? freteInicial?.custoFinal ?? 0),
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

/**
 * The money figures the legacy factory derived. ⚠️ Only `valorCobrado` is still
 * PERSISTED — the other five were removed from `pedidoSchema` (#796) because
 * each was a pure function of `itens` or `freteInicial` on the same document,
 * with no reader, no query and no index, so a stored copy could only drift from
 * the value it copied. They stay on this interface because they are still
 * DISPLAYED: `PedidoFooter` renders `valorFreteInicial` and `valorDevolucao`
 * from a live `derivePedidoTotals(...)` over watched form state. Derive, do not
 * store.
 */
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
 * cache the order doc stores from its items, freight and returns — and nothing
 * else. The four pass-throughs the Flutter factory did NOT compute from items
 * (`impostos`, `valorComissoes`, `valorDespesasIncidentes`,
 * `valorFretesIncidentes`) were "left to the caller" here for as long as this
 * port existed, and no caller ever appeared. #1151 dropped them from
 * `pedidoSchema` outright: a pipeline aggregates the pedido's own
 * subcollections at read time, so there is nothing for a caller to fill in.
 * This owns the item/frete/devolução-derived caches, full stop, so the web
 * resolver and a future MCP agent share one implementation of them.
 *
 * Every value is rounded with the canonical `roundReais`, which rounds from the
 * IEEE-754 double at 2dp — byte-parity with Flutter's `.duasCasasDecimais`
 * (`toStringAsFixed(2)` reparsed); see `@delfrance/core/money`.
 */
export function derivePedidoTotals(args: {
  itens: ReadonlyArray<ItemDoPedido>;
  descontoTotal: number;
  freteInicial: FreteTotals;
  itensDevolvidos?: Record<string, Record<string, ReadonlyArray<ItemDoPedido>>> | null;
}): PedidoDerivedTotals {
  const { itens, descontoTotal, freteInicial, itensDevolvidos } = args;

  const subtotal = roundReais(itens.reduce((sum, item) => sum + itemSubtotal(item), 0));
  const valorCusto = roundReais(itens.reduce((sum, item) => sum + itemCusto(item), 0));
  const valorFreteInicial = roundReais(freteInicial?.valorCobrado ?? 0);
  const custoFreteInicial = roundReais(
    freteInicial?.custoCalculado ?? freteInicial?.custoFinal ?? 0,
  );

  const devolvidos = flattenItensDevolvidos(itensDevolvidos);
  const valorDevolucao = roundReais(devolvidos.reduce((sum, item) => sum + itemSubtotal(item), 0));
  const valorCustoDevolvidos = roundReais(
    devolvidos.reduce((sum, item) => sum + itemCusto(item), 0),
  );

  const valorCobrado = roundReais(roundReais(subtotal - descontoTotal) + valorFreteInicial);

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
