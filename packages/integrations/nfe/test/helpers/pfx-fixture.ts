/**
 * Self-signed PFX builder for unit tests — so no suite ever ships (or depends
 * on) a real ICP-Brasil certificate. Shared by the cert loader tests and the
 * per-filial storage tests.
 *
 * **Never use this in production NF-e signing** — the 1024-bit key keeps the
 * fixture fast, but ICP-Brasil mandates a 2048-bit minimum.
 */
import forge from 'node-forge';

export interface PfxFixtureOpts {
  /** Subject/issuer CN. Defaults to the universal SEFAZ test placeholder. */
  commonName?: string;
  /** PFX passphrase. */
  password: string;
  /** Override `notAfter` for expiry tests. Default: +365 days. */
  notAfter?: Date;
}

/** Build a self-signed PFX in-memory and return it base64-encoded. */
export function buildPfxFixture(opts: PfxFixtureOpts): string {
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
