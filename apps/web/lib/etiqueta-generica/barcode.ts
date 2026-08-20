/**
 * Minimal Code 128 subset-C encoder — enough to put the NF-e chave on the
 * generic shipping label, and nothing more.
 *
 * Why not a library: the label's PDF is drawn as VECTOR (see `pdf.ts`), so the
 * barcode has to be bar geometry, not a rasterised `<canvas>`. `jsbarcode`
 * (already used by the pedido-print sheets) only draws into a DOM element, and
 * `bwip-js` is server-only and 10× the size. Subset C over a fixed-length digit
 * string is a table lookup plus one modulo — the same arithmetic the DANFE ZPL
 * renderer already does by hand to centre its `^BCN` field.
 *
 * Subset C packs TWO digits per symbol, so the 44-digit chave becomes 22 data
 * symbols: `(1 start + 22 data + 1 checksum) × 11 + 13 stop = 277 modules`.
 * The ZPL label does not use this module — a Zebra encodes Code 128 natively
 * (`^BCN` with the `>;` subset-C prefix).
 */

/**
 * The 107 Code 128 symbol patterns, as element widths in modules
 * (bar, space, bar, space, bar, space). Index = symbol value; 103/104/105 are
 * START A/B/C and 106 is the 7-element STOP. Laid out eight per row — the row
 * comments are the index of its first entry — and flattened, so the table stays
 * a readable grid instead of 107 one-entry lines.
 */
const PATTERNS = [
  /* 000 */ '212222 222122 222221 121223 121322 131222 122213 122312',
  /* 008 */ '132212 221213 221312 231212 112232 122132 122231 113222',
  /* 016 */ '123122 123221 223211 221132 221231 213212 223112 312131',
  /* 024 */ '311222 321122 321221 312212 322112 322211 212123 212321',
  /* 032 */ '232121 111323 131123 131321 112313 132113 132311 211313',
  /* 040 */ '231113 231311 112133 112331 132131 113123 113321 133121',
  /* 048 */ '313121 211331 231131 213113 213311 213131 311123 311321',
  /* 056 */ '331121 312113 312311 332111 314111 221411 431111 111224',
  /* 064 */ '111422 121124 121421 141122 141221 112214 112412 122114',
  /* 072 */ '122411 142112 142211 241211 221114 413111 241112 134111',
  /* 080 */ '111242 121142 121241 114212 124112 124211 411212 421112',
  /* 088 */ '421211 212141 214121 412121 111143 111341 131141 114113',
  /* 096 */ '114311 411113 411311 113141 114131 311141 411131 211412',
  /* 104 */ '211214 211232 2331112',
]
  .join(' ')
  .split(' ');

const START_C = 105;
const STOP = 106;

/** A filled bar, in module units from the left edge of the symbol. */
export interface BarcodeBar {
  readonly start: number;
  readonly width: number;
}

export interface Code128Symbol {
  /** Total width of the symbol, in modules (quiet zones excluded). */
  readonly modules: number;
  readonly bars: readonly BarcodeBar[];
}

/**
 * Encode an even-length digit string as Code 128 subset C. Returns `null` for
 * anything it cannot represent (odd length, a non-digit) so a caller can simply
 * drop the barcode instead of printing a wrong one.
 */
export function encodeCode128C(data: string): Code128Symbol | null {
  if (!/^\d+$/.test(data) || data.length % 2 !== 0) return null;

  const values: number[] = [START_C];
  for (let i = 0; i < data.length; i += 2) {
    values.push(Number(data.slice(i, i + 2)));
  }

  // Checksum: the start value plus each data symbol weighted by its 1-based
  // position, modulo 103.
  let sum = START_C;
  for (let i = 1; i < values.length; i += 1) {
    sum += values[i]! * i;
  }
  values.push(sum % 103, STOP);

  const bars: BarcodeBar[] = [];
  let cursor = 0;
  for (const value of values) {
    const pattern = PATTERNS[value]!;
    for (let i = 0; i < pattern.length; i += 1) {
      const width = Number(pattern[i]);
      // Even indexes are bars, odd are spaces.
      if (i % 2 === 0) bars.push({ start: cursor, width });
      cursor += width;
    }
  }

  return { modules: cursor, bars };
}
