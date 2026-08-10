import { parseRef, toOuterRefOrNull } from '@delfrance/schemas';

/**
 * Pure decisions for the `integracoesComProduto` reconcile + the
 * `variacaoMercadoLivre.contaOuterRef` backfill (#920). No Firestore here — the
 * IO lives in `migrate.ts`.
 *
 * ⚠️ The single rule that makes this migration safe: **`integracoesComProduto`
 * is not a Mercado Livre field.** The legacy Amazon code writes it too
 * (`.old/lib/canaisDeVenda/amazon/pages/importarProdutos.dart:1191`,
 * `.old/packages/canais_de_venda/amazon/lib/functions.dart:148`) and Amazon's
 * periodic stock sender READS it
 * (`estoqueAmazonPeriodic.dart:49`). So this never rebuilds the array from the
 * ML links — it reconciles only the ids that resolve to an ML conta and passes
 * every other id through untouched. A wholesale rebuild would silently delete
 * Amazon's entries and stop its stock sync with nothing in the logs.
 */

/**
 * Every id in a stored array field, strings only, first occurrence kept.
 *
 * The `Set` is the membership test, not the output: insertion order has to
 * survive so {@link planIntegracoesComProduto}'s diff reads as a minimal edit
 * rather than a reshuffle. A scan-the-output-array check would be O(n²), and
 * this runs once per scanned produto (~19k on production).
 */
export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const e of v) {
    if (typeof e !== 'string' || e.length === 0 || vistos.has(e)) continue;
    vistos.add(e);
    out.push(e);
  }
  return out;
}

/**
 * The integração doc id a stored `contaOuterRef` points at, or `null`.
 *
 * Same acceptance as the trigger's `contaIdFromRef` and built on the same
 * primitives (`toOuterRefOrNull` + `parseRef`), so the two cannot drift on ref
 * parsing: both stored forms — canonical `documents/integracao/<id>` and bare
 * `integracao/<id>` — resolve, anything else is `null`.
 */
export function contaIdFromRef(raw: unknown): string | null {
  const ref = toOuterRefOrNull(raw);
  if (ref == null) return null;
  const { collection, id } = parseRef(ref);
  if (collection !== 'integracao' || id.length === 0) return null;
  return id;
}

/**
 * The reconcile for ONE produto.
 *
 * - `armazenado` — the stored `integracoesComProduto`.
 * - `contasMl` — every integração doc id whose `tipo` is Mercado Livre. Ids
 *   outside this set are other channels' and are never touched.
 * - `derivadas` — the ML contas this produto's links actually justify.
 *
 * Returns `null` when nothing changes, so a re-run writes nothing — the
 * idempotence the runbook's second pass checks for.
 *
 * ⚠️ `from` is the NORMALIZED view of the stored array (non-strings dropped,
 * duplicates collapsed), not its raw contents, and the comparison is made
 * against that view. So a doc whose only anomaly is a repeated id is reported as
 * unchanged and left alone: a duplicate is inert for `arrayContains`, and
 * rewriting thousands of produtos for it inside a cutover window would spend the
 * budget on cosmetics.
 */
export function planIntegracoesComProduto(
  armazenado: unknown,
  contasMl: ReadonlySet<string>,
  derivadas: ReadonlySet<string>,
): { from: string[]; to: string[] } | null {
  const from = asStringArray(armazenado);

  // Drop only ML ids with no surviving link; keep every foreign id, and keep
  // the original ordering so the diff in the log reads as a minimal edit.
  const to = from.filter((id) => !contasMl.has(id) || derivadas.has(id));

  // Sorted, so a re-run of the same data produces byte-identical output.
  for (const id of [...derivadas].sort()) if (!to.includes(id)) to.push(id);

  if (to.length === from.length && to.every((id, i) => id === from[i])) return null;
  return { from, to };
}

/**
 * The `contaOuterRef` backfill for ONE `variacaoMercadoLivre` doc.
 *
 * Returns the canonical ref to write, or `null` to skip — either because the
 * doc already carries one, or because the parent link it points at is gone and
 * the conta is therefore unknowable. Never guesses: an unresolvable row is left
 * exactly as it is, and `onVariacaoMercadoLivreLinkChanged` keeps using its
 * fallback hop for it.
 */
export function planContaOuterRefBackfill(
  armazenado: unknown,
  contaRefDoPai: string | null,
): string | null {
  if (typeof armazenado === 'string' && armazenado.length > 0) return null;
  if (contaRefDoPai == null) return null;
  return toOuterRefOrNull(contaRefDoPai);
}

/**
 * Strip a leading `documents/` so a stored outer-ref and a live
 * `snapshot.ref.path` can be compared as the same key.
 */
export function normalizarCaminho(raw: string): string {
  return raw.startsWith('documents/') ? raw.slice('documents/'.length) : raw;
}
