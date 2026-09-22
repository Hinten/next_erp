/**
 * Minimal Code 128 encoder — enough to put the NF-e chave on the generic
 * shipping label, and nothing more.
 *
 * Why not a library: the label's PDF is drawn as VECTOR (see `pdf.ts`), so the
 * barcode has to be bar geometry, not a rasterised `<canvas>`. `jsbarcode`
 * (already used by the pedido-print sheets) only draws into a DOM element, and
 * `bwip-js` is server-only and 10× the size. A table lookup plus one modulo is
 * the same arithmetic the DANFE ZPL renderer already does by hand to centre its
 * `^BCN` field.
 *
 * ⚠️ MIXED SUBSETS, and that is the whole point of this module. Subset C packs
 * two DIGITS per symbol; subset B carries one printable ASCII character per
 * symbol. Since NT 2026.004 (CNPJ Alfanumérico, RFB IN 2.229/2024) the chave's
 * positions 6–17 are the emitente's CNPJ body and may hold `A-Z`, so a
 * subset-C-only encoder cannot represent it — it used to return `null`, and
 * both renderers then dropped the barcode SILENTLY, leaving the operator a
 * label with a 10 mm blank gap and no way to scan it.
 *
 * Switching subsets mid-symbol needs nothing but the table below: value 100 is
 * CODE B (from C) and value 99 is CODE C (from B). That is why this is possible
 * here while the DANFE ZPL etiqueta stays blocked on #1624 — a Zebra encodes
 * `^BC` natively, so THAT path needs ZPL's mid-string invocation code, which
 * could not be verified. This module emits the bars itself, so it needs no
 * printer cooperation at all. `./zpl2` therefore still refuses an alfa chave.
 *
 * Widths, for the 44-character chave at the label's 90 mm barcode box:
 *
 *   all-numeric   1 start + 22 pairs + 1 check = 24 × 11 + 13 = 277 modules
 *   12 letters    1 start + 3 pairs + CODE_B + 12 + CODE_C + 13 pairs + 1 check
 *                                              = 32 × 11 + 13 = 365 modules
 *
 * so the X-dimension goes 0.325 mm → 0.247 mm in the worst case. That is under
 * the 0.250 mm GS1 general-distribution nominal but well over the ~0.19 mm a
 * handheld scanner needs, and `MIN_MODULE_MM` below pins it so a future layout
 * change that narrows the box fails loudly instead of printing an unscannable
 * symbol. A real alfa CNPJ usually does better than the worst case: any digits
 * at the end of the alfa window merge into the numeric tail's subset-C run.
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

/**
 * ⚠️ The two switch values are NOT symmetric, and reading them off a single
 * "code set" table is how this goes wrong. From subset C, 100 is CODE B. From
 * subset B, 99 is CODE C — while in subset C that same 99 is the DATA pair
 * `'99'`. Each constant below is therefore named for the subset it is emitted
 * FROM, not the one it selects.
 */
const START_B = 104;
const START_C = 105;
/** Emitted while in C, selects B. (In B, 100 is FNC4 — never emitted here.) */
const TO_B_FROM_C = 100;
/** Emitted while in B, selects C. (In C, 99 is the data pair `'99'`.) */
const TO_C_FROM_B = 99;
const STOP = 106;

/** Subset B covers printable ASCII; `value = charCode - 32`. */
const B_MIN_CHARCODE = 32;
const B_MAX_CHARCODE = 126;

/**
 * The narrowest bar this encoder will vouch for, in millimetres. Code 128's
 * practical floor for a handheld scanner is around 0.19 mm; below that the
 * printer's own dot pitch starts eating the narrow elements. The renderers do
 * not enforce it — they cannot, since the box width is the layout's call — but
 * `minModuleMm` lets a test pin the label's real geometry against it.
 */
export const MIN_MODULE_MM = 0.19;

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

/** One run of characters encoded in a single subset. */
interface Segment {
  set: 'B' | 'C';
  text: string;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Length of the EVEN-length digit run starting at `i` — what subset C could
 * take from there. An odd run gives up its last digit, which the caller then
 * encodes in B.
 */
function evenDigitRun(data: string, i: number): number {
  let n = 0;
  while (i + n < data.length && isDigit(data[i + n]!)) n += 1;
  return n - (n % 2);
}

/**
 * Split `data` into subset runs, using the standard heuristic: subset C pays
 * for itself from 4 digits in, or from 2 when the run sits at the very start or
 * the very end (where no switch symbol is needed on one side).
 *
 * Anything that is not worth a C run is appended to the current B segment one
 * character at a time. That is deliberately simple rather than optimal: a
 * digit that C cannot use (the odd one out of a run) has to land in B anyway,
 * and re-deciding at the next position gets it there without special-casing.
 */
function segment(data: string): Segment[] {
  const segs: Segment[] = [];
  let i = 0;
  while (i < data.length) {
    const even = evenDigitRun(data, i);
    const atStart = i === 0;
    const atEnd = i + even === data.length;
    const worthwhile = atStart || atEnd ? 2 : 4;
    if (even >= worthwhile) {
      segs.push({ set: 'C', text: data.slice(i, i + even) });
      i += even;
      continue;
    }
    const last = segs[segs.length - 1];
    if (last?.set === 'B') last.text += data[i]!;
    else segs.push({ set: 'B', text: data[i]! });
    i += 1;
  }
  return segs;
}

/**
 * Encode a string as Code 128, choosing subsets per run. Returns `null` for
 * anything it cannot represent — an empty string, or a character outside
 * printable ASCII 32–126 — so a caller can drop the barcode rather than print
 * a wrong one.
 *
 * ⚠️ A `null` here is now an unrepresentable PAYLOAD, not an unsupported
 * SUBSET. An NF-e chave is always ASCII, alfa or not, so a caller that sees
 * `null` on one has a bug upstream, not a barcode limitation.
 */
export function encodeCode128(data: string): Code128Symbol | null {
  if (data.length === 0) return null;
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code < B_MIN_CHARCODE || code > B_MAX_CHARCODE) return null;
  }

  const segs = segment(data);
  const first = segs[0]!;
  const values: number[] = [first.set === 'C' ? START_C : START_B];
  let current = first.set;
  for (const seg of segs) {
    if (seg.set !== current) {
      values.push(seg.set === 'B' ? TO_B_FROM_C : TO_C_FROM_B);
      current = seg.set;
    }
    if (seg.set === 'C') {
      for (let i = 0; i < seg.text.length; i += 2) {
        values.push(Number(seg.text.slice(i, i + 2)));
      }
    } else {
      for (let i = 0; i < seg.text.length; i += 1) {
        values.push(seg.text.charCodeAt(i) - B_MIN_CHARCODE);
      }
    }
  }

  // Checksum: the start value plus each subsequent symbol weighted by its
  // 1-based position, modulo 103. Switch symbols are ordinary weighted symbols
  // here — they are part of the sum exactly like data.
  let sum = values[0]!;
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
