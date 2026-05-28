/**
 * Unit tests for the self-signed test cert generator.
 *
 * Pin every property the consumer code paths assume:
 *   - Output round-trips through the real `loadCertificateFromBase64`
 *   - Subject CN matches the requested `<COMPANY NAME>:<CNPJ>` format
 *   - CNPJ extracted by the loader equals the value we asked for
 *   - `assertCertNotExpired` is happy with the 10-year default validity
 *   - keyUsage + extKeyUsage + basicConstraints land in the parsed cert
 *   - Two consecutive calls produce different serials + different keys
 *     (i.e. the generator is actually generating, not memoizing)
 *   - Bad CNPJ input is rejected at the generator's boundary
 */
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';

import {
  NFeCertError,
  assertCertNotExpired,
  generateTestCertificate,
  loadCertificateFromBase64,
} from '../../src/cert';

describe('generateTestCertificate', () => {
  it('round-trips through loadCertificateFromBase64', () => {
    const { pfxBase64, password, cert } = generateTestCertificate();
    const reparsed = loadCertificateFromBase64(pfxBase64, password);
    expect(reparsed.cnpj).toBe(cert.cnpj);
    expect(reparsed.subjectCommonName).toBe(cert.subjectCommonName);
    expect(reparsed.certificatePem).toBe(cert.certificatePem);
  });

  it('uses the default fictitious CNPJ when none is supplied', () => {
    const { cert } = generateTestCertificate();
    expect(cert.cnpj).toBe('99999999000191');
    expect(cert.subjectCommonName).toBe(
      'EMPRESA TESTE HOMOLOGACAO LTDA:99999999000191',
    );
  });

  it('honors a custom CNPJ + company name', () => {
    const { cert } = generateTestCertificate({
      cnpj: '12345678000195',
      companyName: 'ACME LTDA',
    });
    expect(cert.cnpj).toBe('12345678000195');
    expect(cert.subjectCommonName).toBe('ACME LTDA:12345678000195');
  });

  it('rejects a CNPJ that does not match CNPJ_FORMAT', () => {
    expect(() => generateTestCertificate({ cnpj: '12345' })).toThrow(NFeCertError);
    expect(() => generateTestCertificate({ cnpj: 'bad-cnpj' })).toThrow(NFeCertError);
    // Lowercase is also rejected (Receita mandates uppercase for the
    // alphanumeric format).
    expect(() => generateTestCertificate({ cnpj: 'abcdef12000195' })).toThrow(NFeCertError);
  });

  it('passes assertCertNotExpired with the default 10-year validity', () => {
    const { cert } = generateTestCertificate();
    expect(() => assertCertNotExpired(cert)).not.toThrow();
    // notAfter ~10 years out — leave 1-day slack for test wall time.
    const minTenYears = 10 * 365 * 86_400_000 - 86_400_000;
    expect(cert.notAfter.getTime() - Date.now()).toBeGreaterThan(minTenYears);
  });

  it('honors a custom password', () => {
    const { pfxBase64 } = generateTestCertificate({ password: 'custom-pw' });
    // Wrong password fails; correct password succeeds.
    expect(() => loadCertificateFromBase64(pfxBase64, 'homologacao-test')).toThrow(
      NFeCertError,
    );
    expect(() => loadCertificateFromBase64(pfxBase64, 'custom-pw')).not.toThrow();
  });

  it('two consecutive calls produce different serials + different private keys', () => {
    const a = generateTestCertificate();
    const b = generateTestCertificate();
    // The PEM cert bodies must differ (different serial → different
    // signed bytes). The PEM private keys must differ (different
    // freshly-generated RSA keypairs).
    expect(a.cert.certificatePem).not.toBe(b.cert.certificatePem);
    expect(a.cert.privateKeyPem).not.toBe(b.cert.privateKeyPem);
  });

  it('cert carries keyUsage(digitalSignature + nonRepudiation), extKeyUsage(clientAuth), basicConstraints(cA=false)', () => {
    const { cert } = generateTestCertificate();
    // Re-parse the PEM directly through node-forge so we can introspect
    // the extension objects (NFeCertificate doesn't expose them).
    const forgeCert = forge.pki.certificateFromPem(cert.certificatePem);
    type ForgeExt = {
      name?: string;
      digitalSignature?: boolean;
      nonRepudiation?: boolean;
      clientAuth?: boolean;
      cA?: boolean;
    };
    const exts = forgeCert.extensions as readonly ForgeExt[];
    const keyUsage = exts.find((e) => e.name === 'keyUsage');
    const extKeyUsage = exts.find((e) => e.name === 'extKeyUsage');
    const basicConstraints = exts.find((e) => e.name === 'basicConstraints');
    expect(keyUsage?.digitalSignature).toBe(true);
    expect(keyUsage?.nonRepudiation).toBe(true);
    expect(extKeyUsage?.clientAuth).toBe(true);
    expect(basicConstraints?.cA).toBe(false);
  });
});
