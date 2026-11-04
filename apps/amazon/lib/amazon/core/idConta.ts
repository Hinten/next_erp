/**
 * The conta-id grammar, in ONE light module: the routes, the callback, the
 * logger's envelope (`log.ts`) and step 2b's canary lists (`valvulas.ts`) all
 * check an id with it. `core/contas.ts` imports it back and re-exports it, so
 * this app holds one copy.
 *
 * ⚠️ The grammar is restated ONCE outside the app, as `CONTA_ID_AMAZON_REGEX` in
 * `packages/schemas/src/notificacaoAmazon.ts` (the task payload's `contaId`): a
 * package cannot import an app, and this module imports nothing.
 * `notificacoes/notificacao.test.ts` pins the two sources and flags equal, so a
 * change here must change both.
 *
 * No import at all: `contas.ts` reaches the collections handle and Firestore,
 * and the logger's closure must not (`estrutura.test.ts`).
 */

/** Letters, digits, `_` and `-`, 1 to 128 — every auto-id fits, nothing a path could misread. */
export const ID_DE_CONTA = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Can this value be used as a conta (document) id? A route checks it FIRST,
 * before any read: `.doc(id)` validates the path itself and throws outside every
 * narrow `catch`, so a malformed id would be a 500 — or, with a `/`, a read of
 * a document the caller never named. A `.` is refused too (Firestore reserves
 * `.` and `..`), and so is anything outside the auto-id alphabet.
 *
 * ⚠️ Copied, not imported, from the other channels: `apps/*` have no dependency
 * edge to each other.
 */
export function idDeContaValido(id: unknown): id is string {
  return typeof id === 'string' && ID_DE_CONTA.test(id);
}
