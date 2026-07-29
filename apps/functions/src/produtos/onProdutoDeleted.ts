import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { produtoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * Cascade a produto delete server-side (parent OR variation child):
 *
 *  1. **Subcollection orphans (#136).** `deleteDocumentSubtree` on the produto's
 *     OWN document ref deletes the (already-gone) doc plus its ENTIRE descendant
 *     subtree — all 14 subcollections Firestore would otherwise orphan:
 *     `estoques` (+ the nested `historicoEstoque`), `imposto`, `extraData`,
 *     `historicoDePrecos`, `historicoDeCusto`, `historicoDeModificacoes`, and the
 *     seven marketplace links `produtoMercadoLivre` / `variacaoMercadoLivre` /
 *     `prodshopee` / `variashopee` / `produtoMagalu2` / `prodAmazon` /
 *     `produtolojaintegrada`. No name enumeration — the walk asks
 *     `listCollections()`, so anything Flutter writes under a produto is swept
 *     too, including subcollections this repo never registered. It reaches
 *     subcollections regardless of whether the parent doc still exists, which is
 *     the orphan case a delete trigger always sees.
 *
 *     ⚠️ NOT `db.recursiveDelete` (#728). That issued a kindless all-descendants
 *     query per call — `COLLECTION_GROUP * SELECT __name__ LIMIT 5000` — which on
 *     Firestore Enterprise rides no index and cannot be given one. Measured at
 *     ~6,184 documents scanned per call, 9,234 calls in 7 days = 57.1M documents,
 *     93% of the staging project's read volume, and the same cost whether the
 *     produto had fifty subcollection docs or none.
 *  2. **Variation children (#199).** Children are SIBLING top-level docs
 *     (`produtos where paiId == deletedId`), not descendants, so the sweep above
 *     does not touch them. Each is deleted with its own subtree walk — cleanup
 *     never depends on recursive trigger re-delivery. They run in
 *     BOUNDED-concurrency batches so a parent with many variations doesn't
 *     serialize into a timeout-prone call nor fan out unboundedly, and they share
 *     ONE `BulkWriter`: a per-call writer makes each call await every other
 *     call's queued writes.
 *
 *     The child delete re-fires this trigger. Variations are one level deep
 *     (children have no children of their own), so that re-entry passes the
 *     child's `paiId` and **skips the children query entirely** — see
 *     `CascadeProdutoOptions`. Before #728 the re-entry re-ran the whole body;
 *     the observed 9,234/4,655 = 1.983 ratio between the two query shapes is
 *     exactly `(2N+1)/(N+1)`, which is how the re-fire was confirmed to be real.
 *  3. **Inbound kit references (#135/#475).** Other produtos may list the deleted
 *     produto as a KIT COMPONENT (`componentesKit[deletedId]`, denormalized into
 *     the `componentesKitKeys` array-contains index). Neither sweep above touches
 *     those OTHER documents, so remove the deleted id from every referencing kit,
 *     keeping the map and its index array in sync. A kit left with no components
 *     is no longer a kit — null both fields and clear `ehKit` AND `ehKitVirtual`
 *     (legacy empty-kit rule, `.old` `produtoTableProvider.dart`; the
 *     `ehKit === false ⇒ ehKitVirtual === false` invariant is the same one
 *     `buildKitStatusChildOps` enforces).
 *
 * The client `deleteProdutoCascade` now only deletes the parent doc — this trigger
 * is the authoritative cascade, with no dependency on the client/e2e cleanup.
 * Idempotent (Flutter still cascades on its own deletes). Targets the NAMED
 * `default` database (gotcha #8).
 */

/** How many child-subtree walks run at once (bounded fan-out). */
const CHILD_DELETE_CONCURRENCY = 5;

/** Max writes per Firestore `WriteBatch` is 500; stay under it for the kit sweep. */
const KIT_CLEANUP_BATCH_SIZE = 400;

/**
 * Remove `produtoId` from every OTHER produto's `componentesKit` map (and the
 * `componentesKitKeys` denorm array) that references it as a kit component (#475).
 *
 * `componentesKitKeys` is the array-contains index of the map's keys, so the
 * `array-contains` query finds exactly the referencing kits. For each, both fields
 * are rewritten together (never one without the other): `componentesKitKeys` is
 * re-derived from the surviving map keys — self-healing any prior drift, mirroring
 * the legacy `clean()`. If no component remains, the kit is emptied: `componentesKit`
 * and `componentesKitKeys` are nulled and `ehKit`/`ehKitVirtual` cleared to `false`.
 */
async function cleanupInboundKitReferences(db: Firestore, produtoId: string): Promise<void> {
  // `produtoCollection.ref` is a raw (converter-free) ref, so reads/writes here
  // touch stored fields directly without a full-schema parse of unrelated produtos.
  const referencing = await produtoCollection
    .ref(db, {})
    .where('componentesKitKeys', 'array-contains', produtoId)
    .get();

  // Never rewrite the doc being deleted (a kit can't list itself, but be defensive).
  const docs = referencing.docs.filter((snap) => snap.id !== produtoId);

  for (let i = 0; i < docs.length; i += KIT_CLEANUP_BATCH_SIZE) {
    const batch = db.batch();
    for (const snap of docs.slice(i, i + KIT_CLEANUP_BATCH_SIZE)) {
      const componentes = { ...((snap.get('componentesKit') as Record<string, unknown>) ?? {}) };
      delete componentes[produtoId];
      // Sorted to match the denorm convention the write paths use
      // (`editar`/`novo` pages, `usecases.ts`) — keeps the array order-stable so a
      // later web edit doesn't see spurious churn / dirty-detection noise.
      const remainingKeys = Object.keys(componentes).sort();

      if (remainingKeys.length === 0) {
        // Legacy empty-kit rule: an emptied kit stops being a kit. `ehKitVirtual`
        // collapses with `ehKit` (invariant: a non-kit can't be a virtual kit).
        batch.update(snap.ref, {
          componentesKit: null,
          componentesKitKeys: null,
          ehKit: false,
          ehKitVirtual: false,
        });
      } else {
        batch.update(snap.ref, { componentesKit: componentes, componentesKitKeys: remainingKeys });
      }
    }
    await batch.commit();
  }
}

export interface CascadeProdutoOptions {
  /**
   * The deleted produto's own `paiId`, read off the trigger's deleted snapshot
   * (free — no extra read). A non-null value means this produto WAS a variation
   * child, and variations are one level deep, so it can have no children of its
   * own: the `paiId ==` query is skipped. That halves the cascade's query count
   * for a parent with variations (`2N+1` → `N+1`).
   *
   * `undefined` means "unknown" and is the safe default — the query runs. The
   * emulator suite drives the core with two arguments and relies on that.
   *
   * The inbound-kit sweep is NOT skipped: a variation child can legitimately be
   * listed as a kit component, so dropping it would be a correctness change
   * rather than an optimization.
   */
  paiId?: string | null;
}

export async function cascadeProdutoDeletion(
  db: Firestore,
  produtoId: string,
  options: CascadeProdutoOptions = {},
): Promise<void> {
  // One writer for the produto's own subtree AND every variation child's — a
  // writer per call would make each call await all the others' pending writes.
  const writer = db.bulkWriter();
  try {
    // #136 — the produto's own subtree (every subcollection `listCollections()`
    // reports), with no kindless descendant scan.
    await deleteDocumentSubtree(db, produtoCollection.docRef(db, {}, produtoId), { writer });

    // #199 — variation children (top-level produtos pointing back via `paiId`).
    // Skipped on re-entry for a child: variations are one level deep.
    if (options.paiId == null) {
      const children = await produtoCollection
        .ref(db, {})
        .where('paiId', '==', produtoId)
        .select()
        .get();
      const childRefs = children.docs
        .map((child) => child.ref)
        .filter((ref) => ref.id !== produtoId); // defensive: never recurse on self
      for (let i = 0; i < childRefs.length; i += CHILD_DELETE_CONCURRENCY) {
        const slice = childRefs.slice(i, i + CHILD_DELETE_CONCURRENCY);
        await Promise.all(slice.map((ref) => deleteDocumentSubtree(db, ref, { writer })));
      }
    }
  } finally {
    // Flushes every queued delete. In `finally` so a failed children query
    // cannot strand the subtree deletes already queued above it.
    await writer.close();
  }

  // #475 — inbound kit references on OTHER produtos.
  await cleanupInboundKitReferences(db, produtoId);
}

export const onProdutoDeleted = onDocumentDeleted(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { produtoId } = event.params;
    // The deleted snapshot is already in the event — reading `paiId` off it costs
    // nothing and tells the cascade whether this is a variation child re-entry
    // (in which case the children query is provably pointless).
    const paiId = (event.data?.get('paiId') as string | null | undefined) ?? null;
    await cascadeProdutoDeletion(getDb(), produtoId, { paiId });
    logger.info(
      `onProdutoDeleted: ${produtoId} → subtree${paiId ? '' : ' + variation children'}` +
        ' + inbound kit refs cascaded',
    );
  },
);
