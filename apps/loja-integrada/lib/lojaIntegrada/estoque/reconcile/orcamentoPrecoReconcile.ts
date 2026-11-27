/**
 * The TIME budget of the daily reconcile's PRICE units (master plan step 13, PR 13-f1): the price
 * arm's rows beside the stock ones (`orcamentoReconcile.ts`), held to the same rule — a unit starts
 * only while its WORST case still ends inside the slice's 70 s, the last 30 s left to the
 * end-of-slice checkpoint and the hand-off (`cabeNoOrcamentoMsLi`, the import's one copy). Pure:
 * constants, one table and one function; the slice hands its clock in.
 *
 * | Unit | Worst case |
 * | --- | --- |
 * | `paisPreco` — one unit of the parents phase (`paisPrecoReconcile.ts`): ONE masked `getAll` of at most 300 parents, the targets of their children computed in memory | 20 s, nominal |
 * | `fimPreco` — one conta's price end (`fimPrecoReconcile.ts`): its price aviso (one read, and a write when it moves) and its `ultimoReconcilePreco` | 20 s, nominal |
 * | `fimComPreco` — one conta's WHOLE end when the run carries the price arm: the stock end unit and the price end unit, which never split across slices | the stock `fim` row + `fimPreco` = 40 s |
 *
 * A separate table, so the stock table's `satisfies` (and its pinned rows) never move. The
 * nominal rows are budgets, not measurements, as the stock ones are.
 */
import { cabeNoOrcamentoMsLi } from '../../importacao/orcamento';
import { PIOR_CASO_UNIDADE_RECONCILE_LI_MS } from './orcamentoReconcile';

/** A price unit a reconcile slice may start (module header). */
export type UnidadePrecoReconcileLi = 'paisPreco' | 'fimPreco' | 'fimComPreco';

/** Named members of {@link UnidadePrecoReconcileLi}. */
export const UNIDADE_PRECO_RECONCILE_LI = {
  paisPreco: 'paisPreco',
  fimPreco: 'fimPreco',
  fimComPreco: 'fimComPreco',
} as const satisfies Record<string, UnidadePrecoReconcileLi>;

/** Each price unit's WORST case, in ms (the module header's table). */
export const PIOR_CASO_UNIDADE_PRECO_RECONCILE_LI_MS = {
  paisPreco: 20_000,
  fimPreco: 20_000,
  fimComPreco: PIOR_CASO_UNIDADE_RECONCILE_LI_MS.fim + 20_000,
} as const satisfies Record<UnidadePrecoReconcileLi, number>;

/** One slice's price budget, bound to its clock and its start. */
export interface OrcamentoPrecoReconcileLi {
  /** Whether `unidade` may start now. */
  cabe(unidade: UnidadePrecoReconcileLi): boolean;
}

/**
 * The price budget of a slice that started at `inicioMs`, on the stock budget's clock. Reads
 * `agoraMs` on every question. Throws `TypeError` for a unit with no row.
 */
export function abrirOrcamentoPrecoReconcileLi(
  agoraMs: () => number,
  inicioMs: number,
): OrcamentoPrecoReconcileLi {
  return {
    cabe: (unidade) => {
      if (!Object.hasOwn(PIOR_CASO_UNIDADE_PRECO_RECONCILE_LI_MS, unidade)) {
        throw new TypeError(`orcamentoPrecoReconcile: unidade sem pior caso (${String(unidade)})`);
      }
      return cabeNoOrcamentoMsLi(
        agoraMs() - inicioMs,
        PIOR_CASO_UNIDADE_PRECO_RECONCILE_LI_MS[unidade],
      );
    },
  };
}
