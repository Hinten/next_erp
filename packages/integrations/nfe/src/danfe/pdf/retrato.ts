/**
 * DANFE A4 **retrato** (portrait) PDF renderer.
 *
 * Ports the legacy Flutter `gerenerateDanfeA4Retrato` (sic): the canhoto/recibo
 * stub, the emitente header + DANFE label + Code 128 + chave + protocolo, the
 * destinatário grid, optional entrega/retirada and fatura/duplicatas, the
 * cálculo do imposto strip, the transportador/volumes block, the multi-page
 * itens table, the ISSQN block and the dados adicionais footer. `tpAmb=2` and a
 * cancelada NF-e stamp the "SEM VALOR FISCAL" / "CANCELADO" watermark.
 *
 * The header blocks reuse the legacy field layout but stack with a running
 * cursor (contiguous boxes, no gaps); the itens table paginates across A4
 * sheets, repeating the emitente strip + column header.
 */
import { code128Png } from '../barcode';
import {
  formatChaveAcesso,
  formatCep,
  formatCpfCnpj,
  formatDate,
  formatNNF,
  formatQty,
  formatSerie,
  formatTelefone,
  formatTime,
  formatTimeSeconds,
  freteLabel,
} from '../format';
import type { DanfeItem, DanfeLocal, DanfeModel } from '../model';
import { createPdf, drawBarcode, strokeBox, text, type Doc } from './primitives';
import { A4_H_CM, A4_W_CM, cell, cm, field, headerCell, sectionTitle } from './layout';
import {
  composeInfoComplementares,
  measureSplit,
  pageWatermark,
  paginate,
  type RenderA4Options,
} from './a4-common';

// Re-exported so `index.ts` and the retrato tests keep importing them from here.
export { composeInfoComplementares, paginate, type RenderA4Options };

const MARGIN = 0.25; // cm, left/right
const PAGE_BOTTOM = 28.6; // cm — content may run down to here
const DADOS_MIN_H = 2.0; // cm — minimum dados adicionais box height (reserved every page)
const TITLE_H = 0.42; // cm — section-title strip
const ISSQN_H = 1.27; // cm — ISSQN block (title + 1 row), last produtos page only
const LABEL_PAD_PT = 12; // points reserved inside a dados box for its label + padding
const SPLIT_OPTS = { minBoxCm: DADOS_MIN_H, labelPadPt: LABEL_PAD_PT };

/** Item-table column geometry (cm) — verbatim from the legacy produtosTableHeader. */
const COL = {
  codigo: { left: 0.25, w: 3.0, title: 'Código' },
  descricao: { left: 3.25, w: 4.37, title: 'Descrição do Produto/Serviço' },
  ncm: { left: 7.62, w: 1.3, title: 'NCM/SH' },
  cfop: { left: 8.92, w: 0.8, title: 'CFOP' },
  cson: { left: 9.72, w: 1.4, title: 'CST/CSOSN' },
  un: { left: 11.12, w: 0.5, title: 'UN' },
  qtd: { left: 11.62, w: 1.1, title: 'QTD' },
  vUn: { left: 12.72, w: 1.0, title: 'V. UNIT' },
  vDesc: { left: 13.72, w: 1.0, title: 'V. DESC' },
  vProd: { left: 14.72, w: 1.5, title: 'V. LIQ' },
  vBcIcms: { left: 16.22, w: 1.0, title: 'BC ICMS' },
  vIcms: { left: 17.22, w: 1.0, title: 'V. ICMS' },
  pIcms: { left: 18.22, w: 1.0, title: 'A. ICMS' },
  vIpi: { left: 19.22, w: 0.8, title: 'V. IPI' },
  pIpi: { left: 20.02, w: 0.8, title: 'A. IPI' },
} as const;

const CONTENT_W = A4_W_CM - 2 * MARGIN; // 20.5 cm

function enderecoLinha(e: DanfeLocal['endereco']): string {
  const compl = e.complemento ? `, ${e.complemento}` : '';
  const cep = e.cep ? ` - CEP: ${formatCep(e.cep)}` : '';
  return `${e.logradouro}, ${e.numero}${compl} - ${e.bairro} - ${e.municipio} - ${e.uf}${cep}`;
}

/** Canhoto / recibo stub (page 1 only). Returns the y below it. */
function drawCanhoto(doc: Doc, model: DanfeModel, y: number): number {
  field(
    doc,
    MARGIN,
    y,
    16.1,
    0.85,
    null,
    `RECEBEMOS DE ${model.emit.nome} OS PRODUTOS CONSTANTES DA NOTA FISCAL ELETRÔNICA Nº ${model.ide.nNF} DE ${formatDate(model.ide.dhEmi)}`,
    { valueSize: 5, valueLines: 2 },
  );
  // NF-e box on the right (spans both canhoto rows).
  strokeBox(doc, cm(16.35), cm(y), cm(4.4), cm(1.7));
  text(doc, 'NF-e', cm(16.35), cm(y) + 4, {
    size: 9,
    width: cm(4.4),
    align: 'center',
    lineBreak: false,
  });
  text(doc, `Nº ${formatNNF(model.ide.nNF)}`, cm(16.35), cm(y) + 18, {
    size: 13,
    bold: true,
    width: cm(4.4),
    align: 'center',
    lineBreak: false,
  });
  text(doc, `SÉRIE ${formatSerie(model.ide.serie)}`, cm(16.35), cm(y) + 36, {
    size: 8,
    width: cm(4.4),
    align: 'center',
    lineBreak: false,
  });
  field(doc, MARGIN, y + 0.85, 4.1, 0.85, 'DATA DE RECEBIMENTO', null);
  field(doc, 4.35, y + 0.85, 12.0, 0.85, 'IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR', null);
  return y + 1.7 + 0.15;
}

/** Emitente header + DANFE label + Code 128 + chave + protocolo block. */
function drawEmitente(
  doc: Doc,
  model: DanfeModel,
  barcodePng: Buffer,
  t: number,
  page: number,
  totalPages: number,
): number {
  // A — identificação do emitente.
  strokeBox(doc, cm(MARGIN), cm(t), cm(10.0), cm(3.92));
  text(doc, model.emit.nome, cm(MARGIN) + 4, cm(t) + 8, {
    size: 11,
    bold: true,
    width: cm(9.6),
    lineBreak: false,
  });
  const fone = model.emit.endereco.fone
    ? ` - Fone: ${formatTelefone(model.emit.endereco.fone)}`
    : '';
  text(doc, `${enderecoLinha(model.emit.endereco)}${fone}`, cm(MARGIN) + 4, cm(t) + 26, {
    size: 7,
    width: cm(9.6),
    lineBreak: true,
    height: cm(2.5),
  });

  // B — DANFE label box.
  const bx = 10.25;
  strokeBox(doc, cm(bx), cm(t), cm(2.54), cm(3.92));
  text(doc, 'DANFE', cm(bx), cm(t) + 4, {
    size: 11,
    bold: true,
    width: cm(2.54),
    align: 'center',
    lineBreak: false,
  });
  text(doc, 'Documento Auxiliar da Nota Fiscal Eletrônica', cm(bx) + 2, cm(t) + 18, {
    size: 6,
    width: cm(2.54) - 4,
    align: 'center',
    lineBreak: true,
    height: 24,
  });
  text(doc, `0 - Entrada\n1 - Saída`, cm(bx) + 4, cm(t) + 44, {
    size: 6,
    width: cm(1.4),
    lineBreak: true,
  });
  strokeBox(doc, cm(bx) + cm(1.9), cm(t) + 42, 16, 16);
  text(doc, model.ide.tpNF, cm(bx) + cm(1.9), cm(t) + 45, {
    size: 11,
    bold: true,
    width: 16,
    align: 'center',
    lineBreak: false,
  });
  text(
    doc,
    `Nº ${formatNNF(model.ide.nNF)}\nSérie ${formatSerie(model.ide.serie)}\nFolha ${String(page).padStart(2, '0')}/${String(totalPages).padStart(2, '0')}`,
    cm(bx) + 2,
    cm(t) + 62,
    { size: 7, width: cm(2.54) - 4, align: 'center', lineBreak: true },
  );

  // C — Code 128 barcode. The right column (cbx..20.75) is `RIGHT_W` wide so
  // every block ends at the same right edge as the canhoto's NF-e box.
  const cbx = 12.79;
  const RIGHT_W = 7.96; // 12.79 + 7.96 = 20.75
  strokeBox(doc, cm(cbx), cm(t), cm(RIGHT_W), cm(1.48));
  drawBarcode(doc, barcodePng, cm(cbx) + 4, cm(t) + 3, cm(RIGHT_W) - 8, cm(1.48) - 6);
  // D — chave de acesso.
  field(doc, cbx, t + 1.48, RIGHT_W, 0.85, 'CHAVE DE ACESSO', formatChaveAcesso(model.chave), {
    valueAlign: 'center',
    valueBold: true,
    valueSize: 8,
  });
  // E — consulta de autenticidade. An EPEC-approved NF-e (no autorização at
  // the home SEFAZ yet) prints the EPEC variant (legacy retrato.dart:1707).
  const isEpec = model.epec != null;
  field(
    doc,
    cbx,
    t + 2.33,
    RIGHT_W,
    1.59,
    null,
    isEpec
      ? 'Consulta de autenticidade no portal da NF-e www.nfe.fazenda.gov.br/portal'
      : 'Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora',
    { valueSize: 7, valueAlign: 'center', valueLines: 3 },
  );

  // F — natureza da operação.
  field(doc, MARGIN, t + 3.92, 7.87, 0.85, 'NATUREZA DA OPERAÇÃO', model.ide.natOp, {
    valueSize: 9,
  });
  // G — protocolo de autorização. .trim(): either side may be absent
  // (nProt-less EPEC, dh-less protocolo) — a leading/trailing space would
  // render oddly in the centered box.
  const prot = (
    model.epec
      ? `${model.epec.nProt ?? ''}${
          model.epec.dhRegEvento
            ? ` ${formatDate(model.epec.dhRegEvento)} ${formatTimeSeconds(model.epec.dhRegEvento)}`
            : ''
        }`
      : model.prot && (model.prot.cStat === '100' || model.prot.cStat === '150')
        ? `${model.prot.nProt ?? ''} ${formatDate(model.prot.dhRecbto)} ${formatTimeSeconds(model.prot.dhRecbto)}`
        : ''
  ).trim();
  const protLabel = isEpec ? 'PROTOCOLO DE AUTORIZAÇÃO DO EPEC' : 'PROTOCOLO DE AUTORIZAÇÃO DE USO';
  field(doc, cbx, t + 3.92, RIGHT_W, 0.85, protLabel, prot, {
    valueAlign: 'center',
  });
  // H/I/J — inscrições + CNPJ (the CNPJ box closes the row at 20.75).
  field(doc, MARGIN, t + 4.77, 6.86, 0.85, 'INSCRIÇÃO ESTADUAL', model.emit.ie, { valueSize: 9 });
  field(doc, 7.11, t + 4.77, 6.86, 0.85, 'INSCR. ESTADUAL DO SUBST. TRIB.', model.emit.iest ?? '', {
    valueSize: 9,
  });
  field(
    doc,
    13.97,
    t + 4.77,
    6.78,
    0.85,
    'CNPJ/CPF',
    formatCpfCnpj(model.emit.cnpj ?? model.emit.cpf ?? ''),
    {
      valueSize: 9,
    },
  );
  return t + 5.62 + 0.1;
}

/** Destinatário/remetente grid (page 1 only). */
function drawDestinatario(doc: Doc, model: DanfeModel, y: number): number {
  sectionTitle(doc, MARGIN, y, 'DESTINATÁRIO/REMETENTE');
  let t = y + 0.42;
  const d = model.dest;
  const e = d.endereco;
  field(doc, MARGIN, t, 12.32, 0.85, 'Nome/Razão Social', d.nome, { valueSize: 7 });
  field(
    doc,
    12.57,
    t,
    5.33,
    0.85,
    'CNPJ/CPF',
    formatCpfCnpj(d.cnpj ?? d.cpf ?? '') || (d.idEstrangeiro ?? ''),
  );
  field(doc, 17.9, t, 2.85, 0.85, 'DATA DA EMISSÃO', formatDate(model.ide.dhEmi));
  t += 0.85;
  field(
    doc,
    MARGIN,
    t,
    10.16,
    0.85,
    'ENDEREÇO',
    e ? `${e.logradouro}, ${e.numero} ${e.complemento ?? ''}` : '',
  );
  field(doc, 10.41, t, 4.83, 0.85, 'BAIRRO/DISTRITO', e?.bairro ?? '');
  field(doc, 15.24, t, 2.67, 0.85, 'CEP', e?.cep ? formatCep(e.cep) : '');
  field(
    doc,
    17.9,
    t,
    2.85,
    0.85,
    model.ide.tpNF === '0' ? 'DATA ENTRADA' : 'DATA SAÍDA',
    model.ide.dhSaiEnt ? formatDate(model.ide.dhSaiEnt) : '',
  );
  t += 0.85;
  field(doc, MARGIN, t, 7.11, 0.85, 'MUNICÍPIO', e?.municipio ?? '');
  field(doc, 7.36, t, 4.06, 0.85, 'FONE/FAX', e?.fone ? formatTelefone(e.fone) : '');
  field(doc, 11.42, t, 1.14, 0.85, 'UF', e?.uf ?? '');
  field(doc, 12.56, t, 5.34, 0.85, 'INSCRIÇÃO ESTADUAL', d.ie ?? '');
  field(
    doc,
    17.9,
    t,
    2.85,
    0.85,
    model.ide.tpNF === '0' ? 'HORA ENTRADA' : 'HORA SAÍDA',
    model.ide.dhSaiEnt ? formatTime(model.ide.dhSaiEnt) : '',
  );
  return t + 0.85 + 0.1;
}

/** A local de entrega / retirada block (page 1, optional). */
function drawLocal(doc: Doc, local: DanfeLocal, title: string, y: number): number {
  sectionTitle(doc, MARGIN, y, title);
  let t = y + 0.42;
  const e = local.endereco;
  field(doc, MARGIN, t, 12.32, 0.85, 'Nome/Razão Social', local.nome ?? '');
  field(doc, 12.57, t, 5.33, 0.85, 'CNPJ/CPF', formatCpfCnpj(local.cnpj ?? local.cpf ?? ''));
  field(doc, 17.9, t, 2.85, 0.85, 'INSCRIÇÃO ESTADUAL', local.ie ?? '');
  t += 0.85;
  field(
    doc,
    MARGIN,
    t,
    12.32,
    0.85,
    'ENDEREÇO',
    `${e.logradouro}, ${e.numero} ${e.complemento ?? ''}`,
  );
  field(doc, 12.57, t, 5.33, 0.85, 'MUNICÍPIO / UF', `${e.municipio} - ${e.uf}`);
  field(doc, 17.9, t, 2.85, 0.85, 'CEP', e.cep ? formatCep(e.cep) : '');
  return t + 0.85 + 0.1;
}

/** Fatura + duplicatas block (page 1, optional). */
function drawFaturaDup(doc: Doc, model: DanfeModel, y: number): number {
  let t = y;
  if (model.fat) {
    sectionTitle(doc, MARGIN, t, 'FATURA');
    t += 0.42;
    field(doc, MARGIN, t, 5.0, 0.84, 'Nº da Fatura', model.fat.nFat ?? '');
    field(doc, 5.25, t, 5.0, 0.84, 'Valor Original', model.fat.vOrig ?? '0', { money: true });
    field(doc, 10.25, t, 5.0, 0.84, 'Valor Desconto', model.fat.vDesc ?? '0', { money: true });
    field(doc, 15.25, t, 5.5, 0.84, 'Valor Líquido', model.fat.vLiq ?? '0', { money: true });
    t += 0.84 + 0.05;
  }
  if (model.dup.length > 0) {
    sectionTitle(doc, MARGIN, t, model.dup.length === 1 ? 'DUPLICATA' : 'DUPLICATAS');
    t += 0.42;
    const perRow = 3;
    const dupW = CONTENT_W / perRow;
    model.dup.forEach((d, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = MARGIN + col * dupW;
      const yy = t + row * 0.84;
      field(
        doc,
        x,
        yy,
        dupW - 0.05,
        0.84,
        `Dup. ${d.nDup ?? ''}${d.dVenc ? ` venc. ${formatDate(d.dVenc)}` : ''}`,
        d.vDup,
        { money: true, valueSize: 6, labelSize: 5 },
      );
    });
    t += Math.ceil(model.dup.length / perRow) * 0.84 + 0.05;
  }
  return t + 0.05;
}

/** Cálculo do imposto strip (page 1 only). */
function drawImposto(doc: Doc, model: DanfeModel, y: number): number {
  sectionTitle(doc, MARGIN, y, 'CÁLCULO DO IMPOSTO');
  const tot = model.total;
  let t = y + 0.42;
  field(doc, MARGIN, t, 4.06, 0.85, 'BASE DE CÁLCULO DO ICMS', tot.vBC, { money: true });
  field(doc, 4.31, t, 4.06, 0.85, 'VALOR DO ICMS', tot.vICMS, { money: true });
  field(doc, 8.37, t, 4.06, 0.85, 'BASE DE CÁLCULO ICMS ST', tot.vBCST, { money: true });
  field(doc, 12.43, t, 4.06, 0.85, 'VALOR DO ICMS ST', tot.vST, { money: true });
  field(doc, 16.49, t, 4.26, 0.85, 'VALOR TOTAL DOS PRODUTOS', tot.vProd, { money: true });
  t += 0.85;
  // Five equal boxes fill 0.25→16.49 (no gap, IPI no longer cramped); vNF closes
  // the row at 20.75.
  const w2 = 3.248;
  field(doc, MARGIN, t, w2, 0.85, 'VALOR DO FRETE', tot.vFrete, { money: true });
  field(doc, MARGIN + w2, t, w2, 0.85, 'VALOR DO SEGURO', tot.vSeg, { money: true });
  field(doc, MARGIN + 2 * w2, t, w2, 0.85, 'DESCONTO', tot.vDesc, { money: true });
  field(doc, MARGIN + 3 * w2, t, w2, 0.85, 'OUTRAS DESPESAS', tot.vOutro, { money: true });
  field(doc, MARGIN + 4 * w2, t, w2, 0.85, 'VALOR DO IPI', tot.vIPI, { money: true });
  field(doc, 16.49, t, 4.26, 0.85, 'VALOR TOTAL DA NOTA', tot.vNF, {
    money: true,
    valueBold: true,
  });
  return t + 0.85 + 0.1;
}

/** Transportador / volumes block (page 1 only). */
function drawTransporte(doc: Doc, model: DanfeModel, y: number): number {
  sectionTitle(doc, MARGIN, y, 'TRANSPORTADOR / VOLUMES TRANSPORTADOS');
  const tp = model.transp;
  let t = y + 0.42;
  field(doc, MARGIN, t, 9.02, 0.85, 'RAZÃO SOCIAL', tp.transportadorNome ?? '');
  field(doc, 9.27, t, 2.79, 0.85, 'FRETE POR CONTA', freteLabel(tp.modFrete));
  field(doc, 12.06, t, 1.78, 0.85, 'CÓDIGO ANTT', tp.veicRntc ?? '');
  field(doc, 13.84, t, 2.29, 0.85, 'PLACA', tp.veicPlaca ?? '');
  field(doc, 16.13, t, 0.76, 0.85, 'UF', tp.veicUf ?? '');
  field(doc, 16.89, t, 3.86, 0.85, 'CNPJ/CPF', formatCpfCnpj(tp.transportadorDoc ?? ''));
  t += 0.85;
  field(doc, MARGIN, t, 9.02, 0.85, 'ENDEREÇO', tp.transportadorEndereco ?? '');
  field(doc, 9.27, t, 6.86, 0.85, 'MUNICÍPIO', tp.transportadorMunicipio ?? '');
  field(doc, 16.13, t, 0.76, 0.85, 'UF', tp.transportadorUf ?? '');
  field(doc, 16.89, t, 3.86, 0.85, 'INSCRIÇÃO ESTADUAL', tp.transportadorIe ?? '');
  t += 0.85;
  const v = tp.volumes;
  const sumNum = (key: 'qVol' | 'pesoB' | 'pesoL'): number =>
    v.reduce((acc, x) => acc + Number(x[key] ?? 0), 0);
  const qVol = sumNum('qVol');
  // Weights keep their own precision (up to 4 decimals) — `money` would round a
  // 3-decimal weight (1.800 → 1,80). `formatQty` is right-aligned by the field.
  const pesoB = sumNum('pesoB');
  const pesoL = sumNum('pesoL');
  field(doc, MARGIN, t, 2.92, 0.85, 'QUANTIDADE', qVol ? String(qVol) : '', {
    valueAlign: 'right',
  });
  field(doc, 3.17, t, 3.05, 0.85, 'ESPÉCIE', v[0]?.esp ?? '');
  field(doc, 6.22, t, 3.05, 0.85, 'MARCA', v[0]?.marca ?? '');
  field(doc, 9.27, t, 4.83, 0.85, 'NUMERAÇÃO', v[0]?.nVol ?? '');
  field(doc, 14.1, t, 3.43, 0.85, 'PESO BRUTO', pesoB ? formatQty(pesoB) : '', {
    valueAlign: 'right',
  });
  field(doc, 17.53, t, 3.22, 0.85, 'PESO LÍQUIDO', pesoL ? formatQty(pesoL) : '', {
    valueAlign: 'right',
  });
  return t + 0.85 + 0.1;
}

/** Produtos table header row. Returns y below the header. */
function drawProdutosHeader(doc: Doc, y: number): number {
  sectionTitle(doc, MARGIN, y, 'DADOS DOS PRODUTOS / SERVIÇOS');
  const t = y + 0.42;
  for (const c of Object.values(COL)) headerCell(doc, c.left, t, c.w, 0.42, c.title);
  return t + 0.42;
}

/** One produto row at `y` of height `rowH`. */
function drawProdutoRow(
  doc: Doc,
  item: DanfeItem,
  y: number,
  rowH: number,
  hasGtin: boolean,
): void {
  const desc = hasGtin ? `EAN: ${item.cEAN}\n${item.xProd}` : item.xProd;
  cell(doc, COL.codigo.left, y, COL.codigo.w, rowH, item.cProd, { align: 'center' });
  cell(doc, COL.descricao.left, y, COL.descricao.w, rowH, desc, { lines: hasGtin ? 2 : 1 });
  cell(doc, COL.ncm.left, y, COL.ncm.w, rowH, item.ncm, { align: 'center' });
  cell(doc, COL.cfop.left, y, COL.cfop.w, rowH, item.cfop, { align: 'center' });
  cell(doc, COL.cson.left, y, COL.cson.w, rowH, item.cstCsosn, { align: 'center' });
  cell(doc, COL.un.left, y, COL.un.w, rowH, item.uCom, { align: 'center' });
  cell(doc, COL.qtd.left, y, COL.qtd.w, rowH, formatQty(item.qCom), { align: 'right' });
  cell(doc, COL.vUn.left, y, COL.vUn.w, rowH, item.vUnCom, { money: true });
  cell(doc, COL.vDesc.left, y, COL.vDesc.w, rowH, item.vDesc, { money: true });
  cell(doc, COL.vProd.left, y, COL.vProd.w, rowH, item.vProd, { money: true });
  cell(doc, COL.vBcIcms.left, y, COL.vBcIcms.w, rowH, item.vBcIcms, { money: true });
  cell(doc, COL.vIcms.left, y, COL.vIcms.w, rowH, item.vIcms, { money: true });
  cell(doc, COL.pIcms.left, y, COL.pIcms.w, rowH, item.pIcms, { money: true });
  cell(doc, COL.vIpi.left, y, COL.vIpi.w, rowH, item.vIpi, { money: true });
  cell(doc, COL.pIpi.left, y, COL.pIpi.w, rowH, item.pIpi, { money: true });
}

/** Cálculo do ISSQN block (once, above the dados box on the last produtos page). */
function drawIssqn(doc: Doc, model: DanfeModel, topCm: number): void {
  if (!model.issqn) return;
  sectionTitle(doc, MARGIN, topCm, 'CÁLCULO DO ISSQN');
  const t = topCm + TITLE_H;
  field(doc, MARGIN, t, 5.08, 0.85, 'INSCRIÇÃO MUNICIPAL', model.emit.im ?? '');
  field(doc, 5.33, t, 5.08, 0.85, 'VALOR TOTAL DOS SERVIÇOS', model.issqn.vServ, { money: true });
  field(doc, 10.41, t, 5.08, 0.85, 'BASE DE CÁLCULO DO ISSQN', model.issqn.vBC, { money: true });
  field(doc, 15.49, t, 5.26, 0.85, 'VALOR DO ISSQN', model.issqn.vISS, { money: true });
}

const COMPL_W = 12.92; // cm — INFORMAÇÕES COMPLEMENTARES box width
const FISCO_X = 13.17; // cm — RESERVADO AO FISCO box left (= COMPL right edge)
const FISCO_W = 7.58; // cm

/**
 * Draw the DADOS ADICIONAIS block at `topCm` with the given box height: the
 * INFORMAÇÕES COMPLEMENTARES chunk (pre-sized to fit, no ellipsis) + the
 * RESERVADO AO FISCO box (infAdFisco only on the first occurrence).
 */
function drawDadosAdicionais(
  doc: Doc,
  topCm: number,
  boxHCm: number,
  complChunk: string,
  infAdFisco: string,
): void {
  sectionTitle(doc, MARGIN, topCm, 'DADOS ADICIONAIS');
  const by = topCm + TITLE_H;
  strokeBox(doc, cm(MARGIN), cm(by), cm(COMPL_W), cm(boxHCm));
  text(doc, 'INFORMAÇÕES COMPLEMENTARES', cm(MARGIN) + 2, cm(by) + 2, {
    size: 5,
    width: cm(COMPL_W) - 4,
    lineBreak: false,
  });
  if (complChunk) {
    text(doc, complChunk, cm(MARGIN) + 2, cm(by) + 9, {
      size: 6,
      width: cm(COMPL_W) - 4,
      upper: false,
      lineBreak: true,
      height: cm(boxHCm) - 10,
    });
  }
  strokeBox(doc, cm(FISCO_X), cm(by), cm(FISCO_W), cm(boxHCm));
  text(doc, 'RESERVADO AO FISCO', cm(FISCO_X) + 2, cm(by) + 2, {
    size: 5,
    width: cm(FISCO_W) - 4,
    lineBreak: false,
  });
  if (infAdFisco) {
    text(doc, infAdFisco, cm(FISCO_X) + 2, cm(by) + 9, {
      size: 6,
      width: cm(FISCO_W) - 4,
      upper: false,
      lineBreak: true,
      height: cm(boxHCm) - 10,
    });
  }
}

/**
 * A rendered page: produtos rows + its dados-adicionais slice, or a
 * continuation page that carries only more of the infCpl. The dados box is
 * drawn at the live cursor (`y`), so only its height + chunk are carried here.
 */
type PagePlan =
  | { kind: 'produtos'; rows: number; hasIssqn: boolean; dadosBoxHCm: number; dadosChunk: string }
  | { kind: 'continuation'; dadosBoxHCm: number; dadosChunk: string };

export async function renderRetrato(
  model: DanfeModel,
  opts: RenderA4Options = {},
): Promise<Buffer> {
  const cancelada = opts.cancelada ?? false;
  const hasGtin = model.itens.some((i) => i.cEAN !== 'SEM GTIN' && i.cEAN !== '');
  const rowH = hasGtin ? 1.26 : 0.84;

  // Page-1 header height (over-estimate of the blocks present) → produtos top;
  // later pages carry only the emitente strip.
  let headerH = 1.85 /* canhoto */ + 5.72 /* emitente */ + 3.49; /* destinatário */
  if (model.entrega) headerH += 2.25;
  if (model.retirada) headerH += 2.25;
  headerH += drawFaturaDupHeight(model);
  headerH += 2.62 /* imposto */ + 3.49 /* transporte */;
  const produtosTop1 = MARGIN + headerH + 0.84; // + table title + header
  const produtosTopN = MARGIN + 5.72 + 0.84; // emitente strip + table header on later pages

  // Every page reserves the dados-adicionais footer; the last produtos page
  // additionally reserves the ISSQN block.
  const issqnReserve = model.issqn ? ISSQN_H : 0;
  const bottomEvery = PAGE_BOTTOM - (DADOS_MIN_H + TITLE_H);
  const rowsFor = (top: number, extra: number): number =>
    Math.max(1, Math.floor((bottomEvery - extra - top) / rowH));
  const slices = paginate(
    model.itens.length,
    rowsFor(produtosTop1, 0),
    rowsFor(produtosTop1, issqnReserve),
    rowsFor(produtosTopN, 0),
    rowsFor(produtosTopN, issqnReserve),
  );

  const barcodePng = await code128Png(model.chave);
  const { doc, done } = createPdf([cm(A4_W_CM), cm(A4_H_CM)]);
  const innerWidthPt = cm(COMPL_W) - 4;

  // ---- Measuring pass: assign infCpl chunks to produtos pages (using whatever
  // blank space each leaves), then spill the rest onto continuation pages. ----
  const plans: PagePlan[] = [];
  let remaining = composeInfoComplementares(model);
  for (let p = 0; p < slices.length; p++) {
    const top = p === 0 ? produtosTop1 : produtosTopN;
    const isLast = p === slices.length - 1;
    const hasIssqn = isLast && model.issqn != null;
    const dadosTop = top + slices[p]! * rowH + 0.1 + (hasIssqn ? ISSQN_H + 0.1 : 0);
    const avail = cm(PAGE_BOTTOM - dadosTop - TITLE_H);
    const { chunk, boxHCm, rest } = measureSplit(doc, remaining, innerWidthPt, avail, SPLIT_OPTS);
    plans.push({
      kind: 'produtos',
      rows: slices[p]!,
      hasIssqn,
      dadosBoxHCm: boxHCm,
      dadosChunk: chunk,
    });
    remaining = rest;
  }
  const contDadosTop = produtosTopN - 0.54; // just below the emitente strip
  while (remaining.length > 0) {
    const avail = cm(PAGE_BOTTOM - contDadosTop - TITLE_H);
    const { chunk, boxHCm, rest } = measureSplit(doc, remaining, innerWidthPt, avail, SPLIT_OPTS);
    plans.push({ kind: 'continuation', dadosBoxHCm: boxHCm, dadosChunk: chunk });
    remaining = rest;
  }
  const totalPages = plans.length;

  // ---- Render pass — position the dados box at the live cursor `y`. ----
  const infAdFisco = model.infAdic.infAdFisco ?? '';
  let itemIdx = 0;
  for (let i = 0; i < plans.length; i++) {
    if (i > 0) doc.addPage();
    pageWatermark(doc, model, cancelada, cm(A4_W_CM), cm(A4_H_CM));
    const plan = plans[i]!;
    let y = MARGIN;
    if (i === 0) {
      y = drawCanhoto(doc, model, y);
      y = drawEmitente(doc, model, barcodePng, y, 1, totalPages);
      y = drawDestinatario(doc, model, y);
      if (model.entrega) y = drawLocal(doc, model.entrega, 'INFORMAÇÕES DO LOCAL DE ENTREGA', y);
      if (model.retirada) y = drawLocal(doc, model.retirada, 'INFORMAÇÕES DO LOCAL DE RETIRADA', y);
      y = drawFaturaDup(doc, model, y);
      y = drawImposto(doc, model, y);
      y = drawTransporte(doc, model, y);
    } else {
      y = drawEmitente(doc, model, barcodePng, y, i + 1, totalPages);
    }
    if (plan.kind === 'produtos') {
      y = drawProdutosHeader(doc, y);
      for (let r = 0; r < plan.rows; r++) {
        drawProdutoRow(doc, model.itens[itemIdx]!, y, rowH, hasGtin);
        y += rowH;
        itemIdx += 1;
      }
      if (plan.hasIssqn) {
        drawIssqn(doc, model, y + 0.1);
        y += 0.1 + ISSQN_H;
      }
    }
    // The dados block frame sits on every page; infAdFisco only on the first.
    drawDadosAdicionais(doc, y + 0.1, plan.dadosBoxHCm, plan.dadosChunk, i === 0 ? infAdFisco : '');
  }

  doc.end();
  return done;
}

/** Height (cm) the fatura+duplicatas block will consume on page 1. */
function drawFaturaDupHeight(model: DanfeModel): number {
  let h = 0;
  if (model.fat) h += 0.42 + 0.84 + 0.05;
  if (model.dup.length > 0) h += 0.42 + Math.ceil(model.dup.length / 3) * 0.84 + 0.05;
  return h;
}
