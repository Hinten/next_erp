import type { CheckoutReport } from './aggregations';
import { CSV_BOM, csvRow } from '@/lib/csv';
import { saveBlob } from '@/lib/download/saveBlob';

export function checkoutsCsv(report: CheckoutReport, start: string, end: string): string {
  const rows: (string | number)[][] = [
    ['Data início', start],
    ['Data fim', end],
    ['Usuário', 'Checkouts'],
    ...report.rows.map((row) => [row.label, row.count]),
    ['Total de checkouts', report.total],
  ];
  return CSV_BOM + rows.map((row) => csvRow(row)).join('\r\n') + '\r\n';
}

export function downloadCheckoutsCsv(report: CheckoutReport, start: string, end: string): void {
  saveBlob(
    new Blob([checkoutsCsv(report, start, end)], { type: 'text/csv;charset=utf-8;' }),
    `checkouts-${start}-${end}.csv`,
  );
}
