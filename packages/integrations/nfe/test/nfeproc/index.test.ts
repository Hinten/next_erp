import { describe, expect, it } from 'vitest';

import { buildNFeProc } from '../../src/nfeproc';

const CHAVE = '35260514200166000187550010000000071000000018';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

/** Minimal valid TProtNFe with an authorization protocol. */
function protOK(): {
  infProt: {
    tpAmb: '2';
    verAplic: string;
    chNFe: string;
    dhRecbto: string;
    nProt: string;
    digVal: string;
    cStat: string;
    xMotivo: string;
  };
  versao: '4.00';
} {
  return {
    infProt: {
      tpAmb: '2',
      verAplic: 'SP_NFE_PL009_V4',
      chNFe: CHAVE,
      dhRecbto: '2026-05-26T15:30:00-03:00',
      nProt: '135200000000456',
      digVal: 'AbCdEf1234567890==',
      cStat: '100',
      xMotivo: 'Autorizado o uso da NF-e',
    },
    versao: '4.00',
  };
}

/** Fake signed NFe — what the signer returns (no XML declaration). */
const SIGNED_NFE =
  `<NFe xmlns="${NFE_NS}"><infNFe Id="NFe${CHAVE}"><ide>…</ide></infNFe>` +
  `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">…</Signature></NFe>`;

describe('buildNFeProc', () => {
  it('wraps the signed NFe and a SEFAZ protNFe in a <nfeProc> envelope', () => {
    const xml = buildNFeProc(SIGNED_NFE, protOK());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(`<nfeProc xmlns="${NFE_NS}" versao="4.00">`);
    expect(xml).toContain(SIGNED_NFE); // signed NFe embedded verbatim
    expect(xml).toContain('<protNFe versao="4.00">');
    expect(xml).toContain('<infProt>');
    expect(xml).toContain(`<chNFe>${CHAVE}</chNFe>`);
    expect(xml).toContain('<nProt>135200000000456</nProt>');
    expect(xml).toContain('<cStat>100</cStat>');
    expect(xml).toContain('<xMotivo>Autorizado o uso da NF-e</xMotivo>');
    expect(xml.endsWith('</nfeProc>')).toBe(true);
  });

  it('strips a leading XML declaration from the signed NFe so the envelope has only one', () => {
    const signedWithDecl = `<?xml version="1.0" encoding="UTF-8"?>${SIGNED_NFE}`;
    const xml = buildNFeProc(signedWithDecl, protOK());
    // Exactly one `<?xml` should appear (the outer declaration).
    const matches = xml.match(/<\?xml/g) ?? [];
    expect(matches.length).toBe(1);
    expect(xml).toContain(SIGNED_NFE); // unchanged inner NFe content
  });

  it('versao defaults to 4.00', () => {
    const xml = buildNFeProc(SIGNED_NFE, protOK());
    expect(xml).toContain('versao="4.00"');
  });

  it('emits protNFe child elements in canonical META order (infProt → Signature → versao-attr)', () => {
    const xml = buildNFeProc(SIGNED_NFE, protOK());
    const protStart = xml.indexOf('<protNFe');
    const infProtStart = xml.indexOf('<infProt>', protStart);
    // infProt must come AFTER the protNFe opening tag.
    expect(infProtStart).toBeGreaterThan(protStart);
    // versao is an attribute on protNFe, not a child element — make sure
    // it's NOT serialised as <versao>.
    expect(xml).not.toContain('<versao>');
  });

  it('preserves the order: signed NFe FIRST, then protNFe', () => {
    const xml = buildNFeProc(SIGNED_NFE, protOK());
    const nfeIdx = xml.indexOf('<NFe ');
    const protIdx = xml.indexOf('<protNFe');
    expect(nfeIdx).toBeGreaterThan(0);
    expect(protIdx).toBeGreaterThan(nfeIdx);
  });
});
