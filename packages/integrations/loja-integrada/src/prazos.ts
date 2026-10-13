/**
 * The per-call deadline for the Loja Integrada transport (#1094's rule: no
 * `fetch` without a bound).
 *
 * `fetch()` has no default timeout, so a Loja Integrada that accepted the
 * connection and never answered would hold the caller until undici's own 300 s
 * limits — the whole request ceiling of an App Hosting backend. Every call opens
 * one of these deadlines (`abrirPrazo` from `@delfrance/core/wire`), reads the
 * body inside it, and a call that outlives it throws `LiTimeoutError`.
 *
 * ## Why the budget is keyed on the operation CLASS, not the endpoint
 *
 * The question a budget answers is "what does a cut HERE leave behind?". Melhor
 * Envio budgets per method because its methods differ in exactly that — a cut
 * checkout may have spent money (`freight-br/src/melhor-envio/prazos.ts`). Every
 * call this package can make today is a cheap, idempotent `GET`: a cut one leaves
 * nothing behind, and repeating it is harmless. So there is one class,
 * `'leitura'`, and one budget.
 *
 * ⚠️ The first write step adds `'escrita'` to {@link ClasseOperacaoLi}, and
 * `satisfies Record<ClasseOperacaoLi, number>` then makes the missing budget a
 * compile error until someone decides what a cut write leaves behind.
 *
 * ⚠️ There is no `{ curto, longo }` pair and no row in
 * `http-client-timeout-ceiling.test.js`: that registry holds clients of OUR
 * backends whose `longo` tier must outlast the backend's request ceiling. This
 * is a server-to-provider client with no long tier; the test that the calls of
 * ONE request fit under the backend's ceiling arrives with the first route that
 * makes them (precedent: `apps/melhor-envio/lib/freight/prazos.test.ts`).
 */

/** The idempotency class of a call. Only reads exist today. */
export type ClasseOperacaoLi = 'leitura';

/** Milliseconds per call, by class. */
export const PRAZO_LI_MS = {
  leitura: 20_000,
} as const satisfies Record<ClasseOperacaoLi, number>;
