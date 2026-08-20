/**
 * Render the generic (10×15cm) shipping label to a PDF `Blob`.
 *
 * A **vector** renderer: it walks the ops from `buildEtiquetaGenericaLayout`
 * and draws Helvetica text, rules and barcode bars straight into jsPDF. It
 * replaces the first port's `html-to-image` → JPEG → full-bleed `addImage`
 * pipeline, which rasterised the whole label at ~192 dpi and then stretched it
 * onto the page — visibly soft on the 203-dpi thermal head this label is
 * printed on, and impossible to assert anything about in a test. The legacy
 * Flutter label was vector Helvetica too, so this is also the closer port.
 *
 * jsPDF is lazy-`import()`ed so it stays in its own chunk, never the main
 * bundle. `unit: 'mm'` matches the layout spec 1:1, and the page format is the
 * 100×150mm the print agent hard-codes for its `etq` printer.
 */
import { encodeCode128C } from './barcode';
import { buildEtiquetaGenericaLayout, LABEL_H_MM, LABEL_W_MM } from './layout';
import type { EtiquetaGenericaModel } from './model';

/** 10×15cm label page (portrait), in millimetres. */
const LABEL_FORMAT_MM: [number, number] = [LABEL_W_MM, LABEL_H_MM];

export async function renderEtiquetaGenericaPdf(model: EtiquetaGenericaModel): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: LABEL_FORMAT_MM });

  doc.setDrawColor(0, 0, 0);
  doc.setFillColor(0, 0, 0);
  doc.setTextColor(0, 0, 0);

  for (const op of buildEtiquetaGenericaLayout(model).ops) {
    switch (op.kind) {
      case 'rect':
        doc.setLineWidth(op.rule);
        doc.rect(op.x, op.y, op.w, op.h);
        break;
      case 'rule':
        doc.setLineWidth(op.rule);
        doc.line(op.x, op.y, op.x + op.w, op.y);
        break;
      case 'text':
        doc.setFont('helvetica', op.bold ? 'bold' : 'normal');
        doc.setFontSize(op.sizePt);
        // `baseline: 'top'` so the op's `y` means the same thing here as it does
        // in the ZPL renderer, where `^FO` anchors the top of the cell.
        doc.text(op.text, op.align === 'center' ? op.x + op.w / 2 : op.x, op.y, {
          align: op.align,
          baseline: 'top',
        });
        break;
      case 'barcode': {
        const symbol = encodeCode128C(op.data);
        // An unencodable payload drops the barcode rather than printing a wrong
        // one — the human-readable chave below it still carries the value.
        if (!symbol) break;
        const moduleMm = op.w / symbol.modules;
        for (const bar of symbol.bars) {
          doc.rect(op.x + bar.start * moduleMm, op.y, bar.width * moduleMm, op.h, 'F');
        }
        break;
      }
    }
  }

  return doc.output('blob');
}
