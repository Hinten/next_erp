/**
 * The variation CHILDREN of a Shopee listing, WRITTEN (#1517, step 9), and the
 * `filhoUnicoId` repair that closes the same unit of work.
 *
 * ## ⚠️ The per-child order is the parent's order, one level down
 *
 * price patch → produto → estoque → link. The guarded price patch goes first for
 * the same reason it does on the parent (the merge bumps `updateTime`), and the
 * link goes last because it is the only write that needs the parent link's id.
 *
 * ## ⚠️ `filhoUnicoId` runs AFTER the child set is final, in the same unit
 *
 * `familia.ts` states the rule: every writer that changes a produto's child set
 * derives this pointer in the SAME batch as the change. It is a denormalisation
 * with no trigger keeping it honest, so an import that adds a second child and
 * leaves the pointer naming the first would make `unidadeVendavel` bind an order
 * line to the wrong produto.
 *
 * Three properties, each deliberate:
 *
 *  - `limit(2)` is enough, because `derivarFilhoUnico` answers `null` for
 *    anything but exactly one. (The `limit(3)` rule elsewhere is about probing
 *    for a family of one BY SKU — a different query.)
 *  - an UNCHANGED pointer costs no write. This runs on every import of every
 *    produto that owns children.
 *  - a lost precondition re-runs the **DERIVATION**, not the write. Re-writing
 *    the same value would land exactly the stale pointer this exists to prevent.
 *    A second loss SKIPS the repair with a warn: leaving the pointer as it is
 *    self-heals on the next import, and killing a complete import over a
 *    denormalisation is the worse trade.
 *  - it runs when the LISTING has models **or** when the ERP produto already
 *    owns children — never the first alone, because that would skip exactly the
 *    listing that LOST its variations, whose pointer most needs re-deriving.
 *
 * ## ⚠️ A one-model listing gets NO `-UN` suffix
 *
 * The child's `sku` is `model_sku` verbatim; that rule and its reasons live in
 * the pure mapper, which is the only thing that authors a sku. Nothing here
 * derives one.
 *
 * Next-free, clock-free.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { derivarFilhoUnico } from '@delfrance/schemas';
import { isAlreadyExists, isFailedPrecondition } from '@delfrance/data/admin';
import { produtoCollection } from '@delfrance/data/admin/collections';

import { aplicarEstoqueShopee, aplicarPrecosShopee } from './estoquePrecos';
import { aplicarLinkDaVariacao } from './links';
import type { PlanoFilhoShopee } from './planoImportacao';

/** What one child's writes produced. */
export interface ResultadoDoFilho {
  readonly produtoId: string;
  readonly criado: boolean;
}

/**
 * Write ONE child, in the plan's own internal order.
 *
 * ⚠️ `produtoId` is a PARAMETER and not read off `filho.produto`: a
 * byte-identical re-import plans NO produto write at all (the patch would carry
 * only `ultimaModificacao`), and the link merge still has to land under the
 * right document. The caller takes it from `plano.filhoUnico.idsPlanejados[i]`,
 * which the planner pushes in the same loop iteration as `plano.filhos[i]`, so
 * the two are index-aligned by construction rather than by convention.
 *
 * `linkPaiId` is the document id the parent link now lives at — known only after
 * the parent link was written, which is why the parent link precedes the whole
 * child loop.
 */
export async function aplicarFilhoShopee(
  db: Firestore,
  filho: PlanoFilhoShopee,
  produtoId: string,
  paiProdutoId: string,
  linkPaiId: string,
): Promise<ResultadoDoFilho> {
  const escrita = filho.produto;
  let criado = false;

  if (escrita !== null) {
    const ref = produtoCollection.docRef(db, {}, produtoId);
    if (escrita.criar) {
      try {
        // `.create()` and not `.set()`: a concurrent create of the same child
        // must not full-overwrite the winner's document.
        await ref.create(produtoCollection.parse(escrita.data));
        criado = true;
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        // Someone created it between the cascade and now — merge onto theirs
        // rather than claiming a create that did not happen.
        await produtoCollection.merge(db, {}, produtoId, escrita.data);
      }
    } else {
      // The guarded price patch, against the snapshot it was derived from, and
      // BEFORE the merge that would bump that very stamp.
      const snap = await ref.get();
      await aplicarPrecosShopee(db, filho.precos, snap.updateTime);
      await produtoCollection.merge(db, {}, produtoId, escrita.data);
    }
  } else if (filho.precos !== null) {
    const snap = await produtoCollection.docRef(db, {}, produtoId).get();
    await aplicarPrecosShopee(db, filho.precos, snap.updateTime);
  }

  await aplicarEstoqueShopee(db, filho.estoque);
  if (filho.link !== null) {
    await aplicarLinkDaVariacao(db, produtoId, filho.link, paiProdutoId, linkPaiId);
  }
  return { produtoId, criado };
}

/**
 * Re-derive and stamp the parent's `filhoUnicoId`.
 *
 * ⚠️ `tentativas` counts the retries LEFT, and the retry re-enters the whole
 * function — the read, the derivation and the write — so it sees the sibling
 * that invalidated us.
 */
export async function aplicarFilhoUnicoShopee(
  db: Firestore,
  paiProdutoId: string,
  nowMs: number,
  tentativas = 1,
): Promise<void> {
  const ref = produtoCollection.docRef(db, {}, paiProdutoId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const filhos = await produtoCollection
    .ref(db, {})
    .where('paiId', '==', paiProdutoId)
    .limit(2)
    .get();
  const filhoUnicoId = derivarFilhoUnico(filhos.docs.map((d) => ({ id: d.id })));

  const armazenado = ((snap.data() ?? {}) as { filhoUnicoId?: unknown }).filhoUnicoId ?? null;
  if (armazenado === filhoUnicoId) return;

  const lastUpdateTime = snap.updateTime;
  try {
    const patch = { filhoUnicoId, ultimaModificacao: nowMs };
    await (lastUpdateTime !== undefined
      ? ref.update(patch, { lastUpdateTime: lastUpdateTime as Timestamp })
      : ref.update(patch));
  } catch (err) {
    if (!isFailedPrecondition(err)) throw err;
    if (tentativas > 0) {
      await aplicarFilhoUnicoShopee(db, paiProdutoId, nowMs, tentativas - 1);
      return;
    }
    console.warn('[shopee/importacao] ponteiro do membro único ignorado (produto alterado)', {
      produtoId: paiProdutoId,
    });
  }
}
