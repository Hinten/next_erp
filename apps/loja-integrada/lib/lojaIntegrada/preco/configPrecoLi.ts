/**
 * The price sync's ONE setting read from the environment an entry point passes in (master plan
 * step 13, PR 13-d): how a price send spells the promotion's CLEAR on the wire, the forma of
 * `formaPromoLimpaLiSchema` (`@delfrance/schemas`) — `nulo` (JSON `null`, the default), `zero`
 * (JSON `0`) or `igual-cheio` (the full price itself).
 *
 * A LEAF: it imports `@delfrance/schemas` and one type, so the nightly diff (a later PR of step 13)
 * can read the same value — what counts as a landed clear must be what a send sent — without
 * pulling the send run's module, and with it the write context, into its closure.
 *
 * ⚠️ `igual-cheio` is a window-only fallback a PERSON chooses, tried only if the first canary write
 * refuses both other formas. It is never the default, and nothing here ever picks it.
 *
 * The values are spelled like the schema enum, never as a JS literal: `null` or `0` in an
 * environment file reads to a person as "unset" or "false", so neither is accepted.
 *
 * Pure: no clock, no network, no Firestore; the environment is a parameter (`estrutura.test.ts`).
 * Nothing is trimmed or case-folded, as with the valves (`core/valvulas.ts`) and the stock cap
 * (`estoque/configEstoqueLi.ts`).
 */
import {
  FORMA_PROMO_LIMPA_PADRAO_LI,
  type FormaPromoLimpaLi,
  formaPromoLimpaLiSchema,
} from '@delfrance/schemas';

import type { AmbienteLi } from '../core/valvulas';

/** The variable that names the clear's forma (module header). */
export const FORMA_PROMO_LIMPA_ENV_LI = 'LOJA_INTEGRADA_PRECO_PROMO_LIMPO';

/**
 * The clear's forma, as a send run applies it: unset or EXACTLY blank (`''`, nothing trimmed) ⇒
 * {@link FORMA_PROMO_LIMPA_PADRAO_LI} (`nulo`); an EXACT member of `formaPromoLimpaLiSchema` ⇒
 * itself; anything else (`' nulo'`, `'NULO'`, `'null'`, `'0'`, `'igual_cheio'`) ⇒ `null`, and
 * the run REFUSES — the stock cap's rule: a setting nobody can read is never guessed.
 */
export function lerFormaPromoLimpaLi(ambiente: AmbienteLi): FormaPromoLimpaLi | null {
  const valor = ambiente[FORMA_PROMO_LIMPA_ENV_LI];
  if (valor === undefined || valor === '') return FORMA_PROMO_LIMPA_PADRAO_LI;
  const lida = formaPromoLimpaLiSchema.safeParse(valor);
  return lida.success ? lida.data : null;
}
