import type { Firestore } from 'firebase/firestore';
import { and, descending, equal, equalAny, execute, field } from 'firebase/firestore/pipelines';
import { z } from 'zod';
import { dataCivilNoFuso, microsDeDataHoraNoFuso, somarDiasCivis } from '@delfrance/core/datetime';
import { estadoPedidoSchema, FUSO_FISCAL, type EstadoPedido } from '@delfrance/schemas';
import { porBucket, porEstado } from './aggregations';
import {
  pedidoReportAccounts,
  pedidoReportTimestamp,
  type PedidoReportDateRange,
} from './pedidoReportPredicates';

export type SalesMovement = 'saidas' | 'entradas' | 'todos';

export interface SalesReportFilters extends PedidoReportDateRange {
  movement: SalesMovement;
  estados: readonly EstadoPedido[];
  accountIds: readonly string[];
}

const reportItem = z.object({
  precoDeVenda: z.number(),
  quantidade: z.number(),
  descontoUnitario: z.number().nullable().default(null),
});

// Validate only the fields used by the report. Legacy item metadata can have
// fields the current item schema doesn't recognize.
const reportOrder = z.object({
  estado: estadoPedidoSchema,
  itens: z.record(z.string(), z.array(reportItem)).default({}),
});

export function defaultSalesReportDates(now = Date.now()): [string, string] {
  const today = dataCivilNoFuso(now, FUSO_FISCAL);
  return [today.slice(0, 7) + '-01', today];
}

export function salesReportDateRange(start: string, end: string): PedidoReportDateRange | null {
  const nextDay = somarDiasCivis(end, 1);
  if (!nextDay || start > end) return null;
  const startUs = microsDeDataHoraNoFuso(start + 'T00:00:00', FUSO_FISCAL);
  const endExclusiveUs = microsDeDataHoraNoFuso(nextDay + 'T00:00:00', FUSO_FISCAL);
  return startUs !== null && endExclusiveUs !== null && startUs < endExclusiveUs
    ? { startUs, endExclusiveUs }
    : null;
}

export function buildSalesReportPipeline(db: Firestore, filters: SalesReportFilters) {
  const date = pedidoReportTimestamp(filters);
  const predicates = [];
  if (filters.movement !== 'todos') {
    predicates.push(equal(field('ehSaida').ifAbsent(true), filters.movement === 'saidas'));
  }
  if (filters.estados.length > 0) {
    predicates.push(equalAny(field('estado'), [...filters.estados]));
  }
  if (filters.accountIds.length > 0) {
    predicates.push(pedidoReportAccounts(filters.accountIds));
  }
  const predicate =
    predicates.length > 0 ? and(date, predicates[0]!, ...predicates.slice(1)) : date;
  // Staging Explain chose the estado/numero index for combined filters until
  // the timestamp sort let the date range bound the index scan.
  return db
    .pipeline()
    .collection('pedidos')
    .where(predicate)
    .sort(descending(field('timestamp')))
    .select('estado', 'itens');
}

export async function loadSalesReport(db: Firestore, filters: SalesReportFilters) {
  const snapshot = await execute(buildSalesReportPipeline(db, filters));
  const orders = snapshot.results.map((row) => {
    const parsed = reportOrder.safeParse(row.data());
    if (!parsed.success) throw new TypeError('Um pedido contém dados inválidos para o relatório.');
    return { data: parsed.data };
  });
  return { total: orders.length, byBucket: porBucket(orders), byEstado: porEstado(orders) };
}

export type SalesReport = Awaited<ReturnType<typeof loadSalesReport>>;
