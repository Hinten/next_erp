/**
 * The ERP reads of ONE price send run (master plan step 13, PR 13-d) — every Firestore read the
 * run makes before it decides, each the cheapest that answers its question. Next-free, `db` a
 * parameter, every access through a `@delfrance/data/admin/collections` handle. Enterprise bills
 * DATA SCANNED (root `CLAUDE.md` rule 1): every read here is a point read, a where-less listing of
 * the produto's own partition, or the stock flow's duplicate probe on its declared index. No new
 * index.
 *
 * | read | shape | served by |
 * | --- | --- | --- |
 * | the produto | `getAll` of ONE ref, masked to {@link CAMPOS_PRODUTO_PRECO_LI} | a point read |
 * | its own links | where-less listing of `produtos/{p}/produtolojaintegrada` (the stock reader's) | the produto's own partition, no index |
 * | its parent | the same masked point read — only AFTER the link verdict, and only for a parent id {@link paiParaLerPrecoLi} accepts | a point read |
 * | the duplicate-link probe | the stock reader's: GROUP `contaLojaIntegrada == form`, `id in [n, 'n']`, per stored form of the conta ref | COLLECTION_GROUP `produtolojaintegrada (contaLojaIntegrada, id)` |
 *
 * ## The mask is exactly what the price function reads
 *
 * `precoAlvoLi` (`@delfrance/schemas`) reads `paiId` and `precos` on the produto, and `precos` and
 * `propagatePriceToChildren` on its parent — nothing else. So one mask serves both reads, and it
 * holds NO custo: the ERP custo is never sent (the send repeats the store's own), and a field never
 * read can never leak into a body. Kits are ordinary store products for the price: no
 * `componentesKit`.
 *
 * ## A parent ref is never built from a raw `paiId`
 *
 * The parent to read is `paiDoProdutoErp`'s answer AND an id `idDocumentoEstoqueLiSchema`
 * accepts. A child whose parent id names no document (`a/b`, `.`, `__x__`) costs no read at all:
 * `precoAlvoLi` holds it as `pai-ausente` without needing the parent.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  type ProdutoPrecoLi,
  idDocumentoEstoqueLiSchema,
  paiDoProdutoErp,
} from '@delfrance/schemas';

/**
 * The stock flow's readers, the SAME functions (one copy; their index pins live in
 * `estoque/leituraEstoqueErp.test.ts`): the where-less own-links listing and the duplicate probe.
 */
export { lerVinculosDoProdutoLi, sondarVinculoDuplicadoLi } from '../estoque/leituraEstoqueErp';

/**
 * The produto fields the price run reads — exactly what `precoAlvoLi` reads, on the produto
 * (`paiId`, `precos`) and on its parent (`precos`, `propagatePriceToChildren`). NO custo. One
 * mask for both reads (module header).
 */
export const CAMPOS_PRODUTO_PRECO_LI = ['paiId', 'precos', 'propagatePriceToChildren'] as const;

/**
 * ONE masked `getAll` of one produto ⇒ `{ id, dados }` (the masked fields the snapshot holds as
 * its own keys), or `null` when the document does not exist.
 */
export async function lerProdutoPrecoLi(
  db: Firestore,
  produtoId: string,
): Promise<ProdutoPrecoLi | null> {
  const [snap] = await db.getAll(produtoCollection.docRef(db, {}, produtoId), {
    fieldMask: [...CAMPOS_PRODUTO_PRECO_LI],
  });
  if (snap === undefined || !snap.exists) return null;
  const bruto: Readonly<Record<string, unknown>> = snap.data() ?? {};
  const dados: Record<string, unknown> = {};
  for (const campo of CAMPOS_PRODUTO_PRECO_LI) {
    if (Object.hasOwn(bruto, campo)) dados[campo] = bruto[campo];
  }
  return { id: produtoId, dados };
}

/**
 * The parent to READ (module header): `paiDoProdutoErp(dados, id)` when it names one AND
 * `idDocumentoEstoqueLiSchema` accepts it; otherwise `null` — a root (no `paiId`, `''`, a
 * self-parent, another shape), or a parent id that names no document — with no read.
 */
export function paiParaLerPrecoLi(produto: ProdutoPrecoLi): string | null {
  const paiId = paiDoProdutoErp(produto.dados, produto.id);
  if (paiId === null) return null;
  return idDocumentoEstoqueLiSchema.safeParse(paiId).success ? paiId : null;
}
