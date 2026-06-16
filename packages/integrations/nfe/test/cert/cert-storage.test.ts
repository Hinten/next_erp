/**
 * Per-filial cert storage primitives — AES-256-GCM encryption, master-key
 * loading, and `buildCertFromStored` reconstruction.
 *
 * **Mock certs only.** Every cert here comes from `buildPfxFixture` (a
 * self-signed 1024-bit throwaway). The real env cert is never read or
 * exercised — these tests must pass with no NFE_CERT_* configured.
 */
import { createSign, createVerify } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import {
  NFeCertError,
  buildCertFromStored,
  decryptSecret,
  encryptSecret,
  getCertEncryptionKey,
  loadCertificateFromBase64,
} from '../../src/cert/index';
import { buildPfxFixture } from '../helpers/pfx-fixture';

/** Deterministic 32-byte test key — never a real master key. */
const KEY = Buffer.alloc(32, 7);

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a UTF-8 string', () => {
    const blob = encryptSecret('hello-private-key', KEY);
    expect(blob.iv.length).toBeGreaterThan(0);
    expect(blob.authTag.length).toBeGreaterThan(0);
    expect(blob.ciphertext.length).toBeGreaterThan(0);
    expect(decryptSecret(blob, KEY)).toBe('hello-private-key');
  });

  it('uses a fresh IV each call (same input → different ciphertext)', () => {
    const a = encryptSecret('x', KEY);
    const b = encryptSecret('x', KEY);
    expect(a.iv === b.iv && a.ciphertext === b.ciphertext).toBe(false);
    expect(decryptSecret(a, KEY)).toBe('x');
    expect(decryptSecret(b, KEY)).toBe('x');
  });

  it('throws on the wrong key', () => {
    const blob = encryptSecret('secret', KEY);
    expect(() => decryptSecret(blob, Buffer.alloc(32, 9))).toThrow();
  });

  it('throws on a tampered ciphertext (GCM auth tag fails)', () => {
    const blob = encryptSecret('secret', KEY);
    const tampered = { ...blob, ciphertext: Buffer.from('garbage-bytes').toString('base64') };
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });
});

describe('getCertEncryptionKey', () => {
  it('decodes a base64 32-byte key', () => {
    const key = getCertEncryptionKey({ NFE_CERT_ENC_KEY: Buffer.alloc(32, 1).toString('base64') });
    expect(key).toHaveLength(32);
  });

  it('throws NFeCertError when unset', () => {
    expect(() => getCertEncryptionKey({})).toThrow(NFeCertError);
  });

  it('throws NFeCertError when the key is not 32 bytes', () => {
    expect(() =>
      getCertEncryptionKey({ NFE_CERT_ENC_KEY: Buffer.alloc(16, 1).toString('base64') }),
    ).toThrow(NFeCertError);
  });
});

describe('buildCertFromStored', () => {
  it('reconstructs the exact cert shape from a decrypted key + stored public PEM', () => {
    const pfx = buildPfxFixture({ password: 'pw', commonName: 'ACME LTDA:99999999000191' });
    const original = loadCertificateFromBase64(pfx, 'pw');

    // Simulate the at-rest split: encrypt the private key, keep the public PEM.
    const privateKeyPem = decryptSecret(encryptSecret(original.privateKeyPem, KEY), KEY);
    const rebuilt = buildCertFromStored({ privateKeyPem, certificatePem: original.certificatePem });

    expect(rebuilt.privateKeyPem).toBe(original.privateKeyPem);
    expect(rebuilt.certificateDerBase64).toBe(original.certificateDerBase64);
    expect(rebuilt.cnpj).toBe(original.cnpj);
    expect(rebuilt.subjectCommonName).toBe(original.subjectCommonName);
    expect(rebuilt.notAfter.getTime()).toBe(original.notAfter.getTime());
  });

  it('the reconstructed keypair signs + verifies against the ORIGINAL public cert', () => {
    const pfx = buildPfxFixture({ password: 'pw', commonName: 'ACME:99999999000191' });
    const original = loadCertificateFromBase64(pfx, 'pw');
    const rebuilt = buildCertFromStored({
      privateKeyPem: decryptSecret(encryptSecret(original.privateKeyPem, KEY), KEY),
      certificatePem: original.certificatePem,
    });

    const data = Buffer.from('assinatura-nfe-teste');
    const sig = createSign('RSA-SHA256').update(data).sign(rebuilt.privateKeyPem);
    // Verifying against both the rebuilt and the ORIGINAL public cert proves
    // the key↔cert pairing survived encrypt → decrypt → rebuild — exactly what
    // signNFe + the SEFAZ signature rely on.
    expect(createVerify('RSA-SHA256').update(data).verify(rebuilt.certificatePem, sig)).toBe(true);
    expect(createVerify('RSA-SHA256').update(data).verify(original.certificatePem, sig)).toBe(true);
  });

  it('still redacts private material on JSON.stringify (NFeCertificateImpl)', () => {
    const pfx = buildPfxFixture({ password: 'pw', commonName: 'ACME:99999999000191' });
    const original = loadCertificateFromBase64(pfx, 'pw');
    const rebuilt = buildCertFromStored({
      privateKeyPem: original.privateKeyPem,
      certificatePem: original.certificatePem,
    });
    const json = JSON.stringify(rebuilt);
    expect(json).not.toContain('PRIVATE KEY');
    expect(json).toContain('redacted');
  });

  it('throws NFeCertError on a malformed stored public PEM', () => {
    expect(() => buildCertFromStored({ privateKeyPem: 'x', certificatePem: 'not-a-pem' })).toThrow(
      NFeCertError,
    );
  });
});
