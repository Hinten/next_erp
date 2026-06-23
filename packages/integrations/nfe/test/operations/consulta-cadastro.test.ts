import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';

import type { NFeCertificate } from '../../src/cert';
import type { SefazCall } from '../../src/soap';
import { consultarCadastro } from '../../src/operations/index';

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

/** retConsCad with a single match (one infCad WITH ender) — cStat 111. */
const RET_111 =
  `<retConsCad versao="2.00" xmlns="${NFE_NS}">` +
  `<infCons><verAplic>SP_NFE_PL_009</verAplic><cStat>111</cStat>` +
  `<xMotivo>Consulta cadastro com uma ocorrência</xMotivo><UF>SP</UF><CNPJ>${CNPJ}</CNPJ>` +
  `<dhCons>2026-06-23T10:00:00-03:00</dhCons><cUF>35</cUF>` +
  `<infCad><IE>111111111111</IE><CNPJ>${CNPJ}</CNPJ><UF>SP</UF><cSit>1</cSit>` +
  `<indCredNFe>1</indCredNFe><indCredNFCe>0</indCredNFCe>` +
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
  `<infCad><IE>111111111111</IE><CNPJ>${CNPJ}</CNPJ><UF>SP</UF><cSit>1</cSit>` +
  `<xNome>FILIAL UM</xNome></infCad>` +
  `<infCad><IE>222222222222</IE><CNPJ>${CNPJ}</CNPJ><UF>SP</UF><cSit>0</cSit>` +
  `<xNome>FILIAL DOIS</xNome></infCad>` +
  `</infCons></retConsCad>`;

/** retConsCad with no match — cStat 259 (CNPJ não consta na base). */
const RET_259 =
  `<retConsCad versao="2.00" xmlns="${NFE_NS}">` +
  `<infCons><verAplic>SP_NFE_PL_009</verAplic><cStat>259</cStat>` +
  `<xMotivo>CNPJ não consta na base de dados da SEFAZ</xMotivo><UF>SP</UF><CNPJ>${CNPJ}</CNPJ>` +
  `</infCons></retConsCad>`;

afterEach(() => {
  vi.clearAllMocks();
});

describe('consultarCadastro', () => {
  it('builds a versao="2.00" consCad request with CONS-CAD, the UF and CNPJ', async () => {
    vi.mocked(mockedNfeConsultaCadastro).mockResolvedValueOnce({
      resultXml: RET_111,
      rawBody: RET_111,
    });

    await consultarCadastro(dummyCall(), { uf: 'sp', cnpj: CNPJ });

    expect(mockedNfeConsultaCadastro).toHaveBeenCalledOnce();
    const sentXml = vi.mocked(mockedNfeConsultaCadastro).mock.calls[0]![1];
    expect(sentXml).toContain('<consCad');
    expect(sentXml).toContain('versao="2.00"');
    expect(sentXml).toContain('<xServ>CONS-CAD</xServ>');
    expect(sentXml).toContain('<UF>SP</UF>'); // uppercased
    expect(sentXml).toContain(`<CNPJ>${CNPJ}</CNPJ>`);
    // No whitespace between tags (digest/wire-shape predictability).
    expect(sentXml).not.toMatch(/>\s+</);
  });

  it('strips non-digits from the CNPJ before sending', async () => {
    vi.mocked(mockedNfeConsultaCadastro).mockResolvedValueOnce({
      resultXml: RET_259,
      rawBody: RET_259,
    });
    await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: '14.200.166/0001-87' });
    const sentXml = vi.mocked(mockedNfeConsultaCadastro).mock.calls[0]![1];
    expect(sentXml).toContain(`<CNPJ>${CNPJ}</CNPJ>`);
  });

  it('parses cStat 111 — one infCad WITH ender, normalized to an array', async () => {
    vi.mocked(mockedNfeConsultaCadastro).mockResolvedValueOnce({
      resultXml: RET_111,
      rawBody: RET_111,
    });

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
    expect(cad.indCredNFCe).toBe('0');
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
    vi.mocked(mockedNfeConsultaCadastro).mockResolvedValueOnce({
      resultXml: RET_112,
      rawBody: RET_112,
    });

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
    vi.mocked(mockedNfeConsultaCadastro).mockResolvedValueOnce({
      resultXml: RET_259,
      rawBody: RET_259,
    });

    const result = await consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ });

    expect(result.cStat).toBe('259');
    expect(result.xMotivo).toBe('CNPJ não consta na base de dados da SEFAZ');
    expect(result.infCad).toHaveLength(0);
  });

  it('throws NFeXmlError when retConsCad has no infCons (our/SEFAZ-shape bug)', async () => {
    vi.mocked(mockedNfeConsultaCadastro).mockResolvedValueOnce({
      resultXml: `<retConsCad versao="2.00" xmlns="${NFE_NS}"></retConsCad>`,
      rawBody: '',
    });
    await expect(consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ })).rejects.toThrow(
      /infCons/,
    );
  });

  it('fails fast (does not spin) on truncated XML — unterminated comment', async () => {
    // Without the indexOf(-1) guards in parseConsCadXml this unterminated `<!--`
    // pushes the cursor backwards and the loop spins forever. With the guards it
    // breaks, leaves infCons unparsed, and consultarCadastro throws — a hang
    // would instead trip Vitest's per-test timeout and fail loudly.
    vi.mocked(mockedNfeConsultaCadastro).mockResolvedValueOnce({
      resultXml: `<retConsCad versao="2.00" xmlns="${NFE_NS}"><!-- truncado`,
      rawBody: '',
    });
    await expect(consultarCadastro(dummyCall(), { uf: 'SP', cnpj: CNPJ })).rejects.toThrow(
      /infCons/,
    );
  });
});
