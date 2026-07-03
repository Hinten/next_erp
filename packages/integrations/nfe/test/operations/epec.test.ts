/**
 * Library-level tests for the EPEC operation (`enviarEpec`, tpEvento 110140).
 * Mocks the SOAP transport (`nfeRecepcaoEvento`) and the signer (`signEvento`)
 * so the build → XSD-validate → sign → send → parse pipeline runs offline with
 * the REAL builders, the REAL e110140 XSD gate and the real `parse`. Mirrors
 * the mock setup in `cancelar-inutilizar.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';

import type { NFeCertificate } from '../../src/cert';
import type { SefazCall } from '../../src/soap';
import { NFeXsdValidationError } from '../../src/xsd';

vi.mock('../../src/soap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/soap')>();
  return {
    ...actual,
    nfeRecepcaoEvento: vi.fn(),
  };
});

vi.mock('../../src/sign', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sign')>();
  return {
    ...actual,
    signEvento: vi.fn((xml: string) =>
      xml.replace('</evento>', '<Signature>MOCK</Signature></evento>'),
    ),
  };
});

import type { EpecEventoInput } from '../../src/eventos/index';
import { enviarEpec } from '../../src/operations/index';
import { nfeRecepcaoEvento as mockedNfeRecepcaoEvento } from '../../src/soap';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const CHAVE = '35200714200166000187550010000000071000000018';
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
    url: 'https://example.invalid/an/rec',
    cert: dummyCertificate(),
    agent: new https.Agent(),
    tpAmb: '2',
  };
}

function epecArgs(dest?: EpecEventoInput['dest']): Omit<EpecEventoInput, 'tpAmb'> {
  return {
    chNFe: CHAVE,
    cnpj: CNPJ,
    ie: '110042490114',
    cOrgaoAutor: '35',
    verAplic: 'erp-next 1.0',
    dhEmi: '2026-06-11T08:30:00-03:00',
    tpNF: '1',
    dest: dest ?? {
      uf: 'SP',
      cnpj: '99999999000191',
      ie: '222222222',
      vNF: '1234.56',
      vICMS: '0.00',
      vST: '0.00',
    },
    dhEvento: new Date('2026-06-11T08:35:00-03:00'),
  };
}

function retEventoEpec(cStat: string): string {
  return (
    `<retEvento versao="1.00">` +
    `<infEvento Id="ID110140${CHAVE}01">` +
    `<tpAmb>2</tpAmb><verAplic>AN_EVENTOS</verAplic><cOrgao>91</cOrgao>` +
    `<cStat>${cStat}</cStat>` +
    `<xMotivo>${cStat === '136' ? 'Evento registrado, mas nao vinculado a NF-e' : 'Evento registrado e vinculado a NF-e'}</xMotivo>` +
    `<chNFe>${CHAVE}</chNFe><tpEvento>110140</tpEvento>` +
    `<xEvento>EPEC</xEvento><nSeqEvento>1</nSeqEvento>` +
    `<dhRegEvento>2026-06-11T08:36:00-03:00</dhRegEvento>` +
    `<nProt>891260000012345</nProt>` +
    `</infEvento></retEvento>`
  );
}

function retEnvEvento(opts: { cStatLote: string; evento?: string }): string {
  return (
    `<retEnvEvento xmlns="${NFE_NS}" versao="1.00">` +
    `<idLote>1</idLote><tpAmb>2</tpAmb><verAplic>AN_EVENTOS</verAplic>` +
    `<cOrgao>91</cOrgao><cStat>${opts.cStatLote}</cStat>` +
    `<xMotivo>Lote de Evento Processado</xMotivo>` +
    (opts.evento ?? '') +
    `</retEnvEvento>`
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('enviarEpec', () => {
  it('builds → signs → sends the EPEC evento to the AN and parses retEnvEvento (cStat 135)', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '128', evento: retEventoEpec('135') }),
      rawBody: '',
    });

    const res = await enviarEpec(dummyCall(), epecArgs());

    expect(res.ret.retEvento?.[0]?.infEvento.cStat).toBe('135');
    expect(res.ret.retEvento?.[0]?.infEvento.nProt).toBe('891260000012345');
    expect(res.procEventoNFe).not.toBeNull();
    expect(res.rawResponse).toContain('<retEnvEvento');

    // The signed evento is spliced verbatim into the sent envEvento.
    const sent = vi.mocked(mockedNfeRecepcaoEvento).mock.calls[0]![1];
    expect(sent).toMatch(/^<envEvento /);
    expect(sent).toContain('<Signature>MOCK</Signature>');
    expect(sent).toContain(`Id="ID110140${CHAVE}01"`);
    // EPEC routes through cOrgao 91 (Ambiente Nacional) with the issuer's
    // cUF only inside the detEvento summary.
    expect(sent).toContain('<cOrgao>91</cOrgao>');
    expect(sent).toContain('<descEvento>EPEC</descEvento>');
    expect(sent).toContain('<cOrgaoAutor>35</cOrgaoAutor>');
    expect(sent).toContain('<vNF>1234.56</vNF>');
  });

  it('cStat 136 (registrado, não vinculado) is surfaced — the orchestrator treats it as registrado', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '128', evento: retEventoEpec('136') }),
      rawBody: '',
    });
    const res = await enviarEpec(dummyCall(), epecArgs());
    expect(res.ret.retEvento?.[0]?.infEvento.cStat).toBe('136');
    expect(res.procEventoNFe).not.toBeNull();
  });

  it('passes the e110140 XSD gate for a CPF destinatário', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '128', evento: retEventoEpec('135') }),
      rawBody: '',
    });
    await enviarEpec(
      dummyCall(),
      epecArgs({ uf: 'SP', cpf: '12345678909', vNF: '50.00', vICMS: '0.00', vST: '0.00' }),
    );
    const sent = vi.mocked(mockedNfeRecepcaoEvento).mock.calls[0]![1];
    expect(sent).toContain('<CPF>12345678909</CPF>');
  });

  it('passes the e110140 XSD gate for a foreign buyer (idEstrangeiro + UF EX)', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '128', evento: retEventoEpec('135') }),
      rawBody: '',
    });
    await enviarEpec(
      dummyCall(),
      epecArgs({ uf: 'EX', idEstrangeiro: 'EX998877', vNF: '50.00', vICMS: '0.00', vST: '0.00' }),
    );
    const sent = vi.mocked(mockedNfeRecepcaoEvento).mock.calls[0]![1];
    expect(sent).toContain('<UF>EX</UF>');
    expect(sent).toContain('<idEstrangeiro>EX998877</idEstrangeiro>');
  });

  it('rejects a schema-invalid summary at the XSD gate (before send) — SEFAZ-ban kill switch', async () => {
    // The e110140 IE element requires [0-9]{2,14}; a 1-digit IE must die
    // locally, never on the wire (cStat=215 → 656 consumo indevido path).
    await expect(enviarEpec(dummyCall(), { ...epecArgs(), ie: '1' })).rejects.toBeInstanceOf(
      NFeXsdValidationError,
    );
    expect(vi.mocked(mockedNfeRecepcaoEvento)).not.toHaveBeenCalled();
  });

  it('returns procEventoNFe = null on a lote-level rejection (no retEvento)', async () => {
    vi.mocked(mockedNfeRecepcaoEvento).mockResolvedValueOnce({
      resultXml: retEnvEvento({ cStatLote: '215' }),
      rawBody: '',
    });
    const res = await enviarEpec(dummyCall(), epecArgs());
    expect(res.ret.retEvento).toBeUndefined();
    expect(res.procEventoNFe).toBeNull();
  });
});
