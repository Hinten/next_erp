/**
 * ZPL2 renderer for the generic (10×15cm) shipping label — the second walker
 * over `buildEtiquetaGenericaLayout`'s ops, so the Zebra label and the PDF are
 * the SAME label rather than two interpretations of one.
 *
 * ⚠️ **Net-new, not a port.** The legacy Flutter app has a
 * `zpl2_out/generica.dart`, but all 90 of its lines are commented out and its
 * body is a verbatim copy-paste of the *product price-tag* generator (it reads
 * `valor` / `localizacao` / `dataImpressao` / `codigo`, none of which the class
 * declares — it would not compile). The legacy dispatcher's ZPL2 branch showed
 * "ainda não implementado" and printed the PDF instead, and ZPL2 was the
 * DEFAULT the operator clicked (`pedidoTableView.dart:2307`). So there is no
 * legacy layout to match here; the layout spec is the design, and this module
 * only has to express it in ZPL.
 *
 * The idiom follows `packages/integrations/nfe/src/danfe/zpl2.ts`, the repo's
 * other ZPL renderer: `^CI28` for UTF-8 so Portuguese accents survive, layout
 * authored in millimetres and scaled once by `dpi/25.4`, native `^A0N` text,
 * native `^BCN` Code 128 (no rasterised image), `^GB` for the border and rules.
 *
 * Preview any output at https://labelary.com before a physical run.
 */
import { encodeCode128C } from './barcode';
import { buildEtiquetaGenericaLayout, LABEL_H_MM, LABEL_W_MM } from './layout';
import type { EtiquetaGenericaModel } from './model';

export interface EtiquetaZplOptions {
  /** Printhead density in dots-per-inch. Default 203; 300 also supported. */
  readonly dpi?: number;
}

/**
 * Strip the two ZPL control prefixes from field data, so a stray `^` or `~` in
 * a razão social or a logradouro cannot terminate the field or inject a
 * command.
 *
 * Unlike the DANFE renderer's sanitizer this does **not** uppercase: the
 * generic label prints values verbatim (legacy did too), and the PDF and the
 * ZPL have to read the same.
 */
function sanitize(text: string): string {
  return text.replace(/[\^~]/g, ' ');
}

export function renderEtiquetaGenericaZpl(
  model: EtiquetaGenericaModel,
  opts: EtiquetaZplOptions = {},
): string {
  const dpi = opts.dpi ?? 203;
  const dotsPerMm = dpi / 25.4;
  const mm = (v: number): number => Math.round(v * dotsPerMm);

  const out: string[] = ['^XA', '^CI28', `^PW${mm(LABEL_W_MM)}`, `^LL${mm(LABEL_H_MM)}`, '^LH0,0'];

  for (const op of buildEtiquetaGenericaLayout(model).ops) {
    switch (op.kind) {
      case 'rect':
        out.push(`^FO${mm(op.x)},${mm(op.y)}^GB${mm(op.w)},${mm(op.h)},${mm(op.rule)}^FS`);
        break;
      case 'rule':
        // A horizontal rule is a box one rule tall.
        out.push(`^FO${mm(op.x)},${mm(op.y)}^GB${mm(op.w)},${mm(op.rule)},${mm(op.rule)}^FS`);
        break;
      case 'text': {
        // Every line goes through ^FB — including the left-aligned ones, which
        // do not strictly need it — so each anchors to its ^FO identically and
        // the column stays true. The layout has already wrapped the text, so
        // one line per block; ^FB also clips anything unexpected to the label.
        //
        // ⚠️ **The one thing to check on a first physical run.** ^FB and a bare
        // ^FD are documented to anchor differently (block top vs character-cell
        // top), which can put every ^FB line one line-height lower than the PDF
        // draws it. Applying it uniformly makes any such offset uniform rather
        // than mixed, and the maximal label leaves ~8mm of slack, so nothing
        // clips either way — but if Labelary shows the whole column sitting
        // low, subtract `zplTextHeight(...)` from the y here rather than
        // re-tuning the layout spec, which the PDF shares.
        const justify = op.align === 'center' ? 'C' : 'L';
        out.push(
          `^FO${mm(op.x)},${mm(op.y)}^A0N,${zplTextHeight(op.sizePt, dotsPerMm)}` +
            `^FB${mm(op.w)},1,0,${justify},0^FD${sanitize(op.text)}^FS`,
        );
        break;
      }
      case 'barcode': {
        const symbol = encodeCode128C(op.data);
        // Same rule as the PDF: an unencodable payload drops the barcode rather
        // than printing a wrong one — the human-readable chave still carries it.
        if (!symbol) break;
        // The module width has to be a whole number of dots, so the printed
        // symbol is narrower than the space reserved for it. Centre it in that
        // space rather than letting it hang off the left inset.
        const moduleDots = Math.max(2, Math.floor(mm(op.w) / symbol.modules));
        const barcodeDots = moduleDots * symbol.modules;
        const x = mm(op.x) + Math.round((mm(op.w) - barcodeDots) / 2);
        // `>;` forces subset C, matching what `encodeCode128C` counted: the
        // 44-digit chave packs two digits per symbol instead of one.
        out.push(`^FO${x},${mm(op.y)}^BY${moduleDots}^BCN,${mm(op.h)},N,N,N^FD>;${op.data}^FS`);
        break;
      }
    }
  }

  out.push('^XZ');
  return out.join('\n');
}

/**
 * A point size as an `^A0N` character height in dots. Font 0's cell is about
 * 0.92em, the same ratio the layout's `lineHeightMm` uses, so text lands at the
 * size the PDF draws it.
 */
function zplTextHeight(sizePt: number, dotsPerMm: number): number {
  return Math.round(((sizePt * 25.4) / 72) * 0.92 * dotsPerMm);
}
