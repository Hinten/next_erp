/**
 * Tribute engine tests.
 *
 * Each CSOSN variant + PIS/COFINS variant is built, embedded inside a
 * minimum-viable signed `<NFe>`, and round-tripped through
 * `validateXsd('NFe', signedXml)` — so XSD drift surfaces locally,
 * not as a SEFAZ cStat=215 in production.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import forge from 'node-forge';

import {
  computePisCofinsItemValues as rootComputePisCofinsItemValues,
  signNFe,
  validateXsd,
  type NFeCertificate,
} from '../../src/index';

import {
  aggregateISSQN,
  aggregateRetTrib,
  aggregateTotals,
  buildImpostoXml,
  buildIS,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  computePisCofinsItemValues,
  fmtMoney,
  fmtQuantity,
  fmtRate,
  fmtUnitValue,
  NFeTributeError,
  TributeFormatError,
  type ConfCOFINS,
  type ConfiguracaoICMS,
  type ConfiguracaoISRtc,
  type ConfiguracaoISSQN,
  type ConfPIS,
  type Imposto,
  type ModBCST,
  type Retencao,
  type TributeItem,
} from '../../src/tribute/index';
// Not on the barrel (only `buildPagXml` is) — reached directly so the typed
// <pag> value can be asserted without widening the package's public surface.
import { buildPagObject } from '../../src/tribute/pag';
import type {
  TNFe_infNFe_det_imposto_ICMS_ICMSSN201,
  TNFe_infNFe_det_imposto_ICMS_ICMSSN202,
  TNFe_infNFe_det_imposto_ICMS_ICMSSN900,
} from '../../src/types/nfe-schema';
import {
  confICMSSN500Schema,
  confICMSSN900Schema,
  CSOSN,
  CST_PIS_COFINS,
  IND_INCENTIVO,
  IND_ISS,
  MOD_BC,
  MOD_BCST,
  ORIGEM,
} from '@delfrance/schemas';

const CHAVE = '35260514200166000187550010000000071000000018';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

function fixtureCert(): NFeCertificate {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'TRIBUTE TEST' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    certificateDerBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    ),
    subjectCommonName: 'TRIBUTE TEST:99999999000191',
    cnpj: '99999999000191',
    notAfter: cert.validity.notAfter,
    pfxBuffer: Buffer.from(''),
    password: '',
  };
}

/**
 * Wrap an imposto/total/transp/pag set inside a signable <NFe>. The single
 * det's vProd is fixed at 1500.00; `det.qTrib` (default 1) sets its qCom/qTrib
 * and the matching unit price, so a per-unit PIS/COFINS fixture embeds a det
 * whose quantity equals its qBCProd (#509). The default is byte-identical to
 * the det this helper always emitted.
 */
function wrap(
  impostoXml: string,
  totalXml: string,
  transpXml: string,
  pagXml: string,
  det: { qTrib: number } = { qTrib: 1 },
): string {
  const quantidade = fmtQuantity('qTrib', det.qTrib);
  const valorUnitario = fmtUnitValue('vUnTrib', 1500 / det.qTrib);
  return (
    `<NFe xmlns="${NFE_NS}">` +
    `<infNFe Id="NFe${CHAVE}" versao="4.00">` +
    '<ide>' +
    '<cUF>35</cUF><cNF>00000001</cNF>' +
    '<natOp>Venda</natOp><mod>55</mod><serie>1</serie><nNF>7</nNF>' +
    '<dhEmi>2026-05-20T10:30:00-03:00</dhEmi>' +
    '<tpNF>1</tpNF><idDest>1</idDest><cMunFG>3550308</cMunFG>' +
    '<tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>8</cDV>' +
    '<tpAmb>2</tpAmb><finNFe>1</finNFe><indFinal>0</indFinal>' +
    '<indPres>2</indPres><indIntermed>0</indIntermed>' +
    '<procEmi>0</procEmi><verProc>test</verProc>' +
    '</ide>' +
    '<emit>' +
    '<CNPJ>14200166000187</CNPJ><xNome>ACME LTDA</xNome>' +
    '<enderEmit>' +
    '<xLgr>Rua A</xLgr><nro>1</nro><xBairro>Centro</xBairro>' +
    '<cMun>3550308</cMun><xMun>Sao Paulo</xMun><UF>SP</UF>' +
    '<CEP>01001000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais>' +
    '</enderEmit><IE>111111111111</IE><CRT>1</CRT></emit>' +
    '<dest>' +
    '<CNPJ>99999999000191</CNPJ>' +
    '<xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>' +
    '<enderDest>' +
    '<xLgr>Av B</xLgr><nro>1</nro><xBairro>Centro</xBairro>' +
    '<cMun>3550308</cMun><xMun>Sao Paulo</xMun><UF>SP</UF>' +
    '<CEP>01001000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais>' +
    '</enderDest><indIEDest>9</indIEDest></dest>' +
    '<det nItem="1"><prod>' +
    '<cProd>SKU-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Bicicleta</xProd>' +
    '<NCM>87120000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>' +
    `<qCom>${quantidade}</qCom><vUnCom>${valorUnitario}</vUnCom><vProd>1500.00</vProd>` +
    '<cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib>' +
    `<qTrib>${quantidade}</qTrib><vUnTrib>${valorUnitario}</vUnTrib>` +
    '<indTot>1</indTot>' +
    '</prod>' +
    impostoXml +
    '</det>' +
    totalXml +
    transpXml +
    pagXml +
    '</infNFe></NFe>'
  );
}

/** Build a single-item SN-102 NF-e and assert it's XSD-valid after signing. */
async function assertXsdValid(impostoXml: string) {
  const cert = fixtureCert();
  const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto: impostoFor102() }]);
  const xml = wrap(
    impostoXml,
    buildTotalXml(totals),
    buildTranspXml(),
    buildPagXml([{ tPag: '17', vPag: 1500 }]),
  );
  const signed = signNFe(xml, cert);
  await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
}

/**
 * Like {@link assertXsdValid}, but the <total> aggregates the REAL `imposto`,
 * the det carries `item.qTrib` (so a per-unit fixture's det quantity equals
 * its qBCProd) and the payment is the aggregated vNF.
 *
 * ⚠️ XSD/format coverage ONLY: xmllint checks facets and structure, never a
 * cross-element sum, so passing here proves nothing about item ↔ ICMSTot
 * parity (SEFAZ 602/603). That is pinned by the numeric aggregateTotals tests.
 */
async function assertXsdValidWithRealTotals(
  impostoXml: string,
  imposto: Imposto,
  item: TributeItem = item1500,
): Promise<void> {
  // wrap() fixes the det's vProd at 1500.00 — a different item base would
  // embed a det that disagrees with the <imposto> under test.
  expect(item.vProd).toBe(1500);
  const cert = fixtureCert();
  const totals = aggregateTotals([{ item, imposto }]);
  const xml = wrap(
    impostoXml,
    buildTotalXml(totals),
    buildTranspXml(),
    buildPagXml([{ tPag: '17', vPag: totals.vNF }]),
    { qTrib: item.qTrib ?? 1 },
  );
  const signed = signNFe(xml, cert);
  await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const item1500 = { vProd: 1500 };

function impostoFor(csosn: string, extra: Partial<Imposto['configuracaoICMS']> = {}): Imposto {
  return {
    origem: ORIGEM.nacional,
    configuracaoICMS: {
      crt: '1',
      csosn: csosn as never,
      ...extra,
    },
  };
}
function impostoFor101(): Imposto {
  return impostoFor('101', { csosn101: { pCredSN: 1.25, vCredICMSSN: 18.75 } });
}
function impostoFor102(): Imposto {
  return impostoFor('102');
}
function impostoFor500(): Imposto {
  return impostoFor('500', {
    csosn500: { vBCSTRet: 1500, pST: 18, vICMSSTRet: 270 },
  });
}

/** Capture the message of the NFeTributeError buildImpostoXml throws. */
function tributeErrorMessage(imposto: Imposto, item: TributeItem = item1500): string {
  try {
    buildImpostoXml(imposto, item);
  } catch (err) {
    if (err instanceof NFeTributeError) return err.message;
    throw err;
  }
  throw new Error('expected buildImpostoXml to throw NFeTributeError');
}

/** The `<tag>…</tag>` slice of a built `<imposto>`, for exact-byte pins. */
function groupXmlOf(impostoXml: string, tag: 'ICMS' | 'PIS' | 'COFINS'): string {
  // `<PIS>` with its closing '>' never matches `<PISOutr>`/`<PISST>`.
  const match = new RegExp(`<${tag}>.*?</${tag}>`).exec(impostoXml);
  if (match == null) throw new Error(`expected a <${tag}> group in the built <imposto>`);
  return match[0];
}

function icmsXmlOf(impostoXml: string): string {
  return groupXmlOf(impostoXml, 'ICMS');
}

// ---------------------------------------------------------------------------
// CSOSN dispatcher — one test per variant
// ---------------------------------------------------------------------------

describe('buildImpostoXml — CSOSN dispatch', () => {
  it.each([
    ['102', impostoFor102()],
    ['103', impostoFor('103')],
    ['300', impostoFor('300')],
    ['400', impostoFor('400')],
  ])('CSOSN %s → ICMSSN102 (orig + CSOSN only)', async (csosn, imposto) => {
    const xml = buildImpostoXml(imposto, item1500);
    expect(xml).toContain('<ICMSSN102>');
    expect(xml).toContain(`<CSOSN>${csosn}</CSOSN>`);
    expect(xml).toContain('<orig>0</orig>');
    await assertXsdValid(xml);
  });

  it('CSOSN 101 → ICMSSN101 with pCredSN + vCredICMSSN', async () => {
    const xml = buildImpostoXml(impostoFor101(), item1500);
    expect(xml).toContain('<ICMSSN101>');
    expect(xml).toContain('<CSOSN>101</CSOSN>');
    expect(xml).toContain('<pCredSN>1.2500</pCredSN>');
    expect(xml).toContain('<vCredICMSSN>18.75</vCredICMSSN>');
    await assertXsdValid(xml);
  });

  it('CSOSN 201 → ICMSSN201 with ST + crédito', async () => {
    const imposto = impostoFor('201', {
      csosn201: {
        pCredSN: 1.25,
        vCredICMSSN: 18.75,
        modBCST: '4',
        vBCST: 1800,
        pICMSST: 18,
        vICMSST: 324,
      },
    });
    const xml = buildImpostoXml(imposto, item1500);
    expect(xml).toContain('<ICMSSN201>');
    expect(xml).toContain('<vBCST>1800.00</vBCST>');
    expect(xml).toContain('<vICMSST>324.00</vICMSST>');
    await assertXsdValid(xml);
  });

  it.each(['202', '203'])('CSOSN %s → ICMSSN202 (ST sem crédito)', async (csosn) => {
    const imposto = impostoFor(csosn, {
      csosn202ou203: {
        modBCST: '4',
        vBCST: 1800,
        pICMSST: 18,
        vICMSST: 324,
      },
    });
    const xml = buildImpostoXml(imposto, item1500);
    expect(xml).toContain('<ICMSSN202>');
    expect(xml).toContain(`<CSOSN>${csosn}</CSOSN>`);
    await assertXsdValid(xml);
  });

  it('CSOSN 500 → ICMSSN500 (ST já retido)', async () => {
    const xml = buildImpostoXml(impostoFor500(), item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN500><orig>0</orig><CSOSN>500</CSOSN>' +
        '<vBCSTRet>1500.00</vBCSTRet><pST>18.0000</pST><vICMSSTRet>270.00</vICMSSTRet>' +
        '</ICMSSN500></ICMS>',
    );
    await assertXsdValid(xml);
  });

  it('CSOSN 900 → ICMSSN900 (own ICMS + crédito SN groups)', async () => {
    const imposto = impostoFor('900', {
      csosn900: {
        modBC: MOD_BC.valorOperacao,
        vBC: 1500,
        pICMS: 18,
        vICMS: 270,
        pCredSN: 1.25,
        vCredICMSSN: 18.75,
      },
    });
    const xml = buildImpostoXml(imposto, item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN900><orig>0</orig><CSOSN>900</CSOSN>' +
        '<modBC>3</modBC><vBC>1500.00</vBC><pICMS>18.0000</pICMS><vICMS>270.00</vICMS>' +
        '<pCredSN>1.2500</pCredSN><vCredICMSSN>18.75</vCredICMSSN>' +
        '</ICMSSN900></ICMS>',
    );
    await assertXsdValid(xml);
  });

  // Characterization pins (#506): the exact <ICMS> bytes with every XSD
  // sub-group of ICMSSN500 / ICMSSN900 complete and every optional member set,
  // in the XSD sequence order — so a group guard can be shown not to move a
  // byte of a valid config.
  it('CSOSN 500 → ICMSSN500 with every group complete (incl. vICMSSubstituto)', async () => {
    const imposto = impostoFor(CSOSN.icmsCobradoAnteriormente, {
      csosn500: {
        vBCSTRet: 1500,
        pST: 20,
        vICMSSubstituto: 120,
        vICMSSTRet: 180,
        vBCFCPSTRet: 1500,
        pFCPSTRet: 2,
        vFCPSTRet: 30,
        pRedBCEfet: 10,
        vBCEfet: 1350,
        pICMSEfet: 18,
        vICMSEfet: 243,
      },
    });
    const xml = buildImpostoXml(imposto, item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN500><orig>0</orig><CSOSN>500</CSOSN>' +
        // ICMS-ST retido
        '<vBCSTRet>1500.00</vBCSTRet><pST>20.0000</pST>' +
        '<vICMSSubstituto>120.00</vICMSSubstituto><vICMSSTRet>180.00</vICMSSTRet>' +
        // FCP-ST retido
        '<vBCFCPSTRet>1500.00</vBCFCPSTRet><pFCPSTRet>2.0000</pFCPSTRet>' +
        '<vFCPSTRet>30.00</vFCPSTRet>' +
        // ICMS efetivo
        '<pRedBCEfet>10.0000</pRedBCEfet><vBCEfet>1350.00</vBCEfet>' +
        '<pICMSEfet>18.0000</pICMSEfet><vICMSEfet>243.00</vICMSEfet>' +
        '</ICMSSN500></ICMS>',
    );
    await assertXsdValid(xml);
  });

  it('CSOSN 900 → ICMSSN900 with every group complete and every optional set', async () => {
    const imposto = impostoFor(CSOSN.outros, {
      csosn900: {
        modBC: MOD_BC.valorOperacao,
        vBC: 1350,
        pRedBC: 10,
        pICMS: 18,
        vICMS: 243,
        modBCST: MOD_BCST.margemValorAgregado,
        pMVAST: 40,
        pRedBCST: 10,
        vBCST: 1890,
        pICMSST: 18,
        vICMSST: 97.2,
        vBCFCPST: 1890,
        pFCPST: 2,
        vFCPST: 37.8,
        pCredSN: 1.25,
        vCredICMSSN: 18.75,
      },
    });
    const xml = buildImpostoXml(imposto, item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN900><orig>0</orig><CSOSN>900</CSOSN>' +
        // ICMS próprio
        '<modBC>3</modBC><vBC>1350.00</vBC><pRedBC>10.0000</pRedBC>' +
        '<pICMS>18.0000</pICMS><vICMS>243.00</vICMS>' +
        // ICMS-ST
        '<modBCST>4</modBCST><pMVAST>40.0000</pMVAST><pRedBCST>10.0000</pRedBCST>' +
        '<vBCST>1890.00</vBCST><pICMSST>18.0000</pICMSST><vICMSST>97.20</vICMSST>' +
        // FCP-ST (nested inside the ST sequence)
        '<vBCFCPST>1890.00</vBCFCPST><pFCPST>2.0000</pFCPST><vFCPST>37.80</vFCPST>' +
        // crédito SN
        '<pCredSN>1.2500</pCredSN><vCredICMSSN>18.75</vCredICMSSN>' +
        '</ICMSSN900></ICMS>',
    );
    await assertXsdValid(xml);
  });

  // modBCST '6' (Valor da Operação, NT 2019.001 §1.6) is passed straight
  // through to every ICMSSN variant carrying an ST group (#509). CSOSN 900
  // gets a COMPLETE ST group (no pMVAST) so the #506 group guard admits it.
  const ST_VALOR_OPERACAO = {
    modBCST: MOD_BCST.valorOperacao,
    vBCST: 1500,
    pICMSST: 18,
    vICMSST: 270,
  } as const;
  it.each([
    [
      CSOSN.tributadaComCreditoComSt,
      'ICMSSN201',
      { csosn201: { ...ST_VALOR_OPERACAO, pCredSN: 1.25, vCredICMSSN: 18.75 } },
    ],
    [CSOSN.tributadaSemCreditoComSt, 'ICMSSN202', { csosn202ou203: ST_VALOR_OPERACAO }],
    [CSOSN.isencaoFaixaReceitaBrutaComSt, 'ICMSSN202', { csosn202ou203: ST_VALOR_OPERACAO }],
    [CSOSN.outros, 'ICMSSN900', { csosn900: ST_VALOR_OPERACAO }],
  ] as const)(
    'CSOSN %s with modBCST 6 (Valor da Operação) → %s carries <modBCST>6</modBCST>',
    async (csosn, tag, extra) => {
      const xml = buildImpostoXml(impostoFor(csosn, extra), item1500);
      const icms = icmsXmlOf(xml);
      expect(icms).toContain(`<${tag}>`);
      expect(icms).toContain('<modBCST>6</modBCST>');
      expect(icms).not.toContain('<pMVAST>');
      await assertXsdValid(xml);
    },
  );

  it('modBCST drift guard: every ST-bearing ICMSSN wire type enumerates exactly ModBCST', () => {
    // Compile-time (tsc): the codegen types are the XSD's enumerations, so a
    // modalidade the XSD gains — or the schema loses — fails typecheck here.
    expectTypeOf<TNFe_infNFe_det_imposto_ICMS_ICMSSN201['modBCST']>().toEqualTypeOf<ModBCST>();
    expectTypeOf<TNFe_infNFe_det_imposto_ICMS_ICMSSN202['modBCST']>().toEqualTypeOf<ModBCST>();
    expectTypeOf<
      NonNullable<TNFe_infNFe_det_imposto_ICMS_ICMSSN900['modBCST']>
    >().toEqualTypeOf<ModBCST>();
  });

  // PIS / COFINS Outr zero default — SEFAZ XSD requires vBC + pPIS (or
  // qBCProd + vAliqProd) before vPIS even when nothing is due. Previously the
  // dispatcher emitted only `{ CST, vPIS: '0.00' }` and xmllint-wasm rejected
  // with "vPIS not expected, expected vBC or qBCProd". With no rate configured
  // the shape is byte-identical to the pre-#509 output, and it demands no qTrib.
  it.each([
    CST_PIS_COFINS.outrasOperacoesSaida,
    CST_PIS_COFINS.creditoExclusivoTributadaMercadoInterno,
    CST_PIS_COFINS.outrasOperacoesEntrada,
    CST_PIS_COFINS.outrasOperacoes,
  ])('PIS/COFINS CST %s with no rate → the zero (vBC + p) choice, exact bytes', async (cst) => {
    const imposto: Imposto = {
      ...impostoFor102(),
      configuracaoPIS: { CST: cst },
      configuracaoCOFINS: { CST: cst },
    };
    const xml = buildImpostoXml(imposto, item1500);
    expect(groupXmlOf(xml, 'PIS')).toBe(
      `<PIS><PISOutr><CST>${cst}</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS>` +
        '<vPIS>0.00</vPIS></PISOutr></PIS>',
    );
    expect(groupXmlOf(xml, 'COFINS')).toBe(
      `<COFINS><COFINSOutr><CST>${cst}</CST><vBC>0.00</vBC><pCOFINS>0.0000</pCOFINS>` +
        '<vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>',
    );
    expect(computePisCofinsItemValues(imposto, item1500)).toEqual({ vPIS: 0, vCOFINS: 0 });
    await assertXsdValid(xml);
  });
});

// ---------------------------------------------------------------------------
// PIS / COFINS groups (#509)
//
// PISOutr/COFINSOutr (CST 49–99) carry the XSD xs:choice `(vBC + p)` |
// `(qBCProd + vAliqProd)`: the configured percent or per-unit rate is emitted
// (a rate counts only when > 0), both at once is rejected, neither keeps the
// zero shape above. CST 03 (PISQtde/COFINSQtde) takes qBCProd from the item
// qTrib. Values are computed from the RAW operands and only the result is
// rounded. Every expected fragment is transcribed from the XSD sequence order.
// ---------------------------------------------------------------------------

function impostoPisCofins(
  pis: ConfPIS | null | undefined,
  cofins: ConfCOFINS | null | undefined,
): Imposto {
  return { ...impostoFor102(), configuracaoPIS: pis, configuracaoCOFINS: cofins };
}

const OUTR_ZERO_PIS_49 =
  '<PIS><PISOutr><CST>49</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>';

describe('buildImpostoXml — PIS/COFINS configured values (#509)', () => {
  // -- PISOutr / COFINSOutr: percent path -----------------------------------

  it('CST 49 with pPIS 0.65 / pCOFINS 3 → the (vBC + p) choice on the item base', async () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65 },
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pCOFINS: 3 },
    );
    const item = { vProd: 1500, qTrib: 1 };
    const xml = buildImpostoXml(imposto, item);
    expect(groupXmlOf(xml, 'PIS')).toBe(
      '<PIS><PISOutr><CST>49</CST><vBC>1500.00</vBC><pPIS>0.6500</pPIS>' +
        '<vPIS>9.75</vPIS></PISOutr></PIS>',
    );
    expect(groupXmlOf(xml, 'COFINS')).toBe(
      '<COFINS><COFINSOutr><CST>49</CST><vBC>1500.00</vBC><pCOFINS>3.0000</pCOFINS>' +
        '<vCOFINS>45.00</vCOFINS></COFINSOutr></COFINS>',
    );
    expect(xml).not.toContain('<qBCProd>');
    expect(computePisCofinsItemValues(imposto, item)).toEqual({ vPIS: 9.75, vCOFINS: 45 });
    await assertXsdValidWithRealTotals(xml, imposto, item);
  });

  // -- PISOutr / COFINSOutr: per-unit path ----------------------------------

  it('CST 99 with vAliqProd → the (qBCProd + vAliqProd) choice, qBCProd = item qTrib', async () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.1234 },
      { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.5678 },
    );
    const item = { vProd: 1500, qTrib: 3 };
    const xml = buildImpostoXml(imposto, item);
    // 3 × 0.1234 = 0.3702 → 0.37; 3 × 0.5678 = 1.7034 → 1.70.
    expect(groupXmlOf(xml, 'PIS')).toBe(
      '<PIS><PISOutr><CST>99</CST><qBCProd>3.0000</qBCProd><vAliqProd>0.1234</vAliqProd>' +
        '<vPIS>0.37</vPIS></PISOutr></PIS>',
    );
    expect(groupXmlOf(xml, 'COFINS')).toBe(
      '<COFINS><COFINSOutr><CST>99</CST><qBCProd>3.0000</qBCProd><vAliqProd>0.5678</vAliqProd>' +
        '<vCOFINS>1.70</vCOFINS></COFINSOutr></COFINS>',
    );
    expect(xml).not.toContain('<vBC>');
    expect(xml).not.toContain('<pPIS>');
    expect(computePisCofinsItemValues(imposto, item)).toEqual({ vPIS: 0.37, vCOFINS: 1.7 });
    // The det embedded by the helper carries qTrib 3.0000 — the same quantity.
    await assertXsdValidWithRealTotals(xml, imposto, item);
  });

  it('mixed: PIS percent + COFINS per-unit on one item → each tribute picks its own branch', async () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65 },
      { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.25 },
    );
    const item = { vProd: 1500, qTrib: 2 };
    const xml = buildImpostoXml(imposto, item);
    expect(groupXmlOf(xml, 'PIS')).toBe(
      '<PIS><PISOutr><CST>49</CST><vBC>1500.00</vBC><pPIS>0.6500</pPIS>' +
        '<vPIS>9.75</vPIS></PISOutr></PIS>',
    );
    expect(groupXmlOf(xml, 'COFINS')).toBe(
      '<COFINS><COFINSOutr><CST>99</CST><qBCProd>2.0000</qBCProd><vAliqProd>0.2500</vAliqProd>' +
        '<vCOFINS>0.50</vCOFINS></COFINSOutr></COFINS>',
    );
    await assertXsdValidWithRealTotals(xml, imposto, item);
  });

  // -- PISOutr / COFINSOutr: both rates → rejected --------------------------

  it('PIS CST 49 with BOTH pPIS and vAliqProd → NFeTributeError naming the choice', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65, vAliqProd: 0.1 },
      null,
    );
    const item = { vProd: 1500, qTrib: 1 };
    expect(tributeErrorMessage(imposto, item)).toBe(
      'PIS CST=49 (PISOutr) must carry exactly one of `(vBC + pPIS)` or ' +
        '`(qBCProd + vAliqProd)`, not both — configure `pPIS` or `vAliqProd`',
    );
    // The helper every total/pre-flight reads rejects the same config.
    expect(() => computePisCofinsItemValues(imposto, item)).toThrow(NFeTributeError);
    expect(() => computePisCofinsItemValues(imposto, item)).toThrow(/^PIS CST=49 .*not both/);
  });

  it('COFINS-only both-rates violation (PIS valid) → the message names COFINS', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65 },
      { CST: CST_PIS_COFINS.outrasOperacoes, pCOFINS: 3, vAliqProd: 0.1 },
    );
    const item = { vProd: 1500, qTrib: 1 };
    expect(tributeErrorMessage(imposto, item)).toBe(
      'COFINS CST=99 (COFINSOutr) must carry exactly one of `(vBC + pCOFINS)` or ' +
        '`(qBCProd + vAliqProd)`, not both — configure `pCOFINS` or `vAliqProd`',
    );
    expect(() => computePisCofinsItemValues(imposto, item)).toThrow(/^COFINS CST=99 .*not both/);
  });

  // -- zero semantics near-misses: a rate counts only when > 0 ---------------

  it('pPIS 0 alone → the zero shape (0 is "not configured", not a 0% base)', () => {
    const imposto = impostoPisCofins({ CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0 }, null);
    expect(groupXmlOf(buildImpostoXml(imposto, item1500), 'PIS')).toBe(OUTR_ZERO_PIS_49);
  });

  it('pPIS 0 + vAliqProd 0 → the zero shape, no throw and no qTrib demanded', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0, vAliqProd: 0 },
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pCOFINS: 0, vAliqProd: 0 },
    );
    // item1500 carries no qTrib: a 0 per-unit rate must not ask for one.
    const xml = buildImpostoXml(imposto, item1500);
    expect(groupXmlOf(xml, 'PIS')).toBe(OUTR_ZERO_PIS_49);
    expect(groupXmlOf(xml, 'COFINS')).toBe(
      '<COFINS><COFINSOutr><CST>49</CST><vBC>0.00</vBC><pCOFINS>0.0000</pCOFINS>' +
        '<vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>',
    );
    expect(computePisCofinsItemValues(imposto, item1500)).toEqual({ vPIS: 0, vCOFINS: 0 });
  });

  it('pPIS 0 + vAliqProd 0.5 → the per-unit branch (the 0 percent is not a second rate)', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0, vAliqProd: 0.5 },
      null,
    );
    expect(groupXmlOf(buildImpostoXml(imposto, { vProd: 1500, qTrib: 2 }), 'PIS')).toBe(
      '<PIS><PISOutr><CST>49</CST><qBCProd>2.0000</qBCProd><vAliqProd>0.5000</vAliqProd>' +
        '<vPIS>1.00</vPIS></PISOutr></PIS>',
    );
  });

  it('pPIS 0.65 + vAliqProd 0 → the percent branch (the 0 per-unit is not a second rate)', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65, vAliqProd: 0 },
      null,
    );
    expect(groupXmlOf(buildImpostoXml(imposto, item1500), 'PIS')).toBe(
      '<PIS><PISOutr><CST>49</CST><vBC>1500.00</vBC><pPIS>0.6500</pPIS>' +
        '<vPIS>9.75</vPIS></PISOutr></PIS>',
    );
  });

  it('pPIS 0.0001 → the percent branch, even though the value rounds to 0.00', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.0001 },
      null,
    );
    // 1500 × 0.0001% = 0.0015 → 0.00: the smallest positive rate still counts.
    expect(groupXmlOf(buildImpostoXml(imposto, item1500), 'PIS')).toBe(
      '<PIS><PISOutr><CST>49</CST><vBC>1500.00</vBC><pPIS>0.0001</pPIS>' +
        '<vPIS>0.00</vPIS></PISOutr></PIS>',
    );
  });

  // -- the per-unit branch needs the item quantity -------------------------

  it('per-unit CST 49 with no item qTrib → NFeTributeError naming `qTrib`', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, vAliqProd: 0.5 },
      null,
    );
    expect(tributeErrorMessage(imposto, { vProd: 1500 })).toBe(
      'PIS CST=49 por unidade (vAliqProd) requires the item quantity `qTrib`',
    );
    expect(() => computePisCofinsItemValues(imposto, { vProd: 1500 })).toThrow(NFeTributeError);
  });

  it('per-unit with qTrib 0 → qBCProd 0.0000, vPIS 0.00 (engine boundary; fragment only)', () => {
    // No XSD wrap: a zero-quantity det cannot be made consistent, and apps/nfe
    // rejects quantidade 0 before it ever reaches the engine.
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, vAliqProd: 0.5 },
      null,
    );
    expect(groupXmlOf(buildImpostoXml(imposto, { vProd: 1500, qTrib: 0 }), 'PIS')).toBe(
      '<PIS><PISOutr><CST>49</CST><qBCProd>0.0000</qBCProd><vAliqProd>0.5000</vAliqProd>' +
        '<vPIS>0.00</vPIS></PISOutr></PIS>',
    );
  });

  // -- CST 01/02: PISAliq / COFINSAliq -------------------------------------

  it.each([CST_PIS_COFINS.tributavelAliquotaBasica, CST_PIS_COFINS.tributavelAliquotaDiferenciada])(
    'CST %s → PISAliq/COFINSAliq with vBC = item base and the configured rate',
    async (cst) => {
      const imposto = impostoPisCofins({ CST: cst, pPIS: 1.65 }, { CST: cst, pCOFINS: 7.6 });
      const xml = buildImpostoXml(imposto, item1500);
      expect(groupXmlOf(xml, 'PIS')).toBe(
        `<PIS><PISAliq><CST>${cst}</CST><vBC>1500.00</vBC><pPIS>1.6500</pPIS>` +
          '<vPIS>24.75</vPIS></PISAliq></PIS>',
      );
      expect(groupXmlOf(xml, 'COFINS')).toBe(
        `<COFINS><COFINSAliq><CST>${cst}</CST><vBC>1500.00</vBC><pCOFINS>7.6000</pCOFINS>` +
          '<vCOFINS>114.00</vCOFINS></COFINSAliq></COFINS>',
      );
      expect(computePisCofinsItemValues(imposto, item1500)).toEqual({
        vPIS: 24.75,
        vCOFINS: 114,
      });
      await assertXsdValidWithRealTotals(xml, imposto);
    },
  );

  it('CST 01/02 without the rate → the unchanged missing-rate messages', () => {
    expect(
      tributeErrorMessage(impostoPisCofins({ CST: CST_PIS_COFINS.tributavelAliquotaBasica }, null)),
    ).toBe('PIS CST=01 requires `pPIS`');
    expect(
      tributeErrorMessage(
        impostoPisCofins(null, { CST: CST_PIS_COFINS.tributavelAliquotaDiferenciada }),
      ),
    ).toBe('COFINS CST=02 requires `pCOFINS`');
  });

  // -- CST 03: PISQtde / COFINSQtde ----------------------------------------

  it('CST 03 → PISQtde/COFINSQtde with qBCProd = item qTrib, value = qTrib × vAliqProd', async () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade, vAliqProd: 0.5 },
      { CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade, vAliqProd: 0.75 },
    );
    const item = { vProd: 1500, qTrib: 4 };
    const xml = buildImpostoXml(imposto, item);
    // Before #509: qBCProd was hardcoded 1.0000 and vPIS = vAliqProd (0.50).
    expect(groupXmlOf(xml, 'PIS')).toBe(
      '<PIS><PISQtde><CST>03</CST><qBCProd>4.0000</qBCProd><vAliqProd>0.5000</vAliqProd>' +
        '<vPIS>2.00</vPIS></PISQtde></PIS>',
    );
    expect(groupXmlOf(xml, 'COFINS')).toBe(
      '<COFINS><COFINSQtde><CST>03</CST><qBCProd>4.0000</qBCProd><vAliqProd>0.7500</vAliqProd>' +
        '<vCOFINS>3.00</vCOFINS></COFINSQtde></COFINS>',
    );
    expect(computePisCofinsItemValues(imposto, item)).toEqual({ vPIS: 2, vCOFINS: 3 });
    await assertXsdValidWithRealTotals(xml, imposto, item);
  });

  it('CST 03 without vAliqProd → the unchanged messages; without qTrib → names `qTrib`', () => {
    const item = { vProd: 1500, qTrib: 4 };
    expect(
      tributeErrorMessage(
        impostoPisCofins({ CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade }, null),
        item,
      ),
    ).toBe('PIS CST=03 requires `vAliqProd`');
    expect(
      tributeErrorMessage(
        impostoPisCofins(null, { CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade }),
        item,
      ),
    ).toBe('COFINS CST=03 requires `vAliqProd`');
    expect(
      tributeErrorMessage(
        impostoPisCofins(
          { CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade, vAliqProd: 0.5 },
          null,
        ),
        { vProd: 1500 },
      ),
    ).toBe('PIS CST=03 por unidade (vAliqProd) requires the item quantity `qTrib`');
  });

  it('the missing-qTrib message names COFINS on the COFINS side (not a hardcoded PIS)', () => {
    expect(
      tributeErrorMessage(
        impostoPisCofins(null, { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.5 }),
        { vProd: 1500 },
      ),
    ).toBe('COFINS CST=99 por unidade (vAliqProd) requires the item quantity `qTrib`');
    expect(
      tributeErrorMessage(
        impostoPisCofins(null, {
          CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade,
          vAliqProd: 0.5,
        }),
        { vProd: 1500 },
      ),
    ).toBe('COFINS CST=03 por unidade (vAliqProd) requires the item quantity `qTrib`');
  });

  // -- CST 01/02/03 keep `== null`: a stored 0 is a configured rate ---------
  //    (unlike CST 49–99, where 0 means "not configured" — pinned above)

  it('CST 03 with vAliqProd 0 → PISQtde at 0.0000, not the missing-vAliqProd throw', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade, vAliqProd: 0 },
      null,
    );
    expect(groupXmlOf(buildImpostoXml(imposto, { vProd: 1500, qTrib: 2 }), 'PIS')).toBe(
      '<PIS><PISQtde><CST>03</CST><qBCProd>2.0000</qBCProd><vAliqProd>0.0000</vAliqProd>' +
        '<vPIS>0.00</vPIS></PISQtde></PIS>',
    );
  });

  it('CST 01 with pPIS 0 → PISAliq on the item base at 0.0000, not the missing-rate throw', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 0 },
      null,
    );
    expect(groupXmlOf(buildImpostoXml(imposto, item1500), 'PIS')).toBe(
      '<PIS><PISAliq><CST>01</CST><vBC>1500.00</vBC><pPIS>0.0000</pPIS>' +
        '<vPIS>0.00</vPIS></PISAliq></PIS>',
    );
  });

  // -- the rate must fit TDec_0302a04 (at most three integer digits) ---------

  it.each([
    ['PISAliq (CST 01)', { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 1000 }],
    ['PISOutr (CST 49)', { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 1000 }],
  ] as const)('%s with pPIS 1000 → NFeTributeError at build time', (_label, pis) => {
    const message = tributeErrorMessage(impostoPisCofins(pis, null), item1500);
    expect(message).toMatch(/^PIS CST=(01|49): `pPIS` 1000 does not fit the XSD rate format/);
  });

  it('COFINS rate bound names COFINS / pCOFINS', () => {
    expect(
      tributeErrorMessage(
        impostoPisCofins(null, { CST: CST_PIS_COFINS.outrasOperacoes, pCOFINS: 1234.5 }),
      ),
    ).toMatch(/^COFINS CST=99: `pCOFINS` 1234\.5 does not fit the XSD rate format/);
  });

  it('near-miss: pPIS 999.9999 still builds and is XSD-valid', async () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 999.9999 },
      null,
    );
    const xml = buildImpostoXml(imposto, item1500);
    expect(groupXmlOf(xml, 'PIS')).toContain('<pPIS>999.9999</pPIS>');
    await assertXsdValidWithRealTotals(xml, imposto);
  });

  // -- CST 04–09: PISNT / COFINSNT -----------------------------------------

  it.each([
    CST_PIS_COFINS.tributavelMonofasicaRevendaAliquotaZero,
    CST_PIS_COFINS.tributavelSubstituicaoTributaria,
    CST_PIS_COFINS.tributavelAliquotaZero,
    CST_PIS_COFINS.isentaContribuicao,
    CST_PIS_COFINS.semIncidenciaContribuicao,
    CST_PIS_COFINS.suspensaoContribuicao,
  ])('CST %s → PISNT/COFINSNT, CST only, even with rates stored', (cst) => {
    const imposto = impostoPisCofins(
      { CST: cst, pPIS: 1.65, vAliqProd: 0.25 },
      { CST: cst, pCOFINS: 7.6, vAliqProd: 0.25 },
    );
    const xml = buildImpostoXml(imposto, item1500);
    expect(groupXmlOf(xml, 'PIS')).toBe(`<PIS><PISNT><CST>${cst}</CST></PISNT></PIS>`);
    expect(groupXmlOf(xml, 'COFINS')).toBe(
      `<COFINS><COFINSNT><CST>${cst}</CST></COFINSNT></COFINS>`,
    );
    expect(computePisCofinsItemValues(imposto, item1500)).toEqual({ vPIS: 0, vCOFINS: 0 });
  });

  it('null PIS/COFINS config → the SN default PISNT/COFINSNT CST 07, value 0', () => {
    const imposto = impostoFor102();
    const xml = buildImpostoXml(imposto, item1500);
    expect(groupXmlOf(xml, 'PIS')).toBe('<PIS><PISNT><CST>07</CST></PISNT></PIS>');
    expect(groupXmlOf(xml, 'COFINS')).toBe('<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>');
    expect(computePisCofinsItemValues(imposto, item1500)).toEqual({ vPIS: 0, vCOFINS: 0 });
  });

  // -- rounding convention: RAW operands, only the result rounded ------------
  //
  // The wire shows the operands at 4 decimals, so these flip if someone
  // recomputes from the formatted operands — a convention shared with
  // computeRtcItemValues / IS, which must move together.

  it('per-unit rounding: vAliqProd 0.123456 × 1000 → vPIS 123.46 (raw), not 123.50 (wire)', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.123456 },
      null,
    );
    const item = { vProd: 1500, qTrib: 1000 };
    expect(groupXmlOf(buildImpostoXml(imposto, item), 'PIS')).toBe(
      '<PIS><PISOutr><CST>99</CST><qBCProd>1000.0000</qBCProd><vAliqProd>0.1235</vAliqProd>' +
        '<vPIS>123.46</vPIS></PISOutr></PIS>',
    );
    expect(computePisCofinsItemValues(imposto, item).vPIS).toBe(123.46);
  });

  it('percent rounding: pPIS 1.23456 on 100000 → vPIS 1234.56 (raw), not 1234.60 (wire)', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 1.23456 },
      null,
    );
    const item = { vProd: 100000, qTrib: 1 };
    expect(groupXmlOf(buildImpostoXml(imposto, item), 'PIS')).toBe(
      '<PIS><PISOutr><CST>49</CST><vBC>100000.00</vBC><pPIS>1.2346</pPIS>' +
        '<vPIS>1234.56</vPIS></PISOutr></PIS>',
    );
    expect(computePisCofinsItemValues(imposto, item).vPIS).toBe(1234.56);
  });

  // -- the shared helper ≡ the builder, over every CST ----------------------

  // Every CST × {no rate, percent, per-unit, both}: the builder, the helper and
  // the ICMSTot aggregation either ALL throw NFeTributeError or none does (the
  // pre-flight ≡ build equivalence), and when they emit, the helper and the
  // total both carry exactly the <vPIS>/<vCOFINS> the builder wrote (602/603).
  const RATE_CASES = [
    ['no rate', {}, {}],
    ['percent', { pPIS: 1.65 }, { pCOFINS: 7.6 }],
    ['per-unit', { vAliqProd: 0.25 }, { vAliqProd: 0.25 }],
    ['both', { pPIS: 1.65, vAliqProd: 0.25 }, { pCOFINS: 7.6, vAliqProd: 0.25 }],
  ] as const;
  const SWEEP = Object.values(CST_PIS_COFINS).flatMap((cst) =>
    RATE_CASES.map(([label, pis, cofins]) => [cst, label, pis, cofins] as const),
  );
  const SWEEP_ITEM = { vProd: 123.45, qTrib: 2 };

  it.each(SWEEP)(
    'CST %s, %s → buildImpostoXml ≡ computePisCofinsItemValues ≡ aggregateTotals',
    (cst, _l, p, c) => {
      const imposto = impostoPisCofins({ CST: cst, ...p }, { CST: cst, ...c });
      const item = SWEEP_ITEM;
      const aggregate = () => aggregateTotals([{ item, imposto }]);
      let xml: string | null = null;
      let buildError: NFeTributeError | null = null;
      try {
        xml = buildImpostoXml(imposto, item);
      } catch (err) {
        if (!(err instanceof NFeTributeError)) throw err;
        buildError = err;
      }
      if (buildError != null) {
        expect(() => computePisCofinsItemValues(imposto, item)).toThrow(buildError.message);
        expect(aggregate).toThrow(NFeTributeError);
        expect(aggregate).toThrow(buildError.message);
        return;
      }
      const valueOf = (tag: string): number => {
        const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml ?? '');
        if (match == null) return 0; // an NT group carries no value element
        return Number(match[1]);
      };
      const emitted = { vPIS: valueOf('vPIS'), vCOFINS: valueOf('vCOFINS') };
      expect(computePisCofinsItemValues(imposto, item)).toEqual(emitted);
      const totals = aggregate();
      expect({ vPIS: totals.vPIS, vCOFINS: totals.vCOFINS }).toEqual(emitted);
    },
  );

  it('the sweep reaches every outcome — rejected, a zero value and a non-zero value', () => {
    // Guards the table itself: a sweep whose rows all land on one outcome
    // would pass above while proving nothing about the other two.
    const outcomes = new Set(
      SWEEP.map(([cst, , p, c]) => {
        const imposto = impostoPisCofins({ CST: cst, ...p }, { CST: cst, ...c });
        try {
          const { vPIS, vCOFINS } = aggregateTotals([{ item: SWEEP_ITEM, imposto }]);
          return vPIS === 0 && vCOFINS === 0 ? 'zero' : 'value';
        } catch (err) {
          if (err instanceof NFeTributeError) return 'rejected';
          throw err;
        }
      }),
    );
    expect([...outcomes].sort()).toEqual(['rejected', 'value', 'zero']);
  });

  it('computePisCofinsItemValues is on the package root (apps/nfe imports it there)', () => {
    expect(rootComputePisCofinsItemValues).toBe(computePisCofinsItemValues);
  });
});

// ---------------------------------------------------------------------------
// IPI dispatcher (Group B)
// ---------------------------------------------------------------------------

describe('buildImpostoXml — IPI', () => {
  it.each(['00', '49', '50', '99'])(
    'CST %s → <IPITrib> with cEnq + vIPI (and optional vBC/pIPI when provided)',
    async (cst) => {
      const imposto: Imposto = {
        ...impostoFor102(),
        configuracaoIPI: {
          cEnq: '999',
          CST: cst as never,
          vBC: 1500,
          pIPI: 5,
          vIPI: 75,
        },
      };
      const xml = buildImpostoXml(imposto, item1500);
      expect(xml).toContain('<IPI>');
      expect(xml).toContain('<cEnq>999</cEnq>');
      expect(xml).toContain('<IPITrib>');
      expect(xml).toContain(`<CST>${cst}</CST>`);
      expect(xml).toContain('<vBC>1500.00</vBC>');
      expect(xml).toContain('<pIPI>5.0000</pIPI>');
      expect(xml).toContain('<vIPI>75.00</vIPI>');
      await assertXsdValid(xml);
    },
  );

  it('IPITrib by quantity → emits qUnid + vUnid (4 decimals)', async () => {
    const imposto: Imposto = {
      ...impostoFor102(),
      configuracaoIPI: {
        cEnq: '999',
        CST: '00',
        qUnid: 10,
        vUnid: 2.5,
        vIPI: 25,
      },
    };
    const xml = buildImpostoXml(imposto, item1500);
    expect(xml).toContain('<qUnid>10.0000</qUnid>');
    expect(xml).toContain('<vUnid>2.5000</vUnid>');
    expect(xml).toContain('<vIPI>25.00</vIPI>');
    await assertXsdValid(xml);
  });

  it.each(['01', '02', '03', '04', '05', '51', '52', '53', '54', '55'])(
    'CST %s → <IPINT> with cEnq + CST only',
    async (cst) => {
      const imposto: Imposto = {
        ...impostoFor102(),
        configuracaoIPI: { cEnq: '999', CST: cst as never },
      };
      const xml = buildImpostoXml(imposto, item1500);
      expect(xml).toContain('<IPI>');
      expect(xml).toContain('<cEnq>999</cEnq>');
      expect(xml).toContain('<IPINT>');
      expect(xml).toContain(`<CST>${cst}</CST>`);
      expect(xml).not.toContain('<IPITrib>');
      await assertXsdValid(xml);
    },
  );

  it('IPITrib without vIPI throws NFeTributeError', () => {
    const imposto: Imposto = {
      ...impostoFor102(),
      configuracaoIPI: { cEnq: '999', CST: '00', vBC: 100, pIPI: 5 },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  // --- XSD (vBC + pIPI) XOR (qUnid + vUnid) choice enforcement (#508) ---

  it('IPITrib with both pairs present throws naming the conflict', () => {
    const imposto: Imposto = {
      ...impostoFor102(),
      configuracaoIPI: {
        cEnq: '999',
        CST: '00',
        vBC: 1500,
        pIPI: 5,
        qUnid: 10,
        vUnid: 2.5,
        vIPI: 75,
      },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(/not both/);
  });

  it('IPITrib with neither pair present throws naming the required choice', () => {
    const imposto: Imposto = {
      ...impostoFor102(),
      configuracaoIPI: { cEnq: '999', CST: '00', vIPI: 75 },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(/exactly one complete pair/);
  });

  it.each([
    ['vBC', { vBC: 1500 }, /por valor.*missing `pIPI`/],
    ['pIPI', { pIPI: 5 }, /por valor.*missing `vBC`/],
    ['qUnid', { qUnid: 10 }, /por quantidade.*missing `vUnid`/],
    ['vUnid', { vUnid: 2.5 }, /por quantidade.*missing `qUnid`/],
  ])('IPITrib half pair (only %s) throws naming the missing field', (_label, half, re) => {
    const imposto: Imposto = {
      ...impostoFor102(),
      configuracaoIPI: { cEnq: '999', CST: '00', vIPI: 75, ...half },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(re);
  });
});

// ---------------------------------------------------------------------------
// ISSQN dispatcher (Group B — xs:choice with ICMS)
// ---------------------------------------------------------------------------

function issqnFor(extra: Partial<ConfiguracaoISSQN> = {}): ConfiguracaoISSQN {
  return {
    vBC: 500,
    vAliq: 5,
    vISSQN: 25,
    cMunFG: '3550308', // São Paulo (IBGE)
    cListServ: '01.05',
    indISS: IND_ISS.exigivel,
    indIncentivo: IND_INCENTIVO.nao,
    ...extra,
  };
}

describe('buildImpostoXml — ISSQN (xs:choice with ICMS)', () => {
  it('emits <ISSQN> with required fields and no <ICMS> when configuracaoISSQN is set', async () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoISSQN: issqnFor(),
    };
    const xml = buildImpostoXml(imposto, { vProd: 500 });
    expect(xml).toContain('<ISSQN>');
    expect(xml).toContain('<vBC>500.00</vBC>');
    expect(xml).toContain('<vAliq>5.0000</vAliq>');
    expect(xml).toContain('<vISSQN>25.00</vISSQN>');
    expect(xml).toContain('<cMunFG>3550308</cMunFG>');
    expect(xml).toContain('<cListServ>01.05</cListServ>');
    expect(xml).toContain('<indISS>1</indISS>');
    expect(xml).toContain('<indIncentivo>2</indIncentivo>');
    expect(xml).not.toContain('<ICMS>');
    await assertXsdValid(xml);
  });

  it('emits optional ISSQN fields when set (vDeducao, vDescIncond, vDescCond, vISSRet, vOutro)', async () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoISSQN: issqnFor({
        vDeducao: 10,
        vDescIncond: 5,
        vDescCond: 2,
        vISSRet: 1,
        vOutro: 3,
        cServico: 'SVC-001',
      }),
    };
    const xml = buildImpostoXml(imposto, { vProd: 500 });
    expect(xml).toContain('<vDeducao>10.00</vDeducao>');
    expect(xml).toContain('<vDescIncond>5.00</vDescIncond>');
    expect(xml).toContain('<vDescCond>2.00</vDescCond>');
    expect(xml).toContain('<vISSRet>1.00</vISSRet>');
    expect(xml).toContain('<vOutro>3.00</vOutro>');
    expect(xml).toContain('<cServico>SVC-001</cServico>');
    await assertXsdValid(xml);
  });

  it('throws when neither configuracaoICMS nor configuracaoISSQN is provided', () => {
    const imposto: Imposto = { origem: ORIGEM.nacional };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  it('allows IPI to ride alongside ISSQN (both choice + IPI block)', async () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoISSQN: issqnFor(),
      configuracaoIPI: { cEnq: '999', CST: '01' },
    };
    const xml = buildImpostoXml(imposto, { vProd: 500 });
    expect(xml).toContain('<ISSQN>');
    expect(xml).toContain('<IPI>');
    expect(xml).toContain('<IPINT>');
    expect(xml).not.toContain('<ICMS>');
    await assertXsdValid(xml);
  });
});

describe('aggregateISSQN', () => {
  it('returns undefined when no item carries ISSQN', () => {
    const out = aggregateISSQN([{ item: { vProd: 100 }, imposto: impostoFor102() }]);
    expect(out).toBeUndefined();
  });

  it('sums vServ / vBC / vISS across ISSQN items and stamps dCompet', () => {
    const issqnImposto: Imposto = { origem: ORIGEM.nacional, configuracaoISSQN: issqnFor() };
    const out = aggregateISSQN(
      [
        { item: { vProd: 500 }, imposto: issqnImposto },
        {
          item: { vProd: 300 },
          imposto: {
            origem: ORIGEM.nacional,
            configuracaoISSQN: issqnFor({ vBC: 300, vISSQN: 15 }),
          },
        },
        { item: { vProd: 100 }, imposto: impostoFor102() }, // mixed — ignored by ISSQN aggregator
      ],
      { dCompet: '2026-05-27' },
    );
    expect(out?.vServ).toBe('800.00'); // 500 + 300 (ISSQN items only)
    expect(out?.vBC).toBe('800.00');
    expect(out?.vISS).toBe('40.00');
    expect(out?.dCompet).toBe('2026-05-27');
  });

  it('throws when ISSQN items are present but extras.dCompet is missing', () => {
    const issqnImposto: Imposto = { origem: ORIGEM.nacional, configuracaoISSQN: issqnFor() };
    expect(() => aggregateISSQN([{ item: { vProd: 500 }, imposto: issqnImposto }])).toThrow(
      /dCompet/,
    );
  });

  it('emits cRegTrib when supplied via extras', () => {
    const issqnImposto: Imposto = { origem: ORIGEM.nacional, configuracaoISSQN: issqnFor() };
    const out = aggregateISSQN([{ item: { vProd: 500 }, imposto: issqnImposto }], {
      dCompet: '2026-05-27',
      cRegTrib: '3',
    });
    expect(out?.cRegTrib).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// aggregateRetTrib (Group B — retentions)
// ---------------------------------------------------------------------------

describe('aggregateRetTrib', () => {
  it('returns undefined when no item carries retencao', () => {
    const out = aggregateRetTrib([{ item: { vProd: 100 }, imposto: impostoFor102() }]);
    expect(out).toBeUndefined();
  });

  it('sums vRetPIS / vRetCOFINS / vRetCSLL across items', () => {
    const ret: Retencao = { vRetPIS: 1.65, vRetCOFINS: 7.6, vRetCSLL: 1 };
    const out = aggregateRetTrib([
      { item: { vProd: 100 }, imposto: { ...impostoFor102(), retencao: ret } },
      { item: { vProd: 100 }, imposto: { ...impostoFor102(), retencao: ret } },
    ]);
    expect(out?.vRetPIS).toBe('3.30');
    expect(out?.vRetCOFINS).toBe('15.20');
    expect(out?.vRetCSLL).toBe('2.00');
  });

  it('emits IRRF and Prev BC + value pairs', () => {
    const ret: Retencao = { vBCIRRF: 1000, vIRRF: 15, vBCRetPrev: 500, vRetPrev: 55 };
    const out = aggregateRetTrib([
      { item: { vProd: 1000 }, imposto: { ...impostoFor102(), retencao: ret } },
    ]);
    expect(out?.vBCIRRF).toBe('1000.00');
    expect(out?.vIRRF).toBe('15.00');
    expect(out?.vBCRetPrev).toBe('500.00');
    expect(out?.vRetPrev).toBe('55.00');
  });

  it('omits fields whose cumulative sum is 0 (Flutter parity)', () => {
    const ret: Retencao = { vRetPIS: 1.65 };
    const out = aggregateRetTrib([
      { item: { vProd: 100 }, imposto: { ...impostoFor102(), retencao: ret } },
    ]);
    expect(out?.vRetPIS).toBe('1.65');
    expect(out?.vRetCOFINS).toBeUndefined();
    expect(out?.vRetCSLL).toBeUndefined();
    expect(out?.vIRRF).toBeUndefined();
    expect(out?.vRetPrev).toBeUndefined();
  });

  it('ignores items with retencao=null when other items carry retentions', () => {
    const ret: Retencao = { vRetPIS: 2 };
    const out = aggregateRetTrib([
      { item: { vProd: 100 }, imposto: impostoFor102() }, // no retencao
      { item: { vProd: 100 }, imposto: { ...impostoFor102(), retencao: ret } },
    ]);
    expect(out?.vRetPIS).toBe('2.00');
  });
});

// ---------------------------------------------------------------------------
// Hard-fail branches
// ---------------------------------------------------------------------------

describe('buildImpostoXml — failure modes', () => {
  it('throws on CRT=3 (Regime Normal) — Phase D', () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoICMS: { crt: '3', csosn: null },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  it('throws on CRT=4 (MEI)', () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoICMS: { crt: '4', csosn: null },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  it('throws on missing csosn for CRT=1', () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoICMS: { crt: '1', csosn: null },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(/csosn/i);
  });

  it('throws on CSOSN 101 without csosn101 sub-config', () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoICMS: { crt: '1', csosn: '101' },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  it('throws on CSOSN 500 without csosn500 sub-config', () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoICMS: { crt: '1', csosn: '500' },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });
});

// ---------------------------------------------------------------------------
// FCP-ST all-or-nothing trio (#507)
//
// The FCP-ST base/rate/value trio must be emitted together or not at all;
// a partial trio is rejected at build time. CSOSN 500 carries the `…Ret`
// variant of the trio.
// ---------------------------------------------------------------------------

describe('buildImpostoXml — FCP-ST trio all-or-nothing (#507)', () => {
  // [csosn, sub-config key, base fields, trio field names] per CSOSN case.
  const CASES = [
    [
      '201',
      'csosn201',
      { pCredSN: 1.25, vCredICMSSN: 18.75, modBCST: '4', vBCST: 1800, pICMSST: 18, vICMSST: 324 },
      ['vBCFCPST', 'pFCPST', 'vFCPST'],
    ],
    [
      '202',
      'csosn202ou203',
      { modBCST: '4', vBCST: 1800, pICMSST: 18, vICMSST: 324 },
      ['vBCFCPST', 'pFCPST', 'vFCPST'],
    ],
    [
      '203',
      'csosn202ou203',
      { modBCST: '4', vBCST: 1800, pICMSST: 18, vICMSST: 324 },
      ['vBCFCPST', 'pFCPST', 'vFCPST'],
    ],
    [
      '500',
      'csosn500',
      { vBCSTRet: 1500, pST: 18, vICMSSTRet: 270 },
      ['vBCFCPSTRet', 'pFCPSTRet', 'vFCPSTRet'],
    ],
    [
      '900',
      'csosn900',
      // FCP-ST rides after the ST group in the XSD sequence, so the ST fields
      // must be present for the full-trio emission to validate.
      {
        modBC: '3',
        vBC: 1500,
        pICMS: 18,
        vICMS: 270,
        modBCST: '4',
        vBCST: 1800,
        pICMSST: 18,
        vICMSST: 324,
      },
      ['vBCFCPST', 'pFCPST', 'vFCPST'],
    ],
  ] as const;

  // Wire values for the trio, keyed by field name (base + value = money 2dp,
  // rate = 4dp).
  const trioValues: Record<string, number> = {
    vBCFCPST: 1800,
    pFCPST: 2,
    vFCPST: 36,
    vBCFCPSTRet: 1500,
    pFCPSTRet: 2,
    vFCPSTRet: 30,
  };

  it.each(CASES)('CSOSN %s → full trio emits all three', async (csosn, key, base, trio) => {
    const sub = { ...base } as Record<string, number>;
    // `trio` members are keys of `trioValues` by construction (CASES pairs them).
    for (const f of trio) sub[f] = trioValues[f]!;
    const imposto = impostoFor(csosn, { [key]: sub });
    const xml = buildImpostoXml(imposto, item1500);
    for (const f of trio) expect(xml).toContain(`<${f}>`);
    await assertXsdValid(xml);
  });

  it.each(CASES)('CSOSN %s → absent trio emits none', async (csosn, key, base, trio) => {
    const imposto = impostoFor(csosn, { [key]: { ...base } });
    const xml = buildImpostoXml(imposto, item1500);
    for (const f of trio) expect(xml).not.toContain(`<${f}>`);
    await assertXsdValid(xml);
  });

  // Zero is a legitimate FCP-ST value (schema is nonnegative), so a full trio
  // with a 0 member counts as complete — it must emit, not be misread as a
  // partial trio. Pins the guard's `== null` semantics against a `!value`
  // regression.
  it.each(CASES)(
    'CSOSN %s → full trio with a 0 member emits (0 is present)',
    async (csosn, key, base, trio) => {
      const sub = { ...base } as Record<string, number>;
      for (const f of trio) sub[f] = 0;
      const imposto = impostoFor(csosn, { [key]: sub });
      let xml = '';
      expect(() => {
        xml = buildImpostoXml(imposto, item1500);
      }).not.toThrow();
      for (const f of trio) expect(xml).toContain(`<${f}>`);
      await assertXsdValid(xml);
    },
  );

  // Each single-field-present and each two-fields-present combination rejects.
  it.each(CASES)('CSOSN %s → partial trio (1 or 2 of 3) throws', (csosn, key, base, trio) => {
    // Annotated `readonly string[]`: `trio` is a union across CASES, so the
    // inferred element type collapses to `never` and both `includes` and the
    // `trioValues` lookup below stop typechecking.
    const partials: readonly (readonly string[])[] = [
      [trio[0]],
      [trio[1]],
      [trio[2]],
      [trio[0], trio[1]],
      [trio[0], trio[2]],
      [trio[1], trio[2]],
    ];
    for (const present of partials) {
      const sub = { ...base } as Record<string, number>;
      for (const f of present) sub[f] = trioValues[f]!;
      const imposto = impostoFor(csosn, { [key]: sub });
      expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
      const message = tributeErrorMessage(imposto);
      expect(message).toContain(`CSOSN '${csosn}'`);
      // Assert against the `missing:` clause specifically (not the always-
      // present "complete trio (…)" enumeration): it must list exactly the
      // absent members and none of the present ones. Assert the marker is
      // present first, so a future message-format change fails loudly here
      // instead of silently slicing the last character (indexOf → -1).
      expect(message).toContain('missing:');
      const missingClause = message.slice(message.indexOf('missing:'));
      const missing = (trio as readonly string[]).filter((f) => !present.includes(f));
      for (const m of missing) expect(missingClause).toContain(m);
      for (const p of present) expect(missingClause).not.toContain(p);
    }
  });
});

// ---------------------------------------------------------------------------
// ICMSSN500 / ICMSSN900 XSD sub-groups all-or-nothing (#506)
//
// Each `xs:sequence minOccurs="0"` sub-group is emitted complete or omitted;
// anything in between is rejected at build time by ONE NFeTributeError naming
// every incomplete group and its missing REQUIRED members, in XSD order. The
// fixtures below are transcribed from leiauteNFe_v4.00.xsd (ICMSSN500
// L4142-4230, ICMSSN900 L4231-4377), not from the engine's own tables.
// ---------------------------------------------------------------------------

type ConfSN500 = NonNullable<ConfiguracaoICMS['csosn500']>;
type ConfSN900 = NonNullable<ConfiguracaoICMS['csosn900']>;

/**
 * Parse a #506 group error into `{ group label → missing required members }`,
 * keys in message order. Splits on the message's own separators (' — ', '; ',
 * ' missing: ', ', ') so assertions compare exact field tokens: the names are
 * prefixes of one another (vICMS ⊂ vICMSST ⊂ vICMSSTRet, vICMSSubstituto,
 * vICMSEfet), so a `toContain` would pass on the wrong field.
 */
function missingByGroup(message: string): Record<string, string[]> {
  const parts = message.split(' — ');
  if (parts.length !== 2) throw new Error(`expected exactly one ' — ' in: ${message}`);
  const out: Record<string, string[]> = {};
  for (const clause of parts[1]!.split('; ')) {
    const halves = clause.split(' missing: ');
    if (halves.length !== 2) throw new Error(`malformed clause '${clause}' in: ${message}`);
    const [label, fields] = halves as [string, string];
    if (label in out) throw new Error(`group '${label}' reported twice in: ${message}`);
    out[label] = fields.split(', ');
  }
  return out;
}

/** Build, expect the #506 group error for `csosn`, and parse its clauses. */
function groupViolations(csosn: string, imposto: Imposto): Record<string, string[]> {
  const message = tributeErrorMessage(imposto);
  expect(message).toMatch(
    new RegExp(`^CSOSN '${csosn}': XSD sub-groups must be emitted complete or omitted — `),
  );
  return missingByGroup(message);
}

function imposto500(sub: ConfSN500): Imposto {
  return impostoFor(CSOSN.icmsCobradoAnteriormente, { csosn500: sub });
}
function imposto900(sub: ConfSN900): Imposto {
  return impostoFor(CSOSN.outros, { csosn900: sub });
}

/** `sub` with `field` removed (the key gone, not nulled). */
function without<T extends object>(sub: T, field: keyof T): T {
  const copy: Partial<T> = { ...sub };
  delete copy[field];
  return copy as T;
}

/**
 * `present` with every OTHER member of the sub-config's schema set to an
 * explicit `null` — the shape a STORED config has. Every csosn500/csosn900
 * member is `.optional().nullable()` and the web imposto editor writes `null`
 * for a cleared field, so a real document carries `pICMS: null` where
 * `without()` leaves the key out. `shape` is the Zod object's `.shape`, so the
 * padding follows the schema rather than this file's fixtures.
 */
function nullPadded<T extends object>(shape: Record<keyof T, unknown>, present: T): T {
  const nulls = Object.fromEntries(Object.keys(shape).map((key) => [key, null]));
  return { ...nulls, ...present } as T;
}

/**
 * Cartesian product of per-group options into named sub-configs; an option
 * named '' is the group left absent.
 */
function variants<T extends object>(
  axes: ReadonlyArray<ReadonlyArray<readonly [string, Partial<T>]>>,
): Array<[string, T]> {
  const rows = axes.reduce<Array<[string[], Partial<T>]>>(
    (acc, axis) =>
      acc.flatMap(([names, sub]) =>
        axis.map(([name, part]): [string[], Partial<T>] => [
          name === '' ? names : [...names, name],
          { ...sub, ...part },
        ]),
      ),
    [[[], {}]],
  );
  return rows.map(([names, sub]) => [names.join(' + ') || 'no groups', sub as T]);
}

// One complete instance of each group's REQUIRED members (the characterization
// pins' values); optional members are layered on per test.
const SN500_GROUP = {
  stRet: { vBCSTRet: 1500, pST: 20, vICMSSTRet: 180 },
  fcpStRet: { vBCFCPSTRet: 1500, pFCPSTRet: 2, vFCPSTRet: 30 },
  efet: { pRedBCEfet: 10, vBCEfet: 1350, pICMSEfet: 18, vICMSEfet: 243 },
} satisfies Record<string, ConfSN500>;
const SN900_GROUP = {
  proprio: { modBC: MOD_BC.valorOperacao, vBC: 1350, pICMS: 18, vICMS: 243 },
  st: { modBCST: MOD_BCST.margemValorAgregado, vBCST: 1890, pICMSST: 18, vICMSST: 97.2 },
  fcpSt: { vBCFCPST: 1890, pFCPST: 2, vFCPST: 37.8 },
  credSN: { pCredSN: 1.25, vCredICMSSN: 18.75 },
} satisfies Record<string, ConfSN900>;

/** Every group complete and every optional member set. */
const SN500_FULL: ConfSN500 = {
  ...SN500_GROUP.stRet,
  vICMSSubstituto: 120,
  ...SN500_GROUP.fcpStRet,
  ...SN500_GROUP.efet,
};
const SN900_FULL: ConfSN900 = {
  ...SN900_GROUP.proprio,
  pRedBC: 10,
  ...SN900_GROUP.st,
  pMVAST: 40,
  pRedBCST: 10,
  ...SN900_GROUP.fcpSt,
  ...SN900_GROUP.credSN,
};

const ST_900_REQUIRED = ['modBCST', 'vBCST', 'pICMSST', 'vICMSST'];

describe('buildImpostoXml — ICMSSN500/ICMSSN900 XSD groups all-or-nothing (#506)', () => {
  // -- rejections -----------------------------------------------------------

  // Dropping ONE required member from the fully-populated config names exactly
  // that group and that field: the other (complete) groups add no clause.
  it.each([
    ['ICMS próprio', 'modBC'],
    ['ICMS próprio', 'vBC'],
    ['ICMS próprio', 'pICMS'],
    ['ICMS próprio', 'vICMS'],
    ['ICMS-ST', 'modBCST'],
    ['ICMS-ST', 'vBCST'],
    ['ICMS-ST', 'pICMSST'],
    ['ICMS-ST', 'vICMSST'],
    ['FCP-ST', 'vBCFCPST'],
    ['FCP-ST', 'pFCPST'],
    ['FCP-ST', 'vFCPST'],
    ['crédito SN', 'pCredSN'],
    ['crédito SN', 'vCredICMSSN'],
  ] as const)('CSOSN 900: %s without %s → names only that field', (label, field) => {
    const imposto = imposto900(without(SN900_FULL, field));
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
    expect(groupViolations('900', imposto)).toEqual({ [label]: [field] });
  });

  it.each([
    ['ICMS-ST retido', 'vBCSTRet'],
    ['ICMS-ST retido', 'pST'],
    ['ICMS-ST retido', 'vICMSSTRet'],
    ['FCP-ST retido', 'vBCFCPSTRet'],
    ['FCP-ST retido', 'pFCPSTRet'],
    ['FCP-ST retido', 'vFCPSTRet'],
    ['ICMS efetivo', 'pRedBCEfet'],
    ['ICMS efetivo', 'vBCEfet'],
    ['ICMS efetivo', 'pICMSEfet'],
    ['ICMS efetivo', 'vICMSEfet'],
  ] as const)('CSOSN 500: %s without %s → names only that field', (label, field) => {
    const imposto = imposto500(without(SN500_FULL, field));
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
    expect(groupViolations('500', imposto)).toEqual({ [label]: [field] });
  });

  // A partial group with every other group absent — including an OPTIONAL
  // member on its own, which still opens its group and forces the required ones.
  const PARTIAL_900: ReadonlyArray<readonly [string, ConfSN900, Record<string, string[]>]> = [
    [
      'vBC but no pICMS (the #506 report)',
      { modBC: MOD_BC.valorOperacao, vBC: 1500, vICMS: 270 },
      { 'ICMS próprio': ['pICMS'] },
    ],
    ['pRedBC alone', { pRedBC: 10 }, { 'ICMS próprio': ['modBC', 'vBC', 'pICMS', 'vICMS'] }],
    ['pMVAST alone', { pMVAST: 40 }, { 'ICMS-ST': ST_900_REQUIRED }],
    ['pRedBCST alone', { pRedBCST: 10 }, { 'ICMS-ST': ST_900_REQUIRED }],
    // The FCP-ST sequence is NESTED inside the ST one (xsd:4345-4361 within
    // 4295-4362): a complete trio with no ST group is schema-invalid, and only
    // the ST clause is reported — the trio itself is complete. #507 let it by.
    ['complete FCP-ST trio with no ST group', SN900_GROUP.fcpSt, { 'ICMS-ST': ST_900_REQUIRED }],
    ['pCredSN alone', { pCredSN: 1.25 }, { 'crédito SN': ['vCredICMSSN'] }],
    ['vCredICMSSN alone', { vCredICMSSN: 18.75 }, { 'crédito SN': ['pCredSN'] }],
  ];
  it.each(PARTIAL_900)('CSOSN 900: %s → rejected', (_name, sub, expected) => {
    expect(groupViolations('900', imposto900(sub))).toEqual(expected);
  });

  const PARTIAL_500: ReadonlyArray<readonly [string, ConfSN500, Record<string, string[]>]> = [
    [
      'vICMSSubstituto alone',
      { vICMSSubstituto: 120 },
      { 'ICMS-ST retido': ['vBCSTRet', 'pST', 'vICMSSTRet'] },
    ],
    [
      'vBCEfet alone',
      { vBCEfet: 1350 },
      { 'ICMS efetivo': ['pRedBCEfet', 'pICMSEfet', 'vICMSEfet'] },
    ],
  ];
  it.each(PARTIAL_500)('CSOSN 500: %s → rejected', (_name, sub, expected) => {
    expect(groupViolations('500', imposto500(sub))).toEqual(expected);
  });

  // Every violation lands in ONE error, clauses in XSD document order.
  it('CSOSN 900: two incomplete groups → one error, clauses in XSD order', () => {
    const imposto = imposto900({ vBC: 1500, pCredSN: 1.25 });
    const message = tributeErrorMessage(imposto);
    expect(message).toBe(
      "CSOSN '900': XSD sub-groups must be emitted complete or omitted — " +
        'ICMS próprio missing: modBC, pICMS, vICMS; crédito SN missing: vCredICMSSN',
    );
    const violations = missingByGroup(message);
    expect(Object.keys(violations)).toEqual(['ICMS próprio', 'crédito SN']);
  });

  it('CSOSN 900: a partial FCP-ST trio with no ST group → the ST clause, then the FCP-ST one', () => {
    const violations = groupViolations('900', imposto900({ vBCFCPST: 1890 }));
    expect(Object.keys(violations)).toEqual(['ICMS-ST', 'FCP-ST']);
    expect(violations).toEqual({ 'ICMS-ST': ST_900_REQUIRED, 'FCP-ST': ['pFCPST', 'vFCPST'] });
  });

  it('CSOSN 500: all three groups incomplete → three clauses in XSD order', () => {
    const violations = groupViolations(
      '500',
      imposto500({ pST: 20, pFCPSTRet: 2, vICMSEfet: 243 }),
    );
    expect(Object.keys(violations)).toEqual(['ICMS-ST retido', 'FCP-ST retido', 'ICMS efetivo']);
    expect(violations).toEqual({
      'ICMS-ST retido': ['vBCSTRet', 'vICMSSTRet'],
      'FCP-ST retido': ['vBCFCPSTRet', 'vFCPSTRet'],
      'ICMS efetivo': ['pRedBCEfet', 'vBCEfet', 'pICMSEfet'],
    });
  });

  // Near-misses on the presence test (`!= null`). A numeric 0 is PRESENT, so on
  // its own it opens the group: these fail against a `!value` regression, which
  // would read the lone 0 as absent and let the group through. The modBC '0'
  // row cannot catch `!value` ('0' is a truthy string) — it catches a numeric
  // coercion (`Number(v) === 0`, `v === '0'`) that would drop MOD_BC's '0'.
  it.each([
    ['{ pRedBC: 0 } alone (optional member)', { pRedBC: 0 }, ['modBC', 'vBC', 'pICMS', 'vICMS']],
    ['{ vICMS: 0 } alone (required member)', { vICMS: 0 }, ['modBC', 'vBC', 'pICMS']],
    [
      '{ modBC: MOD_BC.margemValorAgregado } alone',
      { modBC: MOD_BC.margemValorAgregado },
      ['vBC', 'pICMS', 'vICMS'],
    ],
  ] as const)('CSOSN 900: %s → rejected (0 is present)', (_name, sub, missing) => {
    expect(groupViolations('900', imposto900(sub))).toEqual({ 'ICMS próprio': [...missing] });
  });

  // Scope near-miss: <ICMS> and <ISSQN> are an xs:choice and ISSQN wins, so a
  // partial ICMS group on an ISSQN item is never built — hence never validated.
  it('ISSQN item carrying a partial csosn900 → no throw, <ISSQN> and no <ICMS>', async () => {
    const imposto: Imposto = { ...imposto900({ vBC: 1500 }), configuracaoISSQN: issqnFor() };
    let xml = '';
    expect(() => {
      xml = buildImpostoXml(imposto, { vProd: 500 });
    }).not.toThrow();
    expect(xml).toContain('<ISSQN>');
    expect(xml).not.toContain('<ICMS>');
    await assertXsdValid(xml);
  });

  // -- complete variants: emitted, exactly the configured tags, XSD-valid -----

  // Absent is legal for every group.
  it.each([
    [CSOSN.icmsCobradoAnteriormente, { csosn500: {} }, 'ICMSSN500'],
    [CSOSN.outros, { csosn900: {} }, 'ICMSSN900'],
  ] as const)('CSOSN %s with no groups at all → orig + CSOSN only', async (csosn, extra, tag) => {
    const xml = buildImpostoXml(impostoFor(csosn, extra), item1500);
    expect(icmsXmlOf(xml)).toBe(
      `<ICMS><${tag}><orig>0</orig><CSOSN>${csosn}</CSOSN></${tag}></ICMS>`,
    );
    await assertXsdValid(xml);
  });

  /** Build `sub`, assert each of its members — and no other — is emitted, then round-trip. */
  async function expectCompleteVariant(imposto: Imposto, sub: object, all: object): Promise<void> {
    const xml = buildImpostoXml(imposto, item1500);
    const icms = icmsXmlOf(xml);
    const present = Object.keys(sub);
    // `<name>` with its closing '>' is an exact tag match (no prefix collision).
    for (const f of present) expect(icms).toContain(`<${f}>`);
    for (const f of Object.keys(all).filter((k) => !present.includes(k))) {
      expect(icms).not.toContain(`<${f}>`);
    }
    await assertXsdValid(xml);
  }

  // ICMSSN500: every subset of its three groups, ICMS-ST retido with and
  // without its optional vICMSSubstituto.
  it.each(
    variants<ConfSN500>([
      [
        ['', {}],
        ['ICMS-ST retido', SN500_GROUP.stRet],
        ['ICMS-ST retido + vICMSSubstituto', { ...SN500_GROUP.stRet, vICMSSubstituto: 120 }],
      ],
      [
        ['', {}],
        ['FCP-ST retido', SN500_GROUP.fcpStRet],
      ],
      [
        ['', {}],
        ['ICMS efetivo', SN500_GROUP.efet],
      ],
    ]),
  )('CSOSN 500 complete variant: %s', async (_name, sub) => {
    await expectCompleteVariant(imposto500(sub), sub, SN500_FULL);
  });

  // ICMSSN900: own ICMS × ICMS-ST (bare, with its optionals, with the nested
  // FCP-ST trio) × crédito SN.
  it.each(
    variants<ConfSN900>([
      [
        ['', {}],
        ['ICMS próprio', SN900_GROUP.proprio],
        ['ICMS próprio + pRedBC', { ...SN900_GROUP.proprio, pRedBC: 10 }],
      ],
      [
        ['', {}],
        ['ICMS-ST', SN900_GROUP.st],
        ['ICMS-ST + pMVAST + pRedBCST', { ...SN900_GROUP.st, pMVAST: 40, pRedBCST: 10 }],
        ['ICMS-ST + FCP-ST', { ...SN900_GROUP.st, ...SN900_GROUP.fcpSt }],
      ],
      [
        ['', {}],
        ['crédito SN', SN900_GROUP.credSN],
      ],
    ]),
  )('CSOSN 900 complete variant: %s', async (_name, sub) => {
    await expectCompleteVariant(imposto900(sub), sub, SN900_FULL);
  });

  // The emit side of the presence near-misses: a COMPLETE group holding a 0 (or
  // modBC '0') member is emitted as-is and validates.
  it('CSOSN 900: complete own group with vICMS 0, pRedBC 0 and modBC 0 → emitted', async () => {
    const imposto = imposto900({
      ...SN900_GROUP.proprio,
      modBC: MOD_BC.margemValorAgregado,
      pRedBC: 0,
      vICMS: 0,
    });
    const xml = buildImpostoXml(imposto, item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN900><orig>0</orig><CSOSN>900</CSOSN>' +
        '<modBC>0</modBC><vBC>1350.00</vBC><pRedBC>0.0000</pRedBC>' +
        '<pICMS>18.0000</pICMS><vICMS>0.00</vICMS>' +
        '</ICMSSN900></ICMS>',
    );
    await assertXsdValid(xml);
  });

  it('CSOSN 500: complete ICMS efetivo group with pRedBCEfet 0 → emitted', async () => {
    const xml = buildImpostoXml(imposto500({ ...SN500_GROUP.efet, pRedBCEfet: 0 }), item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN500><orig>0</orig><CSOSN>500</CSOSN>' +
        '<pRedBCEfet>0.0000</pRedBCEfet><vBCEfet>1350.00</vBCEfet>' +
        '<pICMSEfet>18.0000</pICMSEfet><vICMSEfet>243.00</vICMSEfet>' +
        '</ICMSSN500></ICMS>',
    );
    await assertXsdValid(xml);
  });

  // -- explicit null: the STORED shape ----------------------------------------
  //
  // Every fixture above leaves an absent member's key out, but a stored config
  // carries `field: null` (see `nullPadded`). Presence is `!= null`, so a null
  // member must read exactly like a missing key: it neither opens a group nor
  // completes one. A `!== undefined` regression counts every null as present;
  // the partial-group and lone-null tests below fail against it, and the
  // all-null / complete-group ones pin the emit side of the same fold.

  it('CSOSN 900 with EVERY schema member null → orig + CSOSN only', async () => {
    const sub = nullPadded<ConfSN900>(confICMSSN900Schema.shape, {});
    // The padding covers exactly the members the fully-populated fixture sets.
    expect(Object.keys(sub).sort()).toEqual(Object.keys(SN900_FULL).sort());
    const xml = buildImpostoXml(imposto900(sub), item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN900><orig>0</orig><CSOSN>900</CSOSN></ICMSSN900></ICMS>',
    );
    await assertXsdValid(xml);
  });

  it('CSOSN 500 with EVERY schema member null → orig + CSOSN only', async () => {
    const sub = nullPadded<ConfSN500>(confICMSSN500Schema.shape, {});
    expect(Object.keys(sub).sort()).toEqual(Object.keys(SN500_FULL).sort());
    const xml = buildImpostoXml(imposto500(sub), item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN500><orig>0</orig><CSOSN>500</CSOSN></ICMSSN500></ICMS>',
    );
    await assertXsdValid(xml);
  });

  // The null twin of the `{ vICMS: 0 } alone` near-miss: a lone 0 opens its
  // group, a lone null (one cleared field, every other key never written) does
  // not — for every member, required and optional alike.
  it.each(Object.keys(confICMSSN900Schema.shape))(
    'CSOSN 900: { %s: null } alone → no group opened, orig + CSOSN only',
    (field) => {
      const xml = buildImpostoXml(imposto900({ [field]: null }), item1500);
      expect(icmsXmlOf(xml)).toBe(
        '<ICMS><ICMSSN900><orig>0</orig><CSOSN>900</CSOSN></ICMSSN900></ICMS>',
      );
    },
  );

  it.each(Object.keys(confICMSSN500Schema.shape))(
    'CSOSN 500: { %s: null } alone → no group opened, orig + CSOSN only',
    (field) => {
      const xml = buildImpostoXml(imposto500({ [field]: null }), item1500);
      expect(icmsXmlOf(xml)).toBe(
        '<ICMS><ICMSSN500><orig>0</orig><CSOSN>500</CSOSN></ICMSSN500></ICMS>',
      );
    },
  );

  it("CSOSN 900: complete 'ICMS próprio', every other member null → only that group", async () => {
    const sub = nullPadded(confICMSSN900Schema.shape, SN900_GROUP.proprio);
    const xml = buildImpostoXml(imposto900(sub), item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN900><orig>0</orig><CSOSN>900</CSOSN>' +
        '<modBC>3</modBC><vBC>1350.00</vBC><pICMS>18.0000</pICMS><vICMS>243.00</vICMS>' +
        '</ICMSSN900></ICMS>',
    );
    await assertXsdValid(xml);
  });

  it("CSOSN 500: only 'ICMS efetivo' filled, every other member null → only that group", async () => {
    const sub = nullPadded(confICMSSN500Schema.shape, SN500_GROUP.efet);
    const xml = buildImpostoXml(imposto500(sub), item1500);
    expect(icmsXmlOf(xml)).toBe(
      '<ICMS><ICMSSN500><orig>0</orig><CSOSN>500</CSOSN>' +
        '<pRedBCEfet>10.0000</pRedBCEfet><vBCEfet>1350.00</vBCEfet>' +
        '<pICMSEfet>18.0000</pICMSEfet><vICMSEfet>243.00</vICMSEfet>' +
        '</ICMSSN500></ICMS>',
    );
    await assertXsdValid(xml);
  });

  // The rejection side: a partial group padded with nulls names exactly the
  // members the key-absent version names — a null member is still missing.
  it.each(PARTIAL_900)(
    'CSOSN 900: %s, every other member null → rejected',
    (_name, sub, expected) => {
      expect(
        groupViolations('900', imposto900(nullPadded(confICMSSN900Schema.shape, sub))),
      ).toEqual(expected);
    },
  );

  it.each(PARTIAL_500)(
    'CSOSN 500: %s, every other member null → rejected',
    (_name, sub, expected) => {
      expect(
        groupViolations('500', imposto500(nullPadded(confICMSSN500Schema.shape, sub))),
      ).toEqual(expected);
    },
  );

  it('CSOSN 500: all three groups incomplete, the gaps null → three clauses, only the null members', () => {
    const sub = nullPadded(confICMSSN500Schema.shape, { pST: 20, pFCPSTRet: 2, vICMSEfet: 243 });
    expect(groupViolations('500', imposto500(sub))).toEqual({
      'ICMS-ST retido': ['vBCSTRet', 'vICMSSTRet'],
      'FCP-ST retido': ['vBCFCPSTRet', 'vFCPSTRet'],
      'ICMS efetivo': ['pRedBCEfet', 'vBCEfet', 'pICMSEfet'],
    });
  });
});

// ---------------------------------------------------------------------------
// Total aggregation
// ---------------------------------------------------------------------------

describe('aggregateTotals', () => {
  it('sums vProd across items', () => {
    const totals = aggregateTotals([
      { item: { vProd: 1500 }, imposto: impostoFor102() },
      { item: { vProd: 250.5 }, imposto: impostoFor102() },
    ]);
    expect(totals.vProd).toBe(1750.5);
    expect(totals.vNF).toBe(1750.5); // CSOSN 102 → no ST contribution
  });

  it('CSOSN 101 contributes nothing to ICMSTot.vICMS (vCredICMSSN is the SN credit, not ICMS due)', () => {
    // vCredICMSSN is the buyer-appropriable Simples Nacional credit; ICMSSN101
    // emits no <vICMS>, so Σ item vICMS = 0 and ICMSTot.vICMS must stay 0 —
    // otherwise SEFAZ rejects the note with cStat 532 (totals mismatch).
    const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto: impostoFor101() }]);
    expect(totals.vICMS).toBe(0);
    expect(totals.vBC).toBe(0);
  });

  it('CSOSN 500 adds vFCPSTRet but leaves vNF = vProd (no ST in this op)', () => {
    const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto: impostoFor500() }]);
    expect(totals.vFCPSTRet).toBe(0); // our fixture has no FCP
    expect(totals.vNF).toBe(1500);
  });

  it('extras.vFrete is added to vNF and surfaces on the aggregation', () => {
    const totals = aggregateTotals([{ item: { vProd: 100 }, imposto: impostoFor102() }], {
      vFrete: 25,
    });
    expect(totals.vFrete).toBe(25);
    expect(totals.vNF).toBe(125);
  });

  it('extras.vDesc is subtracted from vNF', () => {
    const totals = aggregateTotals([{ item: { vProd: 100 }, imposto: impostoFor102() }], {
      vDesc: 10,
    });
    expect(totals.vDesc).toBe(10);
    expect(totals.vNF).toBe(90);
  });

  it('ICMSTot.vProd sums the GROSS item vProd and vNF nets extras.vDesc', () => {
    // vProd is the gross wire value (Σ <prod><vProd>); the discount rides in
    // extras.vDesc (Σ <prod><vDesc>). vNF = Σ vProd − vDesc.
    const totals = aggregateTotals(
      [
        { item: { vProd: 100 }, imposto: impostoFor102() },
        { item: { vProd: 50 }, imposto: impostoFor102() },
      ],
      { vDesc: 15 },
    );
    expect(totals.vProd).toBe(150);
    expect(totals.vDesc).toBe(15);
    expect(totals.vNF).toBe(135);
  });

  it('RTC total uses vBaseTributavel (net) not the gross vProd when they differ', async () => {
    // Gross vProd = 100, but the tribute base is 90 (a R$10 discount). The RTC
    // IBS/CBS total must be computed on 90 so it matches the per-item <IBSCBS>.
    const rtc: Imposto = {
      ...impostoFor102(),
      configuracaoIBSCBS: { CST: '000', cClassTrib: '000000', pIBSUF: 10, pIBSMun: 0, pCBS: 0 },
    };
    const grossOnly = aggregateTotals(
      [{ item: { vProd: 100 }, imposto: rtc }],
      {},
      { emitRtc: true },
    );
    const withBase = aggregateTotals(
      [{ item: { vProd: 100, vBaseTributavel: 90 }, imposto: rtc }],
      {},
      { emitRtc: true },
    );
    // 10% IBS-UF on 100 = 10.00; on the net base 90 = 9.00.
    expect(grossOnly.rtc?.vIBSUF).toBe(10);
    expect(withBase.rtc?.vIBSUF).toBe(9);
  });

  it('sums vIPI from configuracaoIPI (IPITrib) and adds it to vNF', () => {
    const ipiTrib: Imposto = {
      ...impostoFor102(),
      configuracaoIPI: { cEnq: '999', CST: '50', vIPI: 50 },
    };
    const totals = aggregateTotals([
      { item: { vProd: 1000 }, imposto: ipiTrib },
      { item: { vProd: 500 }, imposto: ipiTrib },
    ]);
    expect(totals.vIPI).toBe(100);
    expect(totals.vNF).toBe(1600); // 1500 vProd + 100 vIPI
  });

  it('IPINT items contribute 0 to vIPI (no vIPI on the config)', () => {
    const ipiNT: Imposto = {
      ...impostoFor102(),
      configuracaoIPI: { cEnq: '999', CST: '01' },
    };
    const totals = aggregateTotals([{ item: { vProd: 1000 }, imposto: ipiNT }]);
    expect(totals.vIPI).toBe(0);
    expect(totals.vNF).toBe(1000);
  });

  it('IPINT item with a STORED vIPI still contributes 0 (item emits <IPINT>, no vIPI)', () => {
    // CST 01 is IPINT — buildIPI emits <IPINT> with no <vIPI>. A stray stored vIPI
    // must NOT roll into ICMSTot.vIPI, else the total exceeds Σ item vIPI (= 0).
    const ipiNTWithValue: Imposto = {
      ...impostoFor102(),
      configuracaoIPI: { cEnq: '999', CST: '01', vIPI: 999 },
    };
    const totals = aggregateTotals([{ item: { vProd: 1000 }, imposto: ipiNTWithValue }]);
    expect(totals.vIPI).toBe(0);
    expect(totals.vNF).toBe(1000);
  });

  it('an item with BOTH ISSQN and ICMS configs contributes NO ICMS to the totals', () => {
    // buildImpostoXml emits <ISSQN> and drops the ICMS config (xs:choice). The
    // totals must match: no vICMS/vBCST/vST from an item that emitted none.
    const issqnPlusIcms: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoISSQN: { vBC: 1000, vAliq: 5, vISSQN: 50, cMunFG: '3550308', cListServ: '01.01' },
      // A CSOSN 900 config with real ICMS values that must be IGNORED here.
      configuracaoICMS: { crt: '1', csosn: '900', csosn900: { vBC: 1000, pICMS: 18, vICMS: 180 } },
    } as Imposto;
    const totals = aggregateTotals([{ item: { vProd: 1000 }, imposto: issqnPlusIcms }]);
    expect(totals.vICMS).toBe(0);
    expect(totals.vBC).toBe(0);
    // The item's value still composes vProd/vNF (ISSQN items carry a <prod><vProd>).
    expect(totals.vProd).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// ICMSTot vPIS / vCOFINS — Σ of the items that carry <ICMS> (602/603, #509)
// ---------------------------------------------------------------------------

/**
 * A `<tag>` of a built fragment in integer cents — `fmtMoney` always writes two
 * decimals, so the sum stays exact integer arithmetic. Absent (an NT group) = 0.
 */
function wireCents(xml: string, tag: 'vPIS' | 'vCOFINS'): number {
  const match = new RegExp(`<${tag}>(\\d+)\\.(\\d{2})</${tag}>`).exec(xml);
  if (match == null) return 0;
  return Number(match[1]) * 100 + Number(match[2]);
}

describe('aggregateTotals — ICMSTot vPIS/vCOFINS (602/603, #509)', () => {
  const PIS_49_PERCENT = { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 1.65 };
  const COFINS_49_PERCENT = { CST: CST_PIS_COFINS.outrasOperacoesSaida, pCOFINS: 7.6 };

  it('sums a mix of every PIS/COFINS group to Σ the <vPIS>/<vCOFINS> the items emit', () => {
    const items = [
      {
        // PISAliq / COFINSAliq: 1500 × 1.65% = 24.75, × 7.6% = 114.00
        item: { vProd: 1500, qTrib: 1 },
        imposto: impostoPisCofins(
          { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 1.65 },
          { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pCOFINS: 7.6 },
        ),
      },
      {
        // PISQtde / COFINSQtde: 4 × 0.50 = 2.00, 4 × 0.75 = 3.00
        item: { vProd: 200, qTrib: 4 },
        imposto: impostoPisCofins(
          { CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade, vAliqProd: 0.5 },
          { CST: CST_PIS_COFINS.tributavelAliquotaPorUnidade, vAliqProd: 0.75 },
        ),
      },
      {
        // PISOutr percent: 333.33 × 0.65% = 2.1666… → 2.17, × 3% = 9.9999 → 10.00
        item: { vProd: 333.33, qTrib: 1 },
        imposto: impostoPisCofins(
          { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65 },
          { CST: CST_PIS_COFINS.outrasOperacoesSaida, pCOFINS: 3 },
        ),
      },
      {
        // PISOutr per-unit: 3 × 0.1234 = 0.3702 → 0.37, 3 × 0.5678 = 1.7034 → 1.70
        item: { vProd: 60, qTrib: 3 },
        imposto: impostoPisCofins(
          { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.1234 },
          { CST: CST_PIS_COFINS.outrasOperacoes, vAliqProd: 0.5678 },
        ),
      },
      {
        // PISOutr, nothing configured: the zero shape
        item: { vProd: 10, qTrib: 1 },
        imposto: impostoPisCofins(
          { CST: CST_PIS_COFINS.outrasOperacoesSaida },
          { CST: CST_PIS_COFINS.outrasOperacoesSaida },
        ),
      },
      // Null config: the SN default PISNT/COFINSNT CST 07, no value element
      { item: { vProd: 5, qTrib: 1 }, imposto: impostoFor102() },
    ];
    const xmls = items.map(({ item, imposto }) => buildImpostoXml(imposto, item));
    const emittedPis = xmls.reduce((sum, xml) => sum + wireCents(xml, 'vPIS'), 0);
    const emittedCofins = xmls.reduce((sum, xml) => sum + wireCents(xml, 'vCOFINS'), 0);
    // 24.75 + 2.00 + 2.17 + 0.37; 114.00 + 3.00 + 10.00 + 1.70
    expect(emittedPis).toBe(2929);
    expect(emittedCofins).toBe(12870);

    const totals = aggregateTotals(items);
    expect(totals.vPIS).toBe(29.29);
    expect(totals.vCOFINS).toBe(128.7);
    const totalXml = buildTotalXml(totals);
    expect(wireCents(totalXml, 'vPIS')).toBe(emittedPis);
    expect(wireCents(totalXml, 'vCOFINS')).toBe(emittedCofins);
    expect(totalXml).toContain('<vPIS>29.29</vPIS><vCOFINS>128.70</vCOFINS>');
  });

  it('uses the net vBaseTributavel, not the gross vProd — the base the item was built on', () => {
    const imposto = impostoPisCofins(PIS_49_PERCENT, COFINS_49_PERCENT);
    const totals = aggregateTotals([
      { item: { vProd: 200, vBaseTributavel: 180, qTrib: 2 }, imposto },
    ]);
    // 180 × 1.65% = 2.97 and 180 × 7.6% = 13.68; the gross 200 would give 3.30 / 15.20.
    expect(totals.vPIS).toBe(2.97);
    expect(totals.vCOFINS).toBe(13.68);
    const itemXml = buildImpostoXml(imposto, { vProd: 180, qTrib: 2 });
    expect(wireCents(itemXml, 'vPIS')).toBe(297);
    expect(wireCents(itemXml, 'vCOFINS')).toBe(1368);
    // ICMSTot.vProd still sums the GROSS value.
    expect(totals.vProd).toBe(200);
  });

  it('sums the per-item ROUNDED values: 3 × 0.334 → 0.99, not the rounded raw Σ 1.00', () => {
    const imposto = impostoPisCofins(
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 1 },
      { CST: CST_PIS_COFINS.outrasOperacoesSaida, pCOFINS: 1 },
    );
    const item = { vProd: 33.4, qTrib: 1 };
    // Each det emits 33.40 × 1% = 0.334 → 0.33; SEFAZ sums those three 0.33s.
    expect(wireCents(buildImpostoXml(imposto, item), 'vPIS')).toBe(33);
    const totals = aggregateTotals([
      { item, imposto },
      { item, imposto },
      { item, imposto },
    ]);
    expect(totals.vPIS).toBe(0.99);
    expect(totals.vCOFINS).toBe(0.99);
  });

  it('leaves an ISSQN item out: its PIS/COFINS belong to ISSQNtot (608/609), not ICMSTot', () => {
    const onIcms = impostoPisCofins(PIS_49_PERCENT, COFINS_49_PERCENT);
    const onIssqn: Imposto = { ...onIcms, configuracaoISSQN: issqnFor() };
    const item = { vProd: 1000, qTrib: 1 };
    // The ISSQN item DOES emit a <vPIS> — under <ISSQN>, with no <ICMS> group.
    const issqnXml = buildImpostoXml(onIssqn, item);
    expect(issqnXml).toContain('<ISSQN>');
    expect(issqnXml).not.toContain('<ICMS>');
    expect(wireCents(issqnXml, 'vPIS')).toBe(1650);

    // The same config adds 16.50 / 76.00 on the ICMS item and 0 on the ISSQN one.
    const totals = aggregateTotals([
      { item, imposto: onIcms },
      { item, imposto: onIssqn },
    ]);
    expect(totals.vPIS).toBe(16.5);
    expect(totals.vCOFINS).toBe(76);
    const issqnOnly = aggregateTotals([{ item, imposto: onIssqn }]);
    expect(issqnOnly.vPIS).toBe(0);
    expect(issqnOnly.vCOFINS).toBe(0);
  });

  it("counts an indTot='0' item's vPIS/vCOFINS while its vProd stays out of vProd/vNF", () => {
    const totals = aggregateTotals([
      { item: { vProd: 1000, qTrib: 1 }, imposto: impostoFor102() },
      {
        item: { vProd: 500, qTrib: 1, indTot: '0' },
        imposto: impostoPisCofins(PIS_49_PERCENT, COFINS_49_PERCENT),
      },
    ]);
    expect(totals.vProd).toBe(1000);
    expect(totals.vNF).toBe(1000);
    // 602/603 compare against every item with an ICMS group — no indTot filter.
    expect(totals.vPIS).toBe(8.25); // 500 × 1.65%
    expect(totals.vCOFINS).toBe(38); // 500 × 7.6%
  });

  it('leaves vNF unchanged — its formula has no PIS/COFINS term', () => {
    const item = { vProd: 1500, qTrib: 1 };
    const withPisCofins = aggregateTotals([
      {
        item,
        imposto: impostoPisCofins(
          { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 1.65 },
          { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pCOFINS: 7.6 },
        ),
      },
    ]);
    const without = aggregateTotals([{ item, imposto: impostoFor102() }]);
    expect(withPisCofins.vPIS).toBe(24.75);
    expect(withPisCofins.vCOFINS).toBe(114);
    expect(withPisCofins.vNF).toBe(1500);
    expect(withPisCofins.vNF).toBe(without.vNF);
  });

  it('zero default: no-rate and 0-rate configs total 0.00, byte-equal to the null-PIS total', () => {
    const zeroConfigs = [
      ...[
        CST_PIS_COFINS.outrasOperacoesSaida,
        CST_PIS_COFINS.creditoExclusivoTributadaMercadoInterno,
        CST_PIS_COFINS.outrasOperacoesEntrada,
        CST_PIS_COFINS.outrasOperacoes,
      ].map((cst) => impostoPisCofins({ CST: cst }, { CST: cst })),
      impostoPisCofins(
        { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0, vAliqProd: 0 },
        { CST: CST_PIS_COFINS.outrasOperacoesSaida, pCOFINS: 0, vAliqProd: 0 },
      ),
    ];
    // item1500 carries no qTrib — a zero config must not demand one here either.
    const zero = aggregateTotals(zeroConfigs.map((imposto) => ({ item: item1500, imposto })));
    const nullPis = aggregateTotals(
      zeroConfigs.map(() => ({ item: item1500, imposto: impostoFor102() })),
    );
    expect(zero.vPIS).toBe(0);
    expect(zero.vCOFINS).toBe(0);
    const totalXml = buildTotalXml(zero);
    expect(totalXml).toBe(buildTotalXml(nullPis));
    expect(totalXml).toContain('<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS>');
  });
});

// ---------------------------------------------------------------------------
// Transp / Pag builders
// ---------------------------------------------------------------------------

describe('buildTranspXml', () => {
  it('defaults to modFrete=9 (sem ocorrência)', () => {
    expect(buildTranspXml()).toBe('<transp><modFrete>9</modFrete></transp>');
  });
  it('honors a passed modFrete', () => {
    expect(buildTranspXml({ modFrete: '0' })).toContain('<modFrete>0</modFrete>');
  });
  it('rejects an invalid modFrete', () => {
    expect(() => buildTranspXml({ modFrete: '8' as never })).toThrow();
  });

  it('emits <transporta> with carrier fields in canonical XSD order', () => {
    const xml = buildTranspXml({
      modFrete: '0',
      transporta: {
        CNPJ: '99999999000191',
        xNome: 'Trans Dev',
        IE: '110042490114',
        xMun: 'Sao Paulo',
        UF: 'SP',
      },
    });
    expect(xml).toContain(
      '<transporta>' +
        '<CNPJ>99999999000191</CNPJ>' +
        '<xNome>Trans Dev</xNome>' +
        '<IE>110042490114</IE>' +
        '<xMun>Sao Paulo</xMun>' +
        '<UF>SP</UF>' +
        '</transporta>',
    );
  });

  it('emits <veicTransp> with placa + UF + RNTC', () => {
    const xml = buildTranspXml({
      modFrete: '0',
      veicTransp: { placa: 'ABC1D23', UF: 'SP', RNTC: '12345' },
    });
    expect(xml).toContain(
      '<veicTransp><placa>ABC1D23</placa><UF>SP</UF><RNTC>12345</RNTC></veicTransp>',
    );
  });

  it('emits one <reboque> per trailer entry', () => {
    const xml = buildTranspXml({
      modFrete: '0',
      reboque: [{ placa: 'XYZ9876', UF: 'SP' }, { placa: 'XYZ5432' }],
    });
    expect((xml.match(/<reboque>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<reboque><placa>XYZ9876</placa><UF>SP</UF></reboque>');
  });

  it('emits <vol> with formatted pesoL/pesoB (3 decimals)', () => {
    const xml = buildTranspXml({
      modFrete: '0',
      vol: [{ qVol: 2, esp: 'CAIXA', pesoL: 1.25, pesoB: 1.5 }],
    });
    expect(xml).toContain(
      '<vol><qVol>2</qVol><esp>CAIXA</esp><pesoL>1.250</pesoL><pesoB>1.500</pesoB></vol>',
    );
  });

  it('emits one <lacres><nLacre> per seal inside <vol>', () => {
    const xml = buildTranspXml({
      modFrete: '0',
      vol: [{ qVol: 1, esp: 'CAIXA', lacres: ['SEAL-001', 'SEAL-002'] }],
    });
    expect(xml).toContain(
      '<lacres><nLacre>SEAL-001</nLacre></lacres><lacres><nLacre>SEAL-002</nLacre></lacres>',
    );
  });

  it('emits <vagao> and <balsa> when supplied', () => {
    const xml = buildTranspXml({
      modFrete: '0',
      vagao: 'V01',
      balsa: 'B01',
    });
    expect(xml).toContain('<vagao>V01</vagao>');
    expect(xml).toContain('<balsa>B01</balsa>');
  });
});

describe('buildPagXml', () => {
  it('emits one detPag for a single Pix payment', () => {
    const xml = buildPagXml([{ tPag: '17', vPag: 1500 }]);
    expect(xml).toBe('<pag><detPag><tPag>17</tPag><vPag>1500.00</vPag></detPag></pag>');
  });
  it('emits multiple detPag entries with indPag when supplied', () => {
    const xml = buildPagXml([
      { tPag: '01', vPag: 500, indPag: '0' },
      { tPag: '03', vPag: 1000, indPag: '0' },
    ]);
    expect(xml).toContain('<indPag>0</indPag>');
    expect(xml).toContain('<tPag>01</tPag>');
    expect(xml).toContain('<tPag>03</tPag>');
  });
  it('rejects an empty payments list', () => {
    expect(() => buildPagXml([])).toThrow(/at least one payment/i);
  });
  it('rejects a negative vPag', () => {
    expect(() => buildPagXml([{ tPag: '17', vPag: -1 }])).toThrow();
  });

  // <vTroco> — the second parameter. SEFAZ 866 (YA03-20) is "ausência de troco
  // quando o valor dos pagamentos informados for maior que o total da nota", so
  // an over-payment is only legal WITH this element.
  it('emits <vTroco> after </detPag> when change is supplied', () => {
    const xml = buildPagXml([{ tPag: '01', vPag: 100 }], 10);
    expect(xml).toBe(
      '<pag><detPag><tPag>01</tPag><vPag>100.00</vPag></detPag><vTroco>10.00</vTroco></pag>',
    );
  });

  it('formats the troco to 2 decimals', () => {
    expect(buildPagXml([{ tPag: '01', vPag: 100 }], 0.5)).toContain('<vTroco>0.50</vTroco>');
  });

  // ⚠️ The omission cases. A <vTroco>0.00</vTroco> is XSD-valid (TDec_1302
  // matches "0.00"), so nothing downstream would catch it — these are the only
  // guard that an absent troco stays absent.
  it('omits <vTroco> entirely when not supplied', () => {
    expect(buildPagXml([{ tPag: '01', vPag: 100 }])).not.toContain('vTroco');
  });

  it('omits <vTroco> when the troco is 0 or null', () => {
    expect(buildPagXml([{ tPag: '01', vPag: 100 }], 0)).not.toContain('vTroco');
    expect(buildPagXml([{ tPag: '01', vPag: 100 }], null)).not.toContain('vTroco');
  });

  it('rejects a negative troco (that would be a shortfall — 865, not a troco)', () => {
    expect(() => buildPagXml([{ tPag: '01', vPag: 100 }], -1)).toThrow(/vTroco/);
  });

  it('buildPagObject carries the troco on the <pag> GROUP, not on a detPag', () => {
    const pag = buildPagObject([{ tPag: '01', vPag: 100 }], 10);
    expect(pag.vTroco).toBe('10.00');
    expect(pag.detPag).toHaveLength(1);
    expect(pag.detPag[0]).not.toHaveProperty('vTroco');
  });
});

// ---------------------------------------------------------------------------
// Format helpers — quick sanity (full coverage in format.test.ts would be
// nice; sticking with the key invariants here)
// ---------------------------------------------------------------------------

describe('format helpers', () => {
  it('fmtMoney pads to 2 decimals', () => {
    expect(fmtMoney('x', 1)).toBe('1.00');
    expect(fmtMoney('x', 1500.5)).toBe('1500.50');
  });
  it('fmtRate pads to 4 decimals', () => {
    expect(fmtRate('x', 18)).toBe('18.0000');
    expect(fmtRate('x', 1.25)).toBe('1.2500');
  });
  it('throws TributeFormatError on negative numbers', () => {
    expect(() => fmtMoney('x', -1)).toThrow(TributeFormatError);
  });
});

// ---------------------------------------------------------------------------
// Reforma Tributária (IBS/CBS/IS) — NT 2025.002
// ---------------------------------------------------------------------------

/** CSOSN 102 (Simples) + a "tributação integral" RTC config (2026 test rates). */
function impostoForRtc(): Imposto {
  return {
    origem: ORIGEM.nacional,
    configuracaoICMS: { crt: '1', csosn: '102' },
    configuracaoIBSCBS: {
      CST: '000',
      cClassTrib: '000001',
      pIBSUF: 0.1,
      pIBSMun: 0,
      pCBS: 0.9,
    },
  };
}

/** Build totals + wrap + sign + XSD-validate the full NF-e with RTC ON. */
async function assertRtcXsdValid(impostoXml: string, imposto: Imposto): Promise<void> {
  const cert = fixtureCert();
  const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto }], {}, { emitRtc: true });
  const xml = wrap(
    impostoXml,
    buildTotalXml(totals),
    buildTranspXml(),
    buildPagXml([{ tPag: '17', vPag: 1500 }]),
  );
  const signed = signNFe(xml, cert);
  await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
}

describe('buildImpostoXml — Reforma Tributária (IBS/CBS/IS)', () => {
  it('emits the IBSCBS group (item) when emitRtc is on, and XSD-validates', async () => {
    const imposto = impostoForRtc();
    const xml = buildImpostoXml(imposto, item1500, { emitRtc: true });
    expect(xml).toContain('<IBSCBS>');
    expect(xml).toContain('<CST>000</CST>');
    expect(xml).toContain('<cClassTrib>000001</cClassTrib>');
    expect(xml).toContain('<gIBSCBS>');
    expect(xml).toContain('<pIBSUF>0.1000</pIBSUF>');
    expect(xml).toContain('<vIBSUF>1.50</vIBSUF>'); // 1500 × 0.1%
    expect(xml).toContain('<pCBS>0.9000</pCBS>');
    expect(xml).toContain('<vCBS>13.50</vCBS>'); // 1500 × 0.9%
    expect(xml).toContain('<vIBS>1.50</vIBS>'); // vIBSUF + vIBSMun
    await assertRtcXsdValid(xml, imposto);
  });

  it('is a no-op when emitRtc is off (default) — XML identical to the non-RTC item', () => {
    const imposto = impostoForRtc();
    const off = buildImpostoXml(imposto, item1500); // default emitRtc=false
    const offExplicit = buildImpostoXml(imposto, item1500, { emitRtc: false });
    const plain = buildImpostoXml(impostoFor102(), item1500); // same item sans RTC config
    expect(off).toBe(offExplicit);
    expect(off).not.toContain('IBSCBS');
    expect(off).not.toContain('<IS>');
    expect(off).toBe(plain); // byte-identical to the pre-RTC output
  });

  it('emits the optional IS group when configured', async () => {
    const imposto: Imposto = {
      origem: ORIGEM.nacional,
      configuracaoICMS: { crt: '1', csosn: '102' },
      configuracaoIBSCBS: {
        CST: '000',
        cClassTrib: '000001',
        pIBSUF: 0.1,
        pIBSMun: 0,
        pCBS: 0.9,
        is: { CSTIS: '000', cClassTribIS: '000000', pIS: 2 },
      },
    };
    const xml = buildImpostoXml(imposto, item1500, { emitRtc: true });
    expect(xml).toContain('<IS>');
    expect(xml).toContain('<CSTIS>000</CSTIS>');
    expect(xml).toContain('<vIS>30.00</vIS>'); // 1500 × 2%
    await assertRtcXsdValid(xml, imposto);
  });

  it('throws NFeTributeError when emitRtc is on but the registered config is incomplete', () => {
    const imposto = {
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '102' },
      configuracaoIBSCBS: { CST: '000' }, // missing cClassTrib + rates
    } as unknown as Imposto;
    // The engine's operator-fixable class, like a partial ICMSSN900 group — a
    // plain Error would escape every caller that narrows on the in-repo classes
    // (#506). The item builder and the totals aggregator share `parseRtcConfig`.
    const build = () => buildImpostoXml(imposto, item1500, { emitRtc: true });
    expect(build).toThrow(NFeTributeError);
    expect(build).toThrow(/^Invalid configuracaoIBSCBS \(RTC emission is on for this item\): /);
    expect(() =>
      aggregateTotals([{ item: { vProd: 1500 }, imposto }], {}, { emitRtc: true }),
    ).toThrow(NFeTributeError);
  });

  it('throws when an IS sub-config is configured without a rate', () => {
    const imposto = {
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '102' },
      configuracaoIBSCBS: {
        CST: '000',
        cClassTrib: '000001',
        pIBSUF: 0.1,
        pIBSMun: 0,
        pCBS: 0.9,
        is: { CSTIS: '000', cClassTribIS: '000001' }, // no pIS / pISEspec+qTrib
      },
    } as unknown as Imposto;
    const build = () => buildImpostoXml(imposto, item1500, { emitRtc: true });
    expect(build).toThrow(NFeTributeError);
    expect(build).toThrow(/IS requires/);
  });

  it("buildIS's backstop (unreachable through the schema refine) is an NFeTributeError too", () => {
    // `configuracaoISRtcSchema` rejects a rate-less IS before buildIS runs, so
    // only a direct call reaches the backstop.
    const rateless = { CSTIS: '000', cClassTribIS: '000001' } as unknown as ConfiguracaoISRtc;
    const build = () => buildIS(rateless, 1500);
    expect(build).toThrow(NFeTributeError);
    expect(build).toThrow(/^buildIS: IS requires pIS \(ad valorem\) or pISEspec \+ qTrib/);
  });
});

describe('aggregateTotals + buildTotalXml — RTC totals', () => {
  it('sums IBSCBSTot / vNFTot without touching ICMSTot.vNF', () => {
    const imposto = impostoForRtc();
    const items = [{ item: { vProd: 1500 }, imposto }];
    const off = aggregateTotals(items);
    const on = aggregateTotals(items, {}, { emitRtc: true });
    // vNF (ICMSTot) is identical regardless of RTC — the 2025–2026 transition rule.
    expect(on.vNF).toBe(off.vNF);
    expect(off.rtc).toBeUndefined();
    expect(on.rtc).toEqual({
      vBCIBSCBS: 1500,
      vIBSUF: 1.5,
      vIBSMun: 0,
      vIBS: 1.5,
      vCBS: 13.5,
      vIS: 0,
    });
    const totalXml = buildTotalXml(on);
    expect(totalXml).toContain('<IBSCBSTot>');
    expect(totalXml).toContain('<vBCIBSCBS>1500.00</vBCIBSCBS>');
    expect(totalXml).toContain('<vNFTot>1515.00</vNFTot>'); // 1500 + 1.50 + 13.50
    // The off path emits no RTC totals at all.
    expect(buildTotalXml(off)).not.toContain('IBSCBSTot');
  });

  it('omits IBSCBSTot when emitRtc is on but no item carries RTC config', () => {
    const items = [{ item: { vProd: 1500 }, imposto: impostoFor102() }];
    const totals = aggregateTotals(items, {}, { emitRtc: true });
    expect(totals.rtc).toBeUndefined();
    expect(buildTotalXml(totals)).not.toContain('IBSCBSTot');
  });
});

describe('aggregateTotals — indTot=0 (não compõe o total, #398)', () => {
  const IMPOSTO_201 = impostoFor('201', {
    csosn201: {
      pCredSN: 1.25,
      vCredICMSSN: 18.75,
      modBCST: '4',
      vBCST: 1800,
      pICMSST: 18,
      vICMSST: 324,
    },
  });

  it('excludes the item from vProd/vNF but keeps its tribute values in the buckets', () => {
    // Deliberate deviation from the legacy Flutter engine, which emitted
    // indTot='0' but still summed the item (a latent totals-mismatch
    // rejection — MOC 7.0 W16: ICMSTot.vProd = Σ vProd dos itens com indTot=1).
    const totals = aggregateTotals([
      { item: { vProd: 1500 }, imposto: impostoFor102() },
      { item: { vProd: 500, indTot: '0' }, imposto: IMPOSTO_201 },
    ]);
    expect(totals.vProd).toBe(1500); // 500 excluded
    expect(totals.vBCST).toBe(1800); // ST bucket still sums the excluded item
    expect(totals.vST).toBe(324);
    // vNF = vProd + vST + vFCPST = 1500 + 324 + 0.
    expect(totals.vNF).toBe(1824);
  });

  it('vProd collapses to 0 when every item is indTot=0', () => {
    const totals = aggregateTotals([
      { item: { vProd: 500, indTot: '0' }, imposto: impostoFor102() },
    ]);
    expect(totals.vProd).toBe(0);
    expect(totals.vNF).toBe(0);
  });

  it("indTot='1' and absent behave identically (regression: default composes)", () => {
    const explicit = aggregateTotals([
      { item: { vProd: 1500, indTot: '1' }, imposto: impostoFor102() },
    ]);
    const absent = aggregateTotals([{ item: { vProd: 1500 }, imposto: impostoFor102() }]);
    expect(explicit).toEqual(absent);
    expect(explicit.vProd).toBe(1500);
  });
});
