import { CSV_BOM, csvRow } from '@/lib/nfe/export/csv';
import type { PrecoAlteracao } from './types';

/**
 * CSV export for the bulk price-recalculation results table (#544) — port of
 * the legacy `generateCsvAlteracaoDePrecosDownload`
 * (`.old/lib/produtos/pages/alterarPrecoMassa2.dart:485-547`). Same
 * semicolon-delimited + UTF-8 BOM + comma-decimal convention as the NF-e
 * export report (`lib/nfe/export/csv.ts`); formula-injection safety rides
 * `csvCell` via `csvRow`.
 */

export const PRECO_CSV_HEADER = [
  'Sku',
  'Nome',
  'Preço Atual',
  'Novo Preço',
  'Diferença',
  'Erro',
] as const;

/**
 * Reais number → pt-BR grouped decimal string (`5.5 → '5,50'`,
 * `1234.56 → '1.234,56'`). `null` → `''`. Legacy parity: the Flutter report
 * formatted through `NumberFormat.currency(symbol: '', decimalDigits: 2)`,
 * which groups thousands (`utils.dart:13`).
 */
const BR_MONEY = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function brMoney(value: number | null): string {
  if (value === null) return '';
  return BR_MONEY.format(value);
}

/** Null-sku-last comparator — legacy sorts by sku but leaves null skus
 * effectively unordered (`a.key.sku?.compareTo(...) ?? 0`); putting them last
 * is the well-defined choice for this port. */
function compareBySku(a: PrecoAlteracao, b: PrecoAlteracao): number {
  if (a.sku === null && b.sku === null) return 0;
  if (a.sku === null) return 1;
  if (b.sku === null) return -1;
  return a.sku.localeCompare(b.sku);
}

/** Build the full CSV text (BOM + header + one row per alteração, sorted by SKU). */
export function buildPrecoAlteracoesCsv(rows: readonly PrecoAlteracao[]): string {
  const sorted = [...rows].sort(compareBySku);

  const lines = [
    csvRow(PRECO_CSV_HEADER),
    ...sorted.map((row) => {
      // Legacy fills Diferença with the full novo price when there was no
      // precoAtual under this lista yet (first price), not a blank cell —
      // `alterarPrecoMassa2.dart:526`: `precoAtual == null ?
      // formatCurrencyOnly.format(novo) : format(novo - precoAtual)`.
      const diferenca =
        row.precoNovo === null
          ? null
          : row.precoAtual === null
            ? row.precoNovo
            : row.precoNovo - row.precoAtual;
      return csvRow([
        row.sku ?? '',
        row.nome,
        brMoney(row.precoAtual),
        brMoney(row.precoNovo),
        brMoney(diferenca),
        row.erro ?? '',
      ]);
    }),
  ];

  return CSV_BOM + lines.join('\r\n');
}

/** Lowercase, spaces→'-', strip everything else that isn't alnum/hyphen. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** `recalculo-precos-<slug>-<YYYYMMDD-HHmm>.csv` — local time. */
export function precoCsvFilename(listaNome: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `recalculo-precos-${slugify(listaNome)}-${stamp}.csv`;
}
