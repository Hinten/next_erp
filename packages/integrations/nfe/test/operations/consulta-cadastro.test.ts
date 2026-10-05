import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';

import type { NFeCertificate } from '../../src/cert';
import type { SefazCall } from '../../src/soap';
import { consultarCadastro } from '../../src/operations/index';
import { NFeXsdValidationError } from '../../src/xsd/index';

vi.mock('../../src/soap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/soap')>();
  return {
    ...actual,
    nfeConsultaCadastro: vi.fn(),
  };
});

import { nfeConsultaCadastro as mockedNfeConsultaCadastro } from '../../src/soap';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const CNPJ = '14200166000187';

function dummyCertificate(): NFeCertificate {
  return {
    privateKeyPem: '',
    certificatePem: '',
    certificateDerBase64: '',
    subjectCommonName: 'TEST:99999999000191',
    cnpj: '99999999000191',
    notAfter: new Date(Date.now() + 86_400_000),
    pfxBuffer: Buffer.from(''),
    password: '',
  };
}

function dummyCall(): SefazCall {
  return {
    url: 'https://example.invalid/ws/cadconsultacadastro4.asmx',
    cert: dummyCertificate(),
    agent: new https.Agent(),
    tpAmb: '2',
  };
}

// Every fixture below is a SCHEMA-VALID retConsCad: `consultarCadastro` checks the
// reply against retConsCad_v2.00.xsd before parsing it (#1602), so an invalid
// fixture would test the rejection path instead of the parse.

/** retConsCad with a single match (one infCad WITH ender) — cStat 111. */
const RET_111 =
  `<retConsCad versao="2.00" xmlns="${NFE_NS}">` +
  `<infCons><verAplic>SP_NFE_PL_009</verAplic><cStat>111</cStat>` +
  `<xMotivo>Consulta cadastro com uma ocorrência</xMotivo><UF>SP</UF><CNPJ>${CNPJ}</CNPJ>` +
  `<dhCons>2026-06-23T10:00:00-03:00</dhCons><cUF>35</cUF>` +
  `<infCad><IE>111111111111</IE><CNPJ>${CNPJ}</CNPJ><UF>SP</UF><cSit>1</cSit>` +
  `<indCredNFe>1</indCredNFe><indCredCTe>0</indCredCTe>` +
  `<xNome>EMPRESA TESTE LTDA</xNome><xRegApur>NORMAL</xRegApur><CNAE>4711301</CNAE>` +
  `<ender><xLgr>RUA DAS FLORES</xLgr><nro>100</nro><xCpl>SALA 2</xCpl>` +
  `<xBairro>CENTRO</xBairro><cMun>3550308</cMun><xMun>SAO PAULO</xMun><CEP>01001000</CEP>` +
  `</ender></infCad>` +
  `</infCons></retConsCad>`;

/** retConsCad with two matches (two infCad) — cStat 112. */
const RET_112 =
  `<retConsCad versao="2.00" xmlns="${NFE_NS}">` +
  `<infCons><verAplic>SP_NFE_PL_009</verAplic><cStat>112</cStat>` +
  `<xMotivo>Consulta cadastro com mais de uma ocorrência</xMotivo><UF>SP</UF><CNPJ>${CNPJ}</CNPJ>` +
  `<dhCons>2026-06-23T10:00:00-03:00</dhCons><cUF>35</cUF>` +
  `<infCad><IE>111111111111</IE><CNPJ>${CNPJ}</CNPJ><UF>SP</UF><cSit>1</cSit>` +
  `<indCredNFe>1</indCredNFe><indCredCTe>0</indCredCTe><xNome>FILIAL UM</xNome></infCad>` +
  `<infCad><IE>222222222222</IE><CNPJ>${CNPJ}</CNPJ><UF>SP</UF><cSit>0</cSit>` +
  `<indCredNFe>0</indCredNFe><indCredCTe>0</indCredCTe><xNome>FILIAL DOIS</xNome></infCad>` +
  `</infCons></retConsCad>`;

/** retConsCad with no match — cStat 259 (CNPJ não consta na base). */
const RET_259 =
  `<retConsCad versao="2.00" xmlns="${NFE_NS}">` +
  `<infCons><verAplic>SP_NFE_PL_009</verAplic><cStat>259</cStat>` +
  `<xMotivo>CNPJ não consta na base de dados da SEFAZ</xMotivo><UF>SP</UF><CNPJ>${CNPJ}</CNPJ>` +
  `<dhCons>2026-06-23T10:00:00-03:00</dhCons><cUF>35</cUF>` +
  `</infCons></retConsCad>`;

/**
 * A REAL SEFAZ-SP homologação reply, verbatim (2026-09-15). The queried CNPJ is a
 * placeholder with invalid check digits — hence cStat 258 — so it carries no
 * taxpayer data.
 */
const RET_258_REAL_SEFAZ_SP =
  `<retConsCad versao="2.00" xmlns="${NFE_NS}"><infCons><verAplic>SP_NFE_PL009_V4</verAplic>` +
  `<cStat>258</cStat><xMotivo>Rejeição: CNPJ da consulta inválido</xMotivo><UF>SP</UF>` +
  `<CNPJ>12345678000199</CNPJ><dhCons>2026-09-15T09:39:35-03:00</dhCons><cUF>35</cUF>` +
  `</infCons></retConsCad>`;

function replyWith(resultXml: string): void {
  vi.mocked(mockedNfeConsultaCadastro).mockResolvedValueOnce({ resultXml, rawBody: resultXml });
}

/** The reply must be rejected by the response XSD check — never parsed into a result. */
async function expectReplyRejected(resultXml: string): Promise<NFeXsdValidationError> {
  replyWith(resultXml);
  const err: unknown = await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NFeXsdValidationError);
  const xsdErr = err as NFeXsdValidationError;
  expect(xsdErr.rootKey).toBe('retConsCad');
  return xsdErr;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('consultarCadastro', () => {
  it('builds a versao="2.00" consCad request with CONS-CAD, the UF and CNPJ', async () => {
    replyWith(RET_111);

    await consultarCadastro(dummyCall(), { uf: 'sp', cnpj: CNPJ });

    expect(mockedNfeConsultaCadastro).toHaveBeenCalledOnce();
    const sentXml = vi.mocked(mockedNfeConsultaCadastro).mock.calls[0]![1];
    // Root element is `ConsCad` with a CAPITAL C (SEFAZ quirk) — lowercase is a 215.
    expect(sentXml).toContain('<ConsCad');
    expect(sentXml).not.toContain('<consCad');
    expect(sentXml).toContain('versao="2.00"');
    expect(sentXml).toContain('<xServ>CONS-CAD</xServ>');
    expect(sentXml).toContain('<UF>SP</UF>'); // uppercased
    expect(sentXml).toContain(`<CNPJ>${CNPJ}</CNPJ>`);
    // No whitespace between tags (digest/wire-shape predictability).
    expect(sentXml).not.toMatch(/>\s+</);
    // cUF (IBGE) for the nfeCabecMsg SOAP header — '35' for SP.
    expect(vi.mocked(mockedNfeConsultaCadastro).mock.calls[0]![2]).toBe('35');
  });

  it('serializes the request from the layout 2.00 META — exact wire shape', async () => {
    // Pinned whole: the order comes from the generated META, so a regen that
    // moved an element would change what SEFAZ receives. (The SOAP layer strips
    // the declaration before embedding it in the envelope.) The request also
    // passed the REAL validateConsCad on its way here — only the POST is mocked.
    replyWith(RET_259);
    await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ });
    expect(vi.mocked(mockedNfeConsultaCadastro).mock.calls[0]![1]).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        `<ConsCad xmlns="${NFE_NS}" versao="2.00">` +
        `<infCons><xServ>CONS-CAD</xServ><UF>SP</UF><CNPJ>${CNPJ}</CNPJ></infCons>` +
        `</ConsCad>`,
    );
  });

  it('strips non-digits from the CNPJ before sending', async () => {
    replyWith(RET_259);
    await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: '14.200.166/0001-87' });
    const sentXml = vi.mocked(mockedNfeConsultaCadastro).mock.calls[0]![1];
    expect(sentXml).toContain(`<CNPJ>${CNPJ}</CNPJ>`);
  });

  it('parses cStat 111 — one infCad WITH ender, normalized to an array', async () => {
    replyWith(RET_111);

    const result = await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ });

    expect(result.cStat).toBe('111');
    expect(result.xMotivo).toBe('Consulta cadastro com uma ocorrência');
    expect(result.uf).toBe('SP');
    expect(result.infCad).toHaveLength(1);

    const cad = result.infCad[0]!;
    expect(cad.IE).toBe('111111111111');
    expect(cad.CNPJ).toBe(CNPJ);
    expect(cad.CPF).toBeNull();
    expect(cad.UF).toBe('SP');
    expect(cad.cSit).toBe('1');
    expect(cad.indCredNFe).toBe('1');
    expect(cad.indCredCTe).toBe('0');
    expect(cad.xNome).toBe('EMPRESA TESTE LTDA');

    expect(cad.ender).not.toBeNull();
    expect(cad.ender!.xLgr).toBe('RUA DAS FLORES');
    expect(cad.ender!.nro).toBe('100');
    expect(cad.ender!.xCpl).toBe('SALA 2');
    expect(cad.ender!.xBairro).toBe('CENTRO');
    expect(cad.ender!.cMun).toBe('3550308');
    expect(cad.ender!.xMun).toBe('SAO PAULO');
    expect(cad.ender!.CEP).toBe('01001000');
  });

  it('parses cStat 112 — two infCad entries (single→array normalization)', async () => {
    replyWith(RET_112);

    const result = await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ });

    expect(result.cStat).toBe('112');
    expect(result.infCad).toHaveLength(2);
    expect(result.infCad[0]!.xNome).toBe('FILIAL UM');
    expect(result.infCad[0]!.cSit).toBe('1');
    expect(result.infCad[0]!.ender).toBeNull();
    expect(result.infCad[1]!.xNome).toBe('FILIAL DOIS');
    expect(result.infCad[1]!.cSit).toBe('0');
  });

  it('parses cStat 259 — no match, empty infCad', async () => {
    replyWith(RET_259);

    const result = await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ });

    expect(result.cStat).toBe('259');
    expect(result.xMotivo).toBe('CNPJ não consta na base de dados da SEFAZ');
    expect(result.infCad).toHaveLength(0);
  });

  it('accepts a real SEFAZ-SP homologação reply (cStat 258) and parses it', async () => {
    replyWith(RET_258_REAL_SEFAZ_SP);

    const result = await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: '12345678000199' });

    expect(result.cStat).toBe('258');
    expect(result.xMotivo).toBe('Rejeição: CNPJ da consulta inválido');
    expect(result.uf).toBe('SP');
    expect(result.infCad).toHaveLength(0);
  });

  it('trims the padding SEFAZ-SP really sends before validating — a trailing space is not a 500 (#1602)', async () => {
    // Real SEFAZ-SP homologação (2026-09-15) returned <xNome> with a trailing
    // space, which TString's pattern forbids. Each element is trimmed before the
    // XSD check, so the reply passes; whitespace INSIDE a value is kept, and an
    // xs:token field (cSit) is trimmed the same way.
    const padded = RET_111.replace(
      '<xNome>EMPRESA TESTE LTDA</xNome>',
      '<xNome>EMPRESA  TESTE LTDA </xNome>',
    ).replace('<cSit>1</cSit>', '<cSit> 1 </cSit>');
    replyWith(padded);

    const cad = (await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ })).infCad[0]!;

    expect(cad.xNome).toBe('EMPRESA  TESTE LTDA');
    expect(cad.cSit).toBe('1');
    expect(cad.indCredCTe).toBe('0');
  });

  it('still rejects a value that is ONLY whitespace — trimmed to empty, it fails the XSD', async () => {
    // Near-miss of the test above: the trim must not turn a blank value into a
    // pass. `<xCpl>   </xCpl>` becomes `<xCpl></xCpl>`, which TString rejects.
    const err = await expectReplyRejected(
      RET_111.replace('<xCpl>SALA 2</xCpl>', '<xCpl>   </xCpl>'),
    );
    expect(err.message).toContain('xCpl');
  });

  it('rejects a reply missing a required field (dhCons) — #1602', async () => {
    const err = await expectReplyRejected(RET_259.replace(/<dhCons>.*<\/dhCons>/, ''));
    expect(err.message).toContain('dhCons');
  });

  it('rejects a retConsCad with no infCons', async () => {
    await expectReplyRejected(`<retConsCad versao="2.00" xmlns="${NFE_NS}"></retConsCad>`);
  });

  it('rejects an HTML page inside the result wrapper (captive portal / proxy)', async () => {
    await expectReplyRejected('<html><body>Acesso bloqueado pelo proxy</body></html>');
  });

  it('rejects truncated XML — unterminated comment', async () => {
    // xmllint refuses the malformed document before the parser ever sees it. The
    // parser's own no-spin guard on truncated input is pinned in test/xml.
    await expectReplyRejected(`<retConsCad versao="2.00" xmlns="${NFE_NS}"><!-- truncado`);
  });
});
