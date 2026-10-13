/**
 * Pure transform for the legacy `token_id` removal. No Firestore here — see
 * `migrate.ts` for the IO and `tools/migrations/li-token-legado.README.md` for
 * the runbook.
 *
 * `token_id` is the field the legacy app kept its Loja Integrada credential in,
 * on the `integracao` document itself. This codebase never models it (the
 * schema is `.strict()` for it and nothing reads it), and that document is
 * readable by every client holding the `d_integracao` read permission, so its
 * presence is always an exposed credential — whatever the document's `tipo`.
 * The credential this app uses lives in a server-only subcollection instead.
 *
 * ⚠️ **Nothing in this module ever handles the VALUE.** The plan carries the
 * document's `tipo` and the fact that the field is there, never what it holds,
 * so no caller can log, print or serialize the credential by accident. The
 * tests pin that with a token-shaped sentinel.
 */

/** The only field this migration touches. */
export const TOKEN_FIELD = 'token_id';

export type TokenLegadoPlan =
  | {
      readonly action: 'delete';
      /** The document's `tipo` when it is a finite number, else `null`. */
      readonly tipo: number | null;
    }
  | { readonly action: 'skip' };

/**
 * Decide what to do with one `integracao` document.
 *
 * **Idempotent by construction**: once the field is deleted the key is absent
 * and the plan is `skip`, so a second pass reports zero. A key holding `null`,
 * `''` or any other value still counts as carrying the field — presence is the
 * test, not truthiness, because a half-cleared credential field is still a
 * field the legacy app may have written.
 */
export function planTokenLegado(data: unknown): TokenLegadoPlan {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { action: 'skip' };
  const doc = data as Record<string, unknown>;
  if (!Object.hasOwn(doc, TOKEN_FIELD)) return { action: 'skip' };
  const { tipo } = doc;
  return {
    action: 'delete',
    tipo: typeof tipo === 'number' && Number.isFinite(tipo) ? tipo : null,
  };
}

/**
 * The `from` / `to` pair for the JSONL change row. The row's `path` names the
 * document and `from.tipo` names its integração type; the value is NOT part of
 * it, by construction.
 */
export function describeRemoval(plan: Extract<TokenLegadoPlan, { action: 'delete' }>): {
  from: { present: true; tipo: number | null };
  to: 'removed';
} {
  return { from: { present: true, tipo: plan.tipo }, to: 'removed' };
}

/** Count of documents carrying the field, per `tipo` (`'desconhecido'` when it is not a number). */
export function tallyByTipo(plans: readonly TokenLegadoPlan[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const plan of plans) {
    if (plan.action !== 'delete') continue;
    const key = plan.tipo === null ? 'desconhecido' : String(plan.tipo);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return tally;
}
