/**
 * Baseline secret-key redaction for the shared structured logger.
 *
 * This is a deliberately general, non-exhaustive list — enough to keep common
 * credentials (passwords, tokens, cookies, service-account JSON) out of logs.
 *
 * It intentionally does NOT replace the NF-e package's stricter, audited,
 * recursive redactor (`apps/nfe/lib/nfe/log.ts` — `SENSITIVE_KEYS` /
 * `redactSensitive`, pinned by `redact.test.ts`), which this PR leaves
 * untouched. Unifying the two — promoting the canonical key set here and having
 * NF-e delegate to it — is tracked as a follow-up issue.
 */
export const SECRET_KEYS: readonly string[] = [
  // Credentials
  'password',
  'senha',
  'pass',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'apikey',
  'secret',
  'clientSecret',
  'authorization',
  'cookie',
  'setCookie',
  // Keys / certs
  'privateKey',
  'privateKeyPem',
  'certificatePem',
  'pfxBuffer',
  // Project-specific secret env names that may be stashed inside config objects
  'NFE_CERT_BASE64',
  'NFE_CERT_PASSWORD',
  'FIREBASE_SERVICE_ACCOUNT',
];

/**
 * pino `redact.paths`. pino uses fast-redact, whose `*` wildcard matches exactly
 * one path segment — so for every secret key we redact it both at the root and
 * one level deep (`*.key`), which covers the common `{ user: { token } }` shape.
 */
export const REDACT_PATHS: readonly string[] = SECRET_KEYS.flatMap((k) => [k, `*.${k}`]);
