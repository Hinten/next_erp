/**
 * Helvetica / Helvetica-Bold advance widths — enough to measure a string the
 * way the PDF will actually draw it.
 *
 * The layout spec has to wrap text, and it has to stay **pure** (the ZPL walker
 * shares it and never loads jsPDF), so it cannot ask a renderer how wide a line
 * is. The first cut estimated with a flat 0.5em average advance. That is the
 * average for *mixed-case Latin prose* and far too generous for what a Brazilian
 * shipping label carries: digits are 0.556em and uppercase averages ~0.72em
 * (`W` is 0.944em), and addresses and names are very often stored uppercase. A
 * line of 51 `X` measures 118.7mm against a 90mm box — it wrapped, and then ran
 * 7.7mm past the trim, where the MediaBox clips it.
 *
 * So carry the real numbers. These are the Adobe standard-14 AFM advances, in
 * 1/1000 em, which is exactly what jsPDF renders with — `metrics.test.ts`
 * cross-checks every entry against `jsPDF.getTextWidth`, so a mistyped value
 * fails CI rather than shipping a label that overflows.
 */

/** Advance widths per 1000 em for ASCII 32–126, Helvetica. */
// prettier-ignore
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Advance widths per 1000 em for ASCII 32–126, Helvetica-Bold. */
// prettier-ignore
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * The non-ASCII characters this label actually draws. Accented Latin-1 letters
 * are NOT here on purpose — in Helvetica they carry their base letter's advance,
 * so `fold` maps `ã → a`, `Ç → C` and so on, which covers every Portuguese
 * diacritic without a 200-entry table.
 */
const EXTRA: Record<string, readonly [number, number]> = {
  '—': [1000, 1000], // emdash — the DASH placeholder
  '–': [556, 556], // endash
  '·': [278, 278], // periodcentered — the volumes separator
  º: [365, 400], // ordmasculine — "NFe nº"
  ª: [370, 400],
  '°': [400, 400],
  '“': [333, 500],
  '”': [333, 500],
  '‘': [222, 278],
  '’': [222, 278],
  '…': [1000, 1000],
  // ⚠️ The folding rule below does NOT hold for these. A lowercase `i` is 222
  // but its accented forms are 278 — the accent needs the width — and `ý` is
  // wider than `y`. Folding them under-measured by up to 0.2mm per character,
  // which the jsPDF cross-check caught.
  ì: [278, 278],
  í: [278, 278],
  î: [278, 278],
  ï: [278, 278],
  ý: [530, 560],
  ÿ: [530, 560],
};

/** Unknown glyph → the widest advance in the table, so a surprise never under-measures. */
const FALLBACK: readonly [number, number] = [1015, 975];

const ACCENTS = 'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖòóôõöÙÚÛÜùúûüÝýÿ';
const BASES = 'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOoooooUUUUuuuuYyy';

/** Map an accented Latin-1 letter to the base letter whose advance it shares. */
function fold(ch: string): string {
  const i = ACCENTS.indexOf(ch);
  return i === -1 ? ch : BASES[i]!;
}

/** Advance of one character, in 1/1000 em. */
function advance(ch: string, bold: boolean): number {
  const extra = EXTRA[ch];
  if (extra) return extra[bold ? 1 : 0];
  const code = fold(ch).charCodeAt(0);
  if (code < 32 || code > 126) return FALLBACK[bold ? 1 : 0];
  return (bold ? HELVETICA_BOLD : HELVETICA)[code - 32]!;
}

/** Width of `text` at `sizePt`, in **millimetres** — the layout's unit. */
export function textWidthMm(text: string, sizePt: number, bold: boolean): number {
  let thousandths = 0;
  for (const ch of text) thousandths += advance(ch, bold);
  return (thousandths / 1000) * ((sizePt * 25.4) / 72);
}

/** Every character the width table covers — the cross-check test enumerates these. */
export function measurableCharacters(): string[] {
  const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
  return [...ascii, ...Object.keys(EXTRA), ...ACCENTS];
}
