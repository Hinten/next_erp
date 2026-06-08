/**
 * cm-grid layout helpers for the A4 DANFE (retrato + paisagem).
 *
 * The legacy Flutter layout positions every box absolutely on a centimetre
 * grid (`positionedBox` + `getTextBloco`); these helpers reproduce that with
 * pdfkit so the `.old` coordinates port over directly. All x/y/w/h are in
 * **centimetres**; `cm()` converts to points.
 */
import { cmToPt, formatMoney } from '../format';
import { type Doc, strokeBox, text } from './primitives';

export const cm = cmToPt;
export const A4_W_CM = 21;
export const A4_H_CM = 29.7;

const PAD = 2; // inner padding (points)

export interface FieldOpts {
  readonly valueSize?: number;
  readonly valueBold?: boolean;
  readonly valueAlign?: 'left' | 'center' | 'right';
  /** Format the value as pt-BR money and right-align it. */
  readonly money?: boolean;
  readonly labelSize?: number;
  /** Wrap the value over up to N lines (default 1, clipped). */
  readonly valueLines?: number;
}

/**
 * A bordered field box (`getTextBloco`): a small label on top and a value
 * below, within `[xCm, yCm]` of size `wCm × hCm`. Either may be null.
 */
export function field(
  doc: Doc,
  xCm: number,
  yCm: number,
  wCm: number,
  hCm: number,
  label: string | null,
  value: string | null,
  opts: FieldOpts = {},
): void {
  strokeBox(doc, cm(xCm), cm(yCm), cm(wCm), cm(hCm));
  const innerW = cm(wCm) - 2 * PAD;
  let yy = cm(yCm) + PAD;
  if (label) {
    const ls = opts.labelSize ?? 5;
    text(doc, label, cm(xCm) + PAD, yy, { size: ls, width: innerW, lineBreak: false });
    yy += ls + 1.5;
  }
  if (value != null) {
    const vs = opts.valueSize ?? 7;
    const lines = opts.valueLines ?? 1;
    text(doc, opts.money ? formatMoney(value) : value, cm(xCm) + PAD, yy, {
      size: vs,
      bold: opts.valueBold,
      width: innerW,
      align: opts.money ? 'right' : (opts.valueAlign ?? 'left'),
      lineBreak: lines > 1,
      height: lines > 1 ? lines * (vs + 1) : undefined,
      ellipsis: true,
    });
  }
}

/** A centered, bordered table-header cell (`Código Produto`, `NCM/SH`, …). */
export function headerCell(
  doc: Doc,
  xCm: number,
  yCm: number,
  wCm: number,
  hCm: number,
  value: string,
): void {
  strokeBox(doc, cm(xCm), cm(yCm), cm(wCm), cm(hCm));
  text(doc, value, cm(xCm) + 1, cm(yCm) + 1.5, {
    size: 5,
    width: cm(wCm) - 2,
    align: 'center',
    lineBreak: true,
    height: cm(hCm) - 2,
  });
}

/** A bordered table cell with raw / money content (one item row × one column). */
export function cell(
  doc: Doc,
  xCm: number,
  yCm: number,
  wCm: number,
  hCm: number,
  value: string,
  opts: { money?: boolean; align?: 'left' | 'center' | 'right'; lines?: number } = {},
): void {
  strokeBox(doc, cm(xCm), cm(yCm), cm(wCm), cm(hCm));
  const lines = opts.lines ?? 1;
  text(doc, opts.money ? formatMoney(value) : value, cm(xCm) + 1.5, cm(yCm) + 1.5, {
    size: 5,
    width: cm(wCm) - 3,
    align: opts.money ? 'right' : (opts.align ?? 'left'),
    lineBreak: lines > 1,
    height: lines > 1 ? cm(hCm) - 2 : undefined,
    ellipsis: true,
  });
}

/** A small section title above a block (`CÁLCULO DO IMPOSTO`), no border. */
export function sectionTitle(doc: Doc, xCm: number, yCm: number, value: string): void {
  text(doc, value, cm(xCm) + PAD, cm(yCm) + 1, { size: 6, width: cm(A4_W_CM), lineBreak: false });
}
