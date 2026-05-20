import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';

import type { NFeCertificate } from '../cert';
import { NFeSignatureError, signEvento, signInutilizacao, signNFe } from './index';

/** Build a self-signed RSA key + cert so signature verification has a key. */
function fixtureCertificate(): NFeCertificate {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'TEST SIGNER' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certificatePem = forge.pki.certificateToPem(cert);
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem,
    certificateDerBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    ),
    subjectCommonName: 'TEST SIGNER',
    notAfter: cert.validity.notAfter,
    pfxBuffer: Buffer.from(''),
    password: '',
  };
}

const CHAVE = '35200714200166000187550010000000071123456780';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

function buildNFe(): string {
  // No indentation, no line breaks — same as the production serializer (MOC §4.2.1.3).
  return (
    `<NFe xmlns="${NFE_NS}">` +
    `<infNFe Id="NFe${CHAVE}" versao="4.00">` +
    `<ide><cUF>35</cUF><natOp>Venda</natOp></ide>` +
    `</infNFe>` +
    `</NFe>`
  );
}

describe('signNFe', () => {
  const cert = fixtureCertificate();

  it('emits a Signature sibling immediately after infNFe', () => {
    const signed = signNFe(buildNFe(), cert);
    // The post-infNFe placement is digest-critical — assert the textual order.
    expect(signed).toMatch(/<\/infNFe><Signature[\s>]/);
    expect(signed).toContain('<X509Certificate>');
  });

  it('uses the SEFAZ algorithm set', () => {
    const signed = signNFe(buildNFe(), cert);
    expect(signed).toContain('Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"');
    expect(signed).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"');
    expect(signed).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"');
    expect(signed).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"');
  });

  it('references the infNFe by its Id', () => {
    const signed = signNFe(buildNFe(), cert);
    expect(signed).toContain(`URI="#NFe${CHAVE}"`);
  });

  it('KeyInfo contains only X509Certificate — no chain, no KeyValue', () => {
    const signed = signNFe(buildNFe(), cert);
    expect(signed).toContain('<X509Data><X509Certificate>');
    expect(signed).not.toContain('<KeyValue');
    expect(signed).not.toContain('<RSAKeyValue');
    expect(signed).not.toContain('<X509SubjectName');
    expect(signed).not.toContain('<X509IssuerSerial');
  });

  it('produces a cryptographically valid signature (xml-crypto round-trip)', () => {
    const signed = signNFe(buildNFe(), cert);
    const doc = new DOMParser().parseFromString(signed, 'text/xml');
    const sigNode = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
    expect(sigNode).toBeTruthy();
    const verifier = new SignedXml({ publicCert: cert.certificatePem });
    verifier.loadSignature(sigNode!);
    expect(verifier.checkSignature(signed)).toBe(true);
  });

  it('wraps signing failures in NFeSignatureError', () => {
    expect(() => signNFe('<NFe><not-infNFe/></NFe>', cert)).toThrow(NFeSignatureError);
  });
});

describe('signEvento / signInutilizacao', () => {
  const cert = fixtureCertificate();

  it('signs infEvento with the same algorithm set', () => {
    const xml =
      `<evento xmlns="${NFE_NS}">` +
      `<infEvento Id="ID110111${CHAVE}01"><cOrgao>35</cOrgao></infEvento>` +
      `</evento>`;
    const signed = signEvento(xml, cert);
    expect(signed).toContain(`URI="#ID110111${CHAVE}01"`);
    expect(signed).toMatch(/<\/infEvento><Signature[\s>]/);
  });

  it('signs infInut', () => {
    const xml =
      `<inutNFe xmlns="${NFE_NS}">` +
      `<infInut Id="ID35202012345678000187550010000000010000000010"><cUF>35</cUF></infInut>` +
      `</inutNFe>`;
    const signed = signInutilizacao(xml, cert);
    expect(signed).toMatch(/<\/infInut><Signature[\s>]/);
  });
});
