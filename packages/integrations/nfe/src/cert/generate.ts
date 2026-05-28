/**
 * Self-signed A1 certificate generator for SEFAZ-SP homologação tests.
 *
 * **What this is for**: SEFAZ-SP HOM accepts self-signed client certs at
 * the TLS handshake (HOM is the testing surface; real ICP-Brasil
 * certs are reserved for produção). A purpose-built self-signed PFX
 * lets CI runs avoid stashing real cert material in GitHub secrets —
 * the generated cert has no fiscal authority and can be rebuilt on
 * every run from the same generator code.
 *
 * **What this is NOT for**:
 * - **Production emission.** SEFAZ rejects self-signed at the
 *   produção TLS handshake. `src/safety/assertSafeTpAmb` already
 *   blocks `tpAmb='1'` without `NFE_ALLOW_PRODUCAO=true` — defense in
 *   depth on top of SEFAZ's own rejection.
 * - **Real audit trails.** NF-es signed by this cert have no legal
 *   weight; the digital signature traces back to a cert nobody
 *   issued.
 *
 * The output Subject CN follows the ICP-Brasil A1 convention
 * `<COMPANY NAME>:<CNPJ>` that `parsePfxBuffer` (`./index.ts:99`)
 * already requires, so the generated PFX flies through
 * `loadCertificateFromBase64` (`./index.ts:175`) without any loader-
 * side changes.
 */
import forge from 'node-forge';

import {
  CNPJ_FORMAT,
  NFeCertError,
  loadCertificateFromBase64,
  type NFeCertificate,
} from './index';

/** Default fictitious CNPJ — widely used in the Brazilian NF-e community for HOM tests. */
const DEFAULT_CNPJ = '99999999000191';
/** Default Subject CN prefix. */
const DEFAULT_COMPANY_NAME = 'EMPRESA TESTE HOMOLOGACAO LTDA';
/** Default PFX export password — public knowledge, the cert has no fiscal authority. */
const DEFAULT_PASSWORD = 'homologacao-test';
/** Default validity in years. */
const DEFAULT_VALIDITY_YEARS = 10;

/** Output of `generateTestCertificate`. */
export interface GeneratedTestCertificate {
  /**
   * Base64 of the PKCS#12 (.pfx) bytes — set as `NFE_CERT_BASE64`
   * for the orchestrator runtime and the homologação live tests.
   */
  readonly pfxBase64: string;
  /** Password the PFX was exported with — set as `NFE_CERT_PASSWORD`. */
  readonly password: string;
  /**
   * Already-parsed shape, same as `loadCertificateFromBase64`
   * returns — exposed so callers can introspect the generated CNPJ
   * / Subject CN / notAfter without re-parsing.
   */
  readonly cert: NFeCertificate;
}

/** Options for `generateTestCertificate`. All optional with sane defaults. */
export interface GenerateTestCertificateOptions {
  /** Fictitious CNPJ for the Subject CN suffix. Default: `99999999000191`. */
  readonly cnpj?: string;
  /** Subject CN prefix (company name). Default: `EMPRESA TESTE HOMOLOGACAO LTDA`. */
  readonly companyName?: string;
  /** Password to export the PKCS#12 with. Default: `homologacao-test`. */
  readonly password?: string;
  /** Validity in years from `now`. Default: 10. */
  readonly validityYears?: number;
}

/**
 * Generate a fresh self-signed A1 certificate suitable for SEFAZ-SP
 * homologação testing. Builds a PKCS#12 in memory and returns it
 * base64-encoded along with the already-parsed `NFeCertificate`
 * shape (round-tripped through `loadCertificateFromBase64` to
 * exercise the same path the rest of the codebase uses).
 *
 * Two consecutive calls produce different serial numbers and
 * different RSA keypairs — the generator does not reuse any material
 * across calls, so freshness is by construction.
 */
export function generateTestCertificate(
  options: GenerateTestCertificateOptions = {},
): GeneratedTestCertificate {
  const cnpj = options.cnpj ?? DEFAULT_CNPJ;
  const companyName = options.companyName ?? DEFAULT_COMPANY_NAME;
  const password = options.password ?? DEFAULT_PASSWORD;
  const validityYears = options.validityYears ?? DEFAULT_VALIDITY_YEARS;

  if (!CNPJ_FORMAT.test(cnpj)) {
    throw new NFeCertError(
      `generateTestCertificate: cnpj "${cnpj}" does not match ${CNPJ_FORMAT}. ` +
        'Use a 12-alphanumeric + 2-digit DV value (matches ICP-Brasil A1 layout).',
    );
  }

  // 1. RSA 2048 keypair. node-forge's generator is synchronous; for a
  //    test cert that's fine — runs in a few hundred ms at worst.
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });

  // 2. X.509 v3 cert.
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Random 16-byte serial encoded as hex; node-forge wants a string
  // and prefers the high bit clear (avoids negative ASN.1 INTEGER).
  cert.serialNumber = randomSerialHex();
  const now = new Date();
  cert.validity.notBefore = now;
  const notAfter = new Date(now);
  notAfter.setFullYear(now.getFullYear() + validityYears);
  cert.validity.notAfter = notAfter;

  const subject = [{ name: 'commonName', value: `${companyName}:${cnpj}` }];
  cert.setSubject(subject);
  cert.setIssuer(subject); // self-signed — issuer = subject

  cert.setExtensions([
    {
      name: 'keyUsage',
      digitalSignature: true,
      nonRepudiation: true,
    },
    {
      name: 'extKeyUsage',
      clientAuth: true,
    },
    // Mark as a leaf (not a CA) — basicConstraints is informational
    // for self-signed leaves but keeps things tidy.
    {
      name: 'basicConstraints',
      cA: false,
    },
  ]);

  // 3. Sign with the matching private key using SHA-256.
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // 4. Wrap into a PKCS#12. `toPkcs12Asn1` takes the private key
  //    object + a cert chain (single-cert here since it's self-signed).
  const pfxAsn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [cert],
    password,
    // No `algorithm` override — node-forge defaults to AES-256 for
    // modern compatibility (OpenSSL 3 reads it fine; our `parsePfxBuffer`
    // also reads it fine since it parses the DER directly).
    {
      friendlyName: companyName,
    },
  );
  const pfxDer = forge.asn1.toDer(pfxAsn1).getBytes();
  const pfxBase64 = forge.util.encode64(pfxDer);

  // 5. Round-trip through the real loader so the returned cert is
  //    exactly the shape every consumer reads. Any divergence between
  //    the generator and the loader surfaces immediately as an error
  //    here, not in a downstream test.
  const parsed = loadCertificateFromBase64(pfxBase64, password);

  return { pfxBase64, password, cert: parsed };
}

/**
 * Build a 16-byte random hex string with the high bit clear. node-forge
 * uses the string as an ASN.1 INTEGER value; a leading bit set would
 * encode as negative. Crypto-grade randomness is overkill for a test
 * cert serial but free via `Math.random` is too weak (the unit test
 * "two runs produce distinct serials" would flake on bad RNG).
 */
function randomSerialHex(): string {
  const bytes = forge.random.getBytesSync(16);
  let hex = forge.util.bytesToHex(bytes);
  // Clear the high bit of the first nibble — guarantees positive ASN.1.
  const firstChar = parseInt(hex[0]!, 16) & 0x7;
  hex = firstChar.toString(16) + hex.slice(1);
  return hex;
}
