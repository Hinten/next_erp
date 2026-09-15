import { describe, it, expect } from 'vitest';

import { NFeXsdValidationError, validateConsCad, validateRetConsCad } from '../../src/xsd/index';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
// Request root is `ConsCad` with a CAPITAL C (SEFAZ quirk — the schema file is
// lowercase consCad_v2.00.xsd but the element it declares is `ConsCad`).
const consCad = (inner: string): string =>
  `<ConsCad versao="2.00" xmlns="${NFE_NS}">${inner}</ConsCad>`;

describe('validateConsCad', () => {
  it('accepts a well-formed ConsCad (xServ/UF/CNPJ)', async () => {
    await expect(
      validateConsCad(
        consCad('<infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons>'),
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts the IE choice variant', async () => {
    await expect(
      validateConsCad(
        consCad('<infCons><xServ>CONS-CAD</xServ><UF>SP</UF><IE>111111111111</IE></infCons>'),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a bad xServ enumeration', async () => {
    await expect(
      validateConsCad(
        consCad('<infCons><xServ>NOPE</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons>'),
      ),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects a missing versao attribute', async () => {
    await expect(
      validateConsCad(
        `<ConsCad xmlns="${NFE_NS}"><infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons></ConsCad>`,
      ),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });

  it('rejects the lowercase root element (consCad — the bug that caused 215)', async () => {
    await expect(
      validateConsCad(
        `<consCad versao="2.00" xmlns="${NFE_NS}"><infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons></consCad>`,
      ),
    ).rejects.toBeInstanceOf(NFeXsdValidationError);
  });
});

// Every field TRetConsCad_infCons requires, in sequence order; `extra` lands where
// `infCad` goes (after cUF).
const HEADER =
  '<verAplic>SP_NFE_PL_009</verAplic><cStat>259</cStat>' +
  '<xMotivo>CNPJ não consta na base de dados da SEFAZ</xMotivo><UF>SP</UF>' +
  '<CNPJ>14200166000187</CNPJ><dhCons>2026-06-23T10:00:00-03:00</dhCons><cUF>35</cUF>';
const retConsCad = (infCons: string): string =>
  `<retConsCad versao="2.00" xmlns="${NFE_NS}"><infCons>${infCons}</infCons></retConsCad>`;

async function rejection(xml: string): Promise<NFeXsdValidationError> {
  const err: unknown = await validateRetConsCad(xml).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NFeXsdValidationError);
  return err as NFeXsdValidationError;
}

describe('validateRetConsCad', () => {
  it('accepts a schema-valid reply with no infCad (cStat 259)', async () => {
    await expect(validateRetConsCad(retConsCad(HEADER))).resolves.toBeUndefined();
  });

  it('accepts a schema-valid reply with an infCad', async () => {
    const infCad =
      '<infCad><IE>111111111111</IE><CNPJ>14200166000187</CNPJ><UF>SP</UF><cSit>1</cSit>' +
      '<indCredNFe>1</indCredNFe><indCredCTe>0</indCredCTe><xNome>EMPRESA TESTE LTDA</xNome></infCad>';
    await expect(validateRetConsCad(retConsCad(HEADER + infCad))).resolves.toBeUndefined();
  });

  it('rejects a reply missing a required field (dhCons), naming the retConsCad root', async () => {
    const err = await rejection(retConsCad(HEADER.replace(/<dhCons>.*<\/dhCons>/, '')));
    expect(err.rootKey).toBe('retConsCad');
    expect(err.message).toContain('dhCons');
  });

  it('rejects an element layout 2.00 does not declare — infCons is a closed sequence', async () => {
    // An extra field is NOT ignored: there is no xs:any, so a reply carrying one
    // never reaches the parse. A UF that appends a field fails right here (#1602).
    const err = await rejection(retConsCad(`${HEADER}<algoNovo>x</algoNovo>`));
    expect(err.rootKey).toBe('retConsCad');
    expect(err.message).toContain('algoNovo');
  });

  it('rejects an empty retConsCad (no infCons)', async () => {
    const err = await rejection(`<retConsCad versao="2.00" xmlns="${NFE_NS}"></retConsCad>`);
    expect(err.rootKey).toBe('retConsCad');
  });

  it('rejects a captive-portal / proxy HTML page', async () => {
    const err = await rejection('<html><body>Acesso bloqueado</body></html>');
    expect(err.rootKey).toBe('retConsCad');
  });

  it('rejects the REQUEST root handed to the response validator', async () => {
    // Near-miss: the same document validateConsCad accepts above must not pass
    // as a reply — each validator is bound to its own root schema.
    await rejection(
      consCad('<infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>14200166000187</CNPJ></infCons>'),
    );
  });
});
