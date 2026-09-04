import {
  impostoProdutoSchema,
  operacaoIdFromImpostoRef,
  type ImpostoProduto,
} from '@delfrance/schemas';

/**
 * How the produto form's transient `impostos` array is built from the operação
 * list plus the produto's saved `imposto` subcollection.
 *
 * Extracted from `ImpostoManager`'s seeding effect so a SECOND caller can seed
 * the same array: the Modificações tab's "Restaurar" stages an imposto revert
 * into the form, and on a produto whose Impostos tab was never opened that
 * field is still `null` (the tab seeds lazily, and an unvisited tab's effects
 * do not run — see `SectionTabs`). Building the rows there by hand would let
 * the two shapes drift, and a partial array is worse than none: `ImpostoManager`
 * skips its own seed once the value is non-null, so the operações missing from
 * it would render blank and be written back empty on save.
 */

/**
 * Operações are few (fiscal operations) and a produto's imposto docs are one
 * per operação, so both loads are bounded. Shared so the tab's live queries and
 * the revert's one-shot reads can never scope differently.
 */
export const OPERACAO_LIMIT = 200;
export const IMPOSTO_LIMIT = 200;

/** One active operação, as both the picker and the row builder need it. */
export interface OperacaoRow {
  id: string;
  nome: string;
  padrao: boolean;
}

/** A blank imposto entry scoped to one operação (Flutter typo wire key). */
export function emptyImposto(operacaoId: string): ImpostoProduto {
  return impostoProdutoSchema.parse({ impostoOpercaoOuterRef: `operacao/${operacaoId}` });
}

/**
 * The active operações, in the order the query returned them (`nome`).
 * `ativo` is filtered client-side — the collection is small and bounded.
 */
export function operacoesAtivas(
  docs: ReadonlyArray<{ id: string; data: { nome: string; ativo?: boolean; padrao?: boolean } }>,
): OperacaoRow[] {
  return docs
    .filter((o) => o.data.ativo !== false)
    .map((o) => ({ id: o.id, nome: o.data.nome, padrao: o.data.padrao === true }));
}

/**
 * One row per active operação, merged with its saved imposto doc where there is
 * one and a blank entry where there is not.
 *
 * A null-scoped (default-fallback) imposto is skipped: it is not a per-operação
 * entry, so leaving it out of the form keeps it untouched on save rather than
 * rewriting its scope to a fake `operacao/<docId>`.
 */
export function montarLinhasImposto(
  operacoes: readonly OperacaoRow[],
  impostoDocs: ReadonlyArray<{ id: string; data: ImpostoProduto }>,
): ImpostoProduto[] {
  const byOperacao = new Map<string, ImpostoProduto>();
  for (const d of impostoDocs) {
    const opId = operacaoIdFromImpostoRef(d.data.impostoOpercaoOuterRef);
    if (!opId) continue;
    byOperacao.set(opId, { ...d.data, id: d.id, impostoOpercaoOuterRef: `operacao/${opId}` });
  }
  return operacoes.map((op) => byOperacao.get(op.id) ?? emptyImposto(op.id));
}
