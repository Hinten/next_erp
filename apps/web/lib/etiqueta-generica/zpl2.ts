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
import { encodeCode128 } from './barcode';
import { EtiquetaGenericaFormatError } from './errors';
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

/**
 * ⚠️ The ZPL label is the ONE surface that still cannot carry an alphanumeric
 * chave, and the asymmetry with `./pdf` is deliberate rather than an oversight.
 *
 * This renderer does not draw the bars: it emits `^BCN` with the `>;` subset-C
 * prefix and lets the PRINTER encode. Subset C is numeric-only, so an alfa
 * chave needs a mid-string switch to subset B and back — and the switch-back
 * invocation code could not be verified against Zebra's `^BC` reference, so
 * emitting a guess would print a wrong barcode silently. Encoding the whole
 * chave in subset B instead is not a fix either: it doubles the symbol count
 * while `^BY` stays whole-dot, so the symbol overruns the 90 mm box and the
 * printer clips the checksum and stop pattern past `^PW`.
 *
 * ⚠️ So do NOT delete this guard just because `encodeCode128` now handles alfa.
 * It does — but only for `./pdf`, which draws its own bars from the module
 * geometry and needs no printer cooperation. Here the encoder is consulted for
 * WIDTH ONLY; the bytes that reach the Zebra are `op.data` verbatim. Dropping
 * the guard would hand the printer a payload its `>;` prefix cannot represent.
 *
 * Tracked for real mixed-subset ZPL by #1624, which is blocked on hardware
 * validation, not on this code.
 */
const ALL_DIGITS = /^\d+$/;

export function renderEtiquetaGenericaZpl(
  model: EtiquetaGenericaModel,
  opts: EtiquetaZplOptions = {},
): string {
  if (model.nfeChave != null && !ALL_DIGITS.test(model.nfeChave)) {
    throw new EtiquetaGenericaFormatError(
      `A etiqueta ZPL não suporta uma chave alfanumérica (${model.nfeChave}): o ` +
        'código de barras usa Code 128 subset C, que só aceita dígitos. Imprima ' +
        'a etiqueta em PDF, que traz o mesmo layout com o código de barras completo.',
    );
  }

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
        const height = zplTextHeight(op.sizePt, dotsPerMm);
        const field = (dx: number): string =>
          `^FO${mm(op.x) + dx},${mm(op.y)}^A0N,${height}` +
          `^FB${mm(op.w)},1,0,${justify},0^FD${sanitize(op.text)}^FS`;

        out.push(field(0));
        // `op.bold` is the one field of the text op that ZPL cannot express
        // directly: the resident scalable font `0` has no weight axis, so
        // `^A0N` draws the title and the body at the same weight and the PDF's
        // emphasis hierarchy would be lost. Re-emit the field one dot to the
        // right — the conventional ZPL double-strike — which thickens the stems
        // enough to read as bold at 203dpi without needing a downloaded font.
        if (op.bold) out.push(field(1));
        break;
      }
      case 'barcode': {
        // Width math only — the bars come from the printer's own `^BCN`. The
        // guard at the top of this function has already refused anything subset
        // C cannot represent, so a `null` here is a payload bug, not an alfa
        // chave.
        const symbol = encodeCode128(op.data);
        if (!symbol) break;
        // The module width has to be a whole number of dots, so the printed
        // symbol is narrower than the space reserved for it. Centre it in that
        // space rather than letting it hang off the left inset.
        const moduleDots = Math.max(2, Math.floor(mm(op.w) / symbol.modules));
        const barcodeDots = moduleDots * symbol.modules;
        const x = mm(op.x) + Math.round((mm(op.w) - barcodeDots) / 2);
        // `>;` forces subset C, matching what `encodeCode128` counted for an
        // all-digit payload: two digits per symbol instead of one.
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
