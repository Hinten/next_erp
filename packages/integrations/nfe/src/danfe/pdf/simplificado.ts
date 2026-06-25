/**
 * DANFE Simplificado — Etiqueta (10×15 cm) PDF renderer.
 *
 * Ports the legacy Flutter `gerenerateDanfeSimplificadoEtiqueta10x15` (sic —
 * the original Dart function name, misspelled at the source): a compact label
 * with the title, Code 128 of the chave + the grouped
 * chave text, the autorização protocolo, and bordered boxes for emitente, dados
 * gerais da NF-e, destinatário and dados adicionais. `tpAmb=2` stamps a
 * "SEM VALOR FISCAL" watermark; a cancelada NF-e stamps "CANCELADO".
 *
 * Rendered from the already-parsed `DanfeModel` (see `../model`) — never from
 * order data.
 *
 * **Fitting (issue #93).** The label is a fixed 10×15 cm and cannot paginate, so
 * the renderer works in three phases — build the sections as data, *fit* them to
 * the page, then draw. Each multi-line `wrap` row (the addresses, infCpl) first
 * reserves only the lines its text actually needs at the base font; if the stack
 * still overflows the frame (e.g. a B2B destinatário whose IE adds a row), the
 * tallest wrap blocks shed a line and their font auto-shrinks to a floor so the
 * text is shown rather than clipped. The ellipsis is the last resort.
 */
import {
  cmToPt,
  formatChaveAcesso,
  formatCep,
  formatCpfCnpj,
  formatDate,
  formatMoney,
  formatNNF,
  formatSerie,
  formatTimeSeconds,
} from '../format';
import type { DanfeModel, DanfeEndereco } from '../model';
import { code128Png } from '../barcode';
import { contingencyNote } from './a4-common';
import {
  FONT,
  type Doc,
  createPdf,
  drawBarcode,
  fitFontSize,
  labeledRow,
  strokeBox,
  text,
  watermark,
} from './primitives';

export interface RenderSimplificadoOptions {
  /** Stamp the "CANCELADO" overlay (the NF-e estado is cancelada). */
  readonly cancelada?: boolean;
}

const cm = cmToPt;

// Page + frame geometry (constants — independent of the NF-e content).
const W = cm(10);
const H = cm(15);
const M = cm(0.35);
const INNER_W = W - 2 * M;
const PAD_X = M + cm(0.2);
const CONTENT_W = INNER_W - cm(0.4);
/** The outer frame's bottom edge — content must stay above this. */
const FRAME_BOTTOM = H - M;

const LH = cm(0.42); // single-line height
const PAD = cm(0.16); // box inner vertical padding
const BARCODE_H = cm(1.25);
const BASE_SIZE = 7; // body font size
const FONT_FLOOR = 5.5; // smallest wrap-block font before the ellipsis backstop
const MAX_WRAP_LINES = 3;

// Header vertical walk: title → barcode → chave. The first section box starts at
// HEADER_BOTTOM; the fit math and the draw loop share these offsets so they
// cannot drift.
const TITLE_TOP = M + cm(0.2);
const TITLE_GAP = cm(0.5);
const BARCODE_GAP = cm(0.08);
const CHAVE_GAP = cm(0.45);
const HEADER_BOTTOM = TITLE_TOP + TITLE_GAP + BARCODE_H + BARCODE_GAP + CHAVE_GAP;

/** One row inside a bordered section. */
type Row =
  | { kind: 'kv'; label: string; value: string }
  | { kind: 'line'; text: string; bold?: boolean }
  | { kind: 'wrap'; text: string; lines: number };

interface Section {
  readonly title: string | null;
  readonly rows: Row[];
}

/**
 * One line of address: `logradouro, numero, complemento - bairro - municipio -
 * uf, CEP: …`. Each segment is dropped when empty so a missing field never
 * leaves a dangling `, ` / ` - ` separator (issue #93).
 */
function enderecoLinha(e: DanfeEndereco): string {
  const head = [e.logradouro, e.numero].filter(Boolean).join(', ');
  const withCompl = e.complemento ? `${head}, ${e.complemento}` : head;
  const mid = [withCompl, e.bairro, e.municipio, e.uf].filter(Boolean).join(' - ');
  return e.cep ? `${mid}, CEP: ${formatCep(e.cep)}` : mid;
}

/** Assemble the simplificado's bordered sections from the model (no drawing). */
function buildSections(model: DanfeModel): Section[] {
  const sections: Section[] = [];

  // Protocolo de autorização de uso.
  if (model.prot) {
    sections.push({
      title: null,
      rows: [
        { kind: 'line', text: 'Protocolo de autorização de uso', bold: true },
        {
          kind: 'line',
          text: `${model.prot.nProt ?? ''} ${formatDate(model.prot.dhRecbto)} ${formatTimeSeconds(model.prot.dhRecbto)}`.trim(),
        },
      ],
    });
  }

  // Emitente.
  const emitDoc = model.emit.cnpj ?? model.emit.cpf;
  const emitRows: Row[] = [
    { kind: 'kv', label: model.emit.cnpj ? 'Razão Social' : 'Nome', value: model.emit.nome },
  ];
  if (emitDoc) {
    emitRows.push({
      kind: 'kv',
      label: model.emit.cnpj ? 'CNPJ' : 'CPF',
      value: formatCpfCnpj(emitDoc),
    });
  }
  emitRows.push({ kind: 'kv', label: 'IE', value: model.emit.ie });
  emitRows.push({ kind: 'wrap', text: enderecoLinha(model.emit.endereco), lines: MAX_WRAP_LINES });
  sections.push({ title: 'Dados do emitente', rows: emitRows });

  // Dados gerais da NF-e.
  sections.push({
    title: 'Dados gerais da NF-e',
    rows: [
      { kind: 'kv', label: 'Tipo', value: model.ide.tpNF === '1' ? '1 - Saída' : '0 - Entrada' },
      { kind: 'kv', label: 'NF-e Nº', value: formatNNF(model.ide.nNF) },
      { kind: 'kv', label: 'Série', value: formatSerie(model.ide.serie) },
      { kind: 'kv', label: 'Data da emissão', value: formatDate(model.ide.dhEmi) },
      { kind: 'kv', label: 'Valor total', value: formatMoney(model.total.vNF) },
    ],
  });

  // Destinatário.
  const destDoc = model.dest.cnpj ?? model.dest.cpf ?? model.dest.idEstrangeiro;
  const destRows: Row[] = [{ kind: 'kv', label: 'Nome', value: model.dest.nome }];
  if (destDoc) {
    const label = model.dest.cnpj ? 'CNPJ' : model.dest.cpf ? 'CPF' : 'ID Estrangeiro';
    destRows.push({
      kind: 'kv',
      label,
      value: model.dest.idEstrangeiro ? destDoc : formatCpfCnpj(destDoc),
    });
  }
  if (model.dest.ie) destRows.push({ kind: 'kv', label: 'IE', value: model.dest.ie });
  if (model.dest.endereco) {
    destRows.push({
      kind: 'wrap',
      text: enderecoLinha(model.dest.endereco),
      lines: MAX_WRAP_LINES,
    });
  }
  sections.push({ title: 'Dados do destinatário/remetente', rows: destRows });

  // Dados adicionais — the contingency note (dhCont/xJust, mandatory on the
  // printout when tpEmis ≠ 1) leads, then infCpl + infAdFisco.
  const infCpl = [contingencyNote(model), model.infAdic.infCpl, model.infAdic.infAdFisco]
    .filter(Boolean)
    .join(' ');
  if (infCpl) {
    sections.push({
      title: 'Dados adicionais',
      rows: [{ kind: 'wrap', text: infCpl, lines: MAX_WRAP_LINES }],
    });
  }

  return sections;
}

/** A resolved wrap row: how many lines it reserves and at what font size. */
interface WrapFit {
  readonly lines: number;
  readonly fontSize: number;
}

export interface FitPlan {
  /** One entry per `wrap` row, in document order. */
  readonly wrapFits: WrapFit[];
  /** Absolute `y` of the last section box's bottom border after fitting. */
  readonly contentBottomPt: number;
  /** `true` when the fitted content stays above the frame bottom (one page). */
  readonly fits: boolean;
}

/**
 * Resolve every `wrap` row's line count + font size so the section stack fits the
 * one-page budget. Pure apart from the font metrics it reads off `doc`
 * (deterministic). Mirrors what `renderSimplificado` draws, so a test can assert
 * `fits` without rasterising the PDF.
 */
function planFit(doc: Doc, sections: Section[]): FitPlan {
  const wraps = sections
    .flatMap((s) => s.rows)
    .filter((r): r is Extract<Row, { kind: 'wrap' }> => r.kind === 'wrap')
    .map((r) => ({ text: r.text.toUpperCase(), cap: r.lines, lines: 1, fontSize: BASE_SIZE }));

  // Everything that does not move during fitting: header + per-section padding +
  // titles + the single-line (kv/line) rows.
  const fixedH = sections.reduce((acc, sec) => {
    const titleH = sec.title ? LH : 0;
    const singleRows = sec.rows.filter((r) => r.kind !== 'wrap').length;
    return acc + 2 * PAD + titleH + singleRows * LH;
  }, HEADER_BOTTOM);
  const heightOf = (): number => fixedH + wraps.reduce((acc, w) => acc + w.lines, 0) * LH;

  // Natural pass: reserve the lines each block actually needs at the base font
  // (capped), so short addresses don't reserve blank lines.
  doc.font(FONT).fontSize(BASE_SIZE);
  const oneLine = doc.heightOfString('X', { width: CONTENT_W });
  for (const w of wraps) {
    const needed = Math.round(doc.heightOfString(w.text, { width: CONTENT_W }) / oneLine);
    w.lines = Math.max(1, Math.min(w.cap, needed));
  }

  // Reduce under pressure: the tallest wrap block sheds a line (tie → longest
  // text) until the stack fits or every block is down to one line.
  while (heightOf() > FRAME_BOTTOM) {
    let tallest: (typeof wraps)[number] | undefined;
    for (const w of wraps) {
      if (w.lines <= 1) continue;
      if (
        !tallest ||
        w.lines > tallest.lines ||
        (w.lines === tallest.lines && w.text.length > tallest.text.length)
      ) {
        tallest = w;
      }
    }
    if (!tallest) break;
    tallest.lines -= 1;
  }

  // Per-block font fit: shrink to the floor so a reduced block still shows its
  // text before the ellipsis backstop clips it. Unchanged blocks stay at base.
  for (const w of wraps) {
    doc.font(FONT);
    w.fontSize = fitFontSize(doc, w.text, CONTENT_W, w.lines * LH, BASE_SIZE, FONT_FLOOR);
  }

  const contentBottomPt = heightOf();
  return {
    wrapFits: wraps.map((w) => ({ lines: w.lines, fontSize: w.fontSize })),
    contentBottomPt,
    fits: contentBottomPt <= FRAME_BOTTOM,
  };
}

/**
 * Compute the simplificado fit plan for a model without rendering — the testable
 * seam for the "stays on one page" invariant (issue #93). `renderSimplificado`
 * runs the same `planFit` against its own document.
 */
export function planSimplificadoFit(model: DanfeModel): FitPlan {
  const { doc } = createPdf([W, H]);
  const plan = planFit(doc, buildSections(model));
  doc.end();
  return plan;
}

export async function renderSimplificado(
  model: DanfeModel,
  opts: RenderSimplificadoOptions = {},
): Promise<Buffer> {
  const { doc, done } = createPdf([W, H]);

  // Watermark sits behind the content (faint, translucent).
  if (opts.cancelada) {
    watermark(doc, 'CANCELADO', W, H);
  } else if (model.homologacao) {
    watermark(doc, 'SEM VALOR FISCAL', W, H);
  }

  // Outer border.
  strokeBox(doc, M, M, INNER_W, H - 2 * M);

  // Header: title, Code 128 of the chave, then the grouped chave below it.
  let y = TITLE_TOP;
  text(doc, 'DANFE SIMPLIFICADO - ETIQUETA', PAD_X, y, {
    size: 7.5,
    bold: true,
    width: CONTENT_W,
    align: 'center',
  });
  y += TITLE_GAP;

  const png = await code128Png(model.chave);
  drawBarcode(doc, png, PAD_X, y, CONTENT_W, BARCODE_H);
  y += BARCODE_H + BARCODE_GAP;
  text(doc, formatChaveAcesso(model.chave), PAD_X, y, {
    size: 8,
    width: CONTENT_W,
    align: 'center',
  });
  y += CHAVE_GAP; // y === HEADER_BOTTOM

  const sections = buildSections(model);
  const { wrapFits } = planFit(doc, sections);

  // Draw each bordered section using the planned wrap line counts + font sizes.
  // Contiguous boxes: each box's bottom border is the next box's top border (a
  // single DANFE grid line, not doubled lines with a gap between).
  let wrapIdx = 0;
  for (const sec of sections) {
    const rows = sec.rows.map((r) => {
      if (r.kind !== 'wrap') return { r, lines: 1, fontSize: BASE_SIZE };
      const fit = wrapFits[wrapIdx] ?? { lines: r.lines, fontSize: BASE_SIZE };
      wrapIdx += 1;
      return { r, lines: fit.lines, fontSize: fit.fontSize };
    });
    const titleH = sec.title ? LH : 0;
    const boxH = PAD + titleH + rows.reduce((acc, it) => acc + it.lines * LH, 0) + PAD;
    strokeBox(doc, M, y, INNER_W, boxH);
    let yy = y + PAD;
    if (sec.title) {
      text(doc, sec.title, PAD_X, yy, {
        size: BASE_SIZE,
        bold: true,
        width: CONTENT_W,
        align: 'center',
      });
      yy += LH;
    }
    for (const { r, lines, fontSize } of rows) {
      if (r.kind === 'kv') {
        labeledRow(doc, PAD_X, yy, CONTENT_W, r.label, r.value);
      } else if (r.kind === 'line') {
        text(doc, r.text, PAD_X, yy, { size: BASE_SIZE, bold: r.bold, width: CONTENT_W });
      } else {
        text(doc, r.text, PAD_X, yy, {
          size: fontSize,
          width: CONTENT_W,
          lineBreak: true,
          height: lines * LH,
          ellipsis: true,
        });
      }
      yy += lines * LH;
    }
    y += boxH;
  }

  doc.end();
  return done;
}

export { enderecoLinha };
