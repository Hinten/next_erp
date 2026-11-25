import {
  ESTADO_PEDIDO_LABELS,
  type EstadoPedido,
  type Pedido,
  bucketOf,
  nivelDoNomeDoItem,
  nomeDoItem,
  pedidoTotal,
  type EstadoBucket,
} from '@delfrance/schemas';

/**
 * Pure aggregation helpers consumed by /relatorios pages. Operate on
 * already-fetched pedidos arrays — no I/O. Keep them deterministic so
 * they're easy to unit-test.
 */

export interface PedidoLite {
  id: string;
  data: Pedido;
}

/* ---------------------------------- Top produtos --------------------------- */

export interface ProdutoSalesRow {
  produtoUid: string;
  /**
   * Best human-friendly label we have — the best `nomeDoItem` can make of ANY
   * line in the group. No produto docs are loaded here, so it resolves from the
   * denormalised fields alone and falls back to the sku, then the produtoUid.
   */
  label: string;
  quantidade: number;
  receita: number;
  pedidos: number;
}

export interface ProdutoSalesLine {
  pedidoId: string;
  produtoUid: string;
  quantidade: number;
  precoDeVenda: number;
  descontoUnitario?: number | null;
  nomeDeVenda?: string | null;
  sku?: string | null;
}

export type ProdutoSalesMetric = 'quantidade' | 'pedidos' | 'receita';

type Acumulador = ProdutoSalesRow & { _orderIds: Set<string>; _nivelDoRotulo: 0 | 1 | 2 };

/**
 * Accumulate order-line values and keep the best label available for each product.
 * The product id is the order's item-map key, which may differ from the line's
 * own produtoUid in legacy orders.
 */
export function aggregateProductSales(lines: Iterable<ProdutoSalesLine>): ProdutoSalesRow[] {
  const byUid = new Map<string, Acumulador>();
  for (const item of lines) {
    const { produtoUid, pedidoId } = item;
    if (!produtoUid || produtoUid === 'NONE') continue;
    const row: Acumulador = byUid.get(produtoUid) ?? {
      produtoUid,
      label: nomeDoItem({ produtoUid }, null),
      quantidade: 0,
      receita: 0,
      pedidos: 0,
      _orderIds: new Set<string>(),
      _nivelDoRotulo: 0,
    };
    row.quantidade += item.quantidade;
    row.receita += (item.precoDeVenda - (item.descontoUnitario ?? 0)) * item.quantidade;
    // Only a higher tier replaces the label. The first line in a tier wins.
    const nivel = nivelDoNomeDoItem(item);
    if (nivel > row._nivelDoRotulo) {
      row._nivelDoRotulo = nivel;
      row.label = nomeDoItem(item, null);
    }
    row._orderIds.add(pedidoId);
    byUid.set(produtoUid, row);
  }

  return [...byUid.values()].map(({ _orderIds, _nivelDoRotulo: _n, ...row }) => ({
    ...row,
    pedidos: _orderIds.size,
  }));
}

export function rankProductSales(
  rows: readonly ProdutoSalesRow[],
  metric: ProdutoSalesMetric,
  topN: number,
): ProdutoSalesRow[] {
  return [...rows]
    .sort((a, b) => b[metric] - a[metric] || a.produtoUid.localeCompare(b.produtoUid))
    .slice(0, topN);
}

/* -------------------------- Distribuição por estado ------------------------ */

export interface EstadoSliceRow {
  estado: EstadoPedido;
  label: string;
  bucket: EstadoBucket;
  count: number;
  receita: number;
}

type PedidoEstadoRow = { data: { estado: EstadoPedido } & Parameters<typeof pedidoTotal>[0] };

/**
 * Count pedidos per ESTADOS_PEDIDO and sum their totals. Output is
 * ordered by count desc; pages can re-sort as needed.
 */
export function porEstado(pedidos: readonly PedidoEstadoRow[]): EstadoSliceRow[] {
  const map = new Map<EstadoPedido, EstadoSliceRow>();
  for (const { data } of pedidos) {
    const existing =
      map.get(data.estado) ??
      ({
        estado: data.estado,
        label: ESTADO_PEDIDO_LABELS[data.estado],
        bucket: bucketOf(data.estado),
        count: 0,
        receita: 0,
      } satisfies EstadoSliceRow);
    existing.count += 1;
    existing.receita += pedidoTotal(data);
    map.set(data.estado, existing);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/* --------------------------- Resumo por bucket ----------------------------- */

export interface BucketSummary {
  bucket: EstadoBucket;
  count: number;
  receita: number;
}

export function porBucket(pedidos: readonly PedidoEstadoRow[]): BucketSummary[] {
  const map = new Map<EstadoBucket, BucketSummary>([
    ['aberto', { bucket: 'aberto', count: 0, receita: 0 }],
    ['processo', { bucket: 'processo', count: 0, receita: 0 }],
    ['concluido', { bucket: 'concluido', count: 0, receita: 0 }],
    ['cancelado', { bucket: 'cancelado', count: 0, receita: 0 }],
  ]);
  for (const { data } of pedidos) {
    const bucket = bucketOf(data.estado);
    const row = map.get(bucket)!;
    row.count += 1;
    row.receita += pedidoTotal(data);
  }
  return [...map.values()];
}

/* ------------------------------ Totais gerais ----------------------------- */

export interface OverviewTotals {
  pedidos: number;
  receita: number;
  ticketMedio: number;
  itensVendidos: number;
}

export function overview(pedidos: PedidoLite[]): OverviewTotals {
  let receita = 0;
  let itens = 0;
  for (const { data } of pedidos) {
    receita += pedidoTotal(data);
    for (const list of Object.values(data.itens)) {
      for (const it of list) itens += it.quantidade;
    }
  }
  const count = pedidos.length;
  return {
    pedidos: count,
    receita,
    ticketMedio: count === 0 ? 0 : receita / count,
    itensVendidos: itens,
  };
}

/* ---------------------------- Checkouts por usuário ------------------------ */

export const CHECKOUT_TOP_USERS = 20;
export const OTHER_CHECKOUT_USERS = 'Outros usuários';

/** Counts returned by Firestore's grouped aggregate, never checkout documents. */
export interface CheckoutUserCount {
  userId: string | null;
  count: number;
}

export interface CheckoutReportRow extends CheckoutUserCount {
  label: string;
}

export interface CheckoutReport {
  total: number;
  rows: CheckoutReportRow[];
}

/** Merge wire aliases of a uid before choosing the bounded name-lookup set. */
export function rankCheckoutUsers(groups: readonly CheckoutUserCount[]): CheckoutUserCount[] {
  const counts = new Map<string, number>();
  for (const { userId, count } of groups) {
    if (userId !== null) counts.set(userId, (counts.get(userId) ?? 0) + count);
  }
  return [...counts]
    .map(([userId, count]) => ({ userId, count }))
    .sort(
      (a, b) => b.count - a.count || (a.userId! < b.userId! ? -1 : a.userId! > b.userId! ? 1 : 0),
    );
}

/** Unknown/non-collaborator users and every row beyond the lookup cap stay in the total. */
export function checkoutsPorUsuario(
  groups: readonly CheckoutUserCount[],
  collaboratorNames: ReadonlyMap<string, string>,
): CheckoutReport {
  const total = groups.reduce((sum, row) => sum + row.count, 0);
  const rows: CheckoutReportRow[] = [];
  for (const group of rankCheckoutUsers(groups).slice(0, CHECKOUT_TOP_USERS)) {
    const label = collaboratorNames.get(group.userId!);
    if (label?.trim()) rows.push({ ...group, label });
  }
  const other = total - rows.reduce((sum, row) => sum + row.count, 0);
  if (other > 0) rows.push({ userId: null, label: OTHER_CHECKOUT_USERS, count: other });
  return { total, rows };
}
