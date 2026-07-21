import type { DocumentData, DocumentReference, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import {
  historicoCustoCollection,
  historicoPrecoCollection,
  produtoCollection,
} from '@delfrance/data/admin/collections';
import {
  diffPrecos,
  produtoMeta,
  samePrecos,
  type PrecoChange,
  type PrecosMap,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * Price/cost history + parent→children precos propagation for `produtos`,
 * moved server-side (this PR) from the Next produto editor's `onAfterSave`
 * (`applyPrecosChange` / `recordCustoHistory` in
 * `packages/data/src/produto/usecases.ts`, and `propagatePrecosToChildren`)
 * into this one trigger, so every writer (web editor, agent/MCP saves, the
 * still-live Flutter app) gets the same history + propagation instead of only
 * the web editor's save path.
 */

/* -------------------------------------------------------------------------- */
/*                                 Pure core                                  */
/* -------------------------------------------------------------------------- */

/** The history this trigger records for one produto write. */
export interface ProdutoHistoryChanges {
  precoChanges: PrecoChange[];
  custoChange: number | null;
}

/**
 * Diff the two produto revisions into the history records to write. Pure (no
 * I/O) — exported for the unit tests.
 *
 *  - `precoChanges` = `diffPrecos(beforePrecos, afterPrecos)`. On a create
 *    (`before` undefined) `beforePrecos` is `null`, so every `after.precos`
 *    entry comes back as an "added" change (`valorOriginal: null`) — the
 *    produto's initial price history, mirroring the removed client logic's
 *    `oldPrecos = null` diff for a brand-new produto.
 *  - `custoChange` mirrors the removed client logic exactly: only a NON-NULL
 *    `custo` that differs from the previous revision is recorded — a "novo"
 *    record on create, an "editar" record on change. A custo REMOVAL (cleared
 *    to null) is never recorded — legacy parity, the old Flutter model never
 *    wrote a "custo removido" record either.
 */
export function computeProdutoHistoryChanges(
  before: DocumentData | undefined,
  after: DocumentData,
): ProdutoHistoryChanges {
  const beforePrecos = (before?.precos as PrecosMap) ?? null;
  const afterPrecos = (after.precos as PrecosMap) ?? null;
  const precoChanges = diffPrecos(beforePrecos, afterPrecos);

  const afterCusto = typeof after.custo === 'number' ? after.custo : null;
  const beforeCusto = typeof before?.custo === 'number' ? before.custo : null;
  const custoChange = afterCusto !== null && beforeCusto !== afterCusto ? afterCusto : null;

  return { precoChanges, custoChange };
}

/**
 * True when a produto write is a candidate for history/propagation at all:
 * NOT a delete, and NOT a variation child. Pure — exported so the two guards
 * are unit-testable without a live db, mirroring `mudouCampoObservado`'s
 * fast-path in the pedido→estoque sync (`sincronizarEstoquePedido.ts`).
 *
 * A variation child (`paiId` set) gets NO history and NO propagation of its
 * own — only a PARENT's precos/custo transitions are recorded (owner
 * decision, 2026-07-21). This is also what keeps step 3's propagation update
 * from looping: it writes `precos` onto a child, which re-fires this very
 * trigger on that child — and THIS guard turns that re-fire into a no-op.
 */
export function isParentProdutoWrite(after: DocumentData | undefined): after is DocumentData {
  return after !== undefined && after.paiId == null;
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
 * Record price/cost history for a PARENT produto write and — when the precos
 * map actually changed and the parent didn't opt out — propagate it to every
 * existing variation child. Exported (I/O core) for the emulator suite; the
 * trigger below wraps it.
 *
 * Guards, in order:
 *  1. {@link isParentProdutoWrite} false (delete, or a variation child) —
 *     no-op. A delete needs nothing here: `onProdutoDeleted`'s
 *     `recursiveDelete` already sweeps `historicoDePrecos`/`historicoDeCusto`
 *     along with the rest of the produto's subtree.
 *  2. Nothing price/custo-related changed — no-op.
 */
export async function recordProdutoHistoryAndPropagate(
  db: Firestore,
  produtoId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  eventId: string,
): Promise<void> {
  if (!isParentProdutoWrite(after)) return;

  const { precoChanges, custoChange } = computeProdutoHistoryChanges(before, after);
  if (precoChanges.length === 0 && custoChange === null) return;

  const timestamp = Date.now();
  const writes: PendingWrite[] = precoChanges.map((change) => ({
    ref: historicoPrecoCollection.docRef(db, { produtoId }, `${eventId}-${change.listaId}`),
    data: historicoPrecoCollection.parse({
      listaDePrecoHistoricoOuterRef: `documents/listaDePrecos/${change.listaId}`,
      valorOriginal: change.valorOriginal,
      valorFinal: change.valorFinal,
      timestamp,
    }),
    mode: 'set',
  }));

  if (custoChange !== null) {
    writes.push({
      ref: historicoCustoCollection.docRef(db, { produtoId }, `${eventId}-custo`),
      data: historicoCustoCollection.parse({ valor: custoChange, timestamp }),
      mode: 'set',
    });
  }

  // Propagation is gated on precoChanges — never on custoChange alone, a custo
  // edit never touches a child's precos — AND on the new opt-out field.
  // `!== false` treats a missing field (every produto written before this
  // field existed) the same as the schema default `true`.
  if (precoChanges.length > 0 && after.propagatePriceToChildren !== false) {
    const childWrites = await findChildrenToPropagate(
      db,
      produtoId,
      (after.precos as PrecosMap) ?? null,
    );
    writes.push(...childWrites);
  }

  // Deterministic history ids (`{eventId}-{listaId}` / `{eventId}-custo`) make
  // a redelivered event idempotent: `set` (not merge) just rewrites the exact
  // same content again, harmless. Duplicate rows against the still-live
  // legacy Flutter client — which appends its own history independently, with
  // its own random doc ids — are ACCEPTED: no dedup guard (owner decision,
  // 2026-07-21).
  await commitChunked(db, writes);

  const propagated = writes.length - precoChanges.length - (custoChange !== null ? 1 : 0);
  logger.info(
    `onProdutoPrecoCustoChanged: ${produtoId} → ${precoChanges.length} preço(s), ` +
      `${custoChange !== null ? 1 : 0} custo, ${propagated} filho(s) propagado(s)`,
  );
}

/* -------------------------------------------------------------------------- */
/*                                Entry point                                 */
/* -------------------------------------------------------------------------- */

/**
 * The produto price/custo history + propagation trigger. Fires on EVERY
 * produto write (create/update/delete); the guards above make a delete, a
 * variation-child write, or a write that touches neither `precos` nor `custo`
 * a zero-read no-op — only a real parent precos/custo change performs any
 * write, and only a precos change (never custo alone) performs the one extra
 * read that finds children to propagate to. Targets the NAMED `default`
 * database (gotcha #8).
 */
export const onProdutoPrecoCustoChanged = onDocumentWritten(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { produtoId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    await recordProdutoHistoryAndPropagate(getDb(), produtoId, before, after, event.id);
  },
);
