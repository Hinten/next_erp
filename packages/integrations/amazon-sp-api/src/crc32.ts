/**
 * The two integrity helpers the document modules share (`documentosEasyShip.ts`,
 * the label zip; `documentosFeed.ts`, the gzipped feed report): the CRC-32 that
 * fflate never checks, and the predicate that tells fflate's own errors apart
 * from every other exception.
 *
 * One copy for both modules, so the check value and the error test cannot drift
 * between the label and the report.
 *
 * ⚠️ INTERNAL. The barrel (`index.ts`) does not re-export this module.
 */

/**
 * The CRC-32 (IEEE 802.3, reflected polynomial `0xEDB88320`) table, 256
 * entries, built on the FIRST checksum, never at module load. The barrel
 * reaches every bundle that imports the package — the functions bundle
 * included, which reads no document — and esbuild keeps any top-level call it
 * cannot prove pure, so a module-level table would be built at every cold
 * start. A function nothing calls is dropped, with no annotation to trust.
 */
let tabelaCrc32: Uint32Array | null = null;

function obterTabelaCrc32(): Uint32Array {
  if (tabelaCrc32 !== null) return tabelaCrc32;
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  tabelaCrc32 = tabela;
  return tabela;
}

/**
 * The CRC-32 a zip records for an entry and a gzip trailer records for its
 * member. Pinned by the standard check value: `0xCBF43926` for the ASCII bytes
 * `123456789`.
 */
export function crc32(bytes: Uint8Array): number {
  const tabela = obterTabelaCrc32();
  let c = 0xffffffff;
  for (const b of bytes) c = (tabela[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * fflate's own error: a plain `Error` carrying a NUMERIC `code` (its error
 * table's index). `instanceof Error` alone would claim every exception, so the
 * code is what identifies it; this package's document classes (which have no
 * numeric `code`) are narrowed out before this is asked.
 */
export function ehErroDoFflate(err: unknown): boolean {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'number';
}
