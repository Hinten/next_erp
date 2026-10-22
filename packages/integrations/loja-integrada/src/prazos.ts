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
 * checkout may have spent money (`freight-br/src/melhor-envio/prazos.ts`). This
 * package has two classes:
 *
 *  - `'leitura'` — every `GET`, the write client's pre-write read included. A cut
 *    one leaves nothing behind, and repeating it is harmless.
 *  - `'escrita'` — every `PUT` (`escrita.ts`). ⚠️ **A cut write may have
 *    landed.** Loja Integrada's writes take no version and no idempotency key,
 *    so nothing on the wire says whether it did. The caller therefore re-derives
 *    from a FRESH read before deciding anything, and never assumes either
 *    outcome: a retry that skips that read could write twice (and each status
 *    write may e-mail the buyer). The deadline covers the echo's body read too —
 *    a 2xx whose body is then cut still resolves, reported as such.
 *
 * Both are 20 s. They are separate rows so that changing one is a decision about
 * that class alone, and `satisfies Record<ClasseOperacaoLi, number>` makes a
 * class added later a compile error until its budget is decided.
 *
 * ⚠️ There is no `{ curto, longo }` pair and no row in
 * `http-client-timeout-ceiling.test.js`: that registry holds clients of OUR
 * backends whose `longo` tier must outlast the backend's request ceiling. This
 * is a server-to-provider client with no long tier; the test that the calls of
 * ONE request fit under the backend's ceiling arrives with the first route that
 * makes them (precedent: `apps/melhor-envio/lib/freight/prazos.test.ts`).
 */

/** The idempotency class of a call: a read, or a write that may have landed when cut. */
export type ClasseOperacaoLi = 'leitura' | 'escrita';

/** Milliseconds per call, by class. */
export const PRAZO_LI_MS = {
  leitura: 20_000,
  escrita: 20_000,
} as const satisfies Record<ClasseOperacaoLi, number>;
