/**
 * Where a produto's links of a conta can sit, pure (step 13, PR 13-b): the two
 * helpers every reader of a link PARTITION uses, written once. The manual
 * selection (`selecaoManual.ts`) and the stock window's planner
 * (`estoque/descobertaEstoque.ts`, which keeps the stock names) both call them.
 *
 * - {@link sondasDoProduto} names the produtos whose link partition
 *   (`produtos/<id>/prodAmazon`) can list a SKU for a produto: itself, and its
 *   parent when its `paiId` names one (a family-of-one wrapper's link sits on
 *   the wrapper, while its member is the produto that moves).
 * - {@link skusDaConta} keeps the link docs of ONE conta, in both stored ref
 *   forms of the conta (`contaRefForms`, the order import's own pair),
 *   compared EXACTLY, and answers their SKUs.
 *
 * PURE: no Firestore, no clock, no network.
 */
import { contaRefForms } from '@delfrance/data/admin/produtos';
import { CONTA_ID_AMAZON_REGEX, naoDocId } from '@delfrance/schemas';

/** Code-unit order, never a locale's. */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The produtos whose link partition can hold a SKU for `produtoId` (module
 * header): itself, then its parent when `paiId` names one. `raw` is the
 * produto's document, or `null` when it is gone (then only itself).
 *
 * @throws {RangeError} `produtoId` is not a document id.
 */
export function sondasDoProduto(
  produtoId: string,
  raw: Readonly<Record<string, unknown>> | null,
): readonly string[] {
  if (naoDocId(produtoId)) {
    throw new RangeError('sondasVinculos.ts: produtoId não é um id de documento');
  }
  const paiId = raw?.paiId;
  if (typeof paiId === 'string' && !naoDocId(paiId) && paiId !== produtoId) {
    return [produtoId, paiId];
  }
  return [produtoId];
}

/**
 * The SKUs of ONE conta among the link docs of one partition listing (module
 * header): a doc whose `contaAmazonOuterRef` is EXACTLY one of the conta's two
 * stored forms, with a non-empty string `sku`. Distinct, code-unit sorted.
 *
 * @throws {RangeError} `contaId` outside the conta id grammar.
 */
export function skusDaConta(
  links: readonly Readonly<Record<string, unknown>>[],
  contaId: string,
): readonly string[] {
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('sondasVinculos.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
  const formas: readonly string[] = contaRefForms(contaId);
  const skus = new Set<string>();
  for (const link of links) {
    const ref = link.contaAmazonOuterRef;
    const sku = link.sku;
    if (typeof ref !== 'string' || !formas.includes(ref)) continue;
    if (typeof sku !== 'string' || sku === '') continue;
    skus.add(sku);
  }
  return [...skus].sort(compararTexto);
}
