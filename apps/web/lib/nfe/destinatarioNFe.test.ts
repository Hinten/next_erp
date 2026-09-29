/**
 * `lerDestinatarioNFe` (#852) — reads idDest / indIEDest / destinatário UF from
 * a signed NF-e with the native DOMParser (jsdom here). Fixtures are
 * hand-written homologação XML (tpAmb=2) carrying the real NF-e default
 * namespace, so every case also proves the namespaced read works.
 */
import { describe, expect, it } from 'vitest';

import {
  ID_DEST,
  IND_IE_DEST,
  lerDestinatarioDoNfev4,
  lerDestinatarioNFe,
} from './destinatarioNFe';
import { HOMOLOGACAO_XNOME_FIXTURE, nfeAssinadoXml, nfeProcXml } from './nfeAssinadoFixture';

describe('lerDestinatarioNFe', () => {
  it('reads idDest, indIEDest and the dest UF from a bare signed <NFe> (homologação fixture)', () => {
    const xml = nfeAssinadoXml({ idDest: '1', indIEDest: '2', ufDest: 'SP' });
    // The fixture must never be a produção document.
    expect(xml).toContain('<tpAmb>2</tpAmb>');
    expect(xml).toContain('xmlns="http://www.portalfiscal.inf.br/nfe"');

    expect(lerDestinatarioNFe(xml)).toEqual({
      idDest: ID_DEST.interna,
      indIEDest: IND_IE_DEST.isento,
      uf: 'SP',
    });
  });

  it('reads the same payload wrapped in an <nfeProc>', () => {
    const xml = nfeProcXml({ idDest: '1', indIEDest: '2', ufDest: 'SP' });
    expect(xml).toContain('<nfeProc');
    expect(lerDestinatarioNFe(xml)).toEqual({ idDest: '1', indIEDest: '2', uf: 'SP' });
  });

  it('near-miss: reads the UF from <dest><enderDest>, never from <emit><enderEmit>', () => {
    const xml = nfeAssinadoXml({ idDest: '2', indIEDest: '2', ufEmit: 'SP', ufDest: 'MG' });
    expect(lerDestinatarioNFe(xml)).toEqual({
      idDest: ID_DEST.interestadual,
      indIEDest: IND_IE_DEST.isento,
      uf: 'MG',
    });
  });

  it('keeps idDest 3 (exterior) and indIEDest 1 / 9 — the XSD enumerations', () => {
    expect(
      lerDestinatarioNFe(nfeAssinadoXml({ idDest: '3', indIEDest: '9', ufDest: 'EX' })),
    ).toEqual({ idDest: '3', indIEDest: '9', uf: 'EX' });
    expect(
      lerDestinatarioNFe(nfeAssinadoXml({ idDest: '1', indIEDest: '1', ufDest: 'SP' })),
    ).toEqual({ idDest: '1', indIEDest: '1', uf: 'SP' });
  });

  it.each([
    ['idDest 4', { idDest: '4', indIEDest: '2' }],
    ['idDest empty', { idDest: '', indIEDest: '2' }],
    ['idDest 01', { idDest: '01', indIEDest: '2' }],
    ['indIEDest 3', { idDest: '1', indIEDest: '3' }],
    ['indIEDest empty', { idDest: '1', indIEDest: '' }],
  ])('near-miss: %s → null', (_label, input) => {
    expect(lerDestinatarioNFe(nfeAssinadoXml({ ...input, ufDest: 'SP' }))).toBeNull();
  });

  it('a missing or non-UF enderDest keeps the pair and nulls only the uf', () => {
    expect(
      lerDestinatarioNFe(nfeAssinadoXml({ idDest: '1', indIEDest: '2', ufDest: null })),
    ).toEqual({ idDest: '1', indIEDest: '2', uf: null });
    for (const ufDest of ['sp', 'SPX', 'S', '']) {
      expect(lerDestinatarioNFe(nfeAssinadoXml({ idDest: '1', indIEDest: '2', ufDest }))?.uf).toBe(
        null,
      );
    }
  });

  it('malformed XML → null, without throwing (parsererror path)', () => {
    const truncated = nfeAssinadoXml({ idDest: '1', indIEDest: '2', ufDest: 'SP' }).slice(0, 200);
    for (const xml of [truncated, '<NFe><infNFe>', 'not xml at all', '<a></b>']) {
      expect(() => lerDestinatarioNFe(xml)).not.toThrow();
      expect(lerDestinatarioNFe(xml)).toBeNull();
    }
  });

  it('null, undefined, empty and blank input → null', () => {
    expect(lerDestinatarioNFe(null)).toBeNull();
    expect(lerDestinatarioNFe(undefined)).toBeNull();
    expect(lerDestinatarioNFe('')).toBeNull();
    expect(lerDestinatarioNFe('   ')).toBeNull();
  });

  it('an NF-e with no <dest> → null', () => {
    const xml = nfeAssinadoXml({ idDest: '1', indIEDest: '2', comDest: false });
    expect(xml).not.toContain('<dest>');
    expect(lerDestinatarioNFe(xml)).toBeNull();
  });

  it('a document with no <infNFe> → null', () => {
    const xml =
      '<?xml version="1.0"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe">' +
      '<ide><idDest>1</idDest></ide><dest><indIEDest>2</indIEDest></dest></NFe>';
    expect(lerDestinatarioNFe(xml)).toBeNull();
  });

  it('scopes to DIRECT children: an idDest nested deeper than <ide> does not count', () => {
    const xml =
      '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe>' +
      '<ide><outro><idDest>1</idDest></outro></ide>' +
      '<dest><indIEDest>2</indIEDest></dest></infNFe></NFe>';
    expect(lerDestinatarioNFe(xml)).toBeNull();
  });

  it('never exposes dest/xNome — the homologação placeholder cannot leak', () => {
    const xml = nfeAssinadoXml({ idDest: '1', indIEDest: '2', ufDest: 'SP' });
    expect(xml).toContain(HOMOLOGACAO_XNOME_FIXTURE);
    const lido = lerDestinatarioNFe(xml);
    expect(lido).not.toBeNull();
    expect(Object.keys(lido ?? {}).sort()).toEqual(['idDest', 'indIEDest', 'uf']);
    expect(JSON.stringify(lido)).not.toContain('HOMOLOGACAO');
  });
});

describe('lerDestinatarioDoNfev4 — which XML of the nfev4 doc', () => {
  const ASSINADO_SP = nfeAssinadoXml({ idDest: '1', indIEDest: '2', ufDest: 'SP' });
  const PROC_MG = nfeProcXml({ idDest: '2', indIEDest: '2', ufDest: 'MG' });

  it('prefers xml_assinado — exactly what the SEFAZ judged — over xml_nfe_proc', () => {
    expect(lerDestinatarioDoNfev4({ xml_assinado: ASSINADO_SP, xml_nfe_proc: PROC_MG })?.uf).toBe(
      'SP',
    );
  });

  it('falls back to xml_nfe_proc when xml_assinado is null, absent or blank', () => {
    for (const xml_assinado of [null, undefined, '', '   ']) {
      expect(lerDestinatarioDoNfev4({ xml_assinado, xml_nfe_proc: PROC_MG })).toEqual({
        idDest: '2',
        indIEDest: '2',
        uf: 'MG',
      });
    }
  });

  it('never reads xml_epec_proc — an evento, not an NF-e', () => {
    const doc = { xml_assinado: null, xml_nfe_proc: null, xml_epec_proc: ASSINADO_SP };
    expect(lerDestinatarioDoNfev4(doc)).toBeNull();
  });

  it('a RAW soft-read doc with non-string XML fields degrades to null instead of throwing', () => {
    // `parseSoftRead` hands back the raw document on a schema mismatch; a
    // `.trim()` on a number would throw out of a table cell's render.
    for (const doc of [
      { xml_assinado: 7, xml_nfe_proc: null },
      { xml_assinado: { nested: true }, xml_nfe_proc: ['x'] },
      {},
    ]) {
      expect(() => lerDestinatarioDoNfev4(doc)).not.toThrow();
      expect(lerDestinatarioDoNfev4(doc)).toBeNull();
    }
    // …and a non-string xml_assinado still lets a valid xml_nfe_proc answer.
    expect(lerDestinatarioDoNfev4({ xml_assinado: 7, xml_nfe_proc: PROC_MG })?.uf).toBe('MG');
  });

  it('null / undefined doc → null', () => {
    expect(lerDestinatarioDoNfev4(null)).toBeNull();
    expect(lerDestinatarioDoNfev4(undefined)).toBeNull();
  });
});
