/**
 * A1 certificate loader (PFX / PKCS#12).
 *
 * **Server-only.** This module pulls in `node-forge` and exposes the raw
 * private key — it must never be imported from a client bundle. The package
 * `server.ts` entry re-exports it; client code goes through the HTTP
 * `InvoiceProvider` instead.
 *
 * Phase A reads the cert via one of two env vars (whichever is set —
 * `NFE_CERT_PATH` wins if both are):
 *
 *   - `NFE_CERT_PATH`   — filesystem path to a `.pfx` / `.p12` file.
 *                         Convenient for local dev.
 *   - `NFE_CERT_BASE64` — base-64-encoded PFX bytes. Convenient for CI
 *                         secrets (GH Actions, Cloud Secret Manager).
 *   - `NFE_CERT_PASSWORD` — passphrase. Required for both modes.
 *
 * `.pfx` and `.p12` are interchangeable file extensions for the same
 * PKCS#12 format — the loader parses them identically.
 *
 * Output:
 *   - `privateKeyPem` — feeds `xml-crypto` for `infNFe` signing.
 *   - `certificatePem` — embedded in `<X509Certificate>` inside `<Signature>`.
 *   - `pfxBuffer` + `password` — feeds the `https.Agent` used for mTLS.
 *
 * Ported from `.old/functions_node/nota.js` (loadCertificate) +
 * `.old/functions_python/.../upload_certificado.py`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import forge from 'node-forge';

// Same pattern as `apps/{nfe,integrations}/lib/firebase/admin.ts` and
// `tools/test-fixtures/src/admin.ts`: the path from `.env.local`
// (e.g. `NFE_CERT_PATH=.ignore/cert.pfx`) is conventionally repo-root-relative
// but each Next app's cwd is its own dir. Try cwd first (handles absolute
// paths and same-dir relatives), then walk two levels up to the repo /
// worktree root.
function resolveCredentialPath(inputPath: string): string {
  const fromCwd = resolve(inputPath);
  if (existsSync(fromCwd)) return fromCwd;

  const fromRoot = resolve(process.cwd(), '..', '..', inputPath);
  if (existsSync(fromRoot)) return fromRoot;

  throw new NFeCertError(
    `Certificate file not found at '${inputPath}'. Tried: '${fromCwd}' and '${fromRoot}'.`,
  );
}

export class NFeCertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeCertError';
  }
}

/**
 * Canonical CNPJ format — 12 alphanumeric chars + 2 numeric DV (14
 * total). Forward-compatible with Receita Federal IN RFB 2229/2024,
 * which introduces the alphanumeric CNPJ effective July 2026; today's
 * 14-digit CNPJs are a strict subset because `\d` ⊆ `[A-Z0-9]`.
 * Lowercase is not accepted — Receita Federal mandates uppercase.
 * Letters I, O, Q, F are technically valid but Receita recommends
 * avoiding them (visual collision with digits); we do NOT exclude them
 * here because that's a cert-issuer guideline, not a consumer rule.
 */
export const CNPJ_FORMAT = /^[A-Z0-9]{12}[0-9]{2}$/;

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
  /**
   * CNPJ extracted from the Subject CN suffix. ICP-Brasil PA-3 puts the
   * emitter CNPJ in the CN as `<COMPANY NAME>:<CNPJ>`; we pull it once
   * at load time so every consumer (orchestrator, tests) reads the
   * same value the cert was issued for, eliminating SEFAZ rejection
   * 213 (CNPJ-Base do Emitente difere do CNPJ-Base do Certificado
   * Digital) by construction.
   */
  readonly cnpj: string;
  /** `notAfter` — caller can warn when expiry is near. */
  readonly notAfter: Date;
  /** Original PFX bytes — fed verbatim to `https.Agent({ pfx, passphrase })`. */
  readonly pfxBuffer: Buffer;
  /** PFX password — same value the agent needs as `passphrase`. */
  readonly password: string;
}

/**
 * Concrete class returned by every loader. Identical structural shape to
 * `NFeCertificate` (so consumer call sites are unchanged) plus two
 * redaction hooks:
 *
 *   - `[nodejs.util.inspect.custom]()` catches `console.log(cert)`,
 *     `util.inspect(cert)`, and template-string interpolation.
 *   - `toJSON()` catches `JSON.stringify(cert)` and structured-logger
 *     serialization — a different code path from inspect, hence the
 *     belt-and-suspenders.
 *
 * Both hooks render only the non-secret identity fields (cnpj + subject +
 * notAfter), never the private key, certificate PEMs, PFX bytes, or
 * password. This means a future stray `console.log(cert)` or
 * `console.log(runtime)` cannot leak the A1 private material into
 * App Hosting logs.
 */
class NFeCertificateImpl implements NFeCertificate {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  readonly certificateDerBase64: string;
  readonly subjectCommonName: string;
  readonly cnpj: string;
  readonly notAfter: Date;
  readonly pfxBuffer: Buffer;
  readonly password: string;

  constructor(fields: NFeCertificate) {
    this.privateKeyPem = fields.privateKeyPem;
    this.certificatePem = fields.certificatePem;
    this.certificateDerBase64 = fields.certificateDerBase64;
    this.subjectCommonName = fields.subjectCommonName;
    this.cnpj = fields.cnpj;
    this.notAfter = fields.notAfter;
    this.pfxBuffer = fields.pfxBuffer;
    this.password = fields.password;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return (
      `[NFeCertificate cnpj=${this.cnpj} subject="${this.subjectCommonName}" ` +
      `notAfter=${this.notAfter.toISOString()} (private material redacted)]`
    );
  }

  toJSON(): {
    cnpj: string;
    subjectCommonName: string;
    notAfter: string;
    redacted: true;
  } {
    return {
      cnpj: this.cnpj,
      subjectCommonName: this.subjectCommonName,
      notAfter: this.notAfter.toISOString(),
      redacted: true,
    };
  }
}

/** Parse a raw PKCS#12 buffer into the typed `NFeCertificate` shape. */
function parsePfxBuffer(pfxBuffer: Buffer, password: string): NFeCertificate {
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

  // ICP-Brasil A1 certs encode the CNPJ as the CN suffix after the last
  // colon: `<COMPANY NAME>:<CNPJ>`. Pull the suffix and validate it
  // against CNPJ_FORMAT — that's both today's 14-digit and the upcoming
  // alphanumeric format (IN RFB 2229/2024, effective July 2026).
  const colonIdx = subjectCommonName.lastIndexOf(':');
  const cnpjCandidate =
    colonIdx >= 0 ? subjectCommonName.slice(colonIdx + 1).trim() : '';
  if (!CNPJ_FORMAT.test(cnpjCandidate)) {
    throw new NFeCertError(
      `Certificate Subject CN does not contain a valid CNPJ suffix ` +
        `(got "${subjectCommonName}"). Expected ICP-Brasil A1 format ` +
        `"<COMPANY NAME>:<CNPJ>" where the CNPJ matches ${CNPJ_FORMAT}. ` +
        `Verify NFE_CERT_PATH / NFE_CERT_BASE64 points to an ICP-Brasil ` +
        `e-CNPJ certificate.`,
    );
  }
  const cnpj = cnpjCandidate;

  return new NFeCertificateImpl({
    privateKeyPem,
    certificatePem,
    certificateDerBase64,
    subjectCommonName,
    cnpj,
    notAfter: certBag.cert.validity.notAfter,
    pfxBuffer,
    password,
  });
}

/**
 * Decode and parse an A1 PFX from a base-64 string.
 *
 * @param pfxBase64  Base-64 of the .pfx/.p12 file.
 * @param password   Passphrase the certificate was exported with.
 */
/**
 * Internal helper — not re-exported from the package's public `src/index.ts`.
 * Production code path is `loadCertificateFromEnv`; this is the
 * lower-level entry used by the env loader and by the cert unit tests.
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
  return parsePfxBuffer(pfxBuffer, password);
}

/**
 * Read and parse an A1 PFX from a filesystem path.
 *
 * The file extension does not matter — `.pfx`, `.p12`, or anything else
 * is accepted as long as the contents are PKCS#12 DER bytes.
 *
 * @param path     Filesystem path to the .pfx / .p12 file.
 * @param password Passphrase the certificate was exported with.
 */
/**
 * Internal helper — not re-exported from the package's public `src/index.ts`.
 * Production code path is `loadCertificateFromEnv`; this is the
 * lower-level entry used by the env loader and by the cert unit tests.
 */
export function loadCertificateFromPath(path: string, password: string): NFeCertificate {
  if (!path || path.trim().length === 0) {
    throw new NFeCertError('Certificate path is empty');
  }
  if (password == null) {
    throw new NFeCertError('Certificate password is required');
  }
  const resolvedPath = resolveCredentialPath(path);
  let pfxBuffer: Buffer;
  try {
    pfxBuffer = readFileSync(resolvedPath);
  } catch (err) {
    if (err instanceof Error) {
      throw new NFeCertError(`Failed to read certificate file at '${resolvedPath}': ${err.message}`);
    }
    throw err;
  }
  return parsePfxBuffer(pfxBuffer, password);
}

/**
 * Convenience: load the cert from `process.env`, picking the right source
 * automatically.
 *
 * Lookup order:
 *   1. `NFE_CERT_PATH`   — if set, load from disk (local dev path).
 *   2. `NFE_CERT_BASE64` — otherwise, decode the base-64 string (CI secret).
 *   3. neither set       — throw.
 *
 * `NFE_CERT_PASSWORD` is required in both modes. If both `NFE_CERT_PATH`
 * and `NFE_CERT_BASE64` are set, **path wins** — the more explicit signal
 * (developer overriding a checked-in CI value, typically).
 */
export function loadCertificateFromEnv(env: NodeJS.ProcessEnv = process.env): NFeCertificate {
  const password = env.NFE_CERT_PASSWORD;
  if (password == null) throw new NFeCertError('NFE_CERT_PASSWORD is not set');

  const path = env.NFE_CERT_PATH;
  const base64 = env.NFE_CERT_BASE64;

  let cert: NFeCertificate;
  let source: 'path' | 'base64';
  if (path) {
    cert = loadCertificateFromPath(path, password);
    source = 'path';
  } else if (base64) {
    cert = loadCertificateFromBase64(base64, password);
    source = 'base64';
  } else {
    throw new NFeCertError(
      'Certificate source not set: define NFE_CERT_PATH (filesystem path) or NFE_CERT_BASE64 (base-64 PFX).',
    );
  }
  // Surface a heads-up well before expiry so the human-driven Receita
  // Federal renewal can be scheduled. Default window is 30 days.
  warnIfCertNearExpiry(cert);
  // Audit trail — one greppable line per cert load. Lets ops verify
  // "the cert was loaded N times this boot" (expected N=1 in prod).
  // Uses console.debug so it survives the base config's `no-console`
  // allowlist (matches warnIfCertNearExpiry's channel).
  console.debug(
    `[nfe-cert] loaded source=${source}`,
  );
  return cert;
}

/**
 * `true` when the env exposes a complete NF-e cert configuration —
 * password plus at least one of path / base64. Use this anywhere a
 * caller would otherwise probe `process.env.NFE_CERT_*` directly:
 * test gate-checks, dev-script preflights, /api/health diagnostics.
 *
 * Centralising the env-var names here is what lets the package-level
 * ESLint rule forbid `NFE_CERT_*` reads anywhere outside this file.
 */
export function hasNFeCertEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (Boolean(env.NFE_CERT_PATH) || Boolean(env.NFE_CERT_BASE64)) &&
    env.NFE_CERT_PASSWORD != null
  );
}

/**
 * `true` when the cert's `notAfter` has already passed.
 *
 * Loading an expired cert is **not** automatically a failure — a caller may
 * be diagnosing an out-of-band rotation. But every code path that touches
 * SEFAZ must check first, because SEFAZ will reject the mTLS handshake on
 * an expired cert (and counts that as suspicious traffic).
 */
export function isCertExpired(cert: NFeCertificate, now: Date = new Date()): boolean {
  return cert.notAfter.getTime() <= now.getTime();
}

/**
 * Throw if the cert has expired. Use this at every boundary that would
 * otherwise reach SEFAZ — the homologação smoke, every SOAP call site in
 * the `apps/nfe` orchestrator, and any one-off scripts.
 */
export function assertCertNotExpired(cert: NFeCertificate, now: Date = new Date()): void {
  if (!isCertExpired(cert, now)) return;
  const expiredOn = cert.notAfter.toISOString();
  throw new NFeCertError(
    `Certificate expired on ${expiredOn} (subject CN: ${cert.subjectCommonName || '(none)'}). ` +
      'Renew the A1 PFX and update NFE_CERT_BASE64 / NFE_CERT_PASSWORD.',
  );
}

/**
 * Emit a soft warning when the A1 cert is within `daysBeforeExpiry` of
 * expiry. **Already-expired** certs do *not* trip this — that case is
 * the assertion's job (`assertCertNotExpired` throws hard).
 *
 * The annual ICP-Brasil renewal is a manual process (Receita Federal),
 * so the right surface is observability, not automation: log loudly,
 * page on-call via the configured pipeline, give humans the days-left
 * countdown they need to plan.
 *
 * Default logger is `console.warn`; swap a structured logger in for
 * production observability (Stackdriver / Cloud Logging / Sentry).
 *
 * See the master plan's "Cert lifecycle (operations)" section.
 */
export function warnIfCertNearExpiry(
  cert: NFeCertificate,
  daysBeforeExpiry = 30,
  log: (msg: string) => void = (msg) => console.warn(msg),
  now: Date = new Date(),
): void {
  const msLeft = cert.notAfter.getTime() - now.getTime();
  if (msLeft <= 0) return; // delegated to assertCertNotExpired
  const daysLeft = Math.floor(msLeft / 86_400_000);
  if (daysLeft > daysBeforeExpiry) return;
  log(
    `[nfe-cert] A1 certificate expires in ${daysLeft} day(s) ` +
      `(notAfter=${cert.notAfter.toISOString()}, subject="${cert.subjectCommonName || '(none)'}"). ` +
      'Plan a renewal via Receita Federal.',
  );
}
