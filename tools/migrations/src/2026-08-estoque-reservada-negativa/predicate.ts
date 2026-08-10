import { estoqueDisponivel } from '@delfrance/schemas';

/**
 * Pure classification for the #931 audit: which estoque documents hold a
 * NEGATIVE `quantidadeReservada`, and which writer put it there?
 *
 * No Firestore here — `audit.ts` owns the walk. Keeping the decision pure is
 * what makes it unit-testable in `ci.yml`, and `estoqueDisponivel` is imported
 * rather than re-implemented so the "what would this row have published" number
 * comes from the SAME helper the ML sweep uses.
 *
 * ## Why a negative matters
 *
 * `disponivel = quantidade − quantidadeReservada`, so a negative reservation
 * *increases* availability: `8 − (−2) = 10`, two units that do not exist. #925
 * floored it inside `estoqueDisponivel` and #931 floored the two ML-import sites
 * that did their own arithmetic, so such a row is harmless to availability
 * TODAY. It is still a real data defect, and nothing had ever looked for one.
 */

/** One `historicoEstoque` row, reduced to what the classification needs. */
export interface HistoricoResumo {
  /**
   * ⚠️ `undefined` means the KEY WAS ABSENT — the v1 (Flutter) shape, and the
   * wire representation of "unknown" the whole ledger design rests on (ADR 0014
   * §4). `null` is a v2 writer that had nothing to record. The two are NOT
   * interchangeable here: absent is what makes a row unsummable.
   */
  movimentoReservada: number | null | undefined;
  saldoReservada: number | null | undefined;
  timestamp: number | null | undefined;
  /** Display label only — never computed from (ADR 0014 §4). Carried for forensics. */
  tipo: string | null | undefined;
  motivo: string | null | undefined;
}

/**
 * How the negative most plausibly got there. Four kinds, each decidable from the
 * documents alone — no heuristics, and deliberately no fifth kind guessing at
 * intent.
 */
export type ReservaNegativaKind =
  /**
   * No ledger rows at all. Some writer moved the counter and appended nothing:
   * the ML import's unaudited `merge` (ADR 0014 §4 names it), a console edit, or
   * a Flutter-era write that predates the trail.
   */
  | 'sem-historico'
  /**
   * At least one row is missing the `movimentoReservada` KEY — the legacy
   * Flutter v1 shape. The ledger cannot be summed, so nothing more precise can
   * be said; the negative is most likely Flutter-era.
   */
  | 'historico-v1'
  /**
   * Every row is v2, but `Σ movimentoReservada` does not equal the stored
   * counter. Something changed the counter WITHOUT appending a row (again, the
   * ML import is the known one), or a counter floored by `FieldValue.maximum(0)`
   * drifted from a ledger that recorded the unclamped delta.
   */
  | 'desvio-ledger'
  /**
   * Every row is v2 and the sum reconciles: the trail genuinely records the
   * movements that produced the negative. The rows on this row's `ultimasLinhas`
   * name the writer.
   */
  | 'historico-v2';

export interface ReservaNegativaRow {
  estoquePath: string;
  kind: ReservaNegativaKind;
  quantidade: number;
  quantidadeReservada: number;
  /** `quantidade − quantidadeReservada` — what an UNFLOORED derivation yields. */
  disponivelIngenuo: number;
  /** What `estoqueDisponivel` yields today. */
  disponivelFloored: number;
  /**
   * `disponivelIngenuo − disponivelFloored` — how many units this row would
   * invent without the floor, i.e. how much Mercado Livre could have oversold.
   * This is the number that sizes the blast radius; sum it across the report.
   */
  unidadesInventadas: number;
  parentId: string | null;
  depositoOuterRef: string | null;
  ultimaModificacao: number | null;
  /** `null` when any row is v1 — an unsummable ledger has no honest total. */
  somaMovimentoReservada: number | null;
  nLinhas: number;
  /** Rows missing the `movimentoReservada` key (the v1 shape). */
  nSemMovimentoReservada: number;
  /** The most recent rows, newest first — the forensic payload. */
  ultimasLinhas: HistoricoResumo[];
}

/** How many trailing history rows each flagged row carries into the JSONL. */
export const MAX_LINHAS_NO_RELATORIO = 10;

function numeroOuNull(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

function stringOuNull(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/**
 * Newest first. A row with no `timestamp` sorts LAST rather than being dropped —
 * it is still evidence, and a v1 row is exactly the kind most likely to lack one.
 */
function maisRecentesPrimeiro(historico: readonly HistoricoResumo[]): HistoricoResumo[] {
  return [...historico].sort((a, b) => (b.timestamp ?? -Infinity) - (a.timestamp ?? -Infinity));
}

function classificar(
  historico: readonly HistoricoResumo[],
  quantidadeReservada: number,
): { kind: ReservaNegativaKind; soma: number | null; nSemMovimento: number } {
  if (historico.length === 0) {
    return { kind: 'sem-historico', soma: null, nSemMovimento: 0 };
  }

  // `undefined` (absent key) is the unsummable one; an explicit `null` is a v2
  // writer with nothing to record and contributes 0.
  const nSemMovimento = historico.filter((h) => h.movimentoReservada === undefined).length;
  if (nSemMovimento > 0) {
    return { kind: 'historico-v1', soma: null, nSemMovimento };
  }

  const soma = historico.reduce((acc, h) => acc + (h.movimentoReservada ?? 0), 0);
  // The ledger starts from an implicit 0, so a complete v2 trail sums to the
  // stored counter. Tolerance because the wire type is a double and these are
  // summed floats.
  const reconcilia = Math.abs(soma - quantidadeReservada) < 1e-9;
  return { kind: reconcilia ? 'historico-v2' : 'desvio-ledger', soma, nSemMovimento: 0 };
}

/**
 * `null` when the document is fine — i.e. `quantidadeReservada` is absent, not a
 * finite number, or `>= 0`. A row otherwise.
 *
 * ⚠️ A missing or non-numeric counter is deliberately NOT flagged. It reads as
 * `0` everywhere (the schema defaults it, the sweep coalesces it), so it cannot
 * invent stock — which is the thing this audit is looking for. Flagging it would
 * bury the real hits under every kit-sold stamp, which writes no counters at all
 * by design (ADR 0014 §2).
 */
export function auditarReservaNegativa(
  estoquePath: string,
  estoque: Record<string, unknown>,
  historico: readonly HistoricoResumo[],
): ReservaNegativaRow | null {
  const quantidadeReservada = numeroOuNull(estoque.quantidadeReservada);
  if (quantidadeReservada == null || quantidadeReservada >= 0) return null;

  const quantidade = numeroOuNull(estoque.quantidade) ?? 0;
  const disponivelIngenuo = quantidade - quantidadeReservada;
  const disponivelFloored = estoqueDisponivel({ quantidade, quantidadeReservada });

  const { kind, soma, nSemMovimento } = classificar(historico, quantidadeReservada);

  return {
    estoquePath,
    kind,
    quantidade,
    quantidadeReservada,
    disponivelIngenuo,
    disponivelFloored,
    unidadesInventadas: disponivelIngenuo - disponivelFloored,
    parentId: stringOuNull(estoque.parentId),
    depositoOuterRef: stringOuNull(estoque.depositoOuterRef),
    ultimaModificacao: numeroOuNull(estoque.ultimaModificacao),
    somaMovimentoReservada: soma,
    nLinhas: historico.length,
    nSemMovimentoReservada: nSemMovimento,
    ultimasLinhas: maisRecentesPrimeiro(historico).slice(0, MAX_LINHAS_NO_RELATORIO),
  };
}
