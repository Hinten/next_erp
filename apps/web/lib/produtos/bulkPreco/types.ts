import type { PrecosMap } from '@delfrance/schemas';

/**
 * One computed row of the bulk price-recalculation table (#544) — port of the
 * Flutter `PrecoAlterado` (`.old/lib/canaisDeVenda/pages/recalcularPrecos.dart:381-397`).
 * `precoAtual` is the produto's existing price under the target lista (`null`
 * when it has none there yet); `precoNovo` is the freshly computed price
 * (`null` when the cost/weight resolution or the formula engine itself
 * couldn't produce one — `erro` then explains why).
 */
export interface PrecoAlteracao {
  produtoId: string;
  sku: string | null;
  nome: string;
  custo: number | null;
  precoAtual: number | null;
  precoNovo: number | null;
  erro: string | null;
  /**
   * Flags a computed price that falls outside a configured min/max band.
   * Consumed by the sibling PR #545 (limit guardrails) — this PR never sets
   * it, so it stays optional/undefined on every row it produces.
   */
  foraDosLimites?: boolean;
  /** The produto's CURRENT `precos` map, untouched — carried through so the
   * apply step can diff/merge without a second Firestore read. */
  precos: PrecosMap;
}

/** Streaming progress while the catalog loads, page by page. */
export interface LoadProgress {
  /** Rows streamed in so far. */
  carregados: number;
  /** Server-side total (from `countParentProdutos`), or `null` before it resolves. */
  total: number | null;
}

/** Streaming progress while the batched apply runs. */
export interface ApplyProgress {
  done: number;
  total: number;
  sucesso: number;
  erro: number;
}

/**
 * Per-produto apply outcome — mirrors the Dart accounting in
 * `aplicarAlteracoesStream` (`recalcularPrecos.dart:581-681`): a row can be
 * written (`aplicado`), left alone because the chosen mode (aumentar/diminuir)
 * doesn't apply to it (`semAlteracao`/`pulado` distinguish "no diff to begin
 * with" from "diff existed but the mode skipped it"), or fail (`erro`).
 */
export type ApplyStatus = 'aplicado' | 'semAlteracao' | 'pulado' | 'erro';

/** One row's outcome from the apply step. */
export interface ApplyOutcome {
  produtoId: string;
  status: ApplyStatus;
  erro: string | null;
}
