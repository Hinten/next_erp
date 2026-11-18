/**
 * The TIME budget of one slice of the daily stock reconcile (master plan step 12, PR 12-g): when
 * the next unit of work may still start. Pure — constants, one table and two functions; no clock
 * of its own (the slice hands its clock in) and no I/O.
 *
 * ## The import's budget, shared
 *
 * A slice rides the conta's READS queue (`filaLeituraLojaIntegrada`) beside order intake and the
 * product import, so it is held to the import's own ceiling: a unit starts only while its WORST
 * case still ends inside `ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS` (70 s), and the last 30 s
 * (`CAUDA_DESPACHO_IMPORTACAO_LI_MS`) are left to the end-of-slice checkpoint and the hand-off —
 * `DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS`, 100 s, the same constant
 * (`functions/src/index.test.ts` pins the intake ladder with ONE reconcile slice as a co-tenant:
 * the reconcile is one chain for every conta, so an intake attempt waits at most one of its
 * slices). The rule itself is the import's (`cabeNoOrcamentoMsLi`), never a second copy.
 *
 * | Unit | Worst case |
 * | --- | --- |
 * | `erp` — one page of the ERP link walk: the key query, the page's produtos (masked), their stock records at every run conta's depósito, the never-had-stock listings, and the trailing produto's own links | 20 s, nominal |
 * | `mapa` — one batch of the kits map writer (headers, shards, a page of the sweep), with the run document's lease | 20 s, nominal |
 * | `chamada` — one Loja Integrada call of the store's list walk (`faseLi.ts`): a page of the stock list, or one product's stock detail | the import's own row: `RITMO_LEITURA_LI_MS` + `PRAZO_LI_MS.leitura` = 2 s + 20 s = 22 s |
 * | `consulta` — the lookups of ONE page's store rows no snapshot entry names: the link queries (per 15 ids, per stored form of the conta ref), and the evaluation of the produtos they find | 20 s, nominal |
 *
 * A page's lookups are a unit of their OWN, started only when the page holds a row to look up and
 * its worst case still fits; when it does not, the page is dropped unread — nothing of it is kept
 * — and the next slice reads it again first (one call spent twice, and only when a page ends late
 * in a slice: a steady-state list has no row to look up).
 *
 * The nominal rows are budgets, not measurements: every Firestore call carries the SDK's own deadline,
 * the queue's 300 s function timeout is the hard ceiling above all of it, and a slice the
 * platform cuts resumes from its last checkpoint. The owner's staging run of a full reconcile
 * confirms or corrects them before the window (`functions/DEPLOY.md`).
 *
 * Elapsed time is measured from the slice's FIRST statement (the queue handler's `inicioMs`), so
 * the run document's read counts too.
 */
import {
  DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS,
  PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS,
  cabeNoOrcamentoMsLi,
} from '../../importacao/orcamento';

/** A unit of work a reconcile slice may start (module header). */
export type UnidadeReconcileLi = 'erp' | 'mapa' | 'chamada' | 'consulta';

/** Named members of {@link UnidadeReconcileLi}. */
export const UNIDADE_RECONCILE_LI = {
  erp: 'erp',
  mapa: 'mapa',
  chamada: 'chamada',
  consulta: 'consulta',
} as const satisfies Record<string, UnidadeReconcileLi>;

/**
 * Each unit's WORST case, in ms (the module header's table). `satisfies Record<…>` makes a unit
 * added to {@link UnidadeReconcileLi} a compile error until its row is decided.
 */
export const PIOR_CASO_UNIDADE_RECONCILE_LI_MS = {
  erp: 20_000,
  mapa: 20_000,
  // The import's row, the SAME constant: one paced read of the store.
  chamada: PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.chamada,
  consulta: 20_000,
} as const satisfies Record<UnidadeReconcileLi, number>;

/** The longest a slice may run: the import's budget plus its tail (100 s), the SAME constant. */
export const DURACAO_MAXIMA_SLICE_RECONCILE_LI_MS = DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS;

/** One slice's budget, bound to its clock and its start. */
export interface OrcamentoReconcileLi {
  /** The slice's first statement, in ms on the same clock. */
  readonly inicioMs: number;
  /** Whether `unidade` may start now. */
  cabe(unidade: UnidadeReconcileLi): boolean;
}

/**
 * The budget of a slice that started at `inicioMs`. Reads `agoraMs` on every question, never
 * caches it. Throws `TypeError` for a unit with no row (only an untyped caller can pass one).
 */
export function abrirOrcamentoReconcileLi(
  agoraMs: () => number,
  inicioMs: number,
): OrcamentoReconcileLi {
  return {
    inicioMs,
    cabe: (unidade) => {
      if (!Object.hasOwn(PIOR_CASO_UNIDADE_RECONCILE_LI_MS, unidade)) {
        throw new TypeError(`orcamentoReconcile: unidade sem pior caso (${String(unidade)})`);
      }
      return cabeNoOrcamentoMsLi(agoraMs() - inicioMs, PIOR_CASO_UNIDADE_RECONCILE_LI_MS[unidade]);
    },
  };
}
