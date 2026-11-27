/**
 * The daily reconcile's two ARMS — stock and price (master plan step 13, PR 13-f1): which of them
 * a slice can run, read from the environment alone, and which of them a run carries, read from its
 * counters. Pure: the environment is a parameter, no clock, no I/O.
 *
 * ## One run, two flows
 *
 * The price reconcile is folded into the stock one: one schedule, one lease and run document, one
 * ERP key walk. Each flow has its own valve (`LOJA_INTEGRADA_MODO_ESTOQUE`,
 * `LOJA_INTEGRADA_MODO_PRECO`) and its own setting a run cannot do without — the stock cap
 * (`LOJA_INTEGRADA_ESTOQUE_MAX`) and the clear's forma (`LOJA_INTEGRADA_PRECO_PROMO_LIMPO`). An arm
 * is ACTIVE in a slice when its valve is not `off` and its setting reads; the setting is read only
 * when the valve is not `off`, so an `off` valve never reports a misspelt setting.
 *
 * ## The both-valve gate
 *
 * A slice, the nightly start and the conta trigger's arms return at ZERO reads only when BOTH
 * valves are `off` ({@link reconcileDesligadoLi}): with one flow on, the run carries on with that
 * flow alone. So stopping a running chain takes both valves `off`.
 *
 * ## The arms a run carries
 *
 * A run carries an arm when, at the take, the arm was active. It is recorded in the run document's
 * `contadores` — no schema change — and an arm can only be DROPPED mid-run (a later slice finds its
 * valve `off` or its setting unreadable), never added:
 *
 *  - {@link CONTADOR_PRECO_NO_RUN_LI}: the take carried the price arm;
 *  - {@link CONTADOR_PRECO_ABANDONADO_LI}: the price arm was dropped mid-run;
 *  - {@link CONTADOR_ESTOQUE_FORA_DO_RUN_LI}: the take did not carry the stock arm, or it was
 *    dropped.
 *
 * A run whose price valve was unset at the take writes none of them, so its document is exactly
 * the stock-only reconcile's.
 */
import type { FormaPromoLimpaLi } from '@delfrance/schemas';

import {
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  type ValvulaLi,
  lerValvula,
} from '../../core/valvulas';
import { lerFormaPromoLimpaLi } from '../../preco/configPrecoLi';
import { lerTetoEstoqueLi } from '../configEstoqueLi';

/** The take carried the price arm (module header). */
export const CONTADOR_PRECO_NO_RUN_LI = 'precoNoRun';
/** The price arm was dropped mid-run (module header). */
export const CONTADOR_PRECO_ABANDONADO_LI = 'precoAbandonado';
/** The stock arm was not carried at the take, or was dropped (module header). */
export const CONTADOR_ESTOQUE_FORA_DO_RUN_LI = 'estoqueForaDoRun';

/**
 * Every RUN-level counter the price arm writes, which a stock-only run never does — what a
 * comparison of a price-carrying run's counters with a stock-only one's sets aside. Exhaustive:
 * the price arm's per-conta counters live in the conta's own price root, never in the run
 * document.
 */
export const CONTADORES_DE_PRECO_DO_RUN_LI: readonly string[] = [
  CONTADOR_PRECO_NO_RUN_LI,
  CONTADOR_PRECO_ABANDONADO_LI,
  CONTADOR_ESTOQUE_FORA_DO_RUN_LI,
];

/** One arm in a slice: its valve, and whether it can run (module header). */
export interface ArmaDoSliceLi {
  readonly valvula: ValvulaLi;
  readonly ativa: boolean;
}

/** Both arms in a slice, each with its setting (`null`: unreadable, or not read under `off`). */
export interface ArmasDoSliceLi {
  readonly estoque: ArmaDoSliceLi & { readonly teto: number | null };
  readonly preco: ArmaDoSliceLi & { readonly forma: FormaPromoLimpaLi | null };
}

/** Both arms as the environment sets them for this slice (module header). Pure. */
export function lerArmasDoSliceLi(ambiente: AmbienteLi): ArmasDoSliceLi {
  const valvulaEstoque = lerValvula(FLUXO_LI.estoque, ambiente);
  const valvulaPreco = lerValvula(FLUXO_LI.preco, ambiente);
  const teto = valvulaEstoque.modo === MODO_LI.off ? null : lerTetoEstoqueLi(ambiente);
  const forma = valvulaPreco.modo === MODO_LI.off ? null : lerFormaPromoLimpaLi(ambiente);
  return {
    estoque: { valvula: valvulaEstoque, ativa: teto !== null, teto },
    preco: { valvula: valvulaPreco, ativa: forma !== null, forma },
  };
}

/**
 * Both valves `off` (module header, "The both-valve gate"): the zero-read return of a slice, the
 * nightly start and the conta trigger's arms. Unset, blank and a typo are `off` (`lerValvula`).
 *
 * Equal (⇒ `true`): both unset; `OFF`, ` on` or `true` beside an unset one. Distinct (⇒ `false`):
 * either one exactly `dry-run` or `on`.
 */
export function reconcileDesligadoLi(ambiente: AmbienteLi): boolean {
  return (
    lerValvula(FLUXO_LI.estoque, ambiente).modo === MODO_LI.off &&
    lerValvula(FLUXO_LI.preco, ambiente).modo === MODO_LI.off
  );
}

/** The arms a run carries now, from its counters (module header, "The arms a run carries"). Pure. */
export function armasDoRunLi(contadores: Readonly<Record<string, number>>): {
  readonly estoque: boolean;
  readonly preco: boolean;
} {
  const n = (nome: string): number => contadores[nome] ?? 0;
  return {
    estoque: n(CONTADOR_ESTOQUE_FORA_DO_RUN_LI) === 0,
    preco: n(CONTADOR_PRECO_NO_RUN_LI) > 0 && n(CONTADOR_PRECO_ABANDONADO_LI) === 0,
  };
}
