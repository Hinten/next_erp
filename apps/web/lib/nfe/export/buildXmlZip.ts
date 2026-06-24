/**
 * Build a ZIP of every NF-e procNFe XML in the period (#11), in the browser.
 *
 * Bounded memory: the paged note stream is fed into fflate's streaming `Zip` one
 * entry at a time (sync `ZipDeflate` → no Web Worker, so it also runs in the
 * jsdom test env), so the raw XML is never all held at once — only the
 * compressed output accumulates.
 *
 * Completeness (the anti-truncation guarantee):
 *  - the complete Blob is built **before** any download, and when the source is
 *    `exact` we assert `processed === preCount` — a short page throws
 *    `ExportIncompleteError` and **no** file is produced;
 *  - fflate writes the central directory on `zip.end()`, so a corrupt/truncated
 *    archive fails to open loudly (never a silent partial);
 *  - a `_MANIFEST.csv` lists every chave + `Total: N`, so the archive self-verifies.
 */
import { Zip, ZipDeflate, strToU8 } from 'fflate';

import { CSV_BOM, csvRow, formatDateBr } from './csv';
import {
  ExportIncompleteError,
  type ExportResult,
  type ExportSource,
  type ProgressFn,
} from './types';

const MANIFEST_NAME = '_MANIFEST.csv';
const MANIFEST_HEADER = ['Chave', 'Número', 'Série', 'Estado', 'Data de Emissão'] as const;

export async function buildXmlZip(
  source: ExportSource,
  onProgress?: ProgressFn,
): Promise<ExportResult> {
  const chunks: Uint8Array[] = [];
  let zipError: unknown = null;
  const zip = new Zip((err, data, _final) => {
    if (err) {
      zipError = err;
      return;
    }
    if (data.length) chunks.push(data);
  });

  // The XML entries stream into the ZIP in query order (can't buffer hundreds of
  // MB at 50k scale), but the manifest rows are light → buffered so we can sort
  // them strictly by (série, número) for a número-ordered table of contents.
  const manifestRows: { serie: number; numeracao: number; csv: string }[] = [];
  let processed = 0;
  let included = 0;

  for await (const page of source.pages) {
    for (const note of page) {
      processed += 1;
      // Only authorized/cancelled notes carry a procNFe; rejected/error notes
      // have no XML to bundle (they still appear in the CSV report).
      if (!note.xmlNfeProc) continue;
      const name = `${note.chave ?? note.id}-procNFe.xml`;
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(strToU8(note.xmlNfeProc), true);
      if (zipError) throw zipError;
      manifestRows.push({
        serie: note.serie,
        numeracao: note.numeracao,
        csv: csvRow([
          note.chave ?? note.id,
          note.numeracao,
          note.serie,
          note.estado,
          formatDateBr(note.dataEmissao),
        ]),
      });
      included += 1;
    }
    onProgress?.(processed, source.preCount);
  }

  manifestRows.sort((a, b) => a.serie - b.serie || a.numeracao - b.numeracao);
  const manifest: string[] = [
    csvRow(MANIFEST_HEADER),
    ...manifestRows.map((r) => r.csv),
    '',
    csvRow([`Total: ${included}`]),
  ];
  const manifestEntry = new ZipDeflate(MANIFEST_NAME, { level: 6 });
  zip.add(manifestEntry);
  manifestEntry.push(strToU8(CSV_BOM + manifest.join('\r\n') + '\r\n'), true);
  zip.end();
  if (zipError) throw zipError;

  if (source.exact && processed !== source.preCount) {
    throw new ExportIncompleteError(processed, source.preCount);
  }

  // `chunks` are non-overlapping Uint8Array views fflate emitted in order.
  const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
  return { blob, filename: `nfe-xmls-${source.stamp}.zip`, processed, included };
}
