/**
 * A1 certificate loader (PFX / PKCS#12).
 *
 * **Server-only.** This module pulls in `node-forge` and exposes the raw
 * private key — it must never be imported from a client bundle. The package
 * `server.ts` entry re-exports it; client code goes through the HTTP
 * `InvoiceProvider` instead.
 *
 * Phase A reads the cert from `NFE_CERT_BASE64` + `NFE_CERT_PASSWORD`
 * (single-tenant homologação). Per-filial encrypted upload is a Phase D
 * follow-up.
 *
 * Output:
 *   - `privateKeyPem` — feeds `xml-crypto` for `infNFe` signing.
 *   - `certificatePem` — embedded in `<X509Certificate>` inside `<Signature>`.
 *   - `pfxBuffer` + `password` — feeds the `https.Agent` used for mTLS.
 *
 * Ported from `.old/functions_node/nota.js` (loadCertificate) +
 * `.old/functions_python/.../upload_certificado.py`.
 */
import forge from 'node-forge';

export class NFeCertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeCertError';
  }
}

/** Parsed A1 certificate ready for signing + mTLS. */
export interface NFeCertificate {
  /** PKCS#1 PEM-encoded RSA private key. */
  readonly privateKeyPem: string;
  /** PEM-encoded X.509 certificate (single cert, no chain). */
  readonly certificatePem: string;
  /** Base-64 of the X.509 DER, with the PEM header/footer stripped. */
  readonly certificateDerBase64: string;
  /** Subject CN as written on the cert (e.g. `EMPRESA LTDA:12345678000199`). */
  readonly subjectCommonName: string;
  /** `notAfter` — caller can warn when expiry is near. */
  readonly notAfter: Date;
  /** Original PFX bytes — fed verbatim to `https.Agent({ pfx, passphrase })`. */
  readonly pfxBuffer: Buffer;
  /** PFX password — same value the agent needs as `passphrase`. */
  readonly password: string;
}

/**
 * Decode and parse an A1 PFX.
 *
 * @param pfxBase64  Base-64 of the .pfx/.p12 file.
 * @param password   Passphrase the certificate was exported with.
 */
export function loadCertificateFromBase64(pfxBase64: string, password: string): NFeCertificate {
  if (!pfxBase64 || pfxBase64.trim().length === 0) {
    throw new NFeCertError('Certificate base-64 is empty');
  }
  if (password == null) {
    // Empty-string passwords are *technically* legal PKCS#12, so allow `""`
    // and reject only the genuinely missing case.
    throw new NFeCertError('Certificate password is required');
  }

  let pfxBuffer: Buffer;
  try {
    pfxBuffer = Buffer.from(pfxBase64, 'base64');
  } catch (err) {
    if (err instanceof Error) {
      throw new NFeCertError(`Failed to base-64-decode certificate: ${err.message}`);
    }
    throw err;
  }

  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.createBuffer(pfxBuffer.toString('binary'));
    const asn1 = forge.asn1.fromDer(der);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch (err) {
    // node-forge throws plain Error instances on bad password / malformed PFX.
    if (err instanceof Error) {
      throw new NFeCertError(`Failed to open PFX (wrong password or malformed file): ${err.message}`);
    }
    throw err;
  }

  // node-forge typings declare these OIDs as `string | undefined`, but they are
  // baked-in constants — assert them so the index access type-checks.
  const KEY_OID = forge.pki.oids.pkcs8ShroudedKeyBag as string;
  const CERT_OID = forge.pki.oids.certBag as string;
  const keyBag = p12.getBags({ bagType: KEY_OID })[KEY_OID]?.[0];
  const certBag = p12.getBags({ bagType: CERT_OID })[CERT_OID]?.[0];

  if (!keyBag?.key) {
    throw new NFeCertError('PFX has no private key bag');
  }
  if (!certBag?.cert) {
    throw new NFeCertError('PFX has no certificate bag');
  }

  const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);
  const certificatePem = forge.pki.certificateToPem(certBag.cert);
  const certificateDerBase64 = forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certBag.cert)).getBytes(),
  );

  const subjectCn = certBag.cert.subject.getField('CN');
  const subjectCommonName: string =
    typeof subjectCn === 'object' && subjectCn !== null && 'value' in subjectCn
      ? String(subjectCn.value)
      : '';

  return {
    privateKeyPem,
    certificatePem,
    certificateDerBase64,
    subjectCommonName,
    notAfter: certBag.cert.validity.notAfter,
    pfxBuffer,
    password,
  };
}

/**
 * Convenience: read `NFE_CERT_BASE64` + `NFE_CERT_PASSWORD` from `process.env`.
 * Throws `NFeCertError` if either is missing.
 */
export function loadCertificateFromEnv(env: NodeJS.ProcessEnv = process.env): NFeCertificate {
  const base64 = env.NFE_CERT_BASE64;
  const password = env.NFE_CERT_PASSWORD;
  if (!base64) throw new NFeCertError('NFE_CERT_BASE64 is not set');
  if (password == null) throw new NFeCertError('NFE_CERT_PASSWORD is not set');
  return loadCertificateFromBase64(base64, password);
}
