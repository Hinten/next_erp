import { describe, expect, it } from 'vitest';
import forge from 'node-forge';

import {
  buildNFeProc,
  buildNFeProcSafe,
  compareDigest,
  extractDigestValue,
  normalizeDigVal,
} from '../../src/nfeproc';
import type { TProtNFe, TRetConsSitNFe } from '../../src/types/nfe-schema';
import { signNFe, type NFeCertificate } from '../../src/index';
import { parse } from '../../src/xml';

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

// ---------------------------------------------------------------------------
// Digest guard helpers (#396)
// ---------------------------------------------------------------------------

/** Self-signed throwaway cert (same pattern as sign.test.ts / tribute tests). */
function fixtureCertificate(): NFeCertificate {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'DIGEST TEST' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    certificateDerBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    ),
    subjectCommonName: 'DIGEST TEST:99999999000191',
    cnpj: '99999999000191',
    notAfter: cert.validity.notAfter,
    pfxBuffer: Buffer.from(''),
    password: '',
  };
}

describe('extractDigestValue', () => {
  it('finds the single DigestValue in REAL xml-crypto output', () => {
    // Pin the regex against the actual signer output, not a hand-built string.
    const unsigned = `<NFe xmlns="${NFE_NS}"><infNFe Id="NFe${CHAVE}" versao="4.00"><ide><cUF>35</cUF></ide></infNFe></NFe>`;
    const signed = signNFe(unsigned, fixtureCertificate());
    const digest = extractDigestValue(signed);
    expect(digest).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64, whitespace-free
    expect(signed).toContain(`<DigestValue>`);
  });

  it('returns null on zero and on multiple occurrences (ambiguity never blocks)', () => {
    expect(extractDigestValue('<NFe>no signature</NFe>')).toBeNull();
    const two = '<x><DigestValue>AAA=</DigestValue><DigestValue>BBB=</DigestValue></x>';
    expect(extractDigestValue(two)).toBeNull();
  });
});

describe('normalizeDigVal', () => {
  it('accepts bare base64 and strips whitespace', () => {
    expect(normalizeDigVal('AbCdEf12==')).toBe('AbCdEf12==');
    expect(normalizeDigVal(' AbCd\nEf12== ')).toBe('AbCdEf12==');
    expect(normalizeDigVal('')).toBeNull();
    expect(normalizeDigVal(null)).toBeNull();
    expect(normalizeDigVal(undefined)).toBeNull();
  });

  it('unwraps the #raw outer-XML form the wire parser produces', () => {
    expect(normalizeDigVal('<digVal>AbCdEf12==</digVal>')).toBe('AbCdEf12==');
  });

  it('unwraps prefixed and attributed digVal shapes (namespace variants)', () => {
    expect(normalizeDigVal('<nfe:digVal>AbCdEf12==</nfe:digVal>')).toBe('AbCdEf12==');
    expect(normalizeDigVal(`<digVal xmlns="${NFE_NS}">AbCdEf12==</digVal>`)).toBe('AbCdEf12==');
  });

  it('degrades an UNRECOGNIZED XML-ish shape to null (→ unknown), never to a guaranteed mismatch', () => {
    // If the unwrap misses, leftover tags must not survive into the
    // comparison — a tag-bearing string can only ever 'mismatch' and would
    // wrongly BLOCK a legitimate proc build. Fail open to 'unknown'.
    expect(normalizeDigVal('<weird><digVal>AbCdEf12==</digVal></weird>')).toBeNull();
    expect(normalizeDigVal('<digVal>AbCdEf12==</digVal><extra/>')).toBeNull();
  });

  it('round-trips a WIRE-parsed retConsSitNFe digVal (#raw shape pin against codegen drift)', () => {
    // The codegen META marks digVal as #raw, so parse() returns the OUTER XML.
    // If a codegen change ever flips it to a text field, this test still passes
    // (normalizeDigVal accepts both) but documents the current wire shape.
    const xml =
      `<retConsSitNFe xmlns="${NFE_NS}" versao="4.00">` +
      '<tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic>' +
      '<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>' +
      `<cUF>35</cUF><chNFe>${CHAVE}</chNFe>` +
      `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SP_NFE_PL009_V4</verAplic>` +
      `<chNFe>${CHAVE}</chNFe><dhRecbto>2026-05-26T15:30:00-03:00</dhRecbto>` +
      '<nProt>135200000000456</nProt><digVal>AbCdEf12==</digVal>' +
      '<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>' +
      '</retConsSitNFe>';
    const ret = parse<TRetConsSitNFe>('retConsSitNFe', xml);
    const rawDigVal = ret.protNFe?.infProt.digVal;
    expect(rawDigVal).toBeDefined();
    expect(normalizeDigVal(rawDigVal)).toBe('AbCdEf12==');
  });
});

describe('compareDigest', () => {
  const SIGNED_WITH_DIGEST =
    `<NFe xmlns="${NFE_NS}"><infNFe Id="NFe${CHAVE}">…</infNFe>` +
    '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>' +
    '<Reference><DigestValue>GOOD=</DigestValue></Reference>' +
    '</SignedInfo></Signature></NFe>';

  it("'match' when both sides carry the same digest (bare and outer-XML forms)", () => {
    expect(compareDigest(SIGNED_WITH_DIGEST, 'GOOD=')).toBe('match');
    expect(compareDigest(SIGNED_WITH_DIGEST, '<digVal>GOOD=</digVal>')).toBe('match');
  });

  it("'mismatch' ONLY when both sides are present and differ", () => {
    expect(compareDigest(SIGNED_WITH_DIGEST, 'EVIL=')).toBe('mismatch');
  });

  it("'unknown' when either side is absent — never blocks the normal path", () => {
    expect(compareDigest(SIGNED_WITH_DIGEST, undefined)).toBe('unknown');
    expect(compareDigest(SIGNED_WITH_DIGEST, null)).toBe('unknown');
    expect(compareDigest('<NFe>no signature</NFe>', 'GOOD=')).toBe('unknown');
  });

  it('is whitespace-insensitive on both sides (XMLDSig permits wrapped base64)', () => {
    const wrapped = SIGNED_WITH_DIGEST.replace('GOOD=', 'GO\nOD=');
    expect(compareDigest(wrapped, ' GO OD= ')).toBe('match');
  });
});

describe('buildNFeProcSafe', () => {
  const SIGNED_WITH_DIGEST =
    `<NFe xmlns="${NFE_NS}"><infNFe Id="NFe${CHAVE}">…</infNFe>` +
    '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>' +
    '<Reference><DigestValue>GOOD=</DigestValue></Reference>' +
    '</SignedInfo></Signature></NFe>';

  function protWithDigVal(digVal: string | undefined): TProtNFe {
    const prot = protOK();
    return {
      ...prot,
      infProt: { ...prot.infProt, digVal },
    } as unknown as TProtNFe;
  }

  it('builds on match and the xml equals the raw buildNFeProc output', () => {
    const prot = protWithDigVal('GOOD=');
    const { xml, digest } = buildNFeProcSafe(SIGNED_WITH_DIGEST, prot);
    expect(digest).toBe('match');
    expect(xml).toBe(buildNFeProc(SIGNED_WITH_DIGEST, prot));
  });

  it('refuses the stitch on mismatch (xml null)', () => {
    const { xml, digest } = buildNFeProcSafe(SIGNED_WITH_DIGEST, protWithDigVal('EVIL='));
    expect(digest).toBe('mismatch');
    expect(xml).toBeNull();
  });

  it("builds on 'unknown' (absent digVal) — never blocks the normal path", () => {
    const { xml, digest } = buildNFeProcSafe(SIGNED_WITH_DIGEST, protWithDigVal(undefined));
    expect(digest).toBe('unknown');
    expect(xml).toContain('<nfeProc ');
  });
});
