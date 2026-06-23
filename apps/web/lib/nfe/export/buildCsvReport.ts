/**
 * Build the NF-e CSV report for the period (#11), in the browser.
 *
 * Bounded memory: the paged note stream is parsed one note at a time (native
 * `DOMParser` via `parseNfeReportRow`) and rows accumulate as text (~150 B/note).
 * Money is summed in integer cents (no float drift across tens of thousands of
 * notes). The report ends with the totals trailer — a truncated CSV is missing
 * that block, so an incomplete report is visibly detectable. As with the ZIP, an
 * `exact` source asserts `processed === preCount` before producing the file.
 */
import { parseNfeReportRow } from './parseNfeReportRow';
import { CSV_BOM, REPORT_HEADER, csvRow, reportRowCsv, reportTotalsTrailer, toCents } from './csv';
import {
  ExportIncompleteError,
  type ExportResult,
  type ExportSource,
  type ProgressFn,
} from './types';

export async function buildCsvReport(
  source: ExportSource,
  onProgress?: ProgressFn,
): Promise<ExportResult> {
  const lines: string[] = [csvRow(REPORT_HEADER)];
  let processed = 0;
  let entradasCents = 0;
  let saidasCents = 0;

  for await (const page of source.pages) {
    for (const note of page) {
      processed += 1;
      const row = note.xmlNfeProc ? parseNfeReportRow(note.xmlNfeProc) : null;
      lines.push(reportRowCsv(note, row));
      if (row) {
        const cents = toCents(row.vNF);
        if (row.tpNF === '0') entradasCents += cents;
        else if (row.tpNF === '1') saidasCents += cents;
      }
    }
    onProgress?.(processed, source.preCount);
  }

  lines.push(...reportTotalsTrailer({ entradasCents, saidasCents, count: processed }));

  if (source.exact && processed !== source.preCount) {
    throw new ExportIncompleteError(processed, source.preCount);
  }

  const blob = new Blob([CSV_BOM + lines.join('\r\n') + '\r\n'], {
    type: 'text/csv;charset=utf-8',
  });
  return { blob, filename: `nfe-relatorio-${source.stamp}.csv`, processed, included: processed };
}
