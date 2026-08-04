/**
 * Compact codec for the vendored CEP-range → IBGE município table (#785).
 *
 * The table is ~11k ranges. Committing it as a `[number, number, string][]`
 * literal costs ~310 KB of source AND materialises 11k JS arrays on **every**
 * cold start — the metric that matters for App Hosting and the nested Cloud
 * Functions codebases. Instead each column is a comma-separated base36 integer
 * list in one string constant, decoded once, lazily, into a `Uint32Array`
 * (~2 ms, ~130 KB of typed-array heap, zero eager work at import).
 *
 * The `startGaps` column is the load-bearing part: it stores each range's start
 * as a NON-NEGATIVE gap from the previous range's end, which makes overlapping
 * ranges structurally unrepresentable. The generator physically cannot emit a
 * corrupt table — it has to reject the dump instead.
 */

/** The vendored table failed to decode, or a caller fed the codec bad input. */
export class CMunTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CMunTableError';
  }
}

const MAX_U32 = 0xffffffff;

/** Encode non-negative integers as a comma-separated base36 list. */
export function encodeU32List(values: readonly number[]): string {
  const parts = values.map((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
      throw new CMunTableError(`Value at index ${index} is not a u32: ${String(value)}`);
    }
    return value.toString(36);
  });
  return parts.join(',');
}

/**
 * Decode a list produced by {@link encodeU32List}.
 *
 * Single pass, no `split`, no `parseInt`, no intermediate strings — this runs
 * three times per process against ~11k-element lists.
 */
export function decodeU32List(encoded: string, expectedLength: number): Uint32Array {
  const out = new Uint32Array(expectedLength);
  if (encoded.length === 0) {
    if (expectedLength !== 0) {
      throw new CMunTableError(`Expected ${expectedLength} values, decoded 0.`);
    }
    return out;
  }

  let index = 0;
  let acc = 0;

  const push = (): void => {
    if (index >= expectedLength) {
      throw new CMunTableError(`Decoded more than the expected ${expectedLength} values.`);
    }
    if (acc > MAX_U32) {
      throw new CMunTableError(`Value at index ${index} overflows u32: ${String(acc)}`);
    }
    out[index] = acc;
    index += 1;
    acc = 0;
  };

  for (let i = 0; i < encoded.length; i += 1) {
    const code = encoded.charCodeAt(i);
    if (code === 44 /* , */) {
      push();
      continue;
    }
    // '0'-'9' → 0-9, 'a'-'z' → 10-35. Validate the CODE POINT, not the derived
    // digit: `code - 87` maps 'X'/'Y'/'Z' (88-90) onto 1/2/3, which a range
    // check on the digit would wave through as valid data.
    let digit: number;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 97 && code <= 122) digit = code - 87;
    else {
      throw new CMunTableError(
        `Invalid base36 character at offset ${i}: ${JSON.stringify(encoded[i])}`,
      );
    }
    acc = acc * 36 + digit;
  }
  push();

  if (index !== expectedLength) {
    throw new CMunTableError(`Expected ${expectedLength} values, decoded ${index}.`);
  }
  return out;
}

/** One CEP faixa: `[cepInicial, cepFinal]` inclusive, mapped to a 7-digit cMun. */
export interface CMunRange {
  readonly cepInicial: number;
  readonly cepFinal: number;
  readonly cMun: number;
}

/** The three encoded columns plus the length needed to decode them. */
export interface EncodedCMunTable {
  readonly rangeCount: number;
  /** `start[i] − (i ? end[i-1] + 1 : 0)`. Non-negative ⇒ no overlaps. */
  readonly startGaps: string;
  /** `end[i] − start[i]`. Non-negative ⇒ no inverted ranges. */
  readonly rangeLens: string;
  /** The 7-digit cMun of each range, absolute. */
  readonly codes: string;
}

/**
 * Encode ranges that are already sorted by `cepInicial` and non-overlapping.
 *
 * Shared by the runtime and `tools/cmun-table` so the encoder and decoder can
 * never drift — the vendoring script round-trips its output through
 * {@link decodeCMunTable} before writing the module.
 */
export function encodeCMunTable(ranges: readonly CMunRange[]): EncodedCMunTable {
  const startGaps: number[] = [];
  const rangeLens: number[] = [];
  const codes: number[] = [];

  let previousEnd = -1;
  ranges.forEach((range, index) => {
    const gap = range.cepInicial - (previousEnd + 1);
    if (gap < 0) {
      throw new CMunTableError(
        `Range ${index} (cepInicial ${range.cepInicial}) overlaps the previous range ` +
          `(cepFinal ${previousEnd}). Ranges must be sorted and disjoint.`,
      );
    }
    if (range.cepFinal < range.cepInicial) {
      throw new CMunTableError(
        `Range ${index} is inverted: cepInicial ${range.cepInicial} > cepFinal ${range.cepFinal}.`,
      );
    }
    startGaps.push(gap);
    rangeLens.push(range.cepFinal - range.cepInicial);
    codes.push(range.cMun);
    previousEnd = range.cepFinal;
  });

  return {
    rangeCount: ranges.length,
    startGaps: encodeU32List(startGaps),
    rangeLens: encodeU32List(rangeLens),
    codes: encodeU32List(codes),
  };
}

/** Decoded, binary-searchable columns. Parallel arrays, all `rangeCount` long. */
export interface CMunTable {
  /** `cepInicial` of each range, strictly increasing. */
  readonly starts: Uint32Array;
  /** `cepFinal` of each range, inclusive. */
  readonly ends: Uint32Array;
  /** The 7-digit cMun of each range. */
  readonly codes: Uint32Array;
}

/** Rebuild the searchable columns from {@link encodeCMunTable}'s output. */
export function decodeCMunTable(encoded: EncodedCMunTable): CMunTable {
  const { rangeCount } = encoded;
  const gaps = decodeU32List(encoded.startGaps, rangeCount);
  const lens = decodeU32List(encoded.rangeLens, rangeCount);
  const codes = decodeU32List(encoded.codes, rangeCount);

  const starts = new Uint32Array(rangeCount);
  const ends = new Uint32Array(rangeCount);

  let previousEnd = -1;
  for (let i = 0; i < rangeCount; i += 1) {
    const start = previousEnd + 1 + gaps[i]!;
    const end = start + lens[i]!;
    starts[i] = start;
    ends[i] = end;
    previousEnd = end;
  }

  return { starts, ends, codes };
}
