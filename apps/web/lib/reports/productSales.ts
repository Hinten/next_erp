import type { Firestore } from 'firebase/firestore';
import {
  array,
  conditional,
  documentId,
  execute,
  field,
  isType,
  map,
  mapEntries,
} from 'firebase/firestore/pipelines';
import { z } from 'zod';
import { aggregateProductSales, type ProdutoSalesLine, type ProdutoSalesRow } from './aggregations';
import { orderReportPredicate, type OrderReportFilters } from './orderReportFilters';

const salesLineSchema = z.object({
  pedidoId: z.string().min(1),
  produtoUid: z.string().min(1),
  quantidade: z.number().nonnegative(),
  precoDeVenda: z.number().nonnegative(),
  descontoUnitario: z.number().nonnegative().nullable().default(null),
  nomeDeVenda: z.string().nullable().catch(null),
  sku: z.string().nullable().catch(null),
});

export interface ProductSalesReport {
  rows: ProdutoSalesRow[];
  invalidLines: number;
}

export function buildProductSalesPipeline(db: Firestore, filters: OrderReportFilters) {
  const predicate = orderReportPredicate(filters);
  const items = field('itens').ifAbsent({}).ifNull(false);
  const group = field('itemGroups.v').ifAbsent(false).ifNull(false);
  return db
    .pipeline()
    .collection('pedidos')
    .where(predicate)
    .select(
      documentId(field('__name__')).as('pedidoId'),
      mapEntries(conditional(isType(items, 'map'), items, map({ invalid: [{}] }))).as('itemGroups'),
    )
    .unnest(field('itemGroups'))
    .unnest(conditional(isType(group, 'array'), group, array([{}])).as('item'))
    .select(
      'pedidoId',
      field('itemGroups.k').as('produtoUid'),
      field('item.quantidade').as('quantidade'),
      field('item.precoDeVenda').as('precoDeVenda'),
      field('item.descontoUnitario').as('descontoUnitario'),
      field('item.nomeDeVenda').as('nomeDeVenda'),
      field('item.sku').as('sku'),
    );
}

export async function loadProductSalesReport(
  db: Firestore,
  filters: OrderReportFilters,
): Promise<ProductSalesReport> {
  const snapshot = await execute(buildProductSalesPipeline(db, filters));
  let invalidLines = 0;
  function* lines(): Iterable<ProdutoSalesLine> {
    for (const result of snapshot.results) {
      const raw = result.data();
      if (raw.produtoUid === 'NONE' || raw.produtoUid === '') continue;
      const parsed = salesLineSchema.safeParse(raw);
      if (parsed.success) yield parsed.data;
      else invalidLines++;
    }
  }
  const rows = aggregateProductSales(lines());
  return { rows, invalidLines };
}
