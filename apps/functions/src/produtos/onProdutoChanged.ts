import type { DocumentData, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { millisToMicros, nowMicros } from '@delfrance/core/datetime';
import { produtoMeta, samePrecos, type PrecosMap } from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { resolveUsuarioOuterRef } from '../lib/authContext';
import { PRODUTO_HISTORY_ROOT } from '../lib/historyRoots';
import { buildModificationEntry, recordModification } from '../lib/modificationHistory';

/**
 * Unified produto modification history
 * (`produtos/{produtoId}/historicoDeModificacoes`) + the price propagation
 * this trigger has always owned. Replaces `onProdutoPrecoCustoChanged.ts`
 * (this PR): that trigger's `historicoDePrecos`/`historicoDeCusto` writes are
 * GONE — every produto write now gets one changed-fields entry in the new
 * subcollection instead — while parent→children precos propagation stays
 * byte-identical (owner decision, 2026-07-21). The deployed function's
 * identity is preserved via the aliased export in `index.ts`.
 */

/**
 * Fields whose churn is server/denormalization noise, never a meaningful edit
 * worth a history entry: embeddings, marketplace sync state, and the
 * `ultimaModificacao`/`timestamp` stamps every write already touches.
 */
export const PRODUTO_HISTORY_IGNORE_FIELDS: ReadonlyArray<string> = [
  'componentesKitKeys',
  'fotosArquivosIds',
  'integracoesComProduto',
  'marketplace',
  // Sibling of `marketplace` above and written by the same five stamps, but it
  // was missing here — so the one array generated history rows while the other
  // did not (#961). Both are legacy denorms with no query consumers; their churn
  // is never an operator edit.
  'marketplaceIds',
  'nome_embedding',
  'statusProdutosMarketplace',
  'timestamp',
  'ultimaModificacao',
];

/**
 * A variation child's `precos` is server-PROPAGATED from its parent (the
 * write below) — recording it here would echo that write back as a spurious
 * "child changed" entry, and on the child's own re-fire of this trigger would
 * make `campos` non-empty for a change nobody made by hand. `after` carries
 * `paiId` on every write except a delete, where only `before` is left.
 */
export function produtoExtraIgnores(
  before: DocumentData | undefined,
  after: DocumentData | undefined,
): ReadonlyArray<string> {
  return (after ?? before)?.paiId != null ? ['precos'] : [];
}

/* -------------------------------------------------------------------------- */
/*                                  I/O core                                  */
/* -------------------------------------------------------------------------- */

/** Firestore's `WriteBatch` caps at 500 ops; stay under it (mirrors
 *  `onProdutoDeleted`'s `KIT_CLEANUP_BATCH_SIZE`). */
const WRITE_CHUNK_SIZE = 450;

interface PendingWrite {
  ref: DocumentReference;
  data: DocumentData;
  mode: 'set' | 'update';
}

async function commitChunked(db: Firestore, writes: PendingWrite[]): Promise<void> {
  for (let i = 0; i < writes.length; i += WRITE_CHUNK_SIZE) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + WRITE_CHUNK_SIZE)) {
      if (write.mode === 'set') {
        batch.set(write.ref, write.data);
      } else {
        batch.update(write.ref, write.data);
      }
    }
    await batch.commit();
  }
}

/**
 * Every EXISTING variation child (`paiId == parentId`) whose `precos` map
 * differs from the parent's — server-side mirror of the removed client
 * `propagatePrecosToChildren` (`packages/data/src/produto/usecases.ts`). One
 * query, no transaction: a child edit racing this update loses (last write
 * wins), same as the client version it replaces.
 */
async function findChildrenToPropagate(
  db: Firestore,
  parentId: string,
  parentPrecos: PrecosMap,
): Promise<PendingWrite[]> {
  const snap = await produtoCollection.ref(db, {}).where('paiId', '==', parentId).get();
  const writes: PendingWrite[] = [];
  for (const doc of snap.docs) {
    if (doc.id === parentId) continue; // defensive: a produto can't be its own child
    const childPrecos = (doc.data().precos as PrecosMap) ?? null;
    if (!samePrecos(childPrecos, parentPrecos)) {
      writes.push({ ref: doc.ref, data: { precos: parentPrecos ?? null }, mode: 'update' });
    }
  }
  return writes;
}

/**
 * Record one modification-history entry for this produto write, then —
 * parent writes only, and only when `precos` actually changed and the parent
 * didn't opt out — propagate the new map to every existing variation child.
 * Exported (I/O core) for the emulator suite; the trigger below wraps it.
 *
 * A produto DELETE (`after === undefined`) writes NO entry:
 * `onProdutoDeleted`'s subtree walk sweeps everything below the produto — including
 * `historicoDeModificacoes` — so a delete-time entry would be either swept a
 * moment later or orphaned outright (owner decision, 2026-07-21).
 */
export async function recordProdutoModificationAndPropagate(
  db: Firestore,
  produtoId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  eventId: string,
  /**
   * MICROSECONDS since epoch (`microsSinceEpoch` convention) to stamp on the
   * entry — derived from the CloudEvent's `event.time`, NOT `Date.now()`: a
   * redelivered event must rewrite its deterministic doc id with IDENTICAL
   * content, and a wall-clock timestamp would differ per delivery (Copilot
   * review, PR #609).
   */
  eventTimeMicros: number,
  /**
   * Resolved acting user (`documents/usuarios/<uid>`) or `null` for an
   * Admin-SDK write. Threaded in rather than resolved here so this core stays
   * pure and drivable from the emulator suite.
   */
  usuarioOuterRef: string | null = null,
): Promise<void> {
  if (after === undefined) return; // produto delete — no entry (see doc comment)

  const entry = buildModificationEntry({
    before,
    after,
    ignore: [...PRODUTO_HISTORY_IGNORE_FIELDS, ...produtoExtraIgnores(before, after)],
    path: `produtos/${produtoId}`,
    subcolecao: null,
    docId: produtoId,
    eventId,
    eventTimeMicros,
    usuarioOuterRef,
  });
  if (entry === null) return;

  await recordModification(db, PRODUTO_HISTORY_ROOT, produtoId, entry);

  // Propagation is gated on the entry's `campos` — never on custo alone, a
  // custo edit never touches a child's precos — AND on the opt-out field.
  // `!== false` treats a missing field (every produto written before this
  // field existed) the same as the schema default `true`. Variation children
  // never reach here on their own write (their `precos` diff is suppressed by
  // `produtoExtraIgnores`, so `entry.campos` never contains it), but the
  // `paiId == null` check stays as defense-in-depth.
  const shouldPropagate =
    after.paiId == null &&
    entry.campos.includes('precos') &&
    after.propagatePriceToChildren !== false;
  const childWrites = shouldPropagate
    ? await findChildrenToPropagate(db, produtoId, (after.precos as PrecosMap) ?? null)
    : [];
  if (childWrites.length > 0) {
    await commitChunked(db, childWrites);
  }

  logger.info(
    `onProdutoChanged: ${produtoId} → entry ${entry.eventId} (${entry.campos.join(', ')}), ` +
      `${childWrites.length} filho(s) propagado(s)`,
  );
}

/* -------------------------------------------------------------------------- */
/*                                Entry point                                 */
/* -------------------------------------------------------------------------- */

/**
 * The produto modification-history + propagation trigger. Fires on EVERY
 * produto write (create/update/delete); the guards above make a delete or a
 * write that changes nothing outside the ignore list a zero-write no-op —
 * only a real change writes the entry, and only a precos change (never custo
 * alone) performs the one extra read that finds children to propagate to.
 * Targets the NAMED `default` database (gotcha #8).
 */
export const onProdutoChanged = onDocumentWrittenWithAuthContext(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { produtoId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    // `event.time` is the CloudEvent occurrence time — stable across
    // redeliveries of the SAME event, so the deterministic entry doc stays
    // content-identical on retries. Stored as MICROSECONDS since epoch
    // (`microsSinceEpoch`, the repo's datetime standard).
    const eventTimeMillis = Date.parse(event.time);
    await recordProdutoModificationAndPropagate(
      getDb(),
      produtoId,
      before,
      after,
      event.id,
      Number.isNaN(eventTimeMillis) ? nowMicros() : millisToMicros(eventTimeMillis),
      resolveUsuarioOuterRef(event.authType, event.authId),
    );
  },
);
