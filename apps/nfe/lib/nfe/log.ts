/**
 * Safe logging helpers for NF-e code paths.
 *
 * Why these exist: `NFeTransportError` carries the raw SEFAZ SOAP
 * response body as a public readonly property (`responseBody`), and on
 * rejection cStats like 215/225 SEFAZ can echo signed XML — including
 * the issuer's signature blob — back in that body. A plain
 * `console.error('[nfe/foo]', e)` runs the error through Node's
 * `util.inspect`, which enumerates the public field. The masker in
 * GitHub Actions only catches verbatim secret strings; any substring
 * mutation slips through.
 *
 * Use:
 *   - `safeErrorShape(err)` at every `catch` boundary that may surface
 *     an error from the NF-e library.
 *   - `redactSensitive(obj)` when logging a composite object whose
 *     shape isn't fully under our control (runtime snapshots, outcome
 *     bundles, etc.).
 *   - `safeLog(level, ...args)` when you want a one-liner that's
 *     equivalent to `console[level]` with each arg run through
 *     `redactSensitive`.
 *
 * The lint rule in `eslint.config.mjs` (no-restricted-syntax,
 * `CallExpression[callee.object.name="console"]`) ensures NF-e code
 * paths reach for these helpers instead of raw `console.*`.
 */

/**
 * Property names whose values are redacted by `redactSensitive` and
 * `safeLog`. Audit list — add new names here when a new sensitive
 * field enters the surface (and only here; the lint rule pins us to
 * this single source of truth).
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // NFeCertificate fields
  'privateKeyPem',
  'certificatePem',
  'certificateDerBase64',
  'pfxBuffer',
  'password',
  // Signed XML / wire bodies — in-flight generator-output names…
  'signedXml',
  'nfeXml',
  'responseBody',
  // …and the snake_case field names the orchestrator persists on the
  // NotaFiscalEletronica doc (carry the same signed XML / X509 blob).
  'xml_assinado',
  'xml_nfe_proc',
  'xml_epec_proc',
  // Raw env-var-style secret names (caller may stash them in a config object)
  'NFE_CERT_BASE64',
  'NFE_CERT_PASSWORD',
  'NFE_CERT_ENC_KEY',
  'FIREBASE_SERVICE_ACCOUNT',
  // Per-filial cert upload + at-rest fields: the uploaded PFX, the
  // AES-256-GCM-encrypted private key, and its raw ciphertext.
  'pfxBase64',
  'encPrivateKey',
  'ciphertext',
]);

/**
 * Extracts only `name` + `message` (+ `code` when present) from an
 * unknown error. Use at every `console.error` boundary in code paths
 * that may surface `NFeTransportError`, native axios errors, or
 * custom Error classes carrying sensitive props.
 */
export function safeErrorShape(err: unknown): {
  name: string;
  message: string;
  code?: string | number;
} {
  if (err instanceof Error) {
    const code = (err as { code?: string | number }).code;
    return code != null
      ? { name: err.name, message: err.message, code }
      : { name: err.name, message: err.message };
  }
  return { name: 'NonError', message: String(err) };
}

/**
 * Recursively redacts values for `SENSITIVE_KEYS` in a deep structural
 * clone. Primitives, `Date`, and `Buffer` pass through unchanged.
 * Arrays + plain objects are recursed. Use when logging a composite
 * object whose shape isn't fully under your control.
 */
export function redactSensitive<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (value instanceof Buffer) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v)) as unknown as T;
  }
  // Errors need special handling: `message` and `stack` are
  // non-enumerable, so the generic `Object.entries` walk below would
  // drop them and emit an empty `{}` — losing the only useful debug
  // signal at a catch boundary. Copy them explicitly, then redact the
  // enumerable own props (e.g. NFeTransportError.responseBody).
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const [k, v] of Object.entries(value as unknown as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redactSensitive(v);
    }
    return out as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redactSensitive(v);
  }
  return out as T;
}

/**
 * Thin wrapper over `console[level]` that maps every argument through
 * `redactSensitive` first. Equivalent to writing
 * `console.log(label, redactSensitive(obj))` but ergonomic when you
 * have multiple args.
 */
export function safeLog(
  level: 'log' | 'debug' | 'info' | 'warn' | 'error',
  ...args: ReadonlyArray<unknown>
): void {
  // eslint-disable-next-line no-restricted-syntax
  console[level](...args.map((a) => redactSensitive(a)));
}
