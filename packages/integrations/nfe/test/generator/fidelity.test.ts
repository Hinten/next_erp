/**
 * XML fidelity test — every value handed to `generateNFe` must survive
 * serialization unchanged (modulo two allowed transforms in free-text
 * fields: diacritics stripping + XML-significant character escaping).
 *
 * Why this matters: a regression in META, the serializer, the tribute
 * dispatcher, or the raw-splice path could silently round-trip a wrong
 * number — a fiscal nightmare that no other test would catch. Unit
 * tests cover each layer in isolation; this test asserts the
 * end-to-end contract callers actually depend on.
 *
 * Covered:
 *   (a) Primitive caller inputs at canonical positions
 *       (nNF, serie, CNPJ/IE, CEP, natOp, …).
 *   (b) Per-item fields with the right decimal precision
 *       (qCom 4dp, vUnCom 10dp, vProd 2dp, cProd / NCM / CFOP).
 *   (c) Raw-splice contracts — `impostoXml` / `totalXml` / `transpXml`
 *       / `pagXml` appear byte-for-byte inside the output.
 *   (d) Homologação override — `dest.xNome` is replaced (not the input);
 *       all other caller fields still reflect the input.
 *   (e) Deterministic chave — a fixed `cNF` produces a chave whose
 *       composition + mod-11 DV are exactly the documented shape.
 */
import { describe, it, expect } from 'vitest';
import type { Cliente, Endereco, Filial, Operacao } from '@delfrance/schemas';

import { generateNFe } from '../../src/generator/index';
import { HOMOLOGACAO_XNOME } from '../../src/generator/parties';
import { parse } from '../../src/xml';
import { NFeXsdValidationError, validateXsd } from '../../src/xsd';
import type { GeneratorInput, GeneratorItem } from '../../src/generator/types';
import {
  IND_INTERMED_OPERACAO,
  IND_PRES_OPERACAO,
  TIPO_CLIENTE,
  UF_SIGLA,
} from '@delfrance/schemas';

// ---------------------------------------------------------------------------
// Sentinel fixture — every distinct, recognisable value
// ---------------------------------------------------------------------------

const SENT_NUMERACAO = 12345;
const SENT_SERIE = 3;
const SENT_CNPJ_EMIT = '14200166000187';
const SENT_IE_EMIT = '111111111111';
const SENT_CMUN_EMIT = '3550308';
const SENT_CEP_EMIT = '01001000';
const SENT_CEP_DEST = '04504010';
const SENT_NAT_OP = 'Venda de mercadoria';
const SENT_CLIENTE_NOME = 'Distribuidora André & Cia. Ltda.';
const SENT_CLIENTE_NOME_SANITIZED = 'Distribuidora Andre &amp; Cia. Ltda.';
const SENT_CLIENTE_CNPJ = '99999999000191';
const SENT_FIXED_CNF = '00000042';

// Free-text address + contact fields. These are historically tricky in
// the SEFAZ XSD: `complemento` (xCpl) goes through sanitizeNFeText which
// strips a long list of restricted chars; `email` is also free-text but
// MUST keep `@` and `.` — the test asserts both flow through verbatim.
const SENT_EMIT_CPL = 'Sala 12 Andar 3';
const SENT_DEST_CPL = 'Apto 101 Bloco B';
const SENT_CLIENTE_EMAIL = 'cliente.teste@example.com';
const SENT_CLIENTE_ISUF = '123456789';

const SENT_FILIAL: Filial = {
  razaoSocial: 'ACME RAZAO SOCIAL LTDA',
  fantasia: null,
  cnae: null,
  cnpj: SENT_CNPJ_EMIT,
  ie: SENT_IE_EMIT,
  iest: null,
  imun: null,
  sede: {
    idExterno: null,
    logradouro: 'Rua Emit',
    numero: '10',
    bairro: 'Centro Emit',
    complemento: SENT_EMIT_CPL,
    cep: SENT_CEP_EMIT,
    codigoMunicipio: SENT_CMUN_EMIT,
    cidade: 'Sao Paulo',
    estado: UF_SIGLA.SP,
    cPais: '1058',
    pais: 'BRASIL',
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
    timestamp: null,
  },
};

const SENT_CLIENTE: Cliente = {
  tipo: TIPO_CLIENTE.pessoaJuridica,
  nome: SENT_CLIENTE_NOME,
  cpf_cnpj: SENT_CLIENTE_CNPJ,
  idEstrangeiro: null,
  ie: '222222222',
  imun: null,
  isUF: SENT_CLIENTE_ISUF,
  email: SENT_CLIENTE_EMAIL,
  telefone: null,
  observacoesInternas: null,
  timestamp: null,
  nome_embedding: null,
  telefone_embedding: null,
  userCliente: null,
  idMercadoLivre: null,
};

const SENT_ENDERECO_DEST: Endereco = {
  idExterno: null,
  logradouro: 'Av Dest',
  numero: '500',
  bairro: 'Bairro Dest',
  complemento: SENT_DEST_CPL,
  cep: SENT_CEP_DEST,
  codigoMunicipio: SENT_CMUN_EMIT,
  cidade: 'Sao Paulo',
  estado: UF_SIGLA.SP,
  cPais: '1058',
  pais: 'BRASIL',
  nome: null,
  cpf_cnpj: null,
  rg: null,
  ie: null,
  imun: null,
  email: null,
  telefone: null,
  timestamp: null,
};

const SENT_OPERACAO: Operacao = {
  nome: 'Venda',
  naturezaDaOperacao: SENT_NAT_OP,
  tipo: 1,
  ehServico: false,
  ehExterior: false,
  ehConsumidorFinal: false,
  padrao: false,
  ativo: true,
  movimentaEstoque: true,
  movimentaIndisponivelEstoque: true,
  ehFiscal: true,
  finNFe: 1,
  indPres: IND_PRES_OPERACAO.naoPresencialInternet,
  indIntermed: IND_INTERMED_OPERACAO.semIntermediador,
  cfop: '5102',
  cfopInterestadual: '6102',
  NCM: null,
  CEST: null,
  unidade: null,
  infCpl: null,
};

const SENT_IMPOSTO_XML_A =
  '<imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto>';
const SENT_IMPOSTO_XML_B =
  '<imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><PIS><PISNT><CST>04</CST></PISNT></PIS><COFINS><COFINSNT><CST>04</CST></COFINSNT></COFINS></imposto>';

// Item A: high-precision values so each leaf is unmistakeable.
const ITEM_A: GeneratorItem = {
  nItem: 1,
  cProd: 'SKU-A',
  cEAN: 'SEM GTIN',
  xProd: 'Produto A',
  NCM: '87120000',
  CFOP: '5102',
  uCom: 'UN',
  qCom: 1.2345,
  vUnCom: 12.345,
  vProd: 15.24,
  cEANTrib: 'SEM GTIN',
  uTrib: 'UN',
  qTrib: 1.2345,
  vUnTrib: 12.345,
  impostoXml: SENT_IMPOSTO_XML_A,
};

// Item B: distinct shape (whole numbers, different SKU/CFOP).
const ITEM_B: GeneratorItem = {
  nItem: 2,
  cProd: 'SKU-B',
  cEAN: 'SEM GTIN',
  xProd: 'Produto B',
  NCM: '61091000',
  CFOP: '5405',
  uCom: 'PC',
  qCom: 3,
  vUnCom: 99.99,
  vProd: 299.97,
  cEANTrib: 'SEM GTIN',
  uTrib: 'PC',
  qTrib: 3,
  vUnTrib: 99.99,
  impostoXml: SENT_IMPOSTO_XML_B,
};

const SENT_TOTAL_XML =
  '<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>315.21</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>315.21</vNF></ICMSTot></total>';

const SENT_TRANSP_XML = '<transp><modFrete>9</modFrete></transp>';

const SENT_PAG_XML = '<pag><detPag><tPag>17</tPag><vPag>315.21</vPag></detPag></pag>';

function buildInput(overrides: Partial<GeneratorInput> = {}): GeneratorInput {
  // Default to homologação — fixtures must never default to produção
  // even in offline tests, to avoid setting a bad-precedent if the
  // fixture is copied elsewhere. The one produção-specific assertion
  // (cliente.nome sanitization survives) opts in explicitly.
  return {
    ambiente: 'homologacao',
    numeracao: SENT_NUMERACAO,
    serie: SENT_SERIE,
    tpEmis: 1,
    // Explicit instant — deterministic on any runner TZ (#395).
    dhEmi: new Date('2026-05-20T10:30:00-03:00'),
    filial: SENT_FILIAL,
    operacao: SENT_OPERACAO,
    cliente: SENT_CLIENTE,
    enderecoDest: SENT_ENDERECO_DEST,
    itens: [ITEM_A, ITEM_B],
    totalXml: SENT_TOTAL_XML,
    transpXml: SENT_TRANSP_XML,
    pagXml: SENT_PAG_XML,
    cNF: SENT_FIXED_CNF,
    ...overrides,
  };
}

/**
 * Pull the inner content of `<parent>…</parent>` so per-scope field
 * assertions don't collide with same-named fields in other scopes
 * (e.g. `cMun` appears under both `enderEmit` and `enderDest`).
 */
function scope(xml: string, parent: string): string {
  const open = `<${parent}>`;
  const close = `</${parent}>`;
  const start = xml.indexOf(open);
  const end = xml.indexOf(close, start);
  if (start === -1 || end === -1) {
    throw new Error(`scope: <${parent}>…</${parent}> not found in XML`);
  }
  return xml.slice(start + open.length, end);
}

function expectField(xml: string, parent: string, field: string, expected: string): void {
  const block = scope(xml, parent);
  expect(block).toContain(`<${field}>${expected}</${field}>`);
}

// ---------------------------------------------------------------------------
// (a) Primitive caller inputs at canonical positions
// ---------------------------------------------------------------------------

describe('fidelity — primitives (caller inputs at canonical positions)', () => {
  const out = generateNFe(buildInput());

  it('numeracao → <nNF> inside <ide>', () => {
    expectField(out.nfeXml, 'ide', 'nNF', String(SENT_NUMERACAO));
  });

  it('serie → <serie> inside <ide>', () => {
    expectField(out.nfeXml, 'ide', 'serie', String(SENT_SERIE));
  });

  it('operacao.naturezaDaOperacao → <natOp> inside <ide>', () => {
    expectField(out.nfeXml, 'ide', 'natOp', SENT_NAT_OP);
  });

  it('filial.cnpj → <CNPJ> inside <emit>', () => {
    expectField(out.nfeXml, 'emit', 'CNPJ', SENT_CNPJ_EMIT);
  });

  it('filial.ie → <IE> inside <emit>', () => {
    expectField(out.nfeXml, 'emit', 'IE', SENT_IE_EMIT);
  });

  it('filial.sede.cep → <CEP> inside <enderEmit>', () => {
    expectField(out.nfeXml, 'enderEmit', 'CEP', SENT_CEP_EMIT);
  });

  it('filial.sede.codigoMunicipio → <cMun> inside <enderEmit>', () => {
    expectField(out.nfeXml, 'enderEmit', 'cMun', SENT_CMUN_EMIT);
  });

  it('enderecoDest.cep → <CEP> inside <enderDest>', () => {
    expectField(out.nfeXml, 'enderDest', 'CEP', SENT_CEP_DEST);
  });

  it('cliente.cpf_cnpj (tipo=1) → <CNPJ> at the head of <dest>', () => {
    // dest contains a top-level <CNPJ> at the start (XSD choice 4) and an
    // <enderDest> further down. Scope to the slice BEFORE enderDest so an
    // accidental match inside enderDest can't satisfy the assertion.
    const destBlock = scope(out.nfeXml, 'dest');
    const enderStart = destBlock.indexOf('<enderDest>');
    const head = enderStart === -1 ? destBlock : destBlock.slice(0, enderStart);
    expect(head).toContain(`<CNPJ>${SENT_CLIENTE_CNPJ}</CNPJ>`);
  });

  it('filial.sede.complemento → <xCpl> inside <enderEmit>', () => {
    // Free-text address line. Often clipped by an over-eager sanitizer
    // — verbatim survival here proves the generator preserves the raw
    // value when it contains no restricted characters.
    expectField(out.nfeXml, 'enderEmit', 'xCpl', SENT_EMIT_CPL);
  });

  it('enderecoDest.complemento → <xCpl> inside <enderDest>', () => {
    expectField(out.nfeXml, 'enderDest', 'xCpl', SENT_DEST_CPL);
  });

  it('cliente.email → <email> inside <dest> with `@` preserved', () => {
    // email is the canonical tricky free-text field: the XSD requires the
    // `@`, but the generic sanitizer strips `@`. The generator must route
    // emails around the restricted-char filter — assert verbatim survival.
    expectField(out.nfeXml, 'dest', 'email', SENT_CLIENTE_EMAIL);
  });

  it('cliente.isUF → <ISUF> inside <dest>, in XSD element order', () => {
    expectField(out.nfeXml, 'dest', 'ISUF', SENT_CLIENTE_ISUF);
    // The serializer orders by META, not by object key, and the XSD sequence is
    // indIEDest → IE → ISUF → IM. Asserting the value alone would pass even if
    // ISUF were emitted in the wrong slot, which the XSD gate rejects.
    const dest = out.nfeXml.slice(out.nfeXml.indexOf('<dest>'), out.nfeXml.indexOf('</dest>'));
    expect(dest.indexOf('<ISUF>')).toBeGreaterThan(dest.indexOf('<IE>'));
  });
});

// ---------------------------------------------------------------------------
// (b) Per-item fields with the right decimal precision
// ---------------------------------------------------------------------------

describe('fidelity — per-item fields (precision + position)', () => {
  const out = generateNFe(buildInput());
  // Each <det> nests a <prod>; scope to each in turn.
  const detA = out.nfeXml.slice(
    out.nfeXml.indexOf('<det nItem="1">'),
    out.nfeXml.indexOf('</det>') + '</det>'.length,
  );
  const detB = out.nfeXml.slice(
    out.nfeXml.indexOf('<det nItem="2">'),
    out.nfeXml.lastIndexOf('</det>') + '</det>'.length,
  );

  it('item A: cProd, NCM, CFOP, uCom appear inside <det nItem="1">', () => {
    expect(detA).toContain(`<cProd>${ITEM_A.cProd}</cProd>`);
    expect(detA).toContain(`<NCM>${ITEM_A.NCM}</NCM>`);
    expect(detA).toContain(`<CFOP>${ITEM_A.CFOP}</CFOP>`);
    expect(detA).toContain(`<uCom>${ITEM_A.uCom}</uCom>`);
  });

  it('item A: qCom formatted at 4 decimals', () => {
    expect(detA).toContain('<qCom>1.2345</qCom>');
  });

  it('item A: vUnCom formatted at 10 decimals', () => {
    expect(detA).toContain('<vUnCom>12.3450000000</vUnCom>');
  });

  it('item A: vProd formatted at 2 decimals', () => {
    expect(detA).toContain('<vProd>15.24</vProd>');
  });

  it('item A: cEAN "SEM GTIN" preserved verbatim', () => {
    expect(detA).toContain('<cEAN>SEM GTIN</cEAN>');
    expect(detA).toContain('<cEANTrib>SEM GTIN</cEANTrib>');
  });

  it('item B: distinct cProd, CFOP, qCom (3.0000), vUnCom (99.9900000000) in <det nItem="2">', () => {
    expect(detB).toContain('<cProd>SKU-B</cProd>');
    expect(detB).toContain('<CFOP>5405</CFOP>');
    expect(detB).toContain('<qCom>3.0000</qCom>');
    expect(detB).toContain('<vUnCom>99.9900000000</vUnCom>');
    expect(detB).toContain('<vProd>299.97</vProd>');
  });

  it('det count + nItem ordering match the input array', () => {
    // Two <det> elements, sequential nItem.
    const detOpens = out.nfeXml.match(/<det nItem="\d+">/g) ?? [];
    expect(detOpens).toEqual(['<det nItem="1">', '<det nItem="2">']);
  });
});

// ---------------------------------------------------------------------------
// (c) Raw-splice contracts (byte-for-byte)
// ---------------------------------------------------------------------------

describe('fidelity — raw-splice contracts', () => {
  const out = generateNFe(buildInput());

  it('item A impostoXml appears byte-for-byte inside the output', () => {
    expect(out.nfeXml.includes(SENT_IMPOSTO_XML_A)).toBe(true);
  });

  it('item B impostoXml appears byte-for-byte', () => {
    expect(out.nfeXml.includes(SENT_IMPOSTO_XML_B)).toBe(true);
  });

  it('totalXml appears byte-for-byte', () => {
    expect(out.nfeXml.includes(SENT_TOTAL_XML)).toBe(true);
  });

  it('transpXml appears byte-for-byte', () => {
    expect(out.nfeXml.includes(SENT_TRANSP_XML)).toBe(true);
  });

  it('pagXml appears byte-for-byte', () => {
    expect(out.nfeXml.includes(SENT_PAG_XML)).toBe(true);
  });

  it('canonical block order: ide → emit → dest → det → total → transp → pag', () => {
    const positions = [
      '<ide>',
      '<emit>',
      '<dest>',
      '<det nItem="1">',
      '<total>',
      '<transp>',
      '<pag>',
    ].map((tag) => out.nfeXml.indexOf(tag));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// (d-pre) Produção sanitization — cliente.nome flows through with accents
// stripped and `&` left raw (the XML serializer escapes it). This is the
// one path the homologação default can't exercise (it replaces xNome).
// ---------------------------------------------------------------------------

describe('fidelity — produção sanitization', () => {
  it('produção: cliente.nome → sanitised <xNome> inside <dest>', () => {
    const out = generateNFe(buildInput({ ambiente: 'producao' }));
    expectField(out.nfeXml, 'dest', 'xNome', SENT_CLIENTE_NOME_SANITIZED);
    expectField(out.nfeXml, 'ide', 'tpAmb', '1');
  });
});

// ---------------------------------------------------------------------------
// (d) Homologação override is the ONLY field that doesn't reflect the input
// ---------------------------------------------------------------------------

describe('fidelity — homologação override', () => {
  const out = generateNFe(buildInput({ ambiente: 'homologacao' }));

  it('dest.xNome is replaced with the SEFAZ homologação literal', () => {
    expectField(out.nfeXml, 'dest', 'xNome', HOMOLOGACAO_XNOME);
    // The real cliente nome must NOT leak through.
    expect(out.nfeXml).not.toContain('Andre');
    expect(out.nfeXml).not.toContain('Distribuidora');
  });

  it('ide.tpAmb flips to "2" in homologação', () => {
    expectField(out.nfeXml, 'ide', 'tpAmb', '2');
  });

  it('emit.xNome still reflects the real filial razão social', () => {
    expectField(out.nfeXml, 'emit', 'xNome', SENT_FILIAL.razaoSocial);
  });

  it('all other caller fields still reflect the input (numeracao, CNPJs, CFOPs)', () => {
    expectField(out.nfeXml, 'ide', 'nNF', String(SENT_NUMERACAO));
    expectField(out.nfeXml, 'emit', 'CNPJ', SENT_CNPJ_EMIT);
    expect(out.nfeXml).toContain(`<CFOP>${ITEM_A.CFOP}</CFOP>`);
    expect(out.nfeXml).toContain(`<CFOP>${ITEM_B.CFOP}</CFOP>`);
  });
});

// ---------------------------------------------------------------------------
// (e) Deterministic chave + structural round-trip via parse()
// ---------------------------------------------------------------------------

describe('fidelity — deterministic chave + structural round-trip', () => {
  it('fixed cNF produces the documented 44-digit chave with mod-11 DV', () => {
    const out = generateNFe(buildInput());
    expect(out.cNF).toBe(SENT_FIXED_CNF);
    expect(out.chave).toMatch(/^\d{44}$/);
    // cUF=35, AAMM=2605, CNPJ=14200166000187, mod=55, serie=003,
    // nNF=000012345, tpEmis=1, cNF=00000042 → 43 digits below.
    expect(out.chave.slice(0, 43)).toBe('3526051420016600018755003000012345100000042');
    // The Id attribute MUST be "NFe" + the full 44-digit chave.
    expect(out.nfeXml).toContain(`<infNFe Id="NFe${out.chave}" versao="4.00">`);
  });

  it('parse(NFe) round-trips the structural fields back to the input shape', () => {
    const out = generateNFe(buildInput());
    const parsed = parse<{
      infNFe: { ide: { nNF: string; serie: string; cNF: string; cDV: string } };
    }>('NFe', out.nfeXml);
    expect(parsed.infNFe.ide.nNF).toBe(String(SENT_NUMERACAO));
    expect(parsed.infNFe.ide.serie).toBe(String(SENT_SERIE));
    expect(parsed.infNFe.ide.cNF).toBe(SENT_FIXED_CNF);
    expect(parsed.infNFe.ide.cDV).toBe(out.chave.slice(-1));
  });
});

// ---------------------------------------------------------------------------
// (f) Endereço + party-name maxLength truncation
//     Marketplace data routinely overflows the XSD facets for these fields;
//     the sanitiser truncates them at 60 so SEFAZ never sees an over-limit
//     value. This block replaces the live oversize-complemento probe that
//     used to live in emission.homologacao.test.ts — same intent, offline.
// ---------------------------------------------------------------------------

const SENT_OVERSIZE_TEXT_120 =
  'Apto 101 Bloco B - referencia: ao lado do mercado, atras da igreja, antes da padaria, perto do parque, num predio antigo';
const SENT_OVERSIZE_NOME_100 =
  'Distribuidora de Materiais de Construcao e Ferragens do Vale do Paraiba Industria e Comercio Ltda ME';
const SENT_OVERSIZE_NRO_100 =
  '12345 67890 ABCDEF GHIJKL MNOPQR STUVWX YZ - referencia secundaria do imovel para entrega rapida';

/** Pull the inner text of a leaf element. Fails the test loudly if missing. */
function extractLeaf(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = xml.match(re);
  if (!m || m[1] == null) {
    throw new Error(`extractLeaf: <${tag}>…</${tag}> not found`);
  }
  return m[1];
}

describe('fidelity — endereço + name maxLength truncation', () => {
  it('xCpl (complemento) is truncated to 60 chars', () => {
    const out = generateNFe(
      buildInput({
        enderecoDest: { ...SENT_ENDERECO_DEST, complemento: SENT_OVERSIZE_TEXT_120 },
      }),
    );
    const xCpl = extractLeaf(scope(out.nfeXml, 'enderDest'), 'xCpl');
    expect(xCpl.length).toBeLessThanOrEqual(60);
    expect(SENT_OVERSIZE_TEXT_120).toContain(xCpl);
  });

  it('xLgr (logradouro) is truncated to 60 chars', () => {
    const out = generateNFe(
      buildInput({
        enderecoDest: { ...SENT_ENDERECO_DEST, logradouro: SENT_OVERSIZE_TEXT_120 },
      }),
    );
    const xLgr = extractLeaf(scope(out.nfeXml, 'enderDest'), 'xLgr');
    expect(xLgr.length).toBeLessThanOrEqual(60);
    expect(SENT_OVERSIZE_TEXT_120).toContain(xLgr);
  });

  it('nro (numero) is truncated to 60 chars', () => {
    const out = generateNFe(
      buildInput({
        enderecoDest: { ...SENT_ENDERECO_DEST, numero: SENT_OVERSIZE_NRO_100 },
      }),
    );
    const nro = extractLeaf(scope(out.nfeXml, 'enderDest'), 'nro');
    expect(nro.length).toBeLessThanOrEqual(60);
    expect(SENT_OVERSIZE_NRO_100).toContain(nro);
  });

  it('cliente.nome → <dest><xNome> is truncated to 60 chars in produção', () => {
    // Homologação overrides xNome with the SEFAZ-mandated literal
    // HOMOLOGACAO_XNOME (covered by an earlier fidelity block), so the
    // truncation path only runs in produção.
    const out = generateNFe(
      buildInput({
        ambiente: 'producao',
        cliente: { ...SENT_CLIENTE, nome: SENT_OVERSIZE_NOME_100 },
      }),
    );
    const xNome = extractLeaf(scope(out.nfeXml, 'dest'), 'xNome');
    expect(xNome.length).toBeLessThanOrEqual(60);
    expect(SENT_OVERSIZE_NOME_100).toContain(xNome);
    // Sanity: this is NOT the homologação placeholder.
    expect(xNome).not.toBe(HOMOLOGACAO_XNOME);
  });
});

// ---------------------------------------------------------------------------
// (g) Fiscal fields fail loudly on overflow
//     `infCpl` / `infAdFisco` carry fiscally-significant text and MUST NOT
//     be silently truncated — a chopped-off legal notice is a fiscal hazard.
//     Contract: when over-filled, the pre-send XSD gate rejects with
//     NFeXsdValidationError instead of accepting a chopped document.
// ---------------------------------------------------------------------------

describe('fidelity — fiscal fields fail loudly on overflow', () => {
  it('infAdFisco > 2000 chars → validateXsd rejects with NFeXsdValidationError', async () => {
    const out = generateNFe(
      buildInput({
        infAdic: { infAdFisco: 'A'.repeat(2001), infCpl: undefined },
      }),
    );
    await expect(validateXsd('NFe', out.nfeXml)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('infCpl > 5000 chars → validateXsd rejects with NFeXsdValidationError', async () => {
    const out = generateNFe(
      buildInput({
        infAdic: { infAdFisco: undefined, infCpl: 'B'.repeat(5001) },
      }),
    );
    await expect(validateXsd('NFe', out.nfeXml)).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});

// ---------------------------------------------------------------------------
// (h) Optional structural blocks — cobr (billing) + exporta (export ops)
//     Both are NFe optional siblings of <pag> / <infAdic>. We assert the
//     blocks appear in the emitted XML in the right XSD position and
//     pass validateXsd('NFe', xml) end-to-end.
// ---------------------------------------------------------------------------

describe('fidelity — cobr (billing) block', () => {
  it('emits <cobr><fat><dup>… in XSD position between <transp> and <pag>', () => {
    const out = generateNFe(
      buildInput({
        cobr: {
          fat: {
            nFat: 'FAT-001',
            vOrig: '1500.00',
            vDesc: '0.00',
            vLiq: '1500.00',
          },
          dup: [
            { nDup: '001', dVenc: '2026-06-20', vDup: '750.00' },
            { nDup: '002', dVenc: '2026-07-20', vDup: '750.00' },
          ],
        },
      }),
    );
    // Structural position: <cobr> follows </transp> and precedes <pag>.
    // (We don't run validateXsd here — the generator emits an UNSIGNED
    // <NFe> and the XSD requires <Signature> as a sibling of <infNFe>.
    // The signed-XSD round-trip is exercised by the live emission test.)
    const transpEnd = out.nfeXml.indexOf('</transp>');
    const cobrStart = out.nfeXml.indexOf('<cobr>');
    const pagStart = out.nfeXml.indexOf('<pag>');
    expect(transpEnd).toBeGreaterThan(-1);
    expect(cobrStart).toBeGreaterThan(transpEnd);
    expect(pagStart).toBeGreaterThan(cobrStart);
    // Field-level checks.
    expectField(out.nfeXml, 'fat', 'nFat', 'FAT-001');
    expectField(out.nfeXml, 'fat', 'vOrig', '1500.00');
    expect(out.nfeXml).toContain(
      '<dup><nDup>001</nDup><dVenc>2026-06-20</dVenc><vDup>750.00</vDup></dup>',
    );
    expect(out.nfeXml).toContain(
      '<dup><nDup>002</nDup><dVenc>2026-07-20</dVenc><vDup>750.00</vDup></dup>',
    );
  });

  it('omits <cobr> entirely when input.cobr is undefined', () => {
    const out = generateNFe(buildInput());
    expect(out.nfeXml).not.toContain('<cobr>');
  });
});

describe('fidelity — exporta (export operation) block', () => {
  it('emits <exporta> in XSD position between <infAdic> and <infRespTec>', async () => {
    const out = generateNFe(
      buildInput({
        infAdic: { infCpl: 'Export to MERCOSUL — order #X-001', infAdFisco: undefined },
        exporta: {
          UFSaidaPais: 'PR',
          xLocExporta: 'FOZ DO IGUACU',
          xLocDespacho: 'CURITIBA',
        },
      }),
    );
    // Structural position: <exporta> follows </infAdic>.
    const infAdicEnd = out.nfeXml.indexOf('</infAdic>');
    const exportaStart = out.nfeXml.indexOf('<exporta>');
    expect(infAdicEnd).toBeGreaterThan(-1);
    expect(exportaStart).toBeGreaterThan(infAdicEnd);
    // Field-level checks.
    expectField(out.nfeXml, 'exporta', 'UFSaidaPais', 'PR');
    expectField(out.nfeXml, 'exporta', 'xLocExporta', 'FOZ DO IGUACU');
    expectField(out.nfeXml, 'exporta', 'xLocDespacho', 'CURITIBA');
  });

  it('omits <xLocDespacho> when not supplied', () => {
    const out = generateNFe(
      buildInput({
        exporta: { UFSaidaPais: 'RS', xLocExporta: 'URUGUAIANA' },
      }),
    );
    expect(out.nfeXml).toContain('<exporta>');
    expect(out.nfeXml).toContain('<UFSaidaPais>RS</UFSaidaPais>');
    expect(out.nfeXml).toContain('<xLocExporta>URUGUAIANA</xLocExporta>');
    expect(out.nfeXml).not.toContain('<xLocDespacho>');
  });

  it('omits <exporta> entirely when input.exporta is undefined', () => {
    const out = generateNFe(buildInput());
    expect(out.nfeXml).not.toContain('<exporta>');
  });
});

// ---------------------------------------------------------------------------
// (i) The <IE> elements are never free text
// ---------------------------------------------------------------------------

/**
 * `cliente.ie` is free text and carries the `IE_SENTINELA` tokens alongside
 * real inscrições. The reader used to emit it verbatim, so
 * `<IE>Não contribuinte</IE>` reached the signed XML and SEFAZ rejected the
 * note. Nothing about the sentinel vocabulary is enforced at write time, so
 * this is the pin: whatever a cliente holds, an `<IE>` that reaches the wire
 * is alphanumeric, and `dest`'s specifically is digits within the XSD's
 * `TIeDestNaoIsento` range.
 */
describe('fidelity — no <IE> element ever carries free text', () => {
  const allIeValues = (xml: string): string[] =>
    [...xml.matchAll(/<IE>([\s\S]*?)<\/IE>/g)].map((m) => m[1] ?? '');

  it.each([
    ['a real inscrição estadual', '222222222'],
    ['a punctuated inscrição estadual', '110.042.490.114'],
    ['the NAO CONTRIBUINTE sentinel', 'NAO CONTRIBUINTE'],
    ['a hand-typed não contribuinte', 'Não contribuinte'],
    ['the ISENTO sentinel', 'ISENTO'],
    ['no inscrição at all', null],
  ])('%s never leaks a non-alphanumeric <IE>', (_label, ie) => {
    const out = generateNFe(buildInput({ cliente: { ...SENT_CLIENTE, ie } }));
    const values = allIeValues(out.nfeXml);
    // emit always carries one; dest only for indIEDest='1'.
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("dest's <IE> matches the XSD TIeDestNaoIsento pattern [0-9]{2,14}", () => {
    const out = generateNFe(buildInput({ cliente: { ...SENT_CLIENTE, ie: '110.042.490.114' } }));
    const destBlock = scope(out.nfeXml, 'dest');
    const enderStart = destBlock.indexOf('<enderDest>');
    const tail = enderStart === -1 ? destBlock : destBlock.slice(enderStart);
    const values = allIeValues(tail);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^\d{2,14}$/);
  });

  // The signed end-to-end XSD pass for a sentinel-carrying cliente lives in
  // generator.test.ts, which already has the signing fixture — the XSD rejects
  // an unsigned <NFe> outright, so it cannot run here.
  it('omits <IE> from dest entirely for a sentinel', () => {
    const out = generateNFe(buildInput({ cliente: { ...SENT_CLIENTE, ie: 'Não contribuinte' } }));
    const destBlock = scope(out.nfeXml, 'dest');
    expect(destBlock).toContain('<indIEDest>9</indIEDest>');
    expect(allIeValues(destBlock)).toEqual([]);
  });
});
