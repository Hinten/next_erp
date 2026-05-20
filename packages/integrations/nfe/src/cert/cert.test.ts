import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import {
  NFeCertError,
  loadCertificateFromBase64,
  loadCertificateFromEnv,
} from './index';

/** Build a self-signed PFX in-memory so tests don't ship a real certificate. */
function buildPfxFixture(opts: { commonName?: string; password: string }): string {
  // 1024-bit keeps the fixture build fast — fine for unit tests, **never** in
  // production NF-e signing where ICP-Brasil mandates 2048-bit minimum.
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: opts.commonName ?? 'TEST CERT:12345678000199' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], opts.password, {
    algorithm: '3des',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

describe('loadCertificateFromBase64', () => {
  it('parses a valid PFX and exposes key + cert PEMs', () => {
    const pfx = buildPfxFixture({ password: 'secret', commonName: 'ACME:12345678000199' });
    const result = loadCertificateFromBase64(pfx, 'secret');
    expect(result.privateKeyPem).toMatch(/-----BEGIN RSA PRIVATE KEY-----/);
    expect(result.certificatePem).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(result.subjectCommonName).toBe('ACME:12345678000199');
    expect(result.certificateDerBase64.length).toBeGreaterThan(0);
    expect(result.pfxBuffer).toBeInstanceOf(Buffer);
    expect(result.password).toBe('secret');
    expect(result.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('throws NFeCertError on wrong password', () => {
    const pfx = buildPfxFixture({ password: 'right' });
    expect(() => loadCertificateFromBase64(pfx, 'wrong')).toThrow(NFeCertError);
  });

  it('throws NFeCertError on empty base-64', () => {
    expect(() => loadCertificateFromBase64('', 'whatever')).toThrow(NFeCertError);
  });

  it('throws NFeCertError on malformed base-64', () => {
    expect(() => loadCertificateFromBase64('!!!not-a-pfx!!!', 'x')).toThrow(NFeCertError);
  });
});

describe('loadCertificateFromEnv', () => {
  it('reads NFE_CERT_BASE64 / NFE_CERT_PASSWORD', () => {
    const pfx = buildPfxFixture({ password: 'env-pwd' });
    const env = { NFE_CERT_BASE64: pfx, NFE_CERT_PASSWORD: 'env-pwd' };
    const result = loadCertificateFromEnv(env);
    expect(result.privateKeyPem).toMatch(/PRIVATE KEY/);
  });

  it('throws when NFE_CERT_BASE64 missing', () => {
    expect(() => loadCertificateFromEnv({ NFE_CERT_PASSWORD: 'x' })).toThrow(NFeCertError);
  });

  it('throws when NFE_CERT_PASSWORD missing', () => {
    expect(() => loadCertificateFromEnv({ NFE_CERT_BASE64: 'x' })).toThrow(NFeCertError);
  });
});
