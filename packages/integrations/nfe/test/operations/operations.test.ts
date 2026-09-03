import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';

import type { NFeCertificate } from '../../src/cert';
import { NFeXsdValidationError } from '../../src/xsd';
import type { SefazCall } from '../../src/soap';
import {
  autorizarLote,
  consultarLote,
  consultarSituacaoNFe,
  consultarStatusServico,
} from '../../src/operations/index';

vi.mock('../../src/soap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/soap')>();
  return {
    ...actual,
    nfeStatusServico: vi.fn(),
    nfeConsultaProtocolo: vi.fn(),
    nfeRetAutorizacao: vi.fn(),
    nfeAutorizacaoLote: vi.fn(),
  };
});

import {
  nfeAutorizacaoLote as mockedNfeAutorizacaoLote,
  nfeConsultaProtocolo as mockedNfeConsultaProtocolo,
  nfeRetAutorizacao as mockedNfeRetAutorizacao,
  nfeStatusServico as mockedNfeStatusServico,
} from '../../src/soap';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const CHAVE = '35200714200166000187550010000000071000000018';

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
    url: 'https://example.invalid/ws',
    cert: dummyCertificate(),
    agent: new https.Agent(),
    tpAmb: '2',
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('consultarStatusServico', () => {
  it('serializes the request, calls nfeStatusServico, and returns the typed response', async () => {
    const responseXml =
      `<retConsStatServ xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><verAplic>SP_NFE_PL_009i</verAplic><cStat>107</cStat>` +
      `<xMotivo>Servico em Operacao</xMotivo><cUF>35</cUF>` +
      `<dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto>` +
      `</retConsStatServ>`;
    vi.mocked(mockedNfeStatusServico).mockResolvedValueOnce({
      resultXml: responseXml,
      rawBody: '<soap…>' + responseXml + '</soap…>',
    });

    const result = await consultarStatusServico(dummyCall(), { cUF: '35' });

    expect(result.cStat).toBe('107');
    expect(result.xMotivo).toBe('Servico em Operacao');
    expect(result.cUF).toBe('35');
    expect(result.tpAmb).toBe('2');

    // Inspect the request the helper built.
    expect(mockedNfeStatusServico).toHaveBeenCalledOnce();
    const sentXml = vi.mocked(mockedNfeStatusServico).mock.calls[0]![1];
    expect(sentXml).toContain('<consStatServ');
    expect(sentXml).toContain('<tpAmb>2</tpAmb>');
    expect(sentXml).toContain('<cUF>35</cUF>');
    expect(sentXml).toContain('<xServ>STATUS</xServ>');
    expect(sentXml).toContain('versao="4.00"');
  });

  it('propagates the XSD error when the SOAP layer rejects the request', async () => {
    vi.mocked(mockedNfeStatusServico).mockRejectedValueOnce(
      new NFeXsdValidationError('consStatServ', [{ message: 'invalid', line: 1 }]),
    );
    await expect(consultarStatusServico(dummyCall(), { cUF: '35' })).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
  });
});

describe('consultarSituacaoNFe', () => {
  it('builds a consSitNFe request with the chave', async () => {
    const responseXml =
      `<retConsSitNFe xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><verAplic>SP</verAplic><cStat>100</cStat>` +
      `<xMotivo>Autorizado o uso da NF-e</xMotivo><cUF>35</cUF>` +
      `<dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto>` +
      `<chNFe>${CHAVE}</chNFe>` +
      `</retConsSitNFe>`;
    vi.mocked(mockedNfeConsultaProtocolo).mockResolvedValueOnce({
      resultXml: responseXml,
      rawBody: responseXml,
    });

    const result = await consultarSituacaoNFe(dummyCall(), { chave: CHAVE });

    expect(result.cStat).toBe('100');
    expect(result.chNFe).toBe(CHAVE);

    const sentXml = vi.mocked(mockedNfeConsultaProtocolo).mock.calls[0]![1];
    expect(sentXml).toContain(`<chNFe>${CHAVE}</chNFe>`);
    expect(sentXml).toContain('<xServ>CONSULTAR</xServ>');
  });
});

describe('consultarLote', () => {
  it('builds a consReciNFe request with nRec and returns the typed response', async () => {
    const responseXml =
      `<retConsReciNFe xmlns="${NFE_NS}" versao="4.00">` +
      `<tpAmb>2</tpAmb><verAplic>SP</verAplic><nRec>351000000000123</nRec>` +
      `<cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>35</cUF>` +
      `<dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto>` +
      `</retConsReciNFe>`;
    vi.mocked(mockedNfeRetAutorizacao).mockResolvedValueOnce({
      resultXml: responseXml,
      rawBody: responseXml,
    });

    const result = await consultarLote(dummyCall(), { nRec: '351000000000123' });

    expect(result.cStat).toBe('104');
    expect(result.nRec).toBe('351000000000123');

    const sentXml = vi.mocked(mockedNfeRetAutorizacao).mock.calls[0]![1];
    expect(sentXml).toContain('<nRec>351000000000123</nRec>');
  });
});

describe('autorizarLote', () => {
  const SIGNED_NFE =
    `<NFe xmlns="${NFE_NS}">` +
    `<infNFe Id="NFe${CHAVE}" versao="4.00">…signed body…</infNFe>` +
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">…digest…</Signature>` +
    `</NFe>`;

  it('splices each signed NFe verbatim into the enviNFe wrapper', async () => {
    vi.mocked(mockedNfeAutorizacaoLote).mockResolvedValueOnce({
      resultXml:
        `<retEnviNFe xmlns="${NFE_NS}" versao="4.00">` +
        `<tpAmb>2</tpAmb><verAplic>SP</verAplic><cStat>103</cStat>` +
        `<xMotivo>Lote recebido com sucesso</xMotivo><cUF>35</cUF>` +
        `<dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto>` +
        `<infRec><nRec>351000000000123</nRec><tMed>1</tMed></infRec>` +
        `</retEnviNFe>`,
      rawBody: '',
    });

    const result = await autorizarLote(dummyCall(), {
      idLote: '1',
      NFe: [SIGNED_NFE],
    });

    expect(result.cStat).toBe('103');
    expect(result.infRec?.nRec).toBe('351000000000123');

    const sentXml = vi.mocked(mockedNfeAutorizacaoLote).mock.calls[0]![1];
    // The signed NF-e must appear byte-for-byte inside enviNFe — re-parsing
    // would invalidate the digest. This is the regression test for that.
    expect(sentXml).toContain(SIGNED_NFE);
    expect(sentXml).toContain('<idLote>1</idLote>');
    // Single-NFe lote auto-derives indSinc='1' (sync) — SEFAZ rejects
    // single-NFe async with "Solicitada resposta assíncrona para Lote
    // com somente 1 (uma) NF-e".
    expect(sentXml).toContain('<indSinc>1</indSinc>');
    expect(sentXml).toMatch(/^<enviNFe /);
  });

  it("auto-derives indSinc='0' (async) for multi-NFe lotes", async () => {
    vi.mocked(mockedNfeAutorizacaoLote).mockResolvedValueOnce({
      resultXml:
        `<retEnviNFe xmlns="${NFE_NS}" versao="4.00">` +
        `<tpAmb>2</tpAmb><verAplic>SP</verAplic><cStat>103</cStat>` +
        `<xMotivo>Lote recebido com sucesso</xMotivo><cUF>35</cUF>` +
        `<dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto>` +
        `<infRec><nRec>351000000000124</nRec><tMed>1</tMed></infRec>` +
        `</retEnviNFe>`,
      rawBody: '',
    });
    await autorizarLote(dummyCall(), {
      idLote: '2',
      NFe: [SIGNED_NFE, SIGNED_NFE],
    });
    const sentXml = vi.mocked(mockedNfeAutorizacaoLote).mock.calls[0]![1];
    expect(sentXml).toContain('<indSinc>0</indSinc>');
  });

  it("honors explicit indSinc='1' (synchronous)", async () => {
    vi.mocked(mockedNfeAutorizacaoLote).mockResolvedValueOnce({
      resultXml:
        `<retEnviNFe xmlns="${NFE_NS}" versao="4.00">` +
        `<tpAmb>2</tpAmb><verAplic>SP</verAplic><cStat>104</cStat>` +
        `<xMotivo>Lote processado</xMotivo><cUF>35</cUF>` +
        `<dhRecbto>2026-05-20T10:30:00-03:00</dhRecbto>` +
        `</retEnviNFe>`,
      rawBody: '',
    });
    await autorizarLote(dummyCall(), {
      idLote: '42',
      NFe: [SIGNED_NFE],
      indSinc: '1',
    });
    const sentXml = vi.mocked(mockedNfeAutorizacaoLote).mock.calls[0]![1];
    expect(sentXml).toContain('<indSinc>1</indSinc>');
  });

  it('rejects an empty NFe array', async () => {
    await expect(autorizarLote(dummyCall(), { idLote: '1', NFe: [] })).rejects.toThrow(
      /at least one signed NFe/,
    );
  });
});
