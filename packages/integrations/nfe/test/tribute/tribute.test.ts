/**
 * Tribute engine tests.
 *
 * Each CSOSN variant + PIS/COFINS variant is built, embedded inside a
 * minimum-viable signed `<NFe>`, and round-tripped through
 * `validateXsd('NFe', signedXml)` — so XSD drift surfaces locally,
 * not as a SEFAZ cStat=215 in production.
 */
import { describe, expect, it } from 'vitest';
import forge from 'node-forge';

import { signNFe, validateXsd, type NFeCertificate } from '../../src/index';

import {
  aggregateISSQN,
  aggregateRetTrib,
  aggregateTotals,
  buildImpostoXml,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  configuracaoIBSCBSSchema,
  fmtMoney,
  fmtRate,
  NFeTributeError,
  TributeFormatError,
  type ConfiguracaoISSQN,
  type Imposto,
  type Retencao,
} from '../../src/tribute/index';

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

/** Wrap an imposto/total/transp/pag set inside a signable <NFe>. */
function wrap(impostoXml: string, totalXml: string, transpXml: string, pagXml: string): string {
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
    '<qCom>1.0000</qCom><vUnCom>1500.0000000000</vUnCom><vProd>1500.00</vProd>' +
    '<cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib>' +
    '<qTrib>1.0000</qTrib><vUnTrib>1500.0000000000</vUnTrib>' +
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const item1500 = { vProd: 1500 };

function impostoFor(csosn: string, extra: Partial<Imposto['configuracaoICMS']> = {}): Imposto {
  return {
    origem: '0',
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
    expect(xml).toContain('<ICMSSN500>');
    expect(xml).toContain('<vBCSTRet>1500.00</vBCSTRet>');
    expect(xml).toContain('<pST>18.0000</pST>');
    expect(xml).toContain('<vICMSSTRet>270.00</vICMSSTRet>');
    await assertXsdValid(xml);
  });

  it('CSOSN 900 → ICMSSN900 (kitchen sink, all optional)', async () => {
    const imposto = impostoFor('900', {
      csosn900: {
        modBC: '3',
        vBC: 1500,
        pICMS: 18,
        vICMS: 270,
        pCredSN: 1.25,
        vCredICMSSN: 18.75,
      },
    });
    const xml = buildImpostoXml(imposto, item1500);
    expect(xml).toContain('<ICMSSN900>');
    expect(xml).toContain('<vBC>1500.00</vBC>');
    expect(xml).toContain('<vICMS>270.00</vICMS>');
    await assertXsdValid(xml);
  });

  // PIS / COFINS Outr regression — SEFAZ XSD requires vBC + pPIS (or
  // qBCProd + vAliqProd) before vPIS even when the SN flow emits zeros.
  // Previously the dispatcher emitted only `{ CST, vPIS: '0.00' }` and
  // xmllint-wasm rejected with "vPIS not expected, expected vBC or qBCProd".
  it.each(['49', '99'])(
    'PIS CST %s → PISOutr with vBC + pPIS + vPIS (SEFAZ xs:choice)',
    async (cst) => {
      const imposto: Imposto = {
        ...impostoFor102(),
        configuracaoPIS: { CST: cst as never },
        configuracaoCOFINS: { CST: cst as never },
      };
      const xml = buildImpostoXml(imposto, item1500);
      expect(xml).toContain('<PISOutr>');
      expect(xml).toContain(`<CST>${cst}</CST>`);
      expect(xml).toContain('<vBC>0.00</vBC>');
      expect(xml).toContain('<pPIS>0.0000</pPIS>');
      expect(xml).toContain('<vPIS>0.00</vPIS>');
      expect(xml).toContain('<COFINSOutr>');
      expect(xml).toContain('<pCOFINS>0.0000</pCOFINS>');
      expect(xml).toContain('<vCOFINS>0.00</vCOFINS>');
      await assertXsdValid(xml);
    },
  );
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
    indISS: '1',
    indIncentivo: '2',
    ...extra,
  };
}

describe('buildImpostoXml — ISSQN (xs:choice with ICMS)', () => {
  it('emits <ISSQN> with required fields and no <ICMS> when configuracaoISSQN is set', async () => {
    const imposto: Imposto = {
      origem: '0',
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
      origem: '0',
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
    const imposto: Imposto = { origem: '0' };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  it('allows IPI to ride alongside ISSQN (both choice + IPI block)', async () => {
    const imposto: Imposto = {
      origem: '0',
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
    const issqnImposto: Imposto = { origem: '0', configuracaoISSQN: issqnFor() };
    const out = aggregateISSQN(
      [
        { item: { vProd: 500 }, imposto: issqnImposto },
        {
          item: { vProd: 300 },
          imposto: { origem: '0', configuracaoISSQN: issqnFor({ vBC: 300, vISSQN: 15 }) },
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
    const issqnImposto: Imposto = { origem: '0', configuracaoISSQN: issqnFor() };
    expect(() => aggregateISSQN([{ item: { vProd: 500 }, imposto: issqnImposto }])).toThrow(
      /dCompet/,
    );
  });

  it('emits cRegTrib when supplied via extras', () => {
    const issqnImposto: Imposto = { origem: '0', configuracaoISSQN: issqnFor() };
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
      origem: '0',
      configuracaoICMS: { crt: '3', csosn: null },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  it('throws on CRT=4 (MEI)', () => {
    const imposto: Imposto = {
      origem: '0',
      configuracaoICMS: { crt: '4', csosn: null },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  it('throws on missing csosn for CRT=1', () => {
    const imposto: Imposto = {
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: null },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(/csosn/i);
  });

  it('throws on CSOSN 101 without csosn101 sub-config', () => {
    const imposto: Imposto = {
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '101' },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
  });

  it('throws on CSOSN 500 without csosn500 sub-config', () => {
    const imposto: Imposto = {
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '500' },
    };
    expect(() => buildImpostoXml(imposto, item1500)).toThrow(NFeTributeError);
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

  it('CSOSN 101 adds vCredICMSSN to the vICMS bucket', () => {
    const totals = aggregateTotals([{ item: { vProd: 1500 }, imposto: impostoFor101() }]);
    expect(totals.vICMS).toBe(18.75);
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
    origem: '0',
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
      origem: '0',
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

  it('throws when emitRtc is on but the registered config is incomplete', () => {
    const imposto = {
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '102' },
      configuracaoIBSCBS: { CST: '000' }, // missing cClassTrib + rates
    } as unknown as Imposto;
    expect(() => buildImpostoXml(imposto, item1500, { emitRtc: true })).toThrow(
      /configuracaoIBSCBS/,
    );
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
    expect(() => buildImpostoXml(imposto, item1500, { emitRtc: true })).toThrow(/IS requires/);
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

describe('configuracaoIBSCBSSchema — CST↔cClassTrib structural rule (#333)', () => {
  const base = { CST: '000', cClassTrib: '000001', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 };

  it('accepts the confirmed tributação-integral pair (000 / 000001)', () => {
    expect(configuracaoIBSCBSSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a structurally valid code not in the vendored seed (lenient membership)', () => {
    // 200099 is structurally valid for CST 200 but isn't in our seed — must NOT
    // be rejected (membership is a UI warning only, never an emit-time block).
    const ok = configuracaoIBSCBSSchema.safeParse({ ...base, CST: '200', cClassTrib: '200099' });
    expect(ok.success).toBe(true);
  });

  it('rejects when cClassTrib first 3 digits ≠ CST', () => {
    const res = configuracaoIBSCBSSchema.safeParse({ ...base, CST: '000', cClassTrib: '410001' });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'cClassTrib');
      expect(issue?.message).toMatch(/3 primeiros dígitos/);
    }
  });
});
