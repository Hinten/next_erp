import type { EstadoNFe } from '@delfrance/schemas';

/**
 * Mass NF-e export (#11). Shared types for the client-side ZIP/CSV builders.
 *
 * The whole pipeline runs in the browser: a paginated `collectionGroup('nfev4')`
 * read feeds a streaming zip / CSV builder, so the raw XML is never all held in
 * memory. See `exportQuery.ts` (reads) and `buildXmlZip.ts` / `buildCsvReport.ts`.
 */

/** Filter the user picks on the export screen. Dates are ms-epoch (local day bounds). */
export interface ExportFilter {
  /** Start of the period — local day start, ms-epoch. */
  readonly startMs: number;
  /** End of the period — local day end (23:59:59.999), ms-epoch. */
  readonly endMs: number;
  /** Restrict to one filial (denormalized `nfev4.filialId`), or null for all. */
  readonly filialId: string | null;
  /** Restrict to these estados (server-side `estado in [...]`); empty = all. */
  readonly estados: readonly EstadoNFe[];
}

/** The few fields the builders need from each `nfev4` doc — kept minimal so the
 * heavy `xmlNfeProc` string is the only large value retained per note. */
export interface NfeNote {
  /** Doc id (e.g. `s1`) — NOT unique across the collection group: different
   * parent pedidos can each hold a `nfev4/s1`. Use `path` for a stable key. */
  readonly id: string;
  /** Full Firestore path (`pedidos/<id>/nfev4/<docId>`) — globally unique. */
  readonly path: string;
  readonly chave: string | null;
  readonly numeracao: number;
  readonly serie: number;
  readonly estado: EstadoNFe;
  /** `data_emissao` (dhEmi) as ms-since-epoch, or null. */
  readonly dataEmissao: number | null;
  /** The procNFe XML — present only on authorized/cancelled notes. */
  readonly xmlNfeProc: string | null;
}

/** A ready-to-consume export source: the pre-flight count + the paged note stream. */
export interface ExportSource {
  /** `getCountFromServer` total for the (fully server-side) query. Every filter is
   * in the query, so the scanned total must equal this — the builders assert it. */
  readonly preCount: number;
  /** `<YYYYMMDD>-<YYYYMMDD>` stamp for the artifact filename. */
  readonly stamp: string;
  /** Paged note stream (server-filtered; no client-side narrowing). */
  readonly pages: AsyncIterable<NfeNote[]>;
}

/** Progress callback: `(scanned, expected)`. `expected` is `preCount` (the exact
 * total — every filter is server-side). */
export type ProgressFn = (scanned: number, expected: number) => void;

export interface ExportResult {
  readonly blob: Blob;
  readonly filename: string;
  /** Notes scanned in the period (rows in the CSV). */
  readonly processed: number;
  /** Entries actually written to the artifact (XMLs in the ZIP; = processed for CSV). */
  readonly included: number;
}

/**
 * Thrown when an export scanned fewer notes than the pre-flight count — i.e. a
 * page read came up short. The screen surfaces it and offers **no** file, so a
 * silently-truncated export can never be saved.
 */
export class ExportIncompleteError extends Error {
  constructor(
    readonly processed: number,
    readonly expected: number,
  ) {
    super(
      `Exportação incompleta: ${processed} de ${expected} notas processadas. ` +
        'Nenhum arquivo foi gerado — tente novamente.',
    );
    this.name = 'ExportIncompleteError';
  }
}
