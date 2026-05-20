import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import {
  assertCertNotExpired,
  isCertExpired,
  NFeCertError,
  loadCertificateFromBase64,
  loadCertificateFromEnv,
  type NFeCertificate,
} from './index';

/** Build a self-signed PFX in-memory so tests don't ship a real certificate. */
function buildPfxFixture(opts: {
  commonName?: string;
  password: string;
  /** Override `notAfter` for expiry tests. Default: +365 days. */
  notAfter?: Date;
}): string {
  // 1024-bit keeps the fixture build fast — fine for unit tests, **never** in
  // production NF-e signing where ICP-Brasil mandates 2048-bit minimum.
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);
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

describe('isCertExpired / assertCertNotExpired', () => {
  function fakeCert(notAfter: Date): NFeCertificate {
    return {
      privateKeyPem: '',
      certificatePem: '',
      certificateDerBase64: '',
      subjectCommonName: 'TEST:12345678000199',
      notAfter,
      pfxBuffer: Buffer.from(''),
      password: '',
    };
  }

  const NOW = new Date('2026-05-20T12:00:00Z');

  it('reports a future notAfter as not expired', () => {
    const cert = fakeCert(new Date('2027-05-20T12:00:00Z'));
    expect(isCertExpired(cert, NOW)).toBe(false);
    expect(() => assertCertNotExpired(cert, NOW)).not.toThrow();
  });

  it('reports a past notAfter as expired', () => {
    const cert = fakeCert(new Date('2026-05-19T12:00:00Z'));
    expect(isCertExpired(cert, NOW)).toBe(true);
    expect(() => assertCertNotExpired(cert, NOW)).toThrow(NFeCertError);
  });

  it('treats exactly-at-expiry as expired (defense-in-depth)', () => {
    const cert = fakeCert(NOW);
    expect(isCertExpired(cert, NOW)).toBe(true);
    expect(() => assertCertNotExpired(cert, NOW)).toThrow(NFeCertError);
  });

  it('NFeCertError on expiry carries the notAfter and the subject CN', () => {
    const cert = fakeCert(new Date('2025-01-01T00:00:00Z'));
    try {
      assertCertNotExpired(cert, NOW);
      throw new Error('expected assertCertNotExpired to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeCertError);
      const msg = (err as Error).message;
      expect(msg).toContain('2025-01-01');
      expect(msg).toContain('TEST:12345678000199');
      expect(msg).toContain('NFE_CERT_BASE64');
    }
  });

  it('end-to-end: loadCertificateFromBase64 → assertCertNotExpired rejects an expired PFX', () => {
    const expired = buildPfxFixture({
      password: 'x',
      notAfter: new Date(Date.now() - 86_400_000),
    });
    const cert = loadCertificateFromBase64(expired, 'x');
    expect(isCertExpired(cert)).toBe(true);
    expect(() => assertCertNotExpired(cert)).toThrow(NFeCertError);
  });
});
