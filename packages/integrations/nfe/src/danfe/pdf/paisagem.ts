/**
 * DANFE A4 **paisagem** (landscape) PDF renderer.
 *
 * Ports the legacy Flutter `gerenerateDanfeA4Paisagem`: the same blocks as the
 * retrato, re-laid for a 29.7 × 21 cm sheet. The signature landscape traits are
 * (1) the canhoto/recibo is a rotated strip down the **left edge** of page 1
 * (not a top stub), and (2) on later pages — where the canhoto is absent — the
 * emitente header and the produtos table **expand left** to fill the freed
 * column, so every block still ends at the same right edge (the descrição
 * column absorbs the slack).
 *
 * Like the retrato, the itens table paginates across sheets and the INFORMAÇÕES
 * COMPLEMENTARES box grows into each page's blank space and spills onto
 * continuation pages, so a long `infCpl` is never clipped. `tpAmb=2` / a
 * cancelada NF-e stamp the "SEM VALOR FISCAL" / "CANCELADO" watermark.
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
import { createPdf, drawBarcode, strokeBox, text, textRotated, type Doc } from './primitives';
import { A4_H_CM, A4_W_CM, cell, cm, field, groupTitleVertical, headerCell } from './layout';
import {
  composeInfoComplementares,
  measureSplit,
  pageWatermark,
  paginate,
  type RenderA4Options,
} from './a4-common';

const PAGE_W = A4_H_CM; // 29.7 cm — landscape width
const PAGE_H = A4_W_CM; // 21 cm — landscape height
const TOP = 0.47; // cm — content top edge
const PAGE_BOTTOM = 20.53; // cm — 21 − 0.47
const LEFT_P1 = 2.41; // cm — content left on page 1 (after the canhoto strip)
const LEFT_PN = 0.13; // cm — content left on later pages (no canhoto)
const RIGHT = 29.46; // cm — content right edge (shared by every block)
const TITLE_W = 0.51; // cm — vertical group-title strip width
const ROW_H = 0.42; // cm — table header / dados title strip height
const ISSQN_H = 0.67; // cm — ISSQN block (last produtos page only)
const DADOS_MIN_H = 2.59; // cm — minimum dados adicionais box height
const LABEL_PAD_PT = 12; // points reserved inside a dados box for its label + padding
const SPLIT_OPTS = { minBoxCm: DADOS_MIN_H, labelPadPt: LABEL_PAD_PT };

// Where the produtos table header begins on each page kind.
const CABECALHO_H = 4.38; // emitente header height (TOP → 4.85)
const DEST_H = 1.92;
const IMPOSTO_H = 1.28;
const TRANSP_H = 1.92;
const LOCAL_H = 1.92;
const PRODUTOS_HEADER_TOP_PN = TOP + CABECALHO_H; // 4.85

// Dados adicionais box geometry (cm).
const FISCO_X = 21.97;
const FISCO_W = 7.49;
const COMPL_X_P1 = 2.92;
const COMPL_W_P1 = 19.05;
const COMPL_X_PN = LEFT_PN + TITLE_W; // 0.64
const COMPL_W_PN = COMPL_W_P1 + COMPL_X_P1 - COMPL_X_PN; // ends at FISCO_X too

interface Col {
  readonly left: number;
  readonly w: number;
}

/**
 * Produtos column geometry for a page. On later pages the descrição column is
 * 2.28 cm wider (it absorbs the absent canhoto), so every column to its right
 * shifts and the table still ends at `RIGHT`.
 */
function colsFor(
  left: number,
  page1: boolean,
): {
  titleLeft: number;
  codigo: Col;
  descricao: Col;
  ncm: Col;
  cfop: Col;
  cson: Col;
  un: Col;
  qtd: Col;
  vUn: Col;
  vDesc: Col;
  vProd: Col;
  vBcIcms: Col;
  vIcms: Col;
  pIcms: Col;
  vIpi: Col;
  pIpi: Col;
} {
  const descW = page1 ? 8.35 : 8.35 + 2.28;
  let x = left + TITLE_W;
  const mk = (w: number): Col => {
    const c = { left: x, w };
    x += w;
    return c;
  };
  return {
    titleLeft: left,
    codigo: mk(5.0),
    descricao: mk(descW),
    ncm: mk(1.3),
    cfop: mk(0.8),
    cson: mk(1.4),
    un: mk(0.5),
    qtd: mk(1.1),
    vUn: mk(1.0),
    vDesc: mk(1.0),
    vProd: mk(1.5),
    vBcIcms: mk(1.0),
    vIcms: mk(1.0),
    pIcms: mk(1.0),
    vIpi: mk(0.8),
    pIpi: mk(0.8),
  };
}

type ColsGeom = ReturnType<typeof colsFor>;

function enderecoLinha(e: DanfeLocal['endereco']): string {
  const compl = e.complemento ? `, ${e.complemento}` : '';
  const cep = e.cep ? ` - CEP: ${formatCep(e.cep)}` : '';
  return `${e.logradouro}, ${e.numero}${compl} - ${e.bairro} - ${e.municipio} - ${e.uf}${cep}`;
}

/** Canhoto / recibo strip down the left edge (page 1 only), rotated 90°. */
function drawCanhoto(doc: Doc, model: DanfeModel): void {
  // NF-e identification box (top-left), rotated.
  strokeBox(doc, cm(0.13), cm(TOP), cm(2.04), cm(4.53));
  textRotated(
    doc,
    `NF-e  Nº ${formatNNF(model.ide.nNF)}  SÉRIE ${formatSerie(model.ide.serie)}`,
    cm(0.13),
    cm(TOP),
    cm(2.04),
    cm(4.53),
    { size: 9, bold: true },
  );
  // Recibo sentence (tall strip below the NF-e box).
  strokeBox(doc, cm(0.13), cm(5.0), cm(1.02), cm(15.53));
  textRotated(
    doc,
    `RECEBEMOS DE ${model.emit.nome} OS PRODUTOS CONSTANTES DA NOTA FISCAL ELETRÔNICA Nº ${formatNNF(model.ide.nNF)} DE ${formatDate(model.ide.dhEmi)}`,
    cm(0.13),
    cm(5.0),
    cm(1.02),
    cm(15.53),
    { size: 6 },
  );
  // Assinatura do recebedor + data de recebimento (second column of the stub).
  strokeBox(doc, cm(1.15), cm(5.0), cm(1.02), cm(9.21));
  textRotated(
    doc,
    'IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR',
    cm(1.15),
    cm(5.0),
    cm(1.02),
    cm(9.21),
    {
      size: 6,
    },
  );
  strokeBox(doc, cm(1.15), cm(14.21), cm(1.02), cm(6.32));
  textRotated(doc, 'DATA DE RECEBIMENTO', cm(1.15), cm(14.21), cm(1.02), cm(6.32), { size: 6 });
}

/** Emitente header + DANFE label + Code 128 + chave + protocolo block. */
function drawEmitente(
  doc: Doc,
  model: DanfeModel,
  barcodePng: Buffer,
  left: number,
  page: number,
  totalPages: number,
): void {
  const page1 = page === 1;
  // A — identificação do emitente (expands left on later pages; right edge 13.84).
  const emitW = page1 ? 11.43 : 11.43 + 2.28;
  strokeBox(doc, cm(left), cm(TOP), cm(emitW), cm(3.1));
  text(doc, 'IDENTIFICAÇÃO DO EMITENTE', cm(left) + 3, cm(TOP) + 2, {
    size: 5,
    width: cm(emitW) - 6,
    lineBreak: false,
  });
  text(doc, model.emit.nome, cm(left) + 3, cm(TOP) + 12, {
    size: 12,
    bold: true,
    width: cm(emitW) - 6,
    lineBreak: false,
  });
  const fone = model.emit.endereco.fone
    ? ` - Fone: ${formatTelefone(model.emit.endereco.fone)}`
    : '';
  text(doc, `${enderecoLinha(model.emit.endereco)}${fone}`, cm(left) + 3, cm(TOP) + 32, {
    size: 7,
    bold: true,
    width: cm(emitW) - 6,
    lineBreak: true,
    height: cm(2.0),
  });

  // B — DANFE label box (fixed at 13.84, common to both page kinds).
  const bx = 13.84;
  strokeBox(doc, cm(bx), cm(TOP), cm(3.05), cm(3.1));
  text(doc, 'DANFE', cm(bx), cm(TOP) + 4, {
    size: 12,
    bold: true,
    width: cm(3.05),
    align: 'center',
    lineBreak: false,
  });
  text(doc, 'Documento Auxiliar da Nota Fiscal Eletrônica', cm(bx) + 3, cm(TOP) + 22, {
    size: 6,
    width: cm(3.05) - 6,
    align: 'center',
    lineBreak: true,
    height: 22,
  });
  text(doc, '0 - Entrada\n1 - Saída', cm(bx) + 6, cm(TOP) + 48, {
    size: 6,
    width: cm(1.5),
    lineBreak: true,
  });
  strokeBox(doc, cm(bx) + cm(2.0), cm(TOP) + 46, 16, 16);
  text(doc, model.ide.tpNF, cm(bx) + cm(2.0), cm(TOP) + 49, {
    size: 11,
    bold: true,
    width: 16,
    align: 'center',
    lineBreak: false,
  });
  text(
    doc,
    `Nº ${formatNNF(model.ide.nNF)}\nSérie ${formatSerie(model.ide.serie)}  Fl. ${String(page).padStart(2, '0')}/${String(totalPages).padStart(2, '0')}`,
    cm(bx) + 2,
    cm(TOP) + 66,
    { size: 7, width: cm(3.05) - 4, align: 'center', lineBreak: true },
  );

  // C — Code 128 barcode (right column, fixed at 16.89, width 12.57).
  const cbx = 16.89;
  const cbw = 12.57;
  strokeBox(doc, cm(cbx), cm(TOP), cm(cbw), cm(1.19));
  drawBarcode(doc, barcodePng, cm(cbx) + 4, cm(TOP) + 3, cm(cbw) - 8, cm(1.19) - 6);
  // D — chave de acesso.
  field(doc, cbx, TOP + 1.19, cbw, 0.64, 'CHAVE DE ACESSO', formatChaveAcesso(model.chave), {
    valueAlign: 'center',
    valueBold: true,
    valueSize: 8,
  });
  // E — consulta de autenticidade.
  field(
    doc,
    cbx,
    TOP + 1.19 + 0.64,
    cbw,
    1.27,
    null,
    'Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora',
    { valueSize: 7, valueAlign: 'center', valueLines: 3 },
  );
  // F — protocolo de autorização.
  const prot =
    model.prot && (model.prot.cStat === '100' || model.prot.cStat === '150')
      ? `${model.prot.nProt ?? ''} ${formatDate(model.prot.dhRecbto)} ${formatTimeSeconds(model.prot.dhRecbto)}`
      : '';
  field(doc, cbx, TOP + 3.1, cbw, 0.64, 'PROTOCOLO DE AUTORIZAÇÃO DE USO', prot, {
    valueAlign: 'center',
  });

  // G — natureza da operação (expands left on later pages, ending at the barcode
  // box so it never leaves a gap — end-at-fixed-x, not a LEFT_P1-relative width).
  field(doc, left, TOP + 3.1, cbx - left, 0.64, 'NATUREZA DA OPERAÇÃO', model.ide.natOp, {
    valueSize: 9,
  });
  // H/I/J — inscrições + CNPJ. The IE box ends at the IEST box (x=11.81), so it
  // expands left with the page; IEST + CNPJ are fixed and close the row at RIGHT.
  field(doc, left, TOP + 3.74, 11.81 - left, 0.64, 'INSCRIÇÃO ESTADUAL', model.emit.ie, {
    valueSize: 9,
  });
  field(doc, 11.81, TOP + 3.74, 8.89, 0.64, 'INSCRIÇÃO ESTADUAL DE ST', model.emit.iest ?? '', {
    valueSize: 9,
  });
  field(
    doc,
    20.7,
    TOP + 3.74,
    8.76,
    0.64,
    'CNPJ/CPF',
    formatCpfCnpj(model.emit.cnpj ?? model.emit.cpf ?? ''),
    { valueSize: 9 },
  );
}

/** Destinatário/remetente grid (page 1 only). Returns the y below it. */
function drawDestinatario(doc: Doc, model: DanfeModel, top: number): number {
  groupTitleVertical(doc, LEFT_P1, top, TITLE_W, DEST_H, 'DESTINATÁRIO/REMETENTE');
  const d = model.dest;
  const e = d.endereco;
  let t = top;
  field(doc, 2.92, t, 16.38, 0.64, 'Nome/Razão Social', d.nome, { valueSize: 7 });
  field(
    doc,
    19.3,
    t,
    5.84,
    0.64,
    'CNPJ/CPF',
    formatCpfCnpj(d.cnpj ?? d.cpf ?? '') || (d.idEstrangeiro ?? ''),
  );
  field(doc, 25.14, t, 4.32, 0.64, 'DATA DA EMISSÃO', formatDate(model.ide.dhEmi));
  t += 0.64;
  field(
    doc,
    2.92,
    t,
    12.45,
    0.64,
    'ENDEREÇO',
    e ? `${e.logradouro}, ${e.numero} ${e.complemento ?? ''}` : '',
  );
  field(doc, 15.37, t, 5.84, 0.64, 'BAIRRO/DISTRITO', e?.bairro ?? '');
  field(doc, 21.21, t, 3.94, 0.64, 'CEP', e?.cep ? formatCep(e.cep) : '');
  field(
    doc,
    25.14,
    t,
    4.32,
    0.64,
    model.ide.tpNF === '0' ? 'DATA ENTRADA' : 'DATA SAÍDA',
    model.ide.dhSaiEnt ? formatDate(model.ide.dhSaiEnt) : '',
  );
  t += 0.64;
  field(doc, 2.92, t, 10.03, 0.64, 'MUNICÍPIO', e?.municipio ?? '');
  field(doc, 12.95, t, 5.08, 0.64, 'FONE/FAX', e?.fone ? formatTelefone(e.fone) : '');
  field(doc, 18.03, t, 1.27, 0.64, 'UF', e?.uf ?? '');
  field(doc, 19.3, t, 5.84, 0.64, 'INSCRIÇÃO ESTADUAL', d.ie ?? '');
  field(
    doc,
    25.14,
    t,
    4.32,
    0.64,
    model.ide.tpNF === '0' ? 'HORA ENTRADA' : 'HORA SAÍDA',
    model.ide.dhSaiEnt ? formatTime(model.ide.dhSaiEnt) : '',
  );
  return top + DEST_H;
}

/** Local de entrega / retirada block (page 1, optional). Returns the y below it. */
function drawLocal(doc: Doc, local: DanfeLocal, title: string, top: number): number {
  groupTitleVertical(doc, LEFT_P1, top, TITLE_W, LOCAL_H, title);
  const e = local.endereco;
  let t = top;
  field(doc, 2.92, t, 16.38, 0.64, 'Nome/Razão Social', local.nome ?? '');
  field(doc, 19.3, t, 5.84, 0.64, 'CNPJ/CPF', formatCpfCnpj(local.cnpj ?? local.cpf ?? ''));
  field(doc, 25.14, t, 4.32, 0.64, 'INSCRIÇÃO ESTADUAL', local.ie ?? '');
  t += 0.64;
  field(
    doc,
    2.92,
    t,
    12.45,
    0.64,
    'ENDEREÇO',
    `${e.logradouro}, ${e.numero} ${e.complemento ?? ''}`,
  );
  field(doc, 15.37, t, 5.84, 0.64, 'BAIRRO/DISTRITO', e.bairro ?? '');
  field(doc, 21.21, t, 4.0, 0.64, 'CEP', e.cep ? formatCep(e.cep) : '');
  t += 0.64;
  field(doc, 2.92, t, 16.38, 0.64, 'MUNICÍPIO', e.municipio ?? '');
  field(doc, 19.3, t, 10.16, 0.64, 'UF', e.uf ?? '');
  return top + LOCAL_H;
}

/** Fatura + duplicatas block (page 1, optional). Returns the y below it. */
function drawFaturaDup(doc: Doc, model: DanfeModel, top: number): number {
  let t = top;
  if (model.fat) {
    groupTitleVertical(doc, LEFT_P1, t, TITLE_W, 0.64, 'FAT.');
    const w = 6.635;
    field(doc, 2.92, t, w, 0.64, 'Nº da Fatura', model.fat.nFat ?? '');
    field(doc, 2.92 + w, t, w, 0.64, 'Valor Original', model.fat.vOrig ?? '0', { money: true });
    field(doc, 2.92 + 2 * w, t, w, 0.64, 'Valor Desconto', model.fat.vDesc ?? '0', { money: true });
    field(doc, 2.92 + 3 * w, t, w, 0.64, 'Valor Líquido', model.fat.vLiq ?? '0', { money: true });
    t += 0.64;
  }
  if (model.dup.length > 0) {
    const rows = Math.ceil(model.dup.length / 6);
    groupTitleVertical(
      doc,
      LEFT_P1,
      t,
      TITLE_W,
      rows * 0.64,
      model.dup.length === 1 ? 'DUP.' : 'DUPL.',
    );
    const dupW = (RIGHT - 2.92) / 6;
    model.dup.forEach((d, i) => {
      const col = i % 6;
      const row = Math.floor(i / 6);
      field(
        doc,
        2.92 + col * dupW,
        t + row * 0.64,
        dupW - 0.02,
        0.64,
        `Dup. ${d.nDup ?? ''}${d.dVenc ? ` v.${formatDate(d.dVenc)}` : ''}`,
        d.vDup,
        { money: true, valueSize: 5, labelSize: 4 },
      );
    });
    t += rows * 0.64;
  }
  return t;
}

/** Cálculo do imposto strip (page 1 only). Returns the y below it. */
function drawImposto(doc: Doc, model: DanfeModel, top: number): number {
  groupTitleVertical(doc, LEFT_P1, top, TITLE_W, IMPOSTO_H, 'CÁLC. IMPOSTO');
  const tot = model.total;
  let t = top;
  field(doc, 2.92, t, 5.33, 0.64, 'BASE DE CÁLCULO DO ICMS', tot.vBC, { money: true });
  field(doc, 8.25, t, 5.33, 0.64, 'VALOR DO ICMS', tot.vICMS, { money: true });
  field(doc, 13.58, t, 5.33, 0.64, 'BASE DE CÁLCULO DO ICMS ST', tot.vBCST, { money: true });
  field(doc, 18.91, t, 5.33, 0.64, 'VALOR DO ICMS ST', tot.vST, { money: true });
  field(doc, 24.24, t, 5.22, 0.64, 'VALOR TOTAL DOS PRODUTOS', tot.vProd, { money: true });
  t += 0.64;
  field(doc, 2.92, t, 4.32, 0.64, 'VALOR DO FRETE', tot.vFrete, { money: true });
  field(doc, 7.24, t, 4.32, 0.64, 'VALOR DO SEGURO', tot.vSeg, { money: true });
  field(doc, 11.56, t, 4.32, 0.64, 'DESCONTO', tot.vDesc, { money: true });
  field(doc, 15.88, t, 4.32, 0.64, 'OUT. DESP. ACESSÓRIAS', tot.vOutro, { money: true });
  field(doc, 20.2, t, 4.32, 0.64, 'VALOR DO IPI', tot.vIPI, { money: true });
  field(doc, 24.52, t, 4.94, 0.64, 'VALOR TOTAL DA NOTA', tot.vNF, {
    money: true,
    valueBold: true,
  });
  return top + IMPOSTO_H;
}

/** Transportador / volumes block (page 1 only). Returns the y below it. */
function drawTransporte(doc: Doc, model: DanfeModel, top: number): number {
  groupTitleVertical(doc, LEFT_P1, top, TITLE_W, TRANSP_H, 'TRANSPORTE');
  const tp = model.transp;
  let t = top;
  field(doc, 2.92, t, 11.56, 0.64, 'RAZÃO SOCIAL', tp.transportadorNome ?? '');
  field(doc, 14.48, t, 2.79, 0.64, 'FRETE POR CONTA', freteLabel(tp.modFrete));
  field(doc, 17.27, t, 2.54, 0.64, 'CÓDIGO ANTT', tp.veicRntc ?? '');
  field(doc, 19.81, t, 3.81, 0.64, 'PLACA DO VEÍCULO', tp.veicPlaca ?? '');
  field(doc, 23.62, t, 1.02, 0.64, 'UF', tp.veicUf ?? '');
  field(doc, 24.64, t, 4.83, 0.64, 'CNPJ/CPF', formatCpfCnpj(tp.transportadorDoc ?? ''));
  t += 0.64;
  field(doc, 2.92, t, 11.56, 0.64, 'ENDEREÇO', tp.transportadorEndereco ?? '');
  field(doc, 14.48, t, 9.14, 0.64, 'MUNICÍPIO', tp.transportadorMunicipio ?? '');
  field(doc, 23.62, t, 1.02, 0.64, 'UF', tp.transportadorUf ?? '');
  field(doc, 24.64, t, 4.83, 0.64, 'INSCRIÇÃO ESTADUAL', tp.transportadorIe ?? '');
  t += 0.64;
  const v = tp.volumes;
  const sumNum = (key: 'qVol' | 'pesoB' | 'pesoL'): number =>
    v.reduce((acc, x) => acc + Number(x[key] ?? 0), 0);
  const qVol = sumNum('qVol');
  // Weights keep their own precision (up to 4 decimals) — `money` would round a
  // 3-decimal weight (1.800 → 1,80). `formatQty` is right-aligned by the field.
  const pesoB = sumNum('pesoB');
  const pesoL = sumNum('pesoL');
  field(doc, 2.92, t, 3.56, 0.64, 'QUANTIDADE', qVol ? String(qVol) : '', { valueAlign: 'right' });
  field(doc, 6.48, t, 3.81, 0.64, 'ESPÉCIE', v[0]?.esp ?? '');
  field(doc, 10.29, t, 4.19, 0.64, 'MARCA', v[0]?.marca ?? '');
  field(doc, 14.48, t, 5.08, 0.64, 'NUMERAÇÃO', v[0]?.nVol ?? '');
  field(doc, 19.56, t, 5.08, 0.64, 'PESO BRUTO', pesoB ? formatQty(pesoB) : '', {
    valueAlign: 'right',
  });
  field(doc, 24.64, t, 4.83, 0.64, 'PESO LÍQUIDO', pesoL ? formatQty(pesoL) : '', {
    valueAlign: 'right',
  });
  return top + TRANSP_H;
}

const HEADER_TITLES: ReadonlyArray<readonly [keyof ColsGeom, string]> = [
  ['codigo', 'Código Produto/Serviço'],
  ['descricao', 'Descrição Produto/Serviço'],
  ['ncm', 'NCM/SH'],
  ['cfop', 'CFOP'],
  ['cson', 'CST/CSOSN'],
  ['un', 'UN'],
  ['qtd', 'QTD'],
  ['vUn', 'V. UNIT'],
  ['vDesc', 'V. DESC'],
  ['vProd', 'V. LIQ'],
  ['vBcIcms', 'BC ICMS'],
  ['vIcms', 'V. ICMS'],
  ['pIcms', 'A. ICMS'],
  ['vIpi', 'V. IPI'],
  ['pIpi', 'A. IPI'],
];

/** Produtos table column header row. Returns y below the header. */
function drawProdutosHeader(doc: Doc, cols: ColsGeom, top: number): number {
  for (const [key, title] of HEADER_TITLES) {
    const c = cols[key] as Col;
    headerCell(doc, c.left, top, c.w, ROW_H, title);
  }
  return top + ROW_H;
}

/** One produto row at `top` of height `rowH`. */
function drawProdutoRow(
  doc: Doc,
  item: DanfeItem,
  cols: ColsGeom,
  top: number,
  rowH: number,
  hasGtin: boolean,
): void {
  const desc = hasGtin ? `EAN: ${item.cEAN}\n${item.xProd}` : item.xProd;
  cell(doc, cols.codigo.left, top, cols.codigo.w, rowH, item.cProd, { align: 'center' });
  cell(doc, cols.descricao.left, top, cols.descricao.w, rowH, desc, { lines: hasGtin ? 2 : 1 });
  cell(doc, cols.ncm.left, top, cols.ncm.w, rowH, item.ncm, { align: 'center' });
  cell(doc, cols.cfop.left, top, cols.cfop.w, rowH, item.cfop, { align: 'center' });
  cell(doc, cols.cson.left, top, cols.cson.w, rowH, item.cstCsosn, { align: 'center' });
  cell(doc, cols.un.left, top, cols.un.w, rowH, item.uCom, { align: 'center' });
  cell(doc, cols.qtd.left, top, cols.qtd.w, rowH, formatQty(item.qCom), { align: 'right' });
  cell(doc, cols.vUn.left, top, cols.vUn.w, rowH, item.vUnCom, { money: true });
  cell(doc, cols.vDesc.left, top, cols.vDesc.w, rowH, item.vDesc, { money: true });
  cell(doc, cols.vProd.left, top, cols.vProd.w, rowH, item.vProd, { money: true });
  cell(doc, cols.vBcIcms.left, top, cols.vBcIcms.w, rowH, item.vBcIcms, { money: true });
  cell(doc, cols.vIcms.left, top, cols.vIcms.w, rowH, item.vIcms, { money: true });
  cell(doc, cols.pIcms.left, top, cols.pIcms.w, rowH, item.pIcms, { money: true });
  cell(doc, cols.vIpi.left, top, cols.vIpi.w, rowH, item.vIpi, { money: true });
  cell(doc, cols.pIpi.left, top, cols.pIpi.w, rowH, item.pIpi, { money: true });
}

/**
 * Cálculo do ISSQN block (once, above the dados box on the last produtos page).
 * Anchored to the page's `left` and computed from it (the last produtos page may
 * be a later page, where the layout has expanded left), the last box closing the
 * row at `RIGHT`.
 */
function drawIssqn(doc: Doc, model: DanfeModel, left: number, top: number): void {
  if (!model.issqn) return;
  groupTitleVertical(doc, left, top, TITLE_W, ISSQN_H, 'ISSQN');
  const x0 = left + TITLE_W;
  const w = 6.6;
  field(doc, x0, top, w, ISSQN_H, 'INSCRIÇÃO MUNICIPAL', model.emit.im ?? '');
  field(doc, x0 + w, top, w, ISSQN_H, 'VALOR TOTAL DOS SERVIÇOS', model.issqn.vServ, {
    money: true,
  });
  field(doc, x0 + 2 * w, top, w, ISSQN_H, 'BASE DE CÁLCULO DO ISSQN', model.issqn.vBC, {
    money: true,
  });
  field(doc, x0 + 3 * w, top, RIGHT - (x0 + 3 * w), ISSQN_H, 'VALOR DO ISSQN', model.issqn.vISS, {
    money: true,
  });
}

/**
 * Draw the DADOS ADICIONAIS block at `top` with the given box height: the
 * vertical group title, the INFORMAÇÕES COMPLEMENTARES chunk (pre-sized to fit,
 * no ellipsis) + the RESERVADO AO FISCO box (infAdFisco only on the first page).
 */
function drawDadosAdicionais(
  doc: Doc,
  top: number,
  boxHCm: number,
  complChunk: string,
  infAdFisco: string,
  page1: boolean,
): void {
  const titleLeft = page1 ? LEFT_P1 : LEFT_PN;
  const complLeft = page1 ? COMPL_X_P1 : COMPL_X_PN;
  const complW = page1 ? COMPL_W_P1 : COMPL_W_PN;
  groupTitleVertical(doc, titleLeft, top, TITLE_W, boxHCm, 'DADOS ADICIONAIS');
  strokeBox(doc, cm(complLeft), cm(top), cm(complW), cm(boxHCm));
  text(doc, 'INFORMAÇÕES COMPLEMENTARES', cm(complLeft) + 2, cm(top) + 2, {
    size: 5,
    width: cm(complW) - 4,
    lineBreak: false,
  });
  if (complChunk) {
    text(doc, complChunk, cm(complLeft) + 2, cm(top) + 9, {
      size: 6,
      width: cm(complW) - 4,
      upper: false,
      lineBreak: true,
      height: cm(boxHCm) - 10,
    });
  }
  strokeBox(doc, cm(FISCO_X), cm(top), cm(FISCO_W), cm(boxHCm));
  text(doc, 'RESERVADO AO FISCO', cm(FISCO_X) + 2, cm(top) + 2, {
    size: 5,
    width: cm(FISCO_W) - 4,
    lineBreak: false,
  });
  if (infAdFisco) {
    text(doc, infAdFisco, cm(FISCO_X) + 2, cm(top) + 9, {
      size: 6,
      width: cm(FISCO_W) - 4,
      upper: false,
      lineBreak: true,
      height: cm(boxHCm) - 10,
    });
  }
}

/** Height (cm) the fatura+duplicatas block will consume on page 1. */
function faturaDupHeight(model: DanfeModel): number {
  let h = 0;
  if (model.fat) h += 0.64;
  if (model.dup.length > 0) h += Math.ceil(model.dup.length / 6) * 0.64;
  return h;
}

/**
 * A rendered page: produtos rows + its dados slice, or a continuation page that
 * carries only more of the infCpl (the dados box grows up into blank space).
 */
type PagePlan =
  | { kind: 'produtos'; rows: number; hasIssqn: boolean; dadosBoxHCm: number; dadosChunk: string }
  | { kind: 'continuation'; dadosBoxHCm: number; dadosChunk: string };

export async function renderPaisagem(
  model: DanfeModel,
  opts: RenderA4Options = {},
): Promise<Buffer> {
  const cancelada = opts.cancelada ?? false;
  const hasGtin = model.itens.some((i) => i.cEAN !== 'SEM GTIN' && i.cEAN !== '');
  const rowH = hasGtin ? 1.26 : 0.84;

  // Page-1 header height (the blocks above the produtos table) → table top.
  let headerH = CABECALHO_H + DEST_H;
  if (model.entrega) headerH += LOCAL_H;
  if (model.retirada) headerH += LOCAL_H;
  headerH += faturaDupHeight(model) + IMPOSTO_H + TRANSP_H;
  const produtosHeaderTop1 = TOP + headerH;
  const rowsTop1 = produtosHeaderTop1 + ROW_H;
  const rowsTopN = PRODUTOS_HEADER_TOP_PN + ROW_H;

  // Every page reserves the dados-adicionais footer; the last produtos page
  // additionally reserves the ISSQN block.
  const issqnReserve = model.issqn ? ISSQN_H + 0.1 : 0;
  const bottomEvery = PAGE_BOTTOM - DADOS_MIN_H;
  const rowsFor = (top: number, extra: number): number =>
    Math.max(1, Math.floor((bottomEvery - extra - top) / rowH));
  const slices = paginate(
    model.itens.length,
    rowsFor(rowsTop1, 0),
    rowsFor(rowsTop1, issqnReserve),
    rowsFor(rowsTopN, 0),
    rowsFor(rowsTopN, issqnReserve),
  );

  const barcodePng = await code128Png(model.chave);
  const { doc, done } = createPdf([cm(PAGE_W), cm(PAGE_H)]);
  const innerWidthPt = cm(COMPL_W_P1) - 4;

  // ---- Measuring pass: assign infCpl chunks to produtos pages (using each
  // page's blank space), then spill the rest onto continuation pages. ----
  const plans: PagePlan[] = [];
  let remaining = composeInfoComplementares(model);
  for (let p = 0; p < slices.length; p++) {
    const headerTop = p === 0 ? produtosHeaderTop1 : PRODUTOS_HEADER_TOP_PN;
    const isLast = p === slices.length - 1;
    const hasIssqn = isLast && model.issqn != null;
    const dadosTop = headerTop + ROW_H + slices[p]! * rowH + 0.1 + (hasIssqn ? ISSQN_H + 0.1 : 0);
    const avail = cm(PAGE_BOTTOM - dadosTop);
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
  const contDadosTop = PRODUTOS_HEADER_TOP_PN; // below the emitente strip on continuation pages
  while (remaining.length > 0) {
    const avail = cm(PAGE_BOTTOM - contDadosTop);
    const { chunk, boxHCm, rest } = measureSplit(doc, remaining, innerWidthPt, avail, SPLIT_OPTS);
    plans.push({ kind: 'continuation', dadosBoxHCm: boxHCm, dadosChunk: chunk });
    remaining = rest;
  }
  const totalPages = plans.length;

  // ---- Render pass. ----
  const infAdFisco = model.infAdic.infAdFisco ?? '';
  let itemIdx = 0;
  for (let i = 0; i < plans.length; i++) {
    if (i > 0) doc.addPage();
    pageWatermark(doc, model, cancelada, cm(PAGE_W), cm(PAGE_H));
    const plan = plans[i]!;
    const page1 = i === 0;
    const left = page1 ? LEFT_P1 : LEFT_PN;
    if (page1) {
      drawCanhoto(doc, model);
      drawEmitente(doc, model, barcodePng, left, 1, totalPages);
      let y = drawDestinatario(doc, model, TOP + CABECALHO_H);
      if (model.entrega) y = drawLocal(doc, model.entrega, 'INFORMAÇÕES DO LOCAL DE ENTREGA', y);
      if (model.retirada) y = drawLocal(doc, model.retirada, 'INFORMAÇÕES DO LOCAL DE RETIRADA', y);
      y = drawFaturaDup(doc, model, y);
      y = drawImposto(doc, model, y);
      drawTransporte(doc, model, y);
    } else {
      drawEmitente(doc, model, barcodePng, left, i + 1, totalPages);
    }

    let y: number;
    if (plan.kind === 'produtos') {
      const cols = colsFor(left, page1);
      const headerTop = page1 ? produtosHeaderTop1 : PRODUTOS_HEADER_TOP_PN;
      const tableH = ROW_H + plan.rows * rowH;
      groupTitleVertical(doc, cols.titleLeft, headerTop, TITLE_W, tableH, 'PROD./ SERV.');
      y = drawProdutosHeader(doc, cols, headerTop);
      for (let r = 0; r < plan.rows; r++) {
        drawProdutoRow(doc, model.itens[itemIdx]!, cols, y, rowH, hasGtin);
        y += rowH;
        itemIdx += 1;
      }
      if (plan.hasIssqn) {
        drawIssqn(doc, model, left, y + 0.1);
        y += 0.1 + ISSQN_H;
      }
    } else {
      y = PRODUTOS_HEADER_TOP_PN;
    }
    // The dados block frame sits on every page; infAdFisco only on the first.
    drawDadosAdicionais(
      doc,
      y + 0.1,
      plan.dadosBoxHCm,
      plan.dadosChunk,
      page1 ? infAdFisco : '',
      page1,
    );
  }

  doc.end();
  return done;
}
