import { depositoIdFromOuterRef, type ProductLocationRow } from './productLocation';

const BOM = '\uFEFF';
const FORMULA_LEAD = /^[\t\r\n ]*[=+\-@]/;

export const PRODUCT_LOCATION_CSV_HEADER = [
  'SKU',
  'Produto',
  'Localização',
  'Total',
  'Reservado',
  'Disponível',
] as const;

function decimal(value: number): string {
  return Number.isFinite(value) ? String(value).replace('.', ',') : '';
}

/**
 * Serialize one report cell for semicolon-delimited Excel CSV.
 *
 * Text whose first meaningful character can start a spreadsheet formula gets
 * an apostrophe prefix. Numeric values remain numeric, including negatives.
 */
export function productLocationCsvCell(value: string | number | null): string {
  let cell = typeof value === 'number' ? decimal(value) : (value ?? '');
  if (typeof value === 'string' && FORMULA_LEAD.test(cell)) cell = `'${cell}`;
  return /[;"\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function row(cells: readonly (string | number | null)[]): string {
  return cells.map(productLocationCsvCell).join(';');
}

export function buildProductLocationCsv(rows: readonly ProductLocationRow[]): string {
  return (
    BOM +
    [
      row(PRODUCT_LOCATION_CSV_HEADER),
      ...rows.map((item) =>
        row([
          item.sku,
          item.produto,
          item.localizacao,
          item.total,
          item.reservado,
          item.disponivel,
        ]),
      ),
    ].join('\r\n')
  );
}

export function productLocationCsvFilename(depositoOuterRef: unknown, now: Date): string {
  const depositoId = depositoIdFromOuterRef(depositoOuterRef).replace(/[\\/:*?"<>|]/g, '-');
  return `localizacao-produtos-${depositoId}-${now.toISOString().slice(0, 10)}.csv`;
}

/** Browser download kept report-scoped so this surface has no fiscal dependency. */
export function downloadProductLocationCsv(
  rows: readonly ProductLocationRow[],
  depositoOuterRef: unknown,
): void {
  const blob = new Blob([buildProductLocationCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = productLocationCsvFilename(depositoOuterRef, new Date());
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
