/**
 * The TIME budget of one product-import dispatch (master plan step 9): when the next unit of work
 * may still start. Pure — constants, one table and two functions; no clock of its own (the
 * dispatch hands its clock in) and no I/O.
 *
 * ## Why the budget is time, and why it is short
 *
 * The import rides the conta's READS queue (`filaLeituraLojaIntegrada`), which runs ONE dispatch
 * at a time and is shared with order intake. Every order-intake attempt may wait behind one import
 * dispatch, so a dispatch is held to {@link DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS} (100 s):
 * `ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS` (70 s) of units, then `CAUDA_DESPACHO_IMPORTACAO_LI_MS`
 * (30 s) for the last unit's writes, the end-of-dispatch checkpoint and the continuation's
 * enqueue. The intake ladder's arithmetic with that co-tenant is pinned beside the queue's own
 * options (`functions/src/index.test.ts`).
 *
 * ## A unit starts only when its WORST case still fits
 *
 * `decorrido + worst case ≤ ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS` ({@link cabeNoOrcamentoLi}).
 * Never the typical cost: a unit that may take 22 s is refused at 48.001 s even though it usually
 * takes 3, because the tail is what the checkpoint and the hand-off are left with.
 *
 * | Unit | Worst case |
 * | --- | --- |
 * | `chamada` — one Loja Integrada call: a listing page, a trash-list page, a catalogue page, a product detail | `RITMO_LEITURA_LI_MS` (the pacer's wait, OUTSIDE the call's deadline) + `PRAZO_LI_MS.leitura` = 2 s + 20 s = 22 s |
 * | `familia` — one family with no Loja Integrada call (its Firestore reads and writes) | 10 s, nominal |
 *
 * The family row is a budget, not a measurement: Firestore calls carry the SDK's own deadlines,
 * the queue's 300 s function timeout is the hard ceiling above all of it, and a dispatch the
 * platform cuts resumes from its last unit checkpoint.
 *
 * ⚠️ Photos are not a unit here yet. A photo (master plan step 9, "complete") costs a CDN download
 * plus an upload whose deadline the app enforces itself; an original that comes back too large and
 * is fetched again at `800x800` is a unit of its OWN (its own budget check, the original's outcome
 * checkpointed first), so no single unit exceeds 2 s + 20 s + the upload deadline. Those rows, and
 * the upload deadline constant, arrive with the photo import that spends them.
 *
 * ## Elapsed time
 *
 * Measured from the dispatch's FIRST statement ({@link abrirOrcamentoLi}'s `inicioMs`, stamped by
 * the handler), so the job read and the context load count against the budget too. A clock that
 * steps BACKWARDS (an NTP correction) reads as 0 elapsed, never as negative; a non-finite reading
 * fits nothing, so a broken clock stops the dispatch at its next unit instead of running unbounded.
 */
import { PRAZO_LI_MS } from '@delfrance/integrations-loja-integrada';
import {
  CAUDA_DESPACHO_IMPORTACAO_LI_MS,
  ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS,
} from '@delfrance/schemas';

import { RITMO_LEITURA_LI_MS } from '../core/ritmo';

/** A unit of work a dispatch may start (module header). */
export type UnidadeImportacaoLi = 'chamada' | 'familia';

/** Named members of {@link UnidadeImportacaoLi}. */
export const UNIDADE_IMPORTACAO_LI = {
  chamada: 'chamada',
  familia: 'familia',
} as const satisfies Record<string, UnidadeImportacaoLi>;

/** A family with no Loja Integrada call: its Firestore reads and writes. Nominal (module header). */
export const PIOR_CASO_FAMILIA_SEM_CHAMADA_LI_MS = 10_000;

/**
 * Each unit's WORST case, in ms (the module header's table). `satisfies Record<…>` makes a unit
 * added to {@link UnidadeImportacaoLi} a compile error until its row is decided.
 */
export const PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS = {
  chamada: RITMO_LEITURA_LI_MS + PRAZO_LI_MS.leitura,
  familia: PIOR_CASO_FAMILIA_SEM_CHAMADA_LI_MS,
} as const satisfies Record<UnidadeImportacaoLi, number>;

/** The longest a dispatch may run: the budget plus its tail (100 s). */
export const DURACAO_MAXIMA_DESPACHO_IMPORTACAO_LI_MS =
  ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS + CAUDA_DESPACHO_IMPORTACAO_LI_MS;

/**
 * Whether a unit may START after `decorridoMs` of this dispatch: its worst case must end inside
 * the budget (`≤`, so a unit that ends exactly at 70 s starts). A negative elapsed time reads as 0;
 * a non-finite one fits nothing (module header).
 *
 * @throws {TypeError} for a unit with no row (only an untyped caller can pass one).
 */
export function cabeNoOrcamentoLi(decorridoMs: number, unidade: UnidadeImportacaoLi): boolean {
  if (!Object.hasOwn(PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS, unidade)) {
    throw new TypeError(`orcamento: unidade sem pior caso (${String(unidade)})`);
  }
  if (!Number.isFinite(decorridoMs)) return false;
  const decorrido = Math.max(0, decorridoMs);
  return (
    decorrido + PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS[unidade] <= ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS
  );
}

/** One dispatch's budget, bound to its clock and its start. */
export interface OrcamentoDespachoLi {
  /** The dispatch's first statement, in ms on the same clock. */
  readonly inicioMs: number;
  /** Elapsed since {@link inicioMs}, never negative (module header). */
  decorridoMs(): number;
  /** Whether `unidade` may start now ({@link cabeNoOrcamentoLi} at the current elapsed time). */
  cabe(unidade: UnidadeImportacaoLi): boolean;
}

/**
 * The budget of a dispatch that started at `inicioMs` (the handler's first stamp; the clock's
 * current reading when omitted). Reads `agoraMs` on every question, never caches it.
 */
export function abrirOrcamentoLi(
  agoraMs: () => number,
  inicioMs: number = agoraMs(),
): OrcamentoDespachoLi {
  const decorridoMs = (): number => Math.max(0, agoraMs() - inicioMs);
  return {
    inicioMs,
    decorridoMs,
    cabe: (unidade) => cabeNoOrcamentoLi(agoraMs() - inicioMs, unidade),
  };
}
