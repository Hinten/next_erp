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

type Acumulador = ProdutoSalesRow & { _orderIds: Set<string>; _nivelDoRotulo: 0 | 1 | 2 };

/**
 * Aggregate every ItemDoPedido across the supplied pedidos and rank by
 * total quantity sold. Items without a `produtoUid` (or with the literal
 * 'NONE' bucket) are dropped — there's no produto to report on.
 */
export function topProdutos(pedidos: PedidoLite[], topN = 10): ProdutoSalesRow[] {
  const byUid = new Map<string, Acumulador>();

  for (const { id: pedidoId, data } of pedidos) {
    for (const [groupKey, list] of Object.entries(data.itens)) {
      const produtoUid = groupKey && groupKey !== 'NONE' ? groupKey : null;
      if (!produtoUid) continue;
      for (const item of list) {
        const existing: Acumulador = byUid.get(produtoUid) ?? {
          produtoUid,
          // What level 0 resolves to. Seeded through the resolver rather than
          // spelled out, so the seed cannot disagree with the chain's tail.
          label: nomeDoItem({ produtoUid }, null),
          quantidade: 0,
          receita: 0,
          pedidos: 0,
          _orderIds: new Set<string>(),
          _nivelDoRotulo: 0,
        };
        existing.quantidade += item.quantidade;
        existing.receita += (item.precoDeVenda - (item.descontoUnitario ?? 0)) * item.quantidade;
        // A produto repeats across pedidos and only some lines carry a
        // `nomeDeVenda`, so the row's label is the best any of them can offer.
        // ⚠️ The fold is MONOTONIC — strictly `>` — for two reasons: the first
        // line of a tier wins, and a later line carrying LESS cannot walk the
        // label back down. A latch on the name tier alone did the second: a
        // group whose first line had a sku and whose second had neither fell
        // from the sku to the raw id, leaving the row worse than its data.
        // ⚠️ The uid comes from the MAP KEY, not `item.produtoUid` — the two can
        // disagree in the legacy corpus, and the key is what this row reports on.
        const nivel = nivelDoNomeDoItem(item);
        if (nivel > existing._nivelDoRotulo) {
          existing._nivelDoRotulo = nivel;
          existing.label = nomeDoItem(
            { produtoUid, nomeDeVenda: item.nomeDeVenda, sku: item.sku },
            null,
          );
        }
        existing._orderIds.add(pedidoId);
        byUid.set(produtoUid, existing);
      }
    }
  }

  const rows = [...byUid.values()].map(({ _orderIds, _nivelDoRotulo: _n, ...row }) => ({
    ...row,
    pedidos: _orderIds.size,
  }));
  rows.sort((a, b) => b.quantidade - a.quantidade);
  return rows.slice(0, topN);
}

/* -------------------------- Distribuição por estado ------------------------ */

export interface EstadoSliceRow {
  estado: EstadoPedido;
  label: string;
  bucket: EstadoBucket;
  count: number;
  receita: number;
}

/**
 * Count pedidos per ESTADOS_PEDIDO and sum their totals. Output is
 * ordered by count desc; pages can re-sort as needed.
 */
export function porEstado(pedidos: PedidoLite[]): EstadoSliceRow[] {
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

export function porBucket(pedidos: PedidoLite[]): BucketSummary[] {
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
