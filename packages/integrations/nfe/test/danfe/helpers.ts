/** Shared assertions for the DANFE PDF tests (simplificado / retrato / paisagem). */

/** A procNFe-derived chave used to exercise the NFref (referenced NF-e) path. */
export const REF_CHAVE = '35260514200166000187550010000000061000000010';

/** True when `buf` starts with the `%PDF-` magic. */
export const isPdf = (buf: Buffer): boolean => buf.subarray(0, 5).toString('latin1') === '%PDF-';

/** Count the `/Type /Page` objects in a PDF (the `[^s]` excludes `/Pages`). */
export const pageCount = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
