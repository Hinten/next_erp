/**
 * The price push's EFFECTIVE valve (step 13, PR 13-c), pure: the price valve
 * as read, with the validation-preview flag applied. ONE function,
 * {@link valvulaPrecoEfetiva}, for every place that decides a price write's
 * form: the task's valve step, a run's decision step and a price feed's send.
 *
 * ## The preview flag fails CLOSED
 *
 * Under the flag a price write is only VALIDATED by Amazon, never persisted:
 * a per-SKU patch goes with `VALIDATION_PREVIEW` (`previa: true`). A feed has
 * no preview mode, so under the flag NO batch decision may be a feed:
 *
 *  - `on` with the canary list exactly `*` (the only form `decidirLote` turns
 *    into a feed) is read as `dry-run`, with the verdict `validacao-com-todos`
 *    for an ERROR line: the flag is meant for a canary LIST;
 *  - `on` with a list is unchanged: its batch decision hands the canary's SKUs
 *    to tasks, and every task previews;
 *  - `dry-run` and `off` are unchanged.
 *
 * Without the flag the valve is returned as read, `previa: false`.
 *
 * PURE: no Firestore, no clock, no network; the flag comes in as a boolean.
 */
import { type FLUXO_AMAZON, MODO_AMAZON, type ValvulaAmazon } from '../core/valvulas';

/** The verdict a caller writes as an ERROR line. */
export type VereditoValvulaPrecoAmazon = 'validacao-com-todos';

export const VEREDITO_VALVULA_PRECO_AMAZON = {
  validacaoComTodos: 'validacao-com-todos',
} as const satisfies Record<string, VereditoValvulaPrecoAmazon>;

/** The price valve. */
export type ValvulaPrecoAmazon = ValvulaAmazon<typeof FLUXO_AMAZON.preco>;

/** The effective valve (module header). */
export interface ValvulaPrecoEfetivaAmazon {
  /** The valve every decision reads. */
  readonly valvula: ValvulaPrecoAmazon;
  /** Every write under it is a validation preview: nothing is persisted. */
  readonly previa: boolean;
  /** `validacao-com-todos` when the flag met `on` + `*`; else `null`. */
  readonly veredito: VereditoValvulaPrecoAmazon | null;
}

/**
 * The price valve with the preview flag applied (module header).
 *
 * @param valvula the price valve as read.
 * @param soValidacao the preview flag is on.
 */
export function valvulaPrecoEfetiva(
  valvula: ValvulaPrecoAmazon,
  soValidacao: boolean,
): ValvulaPrecoEfetivaAmazon {
  if (!soValidacao) return { valvula, previa: false, veredito: null };
  if (valvula.modo === MODO_AMAZON.on && valvula.canario.tipo === 'todos') {
    return {
      valvula: { ...valvula, modo: MODO_AMAZON.dryRun },
      previa: true,
      veredito: VEREDITO_VALVULA_PRECO_AMAZON.validacaoComTodos,
    };
  }
  return { valvula, previa: true, veredito: null };
}
