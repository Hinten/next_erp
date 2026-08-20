/**
 * The generic (10×15cm) shipping label's LAYOUT SPEC — a pure, renderer-neutral
 * list of draw operations in millimetres, ported from the Flutter
 * `EtiquetaFreteGenericaPDF._makeEtiqueta` widget tree
 * (`.old/packages/integracoes_frete/etiquetas_frete/lib/src/pdf_out/generica.dart`).
 *
 * ⚠️ This module is the DESIGN. `pdf.ts` and `zpl2.ts` are two walkers over the
 * same ops, which is what guarantees the PDF and the ZPL label are the *same*
 * label rather than two interpretations of one — the legacy app kept two
 * independent renderers and its ZPL one was never finished.
 *
 * Legacy geometry reproduced here (the first port had drifted on every one):
 *   - 100×150mm page, NO page margin, a 1pt black border flush to the trim
 *     (`PdfPageFormat(cmToPixel(10), cmToPixel(15))` + `Border.all(width: 1)`).
 *   - Helvetica: 12pt bold for the title and the address-block titles, 10pt for
 *     everything else. The first port's CSS sheet rendered body text at 2.65% of
 *     the label width where legacy sits at 3.53% — a quarter smaller.
 *   - 5mm (0.5cm) side inset on every block, and 5mm of vertical air around the
 *     address / signature blocks (legacy `EdgeInsets.all(cmToPixel(0.5))`).
 *   - Dividers span the full inner width, touching the border on both sides,
 *     with ~2.65mm of air above and below (legacy `pw.Divider()` = a 1pt rule
 *     centred in a 16pt box).
 *
 * Deliberate deviations from legacy, each a considered call rather than a slip:
 *   - a Code 128 of the NF-e chave (legacy printed only the human-readable
 *     "NFe nº" — #376 asks for the chave, and a shipping label nobody can scan
 *     is a worse label);
 *   - the recebedor block is inset 5mm like every other block (legacy rendered
 *     it with NO padding at all, flush against the border — a bug);
 *   - the two "não informado" fallbacks are 10pt like their neighbours (legacy
 *     left them at the inherited 12pt default);
 *   - CEP / CPF-CNPJ are masked and the UF prints as its sigla (legacy printed
 *     raw digits and the full state name; this repo has no UF→name table and
 *     `Campinas - SP` is the shipping norm);
 *   - a `Volumes:` line, which legacy did not have.
 */
import { formatCep, formatCpfCnpj, formatTelefone } from '@/lib/pedido-print/format';

import { textWidthMm } from './metrics';
import type { EtiquetaGenericaAddress, EtiquetaGenericaModel } from './model';

/** Label page, in millimetres. Matches the print agent's hard-coded `etq` format. */
export const LABEL_W_MM = 100;
export const LABEL_H_MM = 150;

const DASH = '—';

/** 1pt rule, in mm — the legacy border/divider thickness. */
const RULE_MM = 0.353;
/** Legacy `EdgeInsets.only(left: 0.5cm, right: 0.5cm)`. */
const SIDE_MM = 5;
/** Legacy `EdgeInsets.all(0.5cm)`, vertical half. */
const PAD_MM = 5;
/** Air above and below a `pw.Divider()` (16pt box, 1pt rule centred). */
const DIVIDER_AIR_MM = 2.65;
/** Legacy `SizedBox(height: cmToPixel(0.1))` under an address-block title. */
const TITLE_GAP_MM = 1;

const SIZE_TITLE = 12;
const SIZE_BODY = 10;
const SIZE_CHAVE = 7;
const SIZE_CAPTION = 8;

/** Blank vertical room above the signature rule — enough to actually sign in. */
const SIGNATURE_ROOM_MM = 11;

/** Code 128 strip height. Kept compact so a maximal reverse label still fits. */
const BARCODE_H_MM = 10;

const INNER_W_MM = LABEL_W_MM - 2 * SIDE_MM;

/**
 * Advance of one text line, in mm. Helvetica's ascent+descent is ~0.925em and
 * the legacy `pw.Text` used `height: 1` / `lineSpacing: 0`, so a line box is the
 * em box: `sizePt * 0.925`, converted pt→mm.
 */
export function lineHeightMm(sizePt: number): number {
  return (sizePt * 0.925 * 25.4) / 72;
}

/**
 * Leave 1% of the box unused. Absorbs the sub-0.03mm per-character rounding
 * between our width table and jsPDF's, which could otherwise accumulate on a
 * long line.
 */
const WRAP_SAFETY = 0.99;

/**
 * Greedy word wrap to a MEASURED width. A single word too wide to fit is
 * hard-split at the longest prefix that does, rather than allowed to overflow.
 *
 * ⚠️ This wraps on real Helvetica advances (`textWidthMm`), not a character
 * count. It used to estimate with a flat 0.5em average, which is the figure for
 * mixed-case prose: a 51-character line of uppercase — ordinary for a Brazilian
 * address — measures 118mm against the 90mm box, wrapped happily, and was then
 * clipped by the page. Wrapping a word early is invisible; a line past the
 * border is not.
 */
export function wrapText(
  text: string,
  maxWidthMm: number,
  sizePt: number,
  bold: boolean,
): string[] {
  const limit = maxWidthMm * WRAP_SAFETY;
  const fits = (s: string): boolean => textWidthMm(s, sizePt, bold) <= limit;

  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line !== '') out.push(line);
    let rest = word;
    while (!fits(rest) && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut -= 1;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line !== '') out.push(line);
  return out.length > 0 ? out : [''];
}

/** The 44-digit chave in eleven blocks of four, for human reading. */
export function groupChave(chave: string): string {
  return (chave.match(/.{1,4}/g) ?? []).join(' ');
}

/** One draw instruction. Coordinates are mm from the top-left of the label. */
export type EtiquetaOp =
  /** Stroked rectangle — the outer border. */
  | { readonly kind: 'rect'; x: number; y: number; w: number; h: number; rule: number }
  /** Horizontal rule — a divider. */
  | { readonly kind: 'rule'; x: number; y: number; w: number; rule: number }
  /** A single line of text. `y` is the TOP of the line box, never the baseline. */
  | {
      readonly kind: 'text';
      x: number;
      y: number;
      w: number;
      text: string;
      sizePt: number;
      bold: boolean;
      align: 'left' | 'center';
    }
  /** Code 128 strip. `data` is the raw payload (digits only, for subset C). */
  | { readonly kind: 'barcode'; x: number; y: number; w: number; h: number; data: string };

export interface EtiquetaGenericaLayout {
  readonly widthMm: number;
  readonly heightMm: number;
  /** Height the ops actually occupy, AFTER any shrink-to-fit. Never > `heightMm`. */
  readonly contentHeightMm: number;
  /**
   * Whitespace actually used, as a fraction of the designed rhythm. `1` when the
   * label fitted as drawn; lower when padding had to be given back. This is
   * spent BEFORE `scale`, because tighter blocks cost the reader nothing and
   * smaller type costs legibility.
   */
  readonly slack: number;
  /**
   * Shrink-to-fit factor applied to the vertical rhythm and the type, after the
   * whitespace was already tightened. `1` unless the label still overflowed.
   */
  readonly scale: number;
  readonly ops: readonly EtiquetaOp[];
}

/**
 * Floor on the shrink-to-fit factor. Below this the label stops being legible,
 * and at that point clipping the tail is arguably no worse — but a pure text
 * label would have to be ~270mm of content to get here, which no real pedido
 * produces. See {@link fitToPage}.
 */
const MIN_SCALE = 0.55;

/**
 * Squeeze an overflowing label onto the page.
 *
 * ⚠️ Without this, overflow is SILENT: `pdf.ts` walks every op unconditionally
 * and anything past `y = 150mm` is simply outside the MediaBox — no throw, no
 * warning, and a PDF that looks complete. What falls off is the tail, and on a
 * reverse label the tail is the `Entrega` block: the filial-sede address the
 * parcel is being returned to. A return label missing its destination is worse
 * than one set a point or two smaller.
 *
 * The squeeze is uniform — every `y`, every font size and the barcode height
 * scale by the same factor — so the design stays recognisable rather than
 * losing a block. `x`/`w` are untouched (horizontal fit is already handled by
 * the wrap), and because the wrap ran at full size, scaled-down lines are
 * strictly narrower than their box.
 */
function fitToPage(
  ops: readonly EtiquetaOp[],
  contentHeightMm: number,
): {
  ops: EtiquetaOp[];
  scale: number;
} {
  if (contentHeightMm <= LABEL_H_MM) return { ops: [...ops], scale: 1 };
  const scale = Math.max(MIN_SCALE, LABEL_H_MM / contentHeightMm);
  return {
    scale,
    ops: ops.map((op) => {
      switch (op.kind) {
        // The border IS the label edge — it never scales.
        case 'rect':
          return op;
        case 'rule':
          return { ...op, y: op.y * scale };
        case 'text':
          return { ...op, y: op.y * scale, sizePt: op.sizePt * scale };
        case 'barcode':
          return { ...op, y: op.y * scale, h: op.h * scale };
      }
    }),
  };
}

/**
 * Build the label's draw ops at a given whitespace `slack` (1 = the designed
 * rhythm). Pure: no Firestore, no DOM, no font metrics beyond the constants
 * above — so the design is unit-testable and both renderers agree line for line.
 *
 * `slack` only ever touches VERTICAL spacing, never the type or the wrap, so
 * re-building at a tighter slack cannot change where a line breaks.
 */
function buildOps(
  model: EtiquetaGenericaModel,
  slack: number,
): { ops: EtiquetaOp[]; heightMm: number } {
  const pad = PAD_MM * slack;
  const divAir = DIVIDER_AIR_MM * slack;
  const titleGap = TITLE_GAP_MM * slack;
  const signRoom = SIGNATURE_ROOM_MM * slack;

  const ops: EtiquetaOp[] = [];
  // Stroke centred on the path: inset by half a rule so the border sits inside
  // the trim on all four sides.
  const half = RULE_MM / 2;
  ops.push({
    kind: 'rect',
    x: half,
    y: half,
    w: LABEL_W_MM - RULE_MM,
    h: LABEL_H_MM - RULE_MM,
    rule: RULE_MM,
  });

  let y = RULE_MM;

  const line = (
    text: string,
    sizePt: number,
    bold: boolean,
    align: 'left' | 'center',
    x = SIDE_MM,
    w = INNER_W_MM,
  ): void => {
    for (const part of wrapText(text, w, sizePt, bold)) {
      ops.push({ kind: 'text', x, y, w, text: part, sizePt, bold, align });
      y += lineHeightMm(sizePt);
    }
  };

  const divider = (): void => {
    y += divAir;
    ops.push({ kind: 'rule', x: RULE_MM, y, w: LABEL_W_MM - 2 * RULE_MM, rule: RULE_MM });
    y += divAir;
  };

  /** `prefix` followed by as many underscores as still fit the line. */
  const fillRule = (prefix: string, sizePt: number): string => {
    const under = textWidthMm('_', sizePt, false);
    const room = INNER_W_MM * 0.99 - textWidthMm(prefix, sizePt, false);
    return prefix + '_'.repeat(Math.max(1, Math.floor(room / under)));
  };

  /**
   * Proof-of-delivery block. **Not** from legacy, which had only
   * `Recebido: ____` + a date — asked for on 2026-08-20 because customers do
   * claim a parcel never arrived, and a signature alone does not identify who
   * signed. Name + document + date + signature is what makes the stub
   * evidence, so all four get a real line, and the signature gets vertical room
   * to actually sign in rather than a caption squeezed against the line above.
   */
  const receiptBlock = (): void => {
    y += pad;
    line('Comprovante de recebimento', SIZE_TITLE, true, 'center');
    y += titleGap;
    line(fillRule('Nome legível: ', SIZE_BODY), SIZE_BODY, false, 'left');
    line(fillRule('CPF / RG: ', SIZE_BODY), SIZE_BODY, false, 'left');
    line('Data: ____/____/______', SIZE_BODY, false, 'left');
    y += signRoom;
    line(fillRule('', SIZE_BODY), SIZE_BODY, false, 'left');
    line('Assinatura do recebedor', SIZE_CAPTION, false, 'center');
    y += pad;
  };

  const addressBlock = (a: EtiquetaGenericaAddress, title: string): void => {
    y += pad;
    line(title, SIZE_TITLE, true, 'center');
    y += titleGap;
    const logradouro = `${a.logradouro ?? DASH}${a.numero ? `, ${a.numero}` : ''}`;
    line(`Logradouro: ${logradouro}`, SIZE_BODY, false, 'left');
    line(`Bairro: ${a.bairro ?? DASH}`, SIZE_BODY, false, 'left');
    if (a.complemento) line(`Complemento: ${a.complemento}`, SIZE_BODY, false, 'left');
    line(`Cidade: ${a.cidade ?? DASH}${a.uf ? ` - ${a.uf}` : ''}`, SIZE_BODY, false, 'left');
    if (a.cep) line(`CEP: ${formatCep(a.cep)}`, SIZE_BODY, false, 'left');
    y += pad;
  };

  /* -------------------------------- header ------------------------------- */

  y += pad;
  line(model.title, SIZE_TITLE, true, 'center');
  if (model.subTitle) line(model.subTitle, SIZE_BODY, true, 'center');
  if (model.nfeNumero != null) {
    line(`NFe nº: ${model.nfeNumero}`, SIZE_BODY, true, 'center');
    y += pad;
  }
  if (model.ehReverso) line('Reverso', SIZE_BODY, true, 'left');
  if (model.nfeChave) {
    ops.push({
      kind: 'barcode',
      x: SIDE_MM,
      y,
      w: INNER_W_MM,
      h: BARCODE_H_MM,
      data: model.nfeChave,
    });
    y += BARCODE_H_MM;
    line(groupChave(model.nfeChave), SIZE_CHAVE, false, 'center');
  }

  divider();

  /* ------------------------------- cliente ------------------------------- */

  if (model.cliente) {
    line(`Cliente: ${model.cliente.nome ?? DASH}`, SIZE_BODY, false, 'left');
    if (model.cliente.telefone) {
      line(`Fone: ${formatTelefone(model.cliente.telefone)}`, SIZE_BODY, false, 'left');
    }
  } else {
    y += pad;
    line('Cliente não informado', SIZE_BODY, false, 'left');
    y += pad;
  }

  divider();

  /* ------------------------------- endereço ------------------------------ */

  // Legacy order, exactly: a MISSING address says so even on a pickup; only a
  // PRESENT address on a `retiradaNaLoja` frete is suppressed outright (the
  // customer collects at the counter, so there is nothing to deliver to).
  if (!model.endereco) {
    y += pad;
    line('Endereço não informado', SIZE_BODY, false, 'left');
    y += pad;
  } else if (!model.ocultarEndereco) {
    addressBlock(model.endereco, model.ehReverso ? 'Retirada' : 'Entrega');
  }

  // Unconditional in legacy — it fires even when the block above drew nothing.
  divider();

  /* ------------------------------- recebedor ----------------------------- */

  if (model.recebedor) {
    line(`Recebedor: ${model.recebedor.nome ?? DASH}`, SIZE_BODY, true, 'left');
    if (model.recebedor.cpfCnpj) {
      line(`CPF/CNPJ: ${formatCpfCnpj(model.recebedor.cpfCnpj)}`, SIZE_BODY, false, 'left');
    }
    if (model.recebedor.telefone) {
      line(`Fone: ${formatTelefone(model.recebedor.telefone)}`, SIZE_BODY, false, 'left');
    }
    divider();
  }

  if (model.volumesResumo) {
    line(`Volumes: ${model.volumesResumo}`, SIZE_BODY, true, 'left');
    divider();
  }

  /* --------------------------------- foot -------------------------------- */

  if (model.ehReverso && model.enderecoReverso) {
    addressBlock(model.enderecoReverso, 'Entrega');
    divider();
  }

  receiptBlock();

  return { ops, heightMm: y };
}

/**
 * Whitespace steps tried, in order, before the type is allowed to shrink.
 * Squeezing the 5mm block padding and the divider air costs the reader nothing;
 * shrinking 10pt type on a proof-of-delivery stub costs legibility, so it is
 * the last resort rather than the first.
 */
const SLACK_STEPS = [0.75, 0.55, 0.4] as const;

/**
 * Build the label. Fits it to the page in two stages — give back whitespace
 * first, only then scale the type (see {@link fitToPage}).
 */
export function buildEtiquetaGenericaLayout(model: EtiquetaGenericaModel): EtiquetaGenericaLayout {
  let slack = 1;
  let built = buildOps(model, slack);
  for (const step of SLACK_STEPS) {
    if (built.heightMm <= LABEL_H_MM) break;
    slack = step;
    built = buildOps(model, slack);
  }

  const fitted = fitToPage(built.ops, built.heightMm);
  return {
    widthMm: LABEL_W_MM,
    heightMm: LABEL_H_MM,
    contentHeightMm: built.heightMm * fitted.scale,
    slack,
    scale: fitted.scale,
    ops: fitted.ops,
  };
}
