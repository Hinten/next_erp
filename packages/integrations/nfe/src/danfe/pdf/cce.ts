/**
 * Carta de Correção Eletrônica (CC-e) PDF renderer — a single **A4 landscape**
 * (29.7 × 21 cm) page printed from a registrada CC-e (`tpEvento=110110`).
 *
 * Ports the legacy Flutter `gerenerateCartaDeCorrecaoPaisagem`
 * (`.old/packages/danfe_nfe/lib/src/cartaDeCorrecao.dart`): a centred title,
 * three rows of identity boxes (CNPJ | chave, série | número | nº sequência,
 * data do registro | protocolo), the full `TEXTO DA CORREÇÃO`, and the fixed
 * `CONDIÇÕES DE USO` legal text. The NF-e fields come from its procNFe
 * (`DanfeModel`); the event-specific fields (`xCorrecao`, `nProt`, `nSeqEvento`,
 * `dhRegEvento`) come from the persisted `cartacorrecao` record. `tpAmb=2` /
 * a cancelada NF-e stamp the "SEM VALOR FISCAL" / "CANCELADO" watermark.
 *
 * The content is bounded (xCorrecao ≤ 1000 chars, xCondUso ~600), so unlike the
 * DANFE renderers this never paginates.
 */
import {
  formatChaveAcesso,
  formatCpfCnpj,
  formatDate,
  formatNNF,
  formatSerie,
  formatTimeSeconds,
} from '../format';
import type { DanfeModel } from '../model';
import { XCONDUSO_CCE } from '../../eventos';
import { createPdf, strokeBox, text, type Doc } from './primitives';
import { A4_H_CM, A4_W_CM, cm, field } from './layout';
import { pageWatermark, type RenderA4Options } from './a4-common';

const PAGE_W = A4_H_CM; // 29.7 cm — landscape width
const PAGE_H = A4_W_CM; // 21 cm — landscape height
const MARGIN = 0.5; // cm
const LEFT = MARGIN; // 0.5
const CONTENT_W = PAGE_W - 2 * MARGIN; // 28.7 cm
const PAD = 2; // inner padding (points), matching layout.ts:field

/** Event-specific fields for a CC-e, read from the persisted `cartacorrecao` record. */
export interface CceData {
  /** Correction text sent as `<xCorrecao>` (already sanitized to the wire form). */
  readonly xCorrecao: string;
  /** Event protocolo returned on cStat=135. */
  readonly nProt: string | null;
  /** Event sequence number (1, 2, 3, …). */
  readonly nSeqEvento: number;
  /** ISO `dhRegEvento` from the retEvento, or null when unavailable. */
  readonly dhRegEvento: string | null;
}

/**
 * A bordered box with a small label on top and a wrapped, full-height value
 * below — like `field`, but the value wraps over the whole box (no ellipsis) so
 * the correction / condições texts are shown in full.
 */
function block(
  doc: Doc,
  xCm: number,
  yCm: number,
  wCm: number,
  hCm: number,
  label: string,
  value: string,
  valueSize: number,
): void {
  strokeBox(doc, cm(xCm), cm(yCm), cm(wCm), cm(hCm));
  const labelSize = 6;
  text(doc, label, cm(xCm) + PAD, cm(yCm) + PAD, {
    size: labelSize,
    width: cm(wCm) - 2 * PAD,
    lineBreak: false,
  });
  const valueTop = cm(yCm) + PAD + labelSize + 3;
  text(doc, value, cm(xCm) + PAD, valueTop, {
    size: valueSize,
    width: cm(wCm) - 2 * PAD,
    height: cm(yCm + hCm) - valueTop - PAD,
    upper: false,
    lineBreak: true,
  });
}

/** Render a CC-e as a one-page A4 landscape PDF. */
export async function renderCce(
  model: DanfeModel,
  cce: CceData,
  opts: RenderA4Options = {},
): Promise<Buffer> {
  const cancelada = opts.cancelada ?? false;
  const { doc, done } = createPdf([cm(PAGE_W), cm(PAGE_H)]);
  pageWatermark(doc, model, cancelada, cm(PAGE_W), cm(PAGE_H));

  // Title.
  text(doc, 'Carta de Correção Eletrônica', cm(LEFT), cm(0.55), {
    size: 16,
    bold: true,
    width: cm(CONTENT_W),
    align: 'center',
  });

  // Identity grid (cm). Three rows of bordered fields.
  const ROW_H = 1.1;
  const halfW = CONTENT_W / 2; // 14.35
  const thirdW = CONTENT_W / 3; // ~9.57
  const docEmit = model.emit.cnpj ?? model.emit.cpf ?? '';

  const y1 = 1.7;
  field(doc, LEFT, y1, halfW, ROW_H, 'CNPJ / CPF DO EMITENTE', formatCpfCnpj(docEmit), {
    valueSize: 9,
  });
  field(doc, LEFT + halfW, y1, halfW, ROW_H, 'CHAVE DE ACESSO', formatChaveAcesso(model.chave), {
    valueSize: 9,
  });

  const y2 = y1 + ROW_H; // 2.8
  field(doc, LEFT, y2, thirdW, ROW_H, 'SÉRIE', formatSerie(model.ide.serie), { valueSize: 9 });
  field(doc, LEFT + thirdW, y2, thirdW, ROW_H, 'NÚMERO', formatNNF(model.ide.nNF), {
    valueSize: 9,
  });
  field(
    doc,
    LEFT + 2 * thirdW,
    y2,
    CONTENT_W - 2 * thirdW,
    ROW_H,
    'Nº DE SEQUÊNCIA DO EVENTO',
    String(cce.nSeqEvento),
    { valueSize: 9 },
  );

  const y3 = y2 + ROW_H; // 3.9
  const dataReg = cce.dhRegEvento
    ? `${formatDate(cce.dhRegEvento)} ${formatTimeSeconds(cce.dhRegEvento)}`
    : '—';
  field(doc, LEFT, y3, halfW, ROW_H, 'DATA E HORA DO REGISTRO DO EVENTO', dataReg, {
    valueSize: 9,
  });
  field(doc, LEFT + halfW, y3, halfW, ROW_H, 'PROTOCOLO', cce.nProt ?? '—', { valueSize: 9 });

  // Correction text (tall) + condições de uso (fixed legal text).
  const yCorr = y3 + ROW_H + 0.1; // 5.1
  const corrH = 7.9;
  block(doc, LEFT, yCorr, CONTENT_W, corrH, 'TEXTO DA CORREÇÃO', cce.xCorrecao, 10);

  const yCond = yCorr + corrH + 0.1; // 13.1
  const condH = PAGE_H - MARGIN - yCond; // down to the bottom margin
  block(doc, LEFT, yCond, CONTENT_W, condH, 'CONDIÇÕES DE USO', XCONDUSO_CCE, 9);

  doc.end();
  return done;
}
