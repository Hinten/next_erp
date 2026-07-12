import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { produtoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * Cascade a produto delete server-side (parent OR variation child):
 *
 *  1. **Subcollection orphans (#136).** `recursiveDelete` on the produto's OWN
 *     document ref deletes the (already-gone) doc plus its ENTIRE descendant
 *     subtree — every subcollection Firestore would otherwise orphan (`estoques`
 *     + `historicoEstoque`, `imposto`, `historicoDePrecos`, `historicoDeCusto`,
 *     `extraData`, and the marketplace links `produtomercadolivre` / `variacoesml`
 *     / `produtoshopee` / …). No name enumeration; new subcollections are swept
 *     automatically. `recursiveDelete` walks subcollections regardless of whether
 *     the parent doc still exists, so it reclaims the orphans.
 *  2. **Variation children (#199).** Children are SIBLING top-level docs
 *     (`produtos where paiId == deletedId`), not descendants, so the sweep above
 *     does not touch them. Each is deleted via its own `recursiveDelete` so its
 *     subtree goes too — cleanup never depends on recursive trigger re-delivery.
 *     Variations are one level deep (children have no children), so the child
 *     delete re-fires this trigger as an idempotent no-op. The per-child
 *     `recursiveDelete`s run in BOUNDED-concurrency batches so a parent with many
 *     variations doesn't serialize into a long-running (timeout-prone) call nor
 *     fan out unboundedly (each `recursiveDelete` is itself a BulkWriter).
 *  3. **Inbound kit references (#135/#475).** Other produtos may list the deleted
 *     produto as a KIT COMPONENT (`componentesKit[deletedId]`, denormalized into
 *     the `componentesKitKeys` array-contains index). Neither sweep above touches
 *     those OTHER documents, so remove the deleted id from every referencing kit,
 *     keeping the map and its index array in sync. A kit left with no components
 *     is no longer a kit — null both fields and clear `ehKit` (legacy empty-kit
 *     rule, `.old` `produtoTableProvider.dart`).
 *
 * The client `deleteProdutoCascade` now only deletes the parent doc — this trigger
 * is the authoritative cascade, with no dependency on the client/e2e cleanup.
 * Idempotent (Flutter still cascades on its own deletes). Targets the NAMED
 * `default` database (gotcha #8).
 */

/** How many child-subtree `recursiveDelete`s run at once (bounded fan-out). */
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
 * and `componentesKitKeys` are nulled and `ehKit` cleared to `false`.
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
      const remainingKeys = Object.keys(componentes);

      if (remainingKeys.length === 0) {
        // Legacy empty-kit rule: an emptied kit stops being a kit.
        batch.update(snap.ref, { componentesKit: null, componentesKitKeys: null, ehKit: false });
      } else {
        batch.update(snap.ref, { componentesKit: componentes, componentesKitKeys: remainingKeys });
      }
    }
    await batch.commit();
  }
}

export async function cascadeProdutoDeletion(db: Firestore, produtoId: string): Promise<void> {
  // #136 — the produto's own subtree (all subcollections) in one BulkWriter walk.
  await db.recursiveDelete(produtoCollection.docRef(db, {}, produtoId));

  // #199 — variation children (top-level produtos pointing back via `paiId`).
  const children = await produtoCollection
    .ref(db, {})
    .where('paiId', '==', produtoId)
    .select()
    .get();
  const childRefs = children.docs.map((child) => child.ref).filter((ref) => ref.id !== produtoId); // defensive: never recurse on self
  for (let i = 0; i < childRefs.length; i += CHILD_DELETE_CONCURRENCY) {
    const slice = childRefs.slice(i, i + CHILD_DELETE_CONCURRENCY);
    await Promise.all(slice.map((ref) => db.recursiveDelete(ref)));
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
    await cascadeProdutoDeletion(getDb(), produtoId);
    logger.info(
      `onProdutoDeleted: ${produtoId} → subtree + variation children + inbound kit refs cascaded`,
    );
  },
);
