/**
 * Validate the tribute stub against the canonical SEFAZ XSD.
 *
 * The stub is throwaway homologação scaffolding; if any helper drifts
 * out of XSD spec we want to know locally, not via cStat=215 from
 * SEFAZ. Each helper is round-tripped through `validateXsd('NFe', ...)`
 * against a minimal fake NF-e wrapper.
 */
import { describe, expect, it } from 'vitest';
import forge from 'node-forge';

import {
  signNFe,
  validateXsd,
  type GeneratorItem,
  type NFeCertificate,
} from '@delfrance/integrations-nfe';

import {
  buildEmptyTotalXml,
  buildSimplePag,
  buildSimpleTransp,
  buildSimplesNacionalCsosn102ImpostoXml,
} from './tribute';

/** Self-signed cert just to satisfy the Signature XSD piece on <NFe>. */
function fixtureCert(): NFeCertificate {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'TEST' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    certificateDerBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    ),
    subjectCommonName: 'TEST',
    notAfter: cert.validity.notAfter,
    pfxBuffer: Buffer.from(''),
    password: '',
  };
}

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const CHAVE = '35260514200166000187550010000000071000000018';

function sampleItem(over: Partial<GeneratorItem> = {}): GeneratorItem {
  return {
    nItem: 1,
    cProd: 'SKU-1',
    cEAN: 'SEM GTIN',
    xProd: 'Bicicleta Aro 29',
    NCM: '87120000',
    CFOP: '5102',
    uCom: 'UN',
    qCom: 1,
    vUnCom: 1500,
    vProd: 1500,
    cEANTrib: 'SEM GTIN',
    uTrib: 'UN',
    qTrib: 1,
    vUnTrib: 1500,
    indTot: '1',
    impostoXml: '',
    ...over,
  };
}

/** Minimum-viable signed-NF-e wrapper, used only to satisfy XSD validation. */
function wrap(impostoXml: string, totalXml: string, transpXml: string, pagXml: string): string {
  const item = sampleItem({ impostoXml });
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
    '</enderEmit>' +
    '<IE>111111111111</IE><CRT>1</CRT>' +
    '</emit>' +
    '<dest>' +
    '<CNPJ>99999999000191</CNPJ>' +
    '<xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>' +
    '<enderDest>' +
    '<xLgr>Av B</xLgr><nro>1</nro><xBairro>Centro</xBairro>' +
    '<cMun>3550308</cMun><xMun>Sao Paulo</xMun><UF>SP</UF>' +
    '<CEP>01001000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais>' +
    '</enderDest>' +
    '<indIEDest>9</indIEDest>' +
    '</dest>' +
    '<det nItem="1">' +
    '<prod>' +
    '<cProd>SKU-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Bicicleta</xProd>' +
    '<NCM>87120000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>' +
    '<qCom>1.0000</qCom><vUnCom>1500.0000000000</vUnCom><vProd>1500.00</vProd>' +
    '<cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib>' +
    '<qTrib>1.0000</qTrib><vUnTrib>1500.0000000000</vUnTrib>' +
    '<indTot>1</indTot>' +
    '</prod>' +
    item.impostoXml +
    '</det>' +
    totalXml +
    transpXml +
    pagXml +
    '</infNFe>' +
    '</NFe>'
  );
}

describe('tribute stub — XSD validity', () => {
  it('buildSimplesNacionalCsosn102ImpostoXml produces a valid <imposto>', async () => {
    const imposto = buildSimplesNacionalCsosn102ImpostoXml(sampleItem());
    const unsigned = wrap(
      imposto,
      buildEmptyTotalXml([sampleItem()]),
      buildSimpleTransp(),
      buildSimplePag(1500),
    );
    const signed = signNFe(unsigned, fixtureCert());
    await expect(validateXsd('NFe', signed)).resolves.toBeUndefined();
  });

  it('buildEmptyTotalXml sums vProd into vNF', () => {
    const t = buildEmptyTotalXml([
      sampleItem({ vProd: 1500 }),
      sampleItem({ vProd: 250.5 }),
    ]);
    expect(t).toContain('<vProd>1750.50</vProd>');
    expect(t).toContain('<vNF>1750.50</vNF>');
    expect(t).toContain('<vICMS>0.00</vICMS>'); // homologação stub posture
  });

  it('buildSimpleTransp produces modFrete=9 (sem ocorrencia)', () => {
    expect(buildSimpleTransp()).toBe('<transp><modFrete>9</modFrete></transp>');
  });

  it('buildSimplePag echoes vPag = vNF', () => {
    expect(buildSimplePag(1500)).toContain('<vPag>1500.00</vPag>');
    expect(buildSimplePag(1500)).toContain('<tPag>99</tPag>');
  });
});
