/**
 * The ONE owner of the versioned credential ref's format:
 * `<fingerprint>.<tokenAtualizadoEmMs>` — 16 lowercase hex characters, a dot,
 * and the millisecond stamp of the save that stored the token.
 *
 * `credencial.ts` builds every ref through {@link montarRef}, and the logger
 * reads one back through {@link versaoDaRef}. Neither reimplements the shape.
 *
 * ⚠️ **Dependency-free on purpose.** `credencial.ts` imports the
 * `@delfrance/data/admin` barrel (for `sha256Hex`), which re-exports the
 * collection handles and more; the logger must not pull the admin data layer in
 * just to read a version suffix. `estrutura.test.ts` asserts that this file
 * imports nothing, and that the logger's import closure never reaches
 * `credencial.ts`.
 *
 * ⚠️ **Only the VERSION is ever logged, never the ref.** The ref carries the
 * fingerprint, which stays out of every log line (`APP/CLAUDE.md`, "Token
 * hygiene"). The version is the save's own clock: it names which save a call ran
 * under, and says nothing about the token.
 */

/** `<16 hex>.<1 to 16 digits>` — what `montarRef` produces for a real stamp. */
const REF_VERSIONADA = /^[0-9a-f]{16}\.(\d{1,16})$/;

/** The versioned ref of a stored credential. The caller supplies the fingerprint. */
export function montarRef(fingerprint: string, tokenAtualizadoEmMs: number): string {
  return `${fingerprint}.${String(tokenAtualizadoEmMs)}`;
}

/**
 * The version suffix (the stamp's digits) of a versioned ref, or `null` for
 * anything else — the package's fixed `'candidato'` label of a token being
 * validated, a ref with no dot, uppercase hex, a negative or fractional stamp.
 * A regex test: total, never throws.
 */
export function versaoDaRef(ref: string): string | null {
  return REF_VERSIONADA.exec(ref)?.[1] ?? null;
}
