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

/** Clip an (already-cased) string to `maxWidth` points, appending `…`. */
export function clipToWidth(
  doc: Doc,
  str: string,
  maxWidth: number,
  font: string,
  size: number,
): string {
  doc.font(font).fontSize(size);
  if (doc.widthOfString(str) <= maxWidth) return str;
  let s = str;
  while (s.length > 1 && doc.widthOfString(`${s}…`) > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

/**
 * A bold label on the left and its value right-aligned in the space that
 * **remains after the label**, on one line within `[x, x+w]`. The value is
 * clipped (with `…`) to that remaining width so a long razão social can never
 * overlap the label. Mirrors the `Row(label … Expanded … value)` pattern
 * repeated across the legacy boxes.
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
  const labelUpper = label.toUpperCase();
  doc.font(FONT_BOLD).fontSize(size);
  const labelW = doc.widthOfString(labelUpper);
  const gap = 6;
  const valX = x + labelW + gap;
  const valW = Math.max(10, x + w - valX);
  const valClipped = clipToWidth(doc, value.toUpperCase(), valW, FONT, size);
  text(doc, label, x, y, { size, bold: true, lineBreak: false });
  text(doc, valClipped, valX, y, {
    size,
    width: valW,
    align: 'right',
    upper: false,
    lineBreak: false,
  });
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
 * Draw text rotated 90° counter-clockwise (reading bottom-to-top) inside the
 * box `[x, y, w, h]` (points) — the landscape DANFE's canhoto labels and the
 * vertical group titles (`PROD./SERV.`, `DESTINATÁRIO`, …).
 *
 * The rotation origin is the box's bottom-left corner; after `rotate(-90)` the
 * text's writing direction (+x) points up the box height (the run length is `h`)
 * and line-wrapping (+y) stacks lines across the box width `w`.
 *
 * The text **auto-fits**: the font shrinks from `size` to a 4 pt floor until the
 * word-wrapped label fits the box thickness, so it is never clipped with an
 * ellipsis. The `height` bound keeps pdfkit's line-wrapper from auto-adding a
 * page to "continue" rotated text that sits near the page bottom in user space.
 *
 * `anchor` controls where the label sits **after the rotation** (which is why a
 * naïve "align right" lands in the wrong corner): `'center'` centres it in the
 * box (group titles, the NF-e box); `'bottomLeft'` pins it to the box's
 * bottom-left corner so it reads up from there — the natural left-edge canhoto.
 */
export function textRotated(
  doc: Doc,
  str: string,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: {
    size?: number;
    bold?: boolean;
    /** Post-rotation anchor. Default `'center'`. */
    anchor?: 'center' | 'bottomLeft';
    upper?: boolean;
  } = {},
): void {
  const { size = 6, bold = false, anchor = 'center', upper = true } = opts;
  const pad = 2;
  const runLen = h - 2 * pad; // text run-length (the box's long axis)
  const crossAvail = w - 2 * pad; // wrap room across the box thickness
  const s = upper ? str.toUpperCase() : str;
  const font = bold ? FONT_BOLD : FONT;

  // Auto-fit: largest size (down to a 4 pt floor) whose wrapped height fits the
  // thickness, so the label is shown in full instead of being ellipsized.
  doc.font(font);
  let fontSize = size;
  for (; fontSize > 4; fontSize -= 0.5) {
    doc.fontSize(fontSize);
    if (doc.heightOfString(s, { width: runLen }) <= crossAvail) break;
  }
  doc.fontSize(fontSize);
  const blockH = Math.min(doc.heightOfString(s, { width: runLen }), crossAvail);

  // `bottomLeft`: line block hugs the box's left edge and the run starts at the
  // bottom (align left). `center`: block centred across the thickness, run
  // centred. The text anchor's `y` offset selects the cross-axis position; after
  // the −90° rotation it maps to the box's horizontal extent.
  const crossOffset = anchor === 'bottomLeft' ? pad : (w - blockH) / 2;
  const align = anchor === 'bottomLeft' ? 'left' : 'center';

  doc.save();
  doc.rotate(-90, { origin: [x, y + h] });
  doc
    .font(font)
    .fontSize(fontSize)
    .fillColor('#000000')
    .text(s, x + pad, y + h + crossOffset, {
      width: runLen,
      height: crossAvail,
      align,
      lineBreak: true,
    });
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
