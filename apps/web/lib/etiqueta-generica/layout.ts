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
 * How many Helvetica characters of `sizePt` fit in `widthMm`. Helvetica's
 * average advance is ~0.5em, so this is deliberately conservative — it drives
 * WRAPPING, never silent truncation, and a wrap one word early is invisible
 * where a line running past the border is not. Legacy simply overflowed.
 */
function maxChars(widthMm: number, sizePt: number): number {
  const charMm = (sizePt * 0.5 * 25.4) / 72;
  return Math.max(1, Math.floor(widthMm / charMm));
}

/**
 * Greedy word wrap to `limit` characters. A single word longer than the limit is
 * hard-split rather than allowed to overflow.
 */
export function wrapText(text: string, limit: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (candidate.length <= limit) {
      line = candidate;
      continue;
    }
    if (line !== '') out.push(line);
    let rest = word;
    while (rest.length > limit) {
      out.push(rest.slice(0, limit));
      rest = rest.slice(limit);
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
  /** Total content height; may exceed `heightMm` on a maximal label. */
  readonly contentHeightMm: number;
  readonly ops: readonly EtiquetaOp[];
}

/**
 * Build the label's draw ops from a resolved model. Pure: no Firestore, no DOM,
 * no font metrics beyond the constants above — so the design is unit-testable
 * and both renderers agree line for line.
 */
export function buildEtiquetaGenericaLayout(model: EtiquetaGenericaModel): EtiquetaGenericaLayout {
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
    for (const part of wrapText(text, maxChars(w, sizePt))) {
      ops.push({ kind: 'text', x, y, w, text: part, sizePt, bold, align });
      y += lineHeightMm(sizePt);
    }
  };

  const divider = (): void => {
    y += DIVIDER_AIR_MM;
    ops.push({ kind: 'rule', x: RULE_MM, y, w: LABEL_W_MM - 2 * RULE_MM, rule: RULE_MM });
    y += DIVIDER_AIR_MM;
  };

  const addressBlock = (a: EtiquetaGenericaAddress, title: string): void => {
    y += PAD_MM;
    line(title, SIZE_TITLE, true, 'center');
    y += TITLE_GAP_MM;
    const logradouro = `${a.logradouro ?? DASH}${a.numero ? `, ${a.numero}` : ''}`;
    line(`Logradouro: ${logradouro}`, SIZE_BODY, false, 'left');
    line(`Bairro: ${a.bairro ?? DASH}`, SIZE_BODY, false, 'left');
    if (a.complemento) line(`Complemento: ${a.complemento}`, SIZE_BODY, false, 'left');
    line(`Cidade: ${a.cidade ?? DASH}${a.uf ? ` - ${a.uf}` : ''}`, SIZE_BODY, false, 'left');
    if (a.cep) line(`CEP: ${formatCep(a.cep)}`, SIZE_BODY, false, 'left');
    y += PAD_MM;
  };

  /* -------------------------------- header ------------------------------- */

  y += PAD_MM;
  line(model.title, SIZE_TITLE, true, 'center');
  if (model.subTitle) line(model.subTitle, SIZE_BODY, true, 'center');
  if (model.nfeNumero != null) {
    line(`NFe nº: ${model.nfeNumero}`, SIZE_BODY, true, 'center');
    y += PAD_MM;
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
    y += PAD_MM;
    line('Cliente não informado', SIZE_BODY, false, 'left');
    y += PAD_MM;
  }

  divider();

  /* ------------------------------- endereço ------------------------------ */

  // Legacy order, exactly: a MISSING address says so even on a pickup; only a
  // PRESENT address on a `retiradaNaLoja` frete is suppressed outright (the
  // customer collects at the counter, so there is nothing to deliver to).
  if (!model.endereco) {
    y += PAD_MM;
    line('Endereço não informado', SIZE_BODY, false, 'left');
    y += PAD_MM;
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
  } else {
    y += PAD_MM;
    line('Recebido: _________________________________', SIZE_BODY, true, 'left');
    line('Data: ____/____/______', SIZE_BODY, true, 'left');
    y += PAD_MM;
  }

  return { widthMm: LABEL_W_MM, heightMm: LABEL_H_MM, contentHeightMm: y, ops };
}
