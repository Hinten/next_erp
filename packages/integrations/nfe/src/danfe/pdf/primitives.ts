/**
 * pdfkit drawing primitives shared by the DANFE PDF renderers.
 *
 * The legacy Flutter layout (`danfe_nfe`) is 100 % absolute-positioned on a
 * centimetre grid; pdfkit's imperative `rect`/`text`/`image` reproduce it 1:1
 * with exact point control. These helpers port `positionedBox` /
 * `getTextBloco` / `textContent` / `moneyContent` and add the watermark/barcode
 * helpers the simplificado (PR1) and retrato/paisagem (PR2) all reuse.
 *
 * All coordinates are PDF **points** (72 dpi). Use `cmToPt` from `../format`
 * to author in centimetres. Fonts are the Standard-14 Times family (WinAnsi),
 * which covers every Portuguese accent + `º ª §` with no embedding.
 */
import PDFDocument from 'pdfkit';

export type Doc = PDFKit.PDFDocument;

export const FONT = 'Times-Roman';
export const FONT_BOLD = 'Times-Bold';

export interface PdfHandle {
  readonly doc: Doc;
  /** Resolves with the full PDF bytes after `doc.end()`. */
  readonly done: Promise<Buffer>;
}

/**
 * Create a pdfkit document that buffers to memory. `size` is `[width, height]`
 * in points. The returned `done` promise resolves once `doc.end()` flushes.
 */
export function createPdf(size: [number, number]): PdfHandle {
  const doc = new PDFDocument({ size, margin: 0 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
}

/** Stroke a 0.75pt rectangle (the DANFE box border). */
export function strokeBox(doc: Doc, x: number, y: number, w: number, h: number): void {
  doc.lineWidth(0.75).rect(x, y, w, h).stroke('#000000');
}

export interface TextOpts {
  readonly size?: number;
  readonly bold?: boolean;
  readonly width?: number;
  readonly align?: 'left' | 'center' | 'right';
  /** Uppercase the text (the legacy `textContent` always did). Default true. */
  readonly upper?: boolean;
  /** Allow wrapping to multiple lines. Default false (single clipped line). */
  readonly lineBreak?: boolean;
  /** Clip height (points) — wrapped text beyond this is truncated. */
  readonly height?: number;
  /** Append an ellipsis when the text is clipped. */
  readonly ellipsis?: boolean;
}

/** Draw text at an absolute point. Uppercases by default, like the legacy layout. */
export function text(doc: Doc, str: string, x: number, y: number, opts: TextOpts = {}): void {
  const {
    size = 7,
    bold = false,
    width,
    align = 'left',
    upper = true,
    lineBreak = false,
    height,
    ellipsis,
  } = opts;
  doc
    .font(bold ? FONT_BOLD : FONT)
    .fontSize(size)
    .fillColor('#000000')
    .text(upper ? str.toUpperCase() : str, x, y, { width, align, lineBreak, height, ellipsis });
}

/**
 * A bold label on the left and its value on the right, within `[x, x+w]` on one
 * line. Mirrors the `Row(label … Expanded … value)` pattern repeated across the
 * legacy boxes.
 */
export function labeledRow(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  size = 7,
): void {
  text(doc, label, x, y, { size, bold: true, lineBreak: false });
  text(doc, value, x, y, { size, width: w, align: 'right', lineBreak: false });
}

/**
 * Diagonal translucent watermark centered on the page (e.g. "SEM VALOR FISCAL"
 * in homologação, "CANCELADO" for a cancelada NF-e). Save/rotate/restore so the
 * surrounding absolute layout is unaffected.
 */
export function watermark(
  doc: Doc,
  str: string,
  pageW: number,
  pageH: number,
  color = '#ff0000',
): void {
  doc.save();
  doc.rotate(-45, { origin: [pageW / 2, pageH / 2] });
  doc.opacity(0.18);
  doc
    .font(FONT_BOLD)
    .fontSize(Math.min(pageW, pageH) * 0.16)
    .fillColor(color)
    .text(str.toUpperCase(), 0, pageH / 2 - Math.min(pageW, pageH) * 0.1, {
      width: pageW,
      align: 'center',
      lineBreak: false,
    });
  doc.opacity(1);
  doc.restore();
}

/**
 * Draw a barcode PNG fitted (aspect-preserving, centered) inside `[x, y, w, h]`.
 */
export function drawBarcode(
  doc: Doc,
  png: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  doc.image(png, x, y, { fit: [w, h], align: 'center', valign: 'center' });
}
