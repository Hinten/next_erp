/**
 * Orchestrator tests for danfeArtifactService — load an nfev4 doc and render a
 * DANFE artifact from its persisted procNFe. No SEFAZ round-trip; the only
 * dependency is Firestore (a small in-memory fake) + the real renderers from
 * `@delfrance/integrations-nfe/danfe`.
 */
import { describe, expect, it } from 'vitest';

import { ESTADO_NFE } from '@delfrance/schemas';

import {
  danfeArtifactService,
  NFeDanfeError,
  NFePedidoNotFoundError,
} from '../../../lib/nfe/orchestrator';

const CHAVE = '35260514200166000187550010000000071000000018';

/** A compact authorized procNFe — enough to render the simplificado. */
const PROCNFE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe${CHAVE}" versao="4.00">
    <ide><cUF>35</cUF><natOp>VENDA</natOp><mod>55</mod><serie>1</serie><nNF>7</nNF>
      <dhEmi>2026-05-26T15:25:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>2</tpAmb></ide>
    <emit><CNPJ>14200166000187</CNPJ><xNome>DELFRANCE LTDA</xNome>
      <enderEmit><xLgr>RUA A</xLgr><nro>1</nro><xBairro>CENTRO</xBairro>
        <xMun>SAO PAULO</xMun><UF>SP</UF><CEP>01001000</CEP></enderEmit>
      <IE>110042490114</IE><CRT>1</CRT></emit>
    <dest><CNPJ>99999090910270</CNPJ><xNome>HOMOLOGACAO</xNome><indIEDest>9</indIEDest></dest>
    <total><ICMSTot><vNF>1234.56</vNF><vProd>1234.56</vProd></ICMSTot></total>
  </infNFe></NFe>
  <protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${CHAVE}</chNFe>
    <dhRecbto>2026-05-26T15:30:12-03:00</dhRecbto><nProt>135260000000456</nProt>
    <cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>
</nfeProc>`;

/** Minimal in-memory Firestore — only the single `doc().get()` the service uses. */
function fakeFirestore(seed: Record<string, Record<string, unknown> | null>) {
  const docs = { ...seed };
  function ref(path: string) {
    return {
      path,
      id: path.split('/').pop()!,
      async get() {
        const data = docs[path];
        return { exists: data != null, id: path.split('/').pop()!, data: () => data };
      },
    };
  }
  function collection(path: string) {
    return { doc: (id: string) => ref(`${path}/${id}`) };
  }
  return { collection: (p: string) => collection(p), doc: (p: string) => ref(p) } as never;
}

function aprovadaDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    estado: ESTADO_NFE.aprovada,
    chave: CHAVE,
    numeracao: 7,
    serie: 1,
    tpEmis: 1,
    xml_nfe_proc: PROCNFE,
    ultima_modificacao: '2026-05-26T15:30:00.000Z',
    ...overrides,
  };
}

describe('danfeArtifactService', () => {
  it('renders the simplificado PDF for an aprovada NF-e', async () => {
    const fs = fakeFirestore({ 'pedidos/PED-1/nfev4/s1': aprovadaDoc() });
    const art = await danfeArtifactService(fs, 'PED-1', 's1', { format: 'simplificado' });

    expect(art.contentType).toBe('application/pdf');
    expect(art.filename).toBe('danfe-7.pdf');
    expect(Buffer.isBuffer(art.body)).toBe(true);
    expect((art.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renders the ZPL label for format=zpl2', async () => {
    const fs = fakeFirestore({ 'pedidos/PED-1/nfev4/s1': aprovadaDoc() });
    const art = await danfeArtifactService(fs, 'PED-1', 's1', { format: 'zpl2', dpi: 300 });

    expect(art.contentType).toBe('text/plain; charset=utf-8');
    expect(art.filename).toBe('danfe-7.txt');
    expect(typeof art.body).toBe('string');
    expect(art.body as string).toContain('^XA');
    expect(art.body as string).toContain('^PW1181'); // 300 dpi
  });

  it('renders a cancelada NF-e (CANCELADO overlay) from its retained procNFe', async () => {
    const fs = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaDoc({ estado: ESTADO_NFE.cancelada }),
    });
    const art = await danfeArtifactService(fs, 'PED-1', 's1', { format: 'simplificado' });
    expect((art.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('throws NFePedidoNotFoundError (→404) when the nfev4 doc is absent', async () => {
    const fs = fakeFirestore({ 'pedidos/PED-1/nfev4/s1': null });
    await expect(
      danfeArtifactService(fs, 'PED-1', 's1', { format: 'simplificado' }),
    ).rejects.toBeInstanceOf(NFePedidoNotFoundError);
  });

  it('throws NFeDanfeError (→422) when the NF-e never authorized', async () => {
    const fs = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaDoc({ estado: ESTADO_NFE.rejeitada }),
    });
    await expect(
      danfeArtifactService(fs, 'PED-1', 's1', { format: 'simplificado' }),
    ).rejects.toBeInstanceOf(NFeDanfeError);
  });

  it('throws NFeDanfeError (→422) when xml_nfe_proc is missing', async () => {
    const fs = fakeFirestore({
      'pedidos/PED-1/nfev4/s1': aprovadaDoc({ xml_nfe_proc: null }),
    });
    await expect(
      danfeArtifactService(fs, 'PED-1', 's1', { format: 'simplificado' }),
    ).rejects.toBeInstanceOf(NFeDanfeError);
  });
});

// ---------------------------------------------------------------------------
// EPEC-approved (estado 'p') — the DANFE renders from xml_assinado +
// xml_epec_proc (no nfeProc yet); the ZPL label is not available.
// ---------------------------------------------------------------------------

describe('danfeArtifactService — EPEC (estado p)', () => {
  /** The bare signed NFe (EPEC has no nfeProc) — the fixture's <NFe>, tpEmis 4. */
  const NFE_ASSINADO = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${CHAVE}" versao="4.00">
  <ide><cUF>35</cUF><natOp>VENDA</natOp><mod>55</mod><serie>1</serie><nNF>7</nNF>
    <dhEmi>2026-06-11T08:30:00-03:00</dhEmi><tpNF>1</tpNF><tpEmis>4</tpEmis><tpAmb>2</tpAmb>
    <verProc>erp-next 1.0</verProc>
    <dhCont>2026-06-11T08:00:00-03:00</dhCont><xJust>SEFAZ-SP indisponivel desde as 08h</xJust></ide>
  <emit><CNPJ>14200166000187</CNPJ><xNome>DELFRANCE LTDA</xNome>
    <enderEmit><xLgr>RUA A</xLgr><nro>1</nro><xBairro>CENTRO</xBairro>
      <xMun>SAO PAULO</xMun><UF>SP</UF><CEP>01001000</CEP></enderEmit>
    <IE>110042490114</IE><CRT>1</CRT></emit>
  <dest><CNPJ>99999090910270</CNPJ><xNome>HOMOLOGACAO</xNome><indIEDest>9</indIEDest></dest>
  <total><ICMSTot><vNF>1234.56</vNF><vProd>1234.56</vProd></ICMSTot></total>
</infNFe><Signature>…</Signature></NFe>`;

  const XML_EPEC_PROC = `<?xml version="1.0" encoding="UTF-8"?>
<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
  <evento versao="1.00"><infEvento Id="ID110140${CHAVE}01"><cOrgao>91</cOrgao><chNFe>${CHAVE}</chNFe></infEvento></evento>
  <retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><cOrgao>91</cOrgao><cStat>136</cStat>
    <xMotivo>Evento registrado, mas nao vinculado a NF-e</xMotivo><chNFe>${CHAVE}</chNFe>
    <tpEvento>110140</tpEvento><nSeqEvento>1</nSeqEvento>
    <dhRegEvento>2026-06-11T08:31:02-03:00</dhRegEvento><nProt>891260000012345</nProt>
  </infEvento></retEvento>
</procEventoNFe>`;

  function epecDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return aprovadaDoc({
      estado: ESTADO_NFE.epecAprovado,
      tpEmis: 4,
      xml_nfe_proc: null,
      xml_assinado: NFE_ASSINADO,
      xml_epec_proc: XML_EPEC_PROC,
      ...overrides,
    });
  }

  it('renders the retrato PDF from xml_assinado + xml_epec_proc with the epec filename', async () => {
    const fs = fakeFirestore({ 'pedidos/PED-1/nfev4/s4': epecDoc() });
    const art = await danfeArtifactService(fs, 'PED-1', 's4', { format: 'retrato' });

    expect(art.contentType).toBe('application/pdf');
    expect(art.filename).toBe('danfe-epec-7.pdf');
    expect((art.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('rejects the ZPL label for an EPEC (PDF only)', async () => {
    const fs = fakeFirestore({ 'pedidos/PED-1/nfev4/s4': epecDoc() });
    await expect(danfeArtifactService(fs, 'PED-1', 's4', { format: 'zpl2' })).rejects.toThrow(
      /etiqueta ZPL não disponível para EPEC/,
    );
  });

  it('throws NFeDanfeError when the p doc lacks xml_epec_proc', async () => {
    const fs = fakeFirestore({
      'pedidos/PED-1/nfev4/s4': epecDoc({ xml_epec_proc: null }),
    });
    await expect(
      danfeArtifactService(fs, 'PED-1', 's4', { format: 'retrato' }),
    ).rejects.toBeInstanceOf(NFeDanfeError);
  });
});
