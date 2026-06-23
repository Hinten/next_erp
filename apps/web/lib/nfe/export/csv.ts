/**
 * CSV formatting for the NF-e report (#11). Semicolon-delimited with a UTF-8 BOM
 * and comma decimals — the combination Excel pt-BR opens correctly. The report
 * **ends with a totals trailer** (`Total Entradas`/`Total Saídas`/`Faturamento`
 * + `Total de notas: N`); a truncated CSV is missing this block, so an
 * incomplete report is visibly detectable.
 */
import { ESTADO_NFE_LABELS } from '@delfrance/schemas';

import type { NfeReportRow } from './parseNfeReportRow';
import type { NfeNote } from './types';

/** Byte-order mark (U+FEFF) so Excel reads the file as UTF-8 (accents intact). */
export const CSV_BOM = String.fromCharCode(0xfeff);

export const REPORT_HEADER = [
  'Série',
  'Número',
  'Status',
  'Tipo',
  'Natureza',
  'Finalidade',
  'Cliente',
  'UF',
  'Data de Emissão',
  'Valor Produtos',
  'Frete',
  'Desconto',
  'Total Nota',
] as const;

type Cell = string | number | null | undefined;

/** Escape one CSV cell: quote (and double inner quotes) when it contains the
 * delimiter, a quote, or a line break. */
export function csvCell(value: Cell): string {
  const s = value == null ? '' : String(value);
  if (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(';');
}

/** `'1234.56'` (XML, dot decimal) → `'1234,56'` (Excel pt-BR). Empty stays empty. */
export function brNum(raw: string): string {
  return raw ? raw.replace('.', ',') : '';
}

/** Integer cents → `'1234,56'` (negative preserved). */
export function centsToBr(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${reais},${frac}`;
}

/** Parse an XML money string (`'1234.56'`) to integer cents — summed in cents to
 * avoid float drift across tens of thousands of notes. */
export function toCents(raw: string): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function tipoLabel(tpNF: string): string {
  if (tpNF === '0') return 'Entrada';
  if (tpNF === '1') return 'Saída';
  return '';
}

/** ISO `data_emissao` → `dd/MM/yyyy` (local). Falls back to the raw value. */
export function formatDateBr(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** One report row. `row` is null when the note has no procNFe (rejected/error):
 * the XML-derived columns stay blank, mirroring the old Flutter report. */
export function reportRowCsv(note: NfeNote, row: NfeReportRow | null): string {
  return csvRow([
    note.serie,
    note.numeracao,
    ESTADO_NFE_LABELS[note.estado] ?? note.estado,
    row ? tipoLabel(row.tpNF) : '',
    row?.natOp ?? '',
    row?.finNFe ?? '',
    row?.destNome ?? '',
    row?.destUF ?? '',
    formatDateBr(note.dataEmissao),
    brNum(row?.vProd ?? ''),
    brNum(row?.vFrete ?? ''),
    brNum(row?.vDesc ?? ''),
    brNum(row?.vNF ?? ''),
  ]);
}

const EMPTY_LEADING = ['', '', '', '', '', '', '', '', '', '', ''] as const;

/** The closing totals block — also the completeness marker for the CSV. */
export function reportTotalsTrailer(input: {
  entradasCents: number;
  saidasCents: number;
  count: number;
}): string[] {
  const fat = input.saidasCents - input.entradasCents;
  return [
    '',
    '',
    csvRow(['Total Entradas', ...EMPTY_LEADING, centsToBr(input.entradasCents)]),
    csvRow(['Total Saídas', ...EMPTY_LEADING, centsToBr(input.saidasCents)]),
    csvRow(['Faturamento Total (Saídas - Entradas)', ...EMPTY_LEADING, centsToBr(fat)]),
    csvRow([`Total de notas: ${input.count}`]),
  ];
}
