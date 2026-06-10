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
import { createPdf, drawBarcode, labeledRow, strokeBox, text, watermark } from './primitives';

export interface RenderSimplificadoOptions {
  /** Stamp the "CANCELADO" overlay (the NF-e estado is cancelada). */
  readonly cancelada?: boolean;
}

const cm = cmToPt;

/** One row inside a bordered section. */
type Row =
  | { kind: 'kv'; label: string; value: string }
  | { kind: 'line'; text: string; bold?: boolean }
  | { kind: 'wrap'; text: string; lines: number };

const LH = cm(0.42); // single-line height
const PAD = cm(0.16); // box inner vertical padding

function rowHeight(r: Row): number {
  return r.kind === 'wrap' ? r.lines * LH : LH;
}

function enderecoLinha(e: DanfeEndereco): string {
  const compl = e.complemento ? `, ${e.complemento}` : '';
  const cep = e.cep ? `, CEP: ${formatCep(e.cep)}` : '';
  return `${e.logradouro}, ${e.numero}${compl} - ${e.bairro} - ${e.municipio} - ${e.uf}${cep}`;
}

export async function renderSimplificado(
  model: DanfeModel,
  opts: RenderSimplificadoOptions = {},
): Promise<Buffer> {
  const W = cm(10);
  const H = cm(15);
  const { doc, done } = createPdf([W, H]);

  const M = cm(0.35);
  const innerW = W - 2 * M;
  const padX = M + cm(0.2);
  const contentW = innerW - cm(0.4);

  // Watermark sits behind the content (faint, translucent).
  if (opts.cancelada) {
    watermark(doc, 'CANCELADO', W, H);
  } else if (model.homologacao) {
    watermark(doc, 'SEM VALOR FISCAL', W, H);
  }

  // Outer border.
  strokeBox(doc, M, M, innerW, H - 2 * M);

  let y = M + cm(0.2);
  text(doc, 'DANFE SIMPLIFICADO - ETIQUETA', padX, y, {
    size: 7.5,
    bold: true,
    width: contentW,
    align: 'center',
  });
  y += cm(0.5);

  // Code 128 of the chave + the grouped chave below it.
  const bcH = cm(1.25);
  const png = await code128Png(model.chave);
  drawBarcode(doc, png, padX, y, contentW, bcH);
  y += bcH + cm(0.08);
  text(doc, formatChaveAcesso(model.chave), padX, y, { size: 8, width: contentW, align: 'center' });
  y += cm(0.45);

  /** Draw a bordered section with an optional centered title and rows. */
  const section = (title: string | null, rows: Row[]): void => {
    const titleH = title ? LH : 0;
    const boxH = PAD + titleH + rows.reduce((acc, r) => acc + rowHeight(r), 0) + PAD;
    strokeBox(doc, M, y, innerW, boxH);
    let yy = y + PAD;
    if (title) {
      text(doc, title, padX, yy, { size: 7, bold: true, width: contentW, align: 'center' });
      yy += LH;
    }
    for (const r of rows) {
      if (r.kind === 'kv') {
        labeledRow(doc, padX, yy, contentW, r.label, r.value);
      } else if (r.kind === 'line') {
        text(doc, r.text, padX, yy, { size: 7, bold: r.bold, width: contentW });
      } else {
        text(doc, r.text, padX, yy, {
          size: 7,
          width: contentW,
          lineBreak: true,
          height: r.lines * LH,
          ellipsis: true,
        });
      }
      yy += rowHeight(r);
    }
    // Contiguous boxes: each box's bottom border is the next box's top border
    // (a single DANFE grid line, not doubled lines with a gap between).
    y += boxH;
  };

  // Protocolo de autorização de uso.
  if (model.prot) {
    section(null, [
      { kind: 'line', text: 'Protocolo de autorização de uso', bold: true },
      {
        kind: 'line',
        text: `${model.prot.nProt ?? ''} ${formatDate(model.prot.dhRecbto)} ${formatTimeSeconds(model.prot.dhRecbto)}`.trim(),
      },
    ]);
  }

  // Emitente.
  const emitDoc = model.emit.cnpj ?? model.emit.cpf;
  section('Dados do emitente', [
    { kind: 'kv', label: model.emit.cnpj ? 'Razão Social' : 'Nome', value: model.emit.nome },
    ...(emitDoc
      ? [
          {
            kind: 'kv' as const,
            label: model.emit.cnpj ? 'CNPJ' : 'CPF',
            value: formatCpfCnpj(emitDoc),
          },
        ]
      : []),
    { kind: 'kv', label: 'IE', value: model.emit.ie },
    { kind: 'wrap', text: enderecoLinha(model.emit.endereco), lines: 3 },
  ]);

  // Dados gerais da NF-e.
  section('Dados gerais da NF-e', [
    { kind: 'kv', label: 'Tipo', value: model.ide.tpNF === '1' ? '1 - Saída' : '0 - Entrada' },
    { kind: 'kv', label: 'NF-e Nº', value: formatNNF(model.ide.nNF) },
    { kind: 'kv', label: 'Série', value: formatSerie(model.ide.serie) },
    { kind: 'kv', label: 'Data da emissão', value: formatDate(model.ide.dhEmi) },
    { kind: 'kv', label: 'Valor total', value: formatMoney(model.total.vNF) },
  ]);

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
    destRows.push({ kind: 'wrap', text: enderecoLinha(model.dest.endereco), lines: 3 });
  }
  section('Dados do destinatário/remetente', destRows);

  // Dados adicionais — the contingency note (dhCont/xJust, mandatory on the
  // printout when tpEmis ≠ 1) leads, then infCpl + infAdFisco.
  const infCpl = [contingencyNote(model), model.infAdic.infCpl, model.infAdic.infAdFisco]
    .filter(Boolean)
    .join(' ');
  if (infCpl) {
    section('Dados adicionais', [{ kind: 'wrap', text: infCpl, lines: 3 }]);
  }

  doc.end();
  return done;
}
