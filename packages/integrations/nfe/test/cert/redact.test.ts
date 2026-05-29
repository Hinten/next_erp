/**
 * Redaction contract for `NFeCertificate` — pins the inspect/toJSON
 * hooks added in `src/cert/index.ts` so future contributors can't
 * accidentally break the leak guard.
 *
 * The hooks are belt-and-suspenders on top of the ESLint rules + the
 * `safeErrorShape` / `safeLog` helpers. If a stray `console.log(cert)`
 * or `JSON.stringify(cert)` ever sneaks past the lint rule, these
 * tests guarantee the private key never reaches the wire.
 */
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';
import forge from 'node-forge';

import { loadCertificateFromBase64 } from '../../src/cert/index';

/** Same self-signed PFX builder as cert.test.ts. */
function buildPfxFixture(password: string): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'REDACT TEST:12345678000199' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

const SECRET_PASSWORD = 'super-secret-passphrase-1A2B3C';

describe('NFeCertificate redaction hooks', () => {
  const pfx = buildPfxFixture(SECRET_PASSWORD);
  const cert = loadCertificateFromBase64(pfx, SECRET_PASSWORD);

  it('util.inspect renders the safe one-line form, not the key material', () => {
    const rendered = inspect(cert);
    expect(rendered).toContain('(private material redacted)');
    expect(rendered).toContain('cnpj=12345678000199');
    expect(rendered).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(rendered).not.toContain(SECRET_PASSWORD);
  });

  it('JSON.stringify drops every sensitive key and stamps redacted:true', () => {
    const json = JSON.stringify(cert);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      cnpj: '12345678000199',
      subjectCommonName: 'REDACT TEST:12345678000199',
      redacted: true,
    });
    expect(parsed).not.toHaveProperty('privateKeyPem');
    expect(parsed).not.toHaveProperty('password');
    expect(parsed).not.toHaveProperty('pfxBuffer');
    expect(parsed).not.toHaveProperty('certificatePem');
    expect(json).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(json).not.toContain(SECRET_PASSWORD);
  });

  it('JSON.stringify recurses through nested wrappers via toJSON()', () => {
    const wrapped = { rt: { cert, ambiente: 'homologacao' } };
    const json = JSON.stringify(wrapped);
    expect(json).toContain('"redacted":true');
    expect(json).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(json).not.toContain(SECRET_PASSWORD);
  });

  it('programmatic field access still works — only the print paths redact', () => {
    // The class implements the NFeCertificate interface structurally —
    // callers like signNFe / createSefazAgent must keep reading these
    // fields directly. The redaction only kicks in for inspect/JSON.
    expect(cert.privateKeyPem).toMatch(/-----BEGIN RSA PRIVATE KEY-----/);
    expect(cert.certificatePem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(cert.password).toBe(SECRET_PASSWORD);
    expect(cert.pfxBuffer).toBeInstanceOf(Buffer);
    expect(cert.cnpj).toBe('12345678000199');
  });
});
