import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import forge from 'node-forge';
import {
  assertCertNotExpired,
  CNPJ_FORMAT,
  isCertExpired,
  NFeCertError,
  loadCertificateFromBase64,
  loadCertificateFromEnv,
  loadCertificateFromPath,
  warnIfCertNearExpiry,
  type NFeCertificate,
} from '../../src/cert/index';

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

describe('loadCertificateFromPath', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nfe-cert-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads a .pfx file from disk and parses it', () => {
    const pfxBase64 = buildPfxFixture({ password: 'pwd', commonName: 'PATH:12345678000199' });
    const pfxPath = join(tempDir, 'cert.pfx');
    writeFileSync(pfxPath, Buffer.from(pfxBase64, 'base64'));
    const result = loadCertificateFromPath(pfxPath, 'pwd');
    expect(result.subjectCommonName).toBe('PATH:12345678000199');
    expect(result.privateKeyPem).toMatch(/PRIVATE KEY/);
  });

  it('treats .p12 the same as .pfx (just a file extension)', () => {
    const pfxBase64 = buildPfxFixture({ password: 'pwd' });
    const pfxPath = join(tempDir, 'cert.p12');
    writeFileSync(pfxPath, Buffer.from(pfxBase64, 'base64'));
    const result = loadCertificateFromPath(pfxPath, 'pwd');
    expect(result.privateKeyPem).toMatch(/PRIVATE KEY/);
  });

  it('throws NFeCertError on missing file', () => {
    expect(() =>
      loadCertificateFromPath(join(tempDir, 'does-not-exist.pfx'), 'pwd'),
    ).toThrow(NFeCertError);
  });

  it('throws NFeCertError on wrong password', () => {
    const pfxBase64 = buildPfxFixture({ password: 'right' });
    const pfxPath = join(tempDir, 'cert.pfx');
    writeFileSync(pfxPath, Buffer.from(pfxBase64, 'base64'));
    expect(() => loadCertificateFromPath(pfxPath, 'wrong')).toThrow(NFeCertError);
  });

  it('throws NFeCertError on empty path', () => {
    expect(() => loadCertificateFromPath('', 'pwd')).toThrow(NFeCertError);
  });
});

describe('loadCertificateFromEnv', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nfe-cert-env-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads NFE_CERT_BASE64 + NFE_CERT_PASSWORD (CI / secret path)', () => {
    const pfx = buildPfxFixture({ password: 'env-pwd' });
    const result = loadCertificateFromEnv({
      NFE_CERT_BASE64: pfx,
      NFE_CERT_PASSWORD: 'env-pwd',
    });
    expect(result.privateKeyPem).toMatch(/PRIVATE KEY/);
  });

  it('reads NFE_CERT_PATH + NFE_CERT_PASSWORD (local dev path)', () => {
    const pfxBase64 = buildPfxFixture({ password: 'env-pwd' });
    const pfxPath = join(tempDir, 'cert.pfx');
    writeFileSync(pfxPath, Buffer.from(pfxBase64, 'base64'));
    const result = loadCertificateFromEnv({
      NFE_CERT_PATH: pfxPath,
      NFE_CERT_PASSWORD: 'env-pwd',
    });
    expect(result.privateKeyPem).toMatch(/PRIVATE KEY/);
  });

  it('NFE_CERT_PATH wins when both PATH and BASE64 are set', () => {
    // PATH points at a cert with CN ending FROM_PATH suffix. BASE64 carries
    // a cert with CN ending FROM_BASE64 suffix. If precedence is right, the
    // result CN reads FROM_PATH. Both CNs include a valid CNPJ suffix so
    // the new extractor accepts them; the precedence assertion targets the
    // company-name prefix.
    const pathPfx = buildPfxFixture({
      password: 'pwd',
      commonName: 'FROM_PATH:99999999000191',
    });
    const pathFile = join(tempDir, 'path.pfx');
    writeFileSync(pathFile, Buffer.from(pathPfx, 'base64'));

    const base64Pfx = buildPfxFixture({
      password: 'pwd',
      commonName: 'FROM_BASE64:99999999000191',
    });

    const result = loadCertificateFromEnv({
      NFE_CERT_PATH: pathFile,
      NFE_CERT_BASE64: base64Pfx,
      NFE_CERT_PASSWORD: 'pwd',
    });
    expect(result.subjectCommonName).toBe('FROM_PATH:99999999000191');
  });

  it('throws when neither NFE_CERT_PATH nor NFE_CERT_BASE64 is set', () => {
    expect(() => loadCertificateFromEnv({ NFE_CERT_PASSWORD: 'x' })).toThrow(NFeCertError);
  });

  it('throws when NFE_CERT_PASSWORD is missing', () => {
    expect(() => loadCertificateFromEnv({ NFE_CERT_BASE64: 'x' })).toThrow(NFeCertError);
    expect(() => loadCertificateFromEnv({ NFE_CERT_PATH: '/x' })).toThrow(NFeCertError);
  });
});

describe('isCertExpired / assertCertNotExpired', () => {
  function fakeCert(notAfter: Date): NFeCertificate {
    return {
      privateKeyPem: '',
      certificatePem: '',
      certificateDerBase64: '',
      subjectCommonName: 'TEST:12345678000199',
      cnpj: '12345678000199',
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

describe('warnIfCertNearExpiry', () => {
  function fakeCert(notAfter: Date): NFeCertificate {
    return {
      privateKeyPem: '',
      certificatePem: '',
      certificateDerBase64: '',
      subjectCommonName: 'TEST:12345678000199',
      cnpj: '12345678000199',
      notAfter,
      pfxBuffer: Buffer.from(''),
      password: '',
    };
  }

  const NOW = new Date('2026-05-20T12:00:00Z');

  it('does not warn when expiry is comfortably in the future', () => {
    const log = vi.fn();
    const cert = fakeCert(new Date('2027-05-20T12:00:00Z')); // ~365 days out
    warnIfCertNearExpiry(cert, 30, log, NOW);
    expect(log).not.toHaveBeenCalled();
  });

  it('warns when expiry is within the window', () => {
    const log = vi.fn();
    const cert = fakeCert(new Date('2026-06-04T12:00:00Z')); // 15 days out
    warnIfCertNearExpiry(cert, 30, log, NOW);
    expect(log).toHaveBeenCalledOnce();
    const msg = log.mock.calls[0]![0];
    expect(msg).toContain('15 day');
    expect(msg).toContain('2026-06-04');
    // The expiry warning goes to App Hosting logs, so it must NOT leak the
    // cert subject (company name + CNPJ) — only the actionable notAfter date.
    expect(msg).not.toContain('TEST:12345678000199');
    expect(msg).toContain('Receita Federal');
  });

  it('honors a custom daysBeforeExpiry threshold', () => {
    const log = vi.fn();
    const cert = fakeCert(new Date('2026-07-20T12:00:00Z')); // ~61 days out
    warnIfCertNearExpiry(cert, 30, log, NOW); // 30-day window — silent
    expect(log).not.toHaveBeenCalled();
    warnIfCertNearExpiry(cert, 90, log, NOW); // 90-day window — warns
    expect(log).toHaveBeenCalledOnce();
  });

  it('stays silent for already-expired certs (assertCertNotExpired owns that case)', () => {
    const log = vi.fn();
    const cert = fakeCert(new Date('2025-01-01T00:00:00Z'));
    warnIfCertNearExpiry(cert, 30, log, NOW);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('CNPJ extraction from Subject CN', () => {
  it('extracts a 14-digit CNPJ (today\'s pre-July-2026 format)', () => {
    // CN suffix is the universally-recognized "fake CNPJ" placeholder
    // used across SEFAZ test packs. We assert format, not the specific
    // 14 digits — the test owns both sides of the fixture, so a format
    // check is what's load-bearing.
    const pfx = buildPfxFixture({
      password: 'x',
      commonName: 'EMPRESA EXEMPLO LTDA:99999999000191',
    });
    const cert = loadCertificateFromBase64(pfx, 'x');
    expect(cert.cnpj).toMatch(CNPJ_FORMAT);
    expect(cert.cnpj).toHaveLength(14);
  });

  it('extracts an alphanumeric CNPJ (post-July-2026 IN RFB 2229/2024 format)', () => {
    // 12 alphanumeric + 2 numeric DV — same shape Receita Federal will
    // start issuing in July 2026. The new extractor must accept this so
    // we're forward-compatible with the rollout.
    const pfx = buildPfxFixture({
      password: 'x',
      commonName: 'EMPRESA ALFA LTDA:ABCDEFGH123456',
    });
    const cert = loadCertificateFromBase64(pfx, 'x');
    expect(cert.cnpj).toMatch(CNPJ_FORMAT);
    expect(cert.cnpj).toHaveLength(14);
  });

  it('throws NFeCertError when CN has no CNPJ suffix', () => {
    const pfx = buildPfxFixture({
      password: 'x',
      commonName: 'PLAIN COMPANY NAME',
    });
    expect(() => loadCertificateFromBase64(pfx, 'x')).toThrow(NFeCertError);
    // Error message names the offending CN so operators can diagnose
    // which cert was loaded.
    expect(() => loadCertificateFromBase64(pfx, 'x')).toThrow(/PLAIN COMPANY NAME/);
  });

  it('throws NFeCertError when CNPJ suffix is the wrong length', () => {
    const pfx = buildPfxFixture({
      password: 'x',
      commonName: 'EXEMPLO:1234',
    });
    expect(() => loadCertificateFromBase64(pfx, 'x')).toThrow(NFeCertError);
  });

  it('throws NFeCertError when CNPJ suffix is lowercase (Receita mandates uppercase)', () => {
    const pfx = buildPfxFixture({
      password: 'x',
      commonName: 'EXEMPLO:abcdefgh123456',
    });
    expect(() => loadCertificateFromBase64(pfx, 'x')).toThrow(NFeCertError);
  });

  it('throws NFeCertError when CNPJ suffix has 15 chars (one too many)', () => {
    const pfx = buildPfxFixture({
      password: 'x',
      commonName: 'EXEMPLO:99999999000191X',
    });
    expect(() => loadCertificateFromBase64(pfx, 'x')).toThrow(NFeCertError);
  });

  it('tolerates a colon in the company name — only the last colon matters', () => {
    // Edge case: company names can legally contain colons. The extractor
    // splits on the LAST colon, so this still parses cleanly.
    const pfx = buildPfxFixture({
      password: 'x',
      commonName: 'GROUP X: SUBSIDIARY LTDA:99999999000191',
    });
    const cert = loadCertificateFromBase64(pfx, 'x');
    expect(cert.cnpj).toMatch(CNPJ_FORMAT);
  });
});
