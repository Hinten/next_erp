/**
 * Library-level tests for the cancelamento + inutilização operations.
 * Mocks the SOAP transport (`nfeRecepcaoEvento` / `nfeInutilizacao`) and
 * the signer (`signEvento` / `signInutilizacao`) so the build → sign →
 * send → parse pipeline runs offline with the real builders + real
 * `parse`. Mirrors the mock setup in `operations.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';

import type { NFeCertificate } from '../../src/cert';
import type { SefazCall } from '../../src/soap';

vi.mock('../../src/soap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/soap')>();
  return {
    ...actual,
    nfeRecepcaoEvento: vi.fn(),
    nfeInutilizacao: vi.fn(),
  };
});

// Passthrough signer — appends a marker <Signature> so the signed payload
// is structurally distinct from the unsigned one (no real key needed).
vi.mock('../../src/sign', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sign')>();
  return {
    ...actual,
    signEvento: vi.fn((xml: string) =>
      xml.replace('</evento>', '<Signature>MOCK</Signature></evento>'),
    ),
    signInutilizacao: vi.fn((xml: string) =>
      xml.replace('</inutNFe>', '<Signature>MOCK</Signature></inutNFe>'),
    ),
  };
});

import { cancelarNFe, cartaCorrecaoNFe, inutilizarNumeracao } from '../../src/operations/index';
import {
  nfeInutilizacao as mockedNfeInutilizacao,
  nfeRecepcaoEvento as mockedNfeRecepcaoEvento,
} from '../../src/soap';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const CHAVE = '35200714200166000187550010000000071000000018';
const CNPJ = '14200166000187';
const NPROT = '135200000012345';

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

function retEvento(cStat: string): string {
  return (
    `<retEvento versao="1.00">` +
    `<infEvento Id="ID110111${CHAVE}01">` +
    `<tpAmb>2</tpAmb><verAplic>SP_EVENTOS</verAplic><cOrgao>35</cOrgao>` +
    `<cStat>${cStat}</cStat>` +
    `<xMotivo>Evento registrado e vinculado a NF-e</xMotivo>` +
    `<chNFe>${CHAVE}</chNFe><tpEvento>110111</tpEvento>` +
    `<xEvento>Cancelamento</xEvento><nSeqEvento>1</nSeqEvento>` +
    `<dhRegEvento>2026-05-29T10:00:00-03:00</dhRegEvento>` +
    `<nProt>135200000099999</nProt>` +
    `</infEvento></retEvento>`
  );
}

function retEnvEvento(opts: { cStatLote: string; evento?: string }): string {
  return (
    `<retEnvEvento xmlns="${NFE_NS}" versao="1.00">` +
    `<idLote>1</idLote><tpAmb>2</tpAmb><verAplic>SP_EVENTOS</verAplic>` +
    `<cOrgao>35</cOrgao><cStat>${opts.cStatLote}</cStat>` +
    `<xMotivo>Lote de Evento Processado</xMotivo>` +
    (opts.evento ?? '') +
    `</retEnvEvento>`
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('cancelarNFe', () => {
  function cancelArgs() {
    return {
      chNFe: CHAVE,
      cOrgao: '35',
      cnpj: CNPJ,
      nProt: NPROT,
      xJust: 'Cancelamento por erro de digitacao no pedido',
      dhEvento: new Date('2026-05-29T10:00:00'),
    };
  }

  it('builds → signs → sends a single-evento envEvento and parses retEnvEvento', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '128', evento: retEvento('135') }),
      rawBody: '',
    });

    const res = await cancelarNFe(dummyCall(), cancelArgs());

    expect(res.ret.retEvento?.[0]?.infEvento.cStat).toBe('135');
    expect(res.ret.retEvento?.[0]?.infEvento.nProt).toBe('135200000099999');
    expect(res.procEventoNFe).not.toBeNull();
    expect(res.rawResponse).toContain('<retEnvEvento');

    // The signed evento (with the mock Signature) must be spliced verbatim
    // into the sent envEvento — re-serialization would break the digest.
    const sent = vi.mocked(mockedNfeRecepcaoEvento).mock.calls[0]![1];
    expect(sent).toMatch(/^<envEvento /);
    expect(sent).toContain('<idLote>1</idLote>');
    expect(sent).toContain('<Signature>MOCK</Signature>');
    expect(sent).toContain(`Id="ID110111${CHAVE}01"`);
  });

  it('accepts cStat 155 (homologado fora de prazo) the same way', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '128', evento: retEvento('155') }),
      rawBody: '',
    });
    const res = await cancelarNFe(dummyCall(), cancelArgs());
    expect(res.ret.retEvento?.[0]?.infEvento.cStat).toBe('155');
    expect(res.procEventoNFe).not.toBeNull();
  });

  it('returns procEventoNFe = null on a lote-level rejection (no retEvento)', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '215' }),
      rawBody: '',
    });
    const res = await cancelarNFe(dummyCall(), cancelArgs());
    expect(res.ret.retEvento).toBeUndefined();
    expect(res.procEventoNFe).toBeNull();
  });
});

describe('cartaCorrecaoNFe', () => {
  function cceArgs(nSeqEvento = 1) {
    return {
      chNFe: CHAVE,
      cOrgao: '35',
      cnpj: CNPJ,
      xCorrecao: 'Correcao do peso bruto informado no campo de transporte da nota',
      nSeqEvento,
      dhEvento: new Date('2026-05-29T10:00:00'),
    };
  }

  function retEventoCCe(cStat: string, nSeq = 1): string {
    return (
      `<retEvento versao="1.00">` +
      `<infEvento Id="ID110110${CHAVE}${String(nSeq).padStart(2, '0')}">` +
      `<tpAmb>2</tpAmb><verAplic>SP_EVENTOS</verAplic><cOrgao>35</cOrgao>` +
      `<cStat>${cStat}</cStat>` +
      `<xMotivo>Evento registrado e vinculado a NF-e</xMotivo>` +
      `<chNFe>${CHAVE}</chNFe><tpEvento>110110</tpEvento>` +
      `<xEvento>Carta de Correcao</xEvento><nSeqEvento>${nSeq}</nSeqEvento>` +
      `<dhRegEvento>2026-05-29T10:00:00-03:00</dhRegEvento>` +
      `<nProt>135200000077777</nProt>` +
      `</infEvento></retEvento>`
    );
  }

  it('builds → signs → sends the CC-e evento (tpEvento 110110) and parses retEnvEvento', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '128', evento: retEventoCCe('135', 2) }),
      rawBody: '',
    });

    const res = await cartaCorrecaoNFe(dummyCall(), cceArgs(2));

    expect(res.ret.retEvento?.[0]?.infEvento.cStat).toBe('135');
    expect(res.ret.retEvento?.[0]?.infEvento.nProt).toBe('135200000077777');
    expect(res.procEventoNFe).not.toBeNull();

    const sent = vi.mocked(mockedNfeRecepcaoEvento).mock.calls[0]![1];
    expect(sent).toMatch(/^<envEvento /);
    expect(sent).toContain('<Signature>MOCK</Signature>');
    // Id encodes tpEvento 110110 + chave + zero-padded nSeqEvento (02 here).
    expect(sent).toContain(`Id="ID110110${CHAVE}02"`);
    // The fixed xCondUso legal text rides in the detEvento.
    expect(sent).toContain('A Carta de Correção é disciplinada');
  });

  it('rejects an xCorrecao below 15 chars at the XSD gate (before send)', async () => {
    await expect(
      cartaCorrecaoNFe(dummyCall(), { ...cceArgs(), xCorrecao: 'curto' }),
    ).rejects.toThrow();
    expect(vi.mocked(mockedNfeRecepcaoEvento)).not.toHaveBeenCalled();
  });
});

describe('inutilizarNumeracao (library)', () => {
  function inutArgs() {
    return {
      cUF: '35',
      ano: '26',
      cnpj: CNPJ,
      serie: 9,
      nNFIni: 5,
      nNFFin: 12,
      xJust: 'Inutilizacao de faixa nao utilizada teste',
    };
  }

  function retInutNFe(cStat: string): string {
    return (
      `<retInutNFe xmlns="${NFE_NS}" versao="4.00">` +
      `<infInut Id="ID35261420016600018755009000000005000000012">` +
      `<tpAmb>2</tpAmb><verAplic>SP_NFE</verAplic>` +
      `<cStat>${cStat}</cStat>` +
      `<xMotivo>Inutilizacao de numero homologada</xMotivo>` +
      `<cUF>35</cUF><ano>26</ano><CNPJ>${CNPJ}</CNPJ><mod>55</mod>` +
      `<serie>9</serie><nNFIni>5</nNFIni><nNFFin>12</nNFFin>` +
      `<dhRecbto>2026-05-29T10:00:00-03:00</dhRecbto>` +
      `<nProt>135200000088888</nProt>` +
      `</infInut></retInutNFe>`
    );
  }

  it('builds → signs → sends inutNFe and parses cStat 102 + nProt', async () => {
    vi.mocked(mockedNfeInutilizacao).mockResolvedValueOnce({
      resultXml: retInutNFe('102'),
      rawBody: '',
    });

    const res = await inutilizarNumeracao(dummyCall(), inutArgs());

    expect(res.ret.infInut.cStat).toBe('102');
    expect(res.ret.infInut.nProt).toBe('135200000088888');
    expect(res.rawResponse).toContain('<retInutNFe');

    const sent = vi.mocked(mockedNfeInutilizacao).mock.calls[0]![1];
    expect(sent).toMatch(/^<inutNFe /);
    expect(sent).toContain('<xServ>INUTILIZAR</xServ>');
    expect(sent).toContain('<Signature>MOCK</Signature>');
  });

  it('surfaces a rejection cStat (caller decides) without throwing', async () => {
    vi.mocked(mockedNfeInutilizacao).mockResolvedValueOnce({
      resultXml: retInutNFe('563'),
      rawBody: '',
    });
    const res = await inutilizarNumeracao(dummyCall(), inutArgs());
    expect(res.ret.infInut.cStat).toBe('563');
  });
});
