/**
 * The ERP `Categoria` chain of a Shopee listing (#1517, step 9) — the per-dispatch
 * tree memo, and the create-if-absent applier.
 *
 * ## ⚠️ No per-item API call
 *
 * Step 10 already caches the whole `get_category` tree behind a TTL, indexed
 * once per window ({@link lerIndiceDeCategorias}), and `caminhoDaCategoria`
 * walks it in memory — ROOT-FIRST, cycle-safe, capped, and truncating at the
 * ROOT end so the requested node is always last. That is strictly better than
 * Mercado Livre's one category call per import, which is itself already better
 * than the legacy's one call per ANCESTOR.
 *
 * ## ⚠️ The document id is PREFIXED — `categorias/shopee-<category_id>`
 *
 * and the reason is the OPPOSITE of Mercado Livre's. ML uses the bare `MLB…` id
 * for legacy-id convergence: the Flutter app wrote the same document id, so a
 * migrated doc and an imported one are the same doc. There is **no legacy Shopee
 * categoria corpus at all** — the Flutter provider walked `parent_category_id`
 * in memory and never created a `Categoria` document — so that argument does not
 * transfer, and three things push the other way: `categorias` is a GLOBAL ERP
 * namespace shared with ML ids and operator-created documents; a bare integer is
 * the one id shape an operator could plausibly type by hand; and provenance
 * becomes readable in the console and in every `categoriaPaiOuterRef`.
 *
 * ⚠️ It does NOT solve the per-shop tree question: two BR shops served different
 * trees would still collide on one document. That is UNVERIFIED and on the
 * register; the prefix is one constant away from any other scheme.
 *
 * ## ⚠️ Create-if-absent ONLY
 *
 * `docRef.create()` with `ALREADY_EXISTS` swallowed. An existing categoria —
 * Flutter-written, ERP-curated, or from an earlier import — is NEVER overwritten
 * by an import. An unknown category id yields an EMPTY chain: nothing is
 * created, nothing is linked, nothing fails, and one log line says so.
 *
 * Next-free, clock-free: `nowMs` arrives on the plan.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ShopeeCategoria, ShopeeClient } from '@delfrance/integrations-shopee';
import { SHOPEE_GET_VARIATIONS_PATH } from '@delfrance/integrations-shopee';
import { isAlreadyExists } from '@delfrance/data/admin';
import { categoriaCollection } from '@delfrance/data/admin/collections';

import { lerIndiceDeCategorias } from '../taxonomia/cache';
import { caminhoDaCategoria, type ShopeeCategoriaIndice } from '../taxonomia/categorias';
import type { MemoDeCategorias } from './itemLido';
import type { CategoriaParaCriar } from './planoImportacao';

/**
 * Build the per-dispatch category-tree memo.
 *
 * ⚠️ `variationsPath` is a CONSTANT here, and it is honest rather than lazy:
 * the field only ever selects which path `get_variations` is signed with, and
 * `lerIndiceDeCategorias` calls `get_category`. The cache key is the
 * `integracaoId` alone, so this object shares the TTL window with the taxonomy
 * routes rather than re-reading the tree for the import.
 *
 * ⚠️ Single-flight for the same reason the grupo memo is: the PROMISE is
 * memoised, not the result, so two items asking before the first read resolves
 * do not each issue one.
 *
 * ⚠️ **A REJECTION is not memoised, and that asymmetry is the whole cost of
 * memoising a promise.** Holding a rejected one would make every later
 * `carregar()` of the dispatch re-await the SAME failure — and a category read
 * that fails is contained PER ITEM (a `ShopeeApiError` reaches
 * `classificarFalhaDeItem` as `erro-shopee`), so one blip on the first item
 * that asks would turn every remaining item of the dispatch — up to
 * `ITENS_POR_DESPACHO_SEM_FOTOS` of them — into a `failures[]` row for a read
 * nobody ever retried, while the next dispatch's fresh memo imports them fine.
 * So the slot is cleared when the read rejects and the NEXT item re-reads.
 *
 * ⚠️ The first caller still SEES that rejection — the clearing re-throws, so the
 * item that paid for the read is the item that fails — and so do the concurrent
 * callers that awaited the same in-flight promise: one read, one verdict, shared
 * by everyone who was waiting on it. That is single-flight working, not the
 * poisoning above, which is about callers arriving AFTER the read has settled.
 */
export function criarMemoDeCategorias(
  client: ShopeeClient,
  integracaoId: string,
): MemoDeCategorias {
  let pendente: Promise<ShopeeCategoriaIndice> | null = null;
  return {
    carregar(): Promise<ShopeeCategoriaIndice> {
      pendente ??= lerIndiceDeCategorias({
        integracaoId,
        client,
        variationsPath: SHOPEE_GET_VARIATIONS_PATH,
      }).catch((err: unknown) => {
        pendente = null;
        throw err;
      });
      return pendente;
    },
  };
}

/**
 * The ROOT-FIRST, inclusive chain for one listing's category.
 *
 * `[]` for an unknown id and `[]` when no memo was handed in — the two degrade
 * identically on purpose, because both mean "we have nothing to say about this
 * listing's category" and neither is a reason to fail an import.
 */
export async function caminhoDaCategoriaDoAnuncio(
  memo: MemoDeCategorias | undefined,
  categoryId: number | null | undefined,
): Promise<readonly ShopeeCategoria[]> {
  if (memo === undefined) {
    console.warn('[shopee/importacao] sem árvore de categorias; a categoria não será vinculada');
    return [];
  }
  if (typeof categoryId !== 'number' || categoryId === 0) return [];
  const indice = await memo.carregar();
  const caminho = caminhoDaCategoria(indice, categoryId);
  if (caminho.length === 0) {
    console.warn('[shopee/importacao] category_id desconhecido na árvore; nada a vincular', {
      categoryId,
    });
  }
  return caminho;
}

/**
 * Create the chain's missing documents, root→leaf.
 *
 * ⚠️ The ORDER is load-bearing: a child's `categoriaPaiOuterRef` must point at a
 * document that already exists, so the root goes first.
 */
export async function aplicarCategoriasShopee(
  db: Firestore,
  categorias: readonly CategoriaParaCriar[],
): Promise<void> {
  for (const categoria of categorias) {
    try {
      await categoriaCollection
        .docRef(db, {}, categoria.docId)
        .create(categoriaCollection.parse(categoria.data));
    } catch (err) {
      // An existing categoria — from either app — is never overwritten.
      if (isAlreadyExists(err)) continue;
      throw err;
    }
  }
}
