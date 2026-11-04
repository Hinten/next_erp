/**
 * The FORMAT of a credential ref, and nothing else: how one is built
 * ({@link montarRef}), what it looks like ({@link FORMATO_REF}), and the one
 * part a log line may carry — its version, the consent's millisecond start
 * ({@link versaoDaRef}).
 *
 * ⚠️ **No import at all.** The logger (`log.ts`) needs the version, and the
 * fingerprint's hash lives in `refCredencial.ts`, which imports `sha256Hex`
 * from `@delfrance/data/admin`. Importing that from here would drag the Admin
 * data layer into the logger's light closure (`estrutura.test.ts` pins it).
 * So this file owns the format, `refCredencial.ts` owns the hash and
 * re-exports these, and the import sites stay as they are.
 *
 * ⚠️ The ref itself is never logged: its first half is the refresh token's
 * fingerprint. Only {@link versaoDaRef} reaches a line.
 */

/**
 * The label the code exchange runs under. There is no stored credential yet, so
 * nothing is ever stored under it, and the park ignores that operation
 * (`estacionamento.ts`). It can never equal a versioned ref (no hex, no dot).
 */
export const REF_CONSENTIMENTO = 'consentimento';

/**
 * `<16 lowercase hex>.<autorizadoEmMs>`: the fingerprint, a dot, and the
 * consent's millisecond start without a leading zero (an epoch in ms is never
 * `0`, and a leading zero would give one version two spellings).
 */
export const FORMATO_REF = /^([0-9a-f]{16})\.([1-9][0-9]{0,15})$/;

/**
 * The longest ref the package accepts (`MAX_REF_CREDENCIAL`). A local copy,
 * because this file imports nothing; `formatoDaRef.test.ts` pins it equal to
 * the package's.
 */
export const MAX_TAMANHO_REF = 64;

/** `<fingerprint>.<autorizadoEmMs>`. The caller supplies the fingerprint. */
export function montarRef(fingerprint: string, autorizadoEmMs: number): string {
  return `${fingerprint}.${String(autorizadoEmMs)}`;
}

/**
 * The version of a ref — its millisecond suffix, as a number — or `null` for
 * {@link REF_CONSENTIMENTO}, anything outside {@link FORMATO_REF}, a suffix past
 * `Number.MAX_SAFE_INTEGER`, or a value longer than the package's limit. Pure
 * and total: any input, never a throw.
 */
export function versaoDaRef(ref: unknown): number | null {
  if (typeof ref !== 'string' || ref.length > MAX_TAMANHO_REF) return null;
  if (ref === REF_CONSENTIMENTO) return null;
  const m = FORMATO_REF.exec(ref);
  if (m === null) return null;
  const ms = Number(m[2]);
  return Number.isSafeInteger(ms) ? ms : null;
}
