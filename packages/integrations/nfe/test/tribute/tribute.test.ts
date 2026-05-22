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
  aggregateTotals,
  buildImpostoXml,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  fmtMoney,
  fmtRate,
  NFeTributeError,
  TributeFormatError,
  type Imposto,
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
    totalXml + transpXml + pagXml +
    '</infNFe></NFe>'
  );
}

/** Build a single-item SN-102 NF-e and assert it's XSD-valid after signing. */
async function assertXsdValid(impostoXml: string) {
  const cert = fixtureCert();
  const totals = aggregateTotals([
    { item: { vProd: 1500 }, imposto: impostoFor102() },
  ]);
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
    const totals = aggregateTotals([
      { item: { vProd: 1500 }, imposto: impostoFor101() },
    ]);
    expect(totals.vICMS).toBe(18.75);
  });

  it('CSOSN 500 adds vFCPSTRet but leaves vNF = vProd (no ST in this op)', () => {
    const totals = aggregateTotals([
      { item: { vProd: 1500 }, imposto: impostoFor500() },
    ]);
    expect(totals.vFCPSTRet).toBe(0); // our fixture has no FCP
    expect(totals.vNF).toBe(1500);
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
});

describe('buildPagXml', () => {
  it('emits one detPag for a single Pix payment', () => {
    const xml = buildPagXml([{ tPag: '17', vPag: 1500 }]);
    expect(xml).toBe(
      '<pag><detPag><tPag>17</tPag><vPag>1500.00</vPag></detPag></pag>',
    );
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
