import {
  type Firestore,
  type Transaction,
  collection as fsCollection,
  doc as fsDoc,
  runTransaction,
} from 'firebase/firestore';
import type { z, ZodTypeAny } from 'zod';
import {
  type CollectionHandle,
  type PathContext,
} from '@delfrance/data';
import { writeAuditEntry } from '@delfrance/data/audit';
import { isEmpty, pickDirty } from './diff';

export interface SaveRecordInput<S extends ZodTypeAny, T extends Record<string, unknown>> {
  db: Firestore;
  collection: CollectionHandle<S>;
  pathContext: PathContext;
  /** undefined ⇒ create a new doc. */
  recordId?: string;
  values: T;
  /** RHF `formState.dirtyFields`. */
  dirtyFields: Partial<Record<keyof T, unknown>>;
  /** Uid threaded through to the audit entry. */
  currentUserUid: string;
}

export interface SaveRecordResult<T> {
  id: string;
  /** What actually went to Firestore — full doc on create, patch on update. */
  patch: Partial<T> | T;
}

export class NothingChangedError extends Error {
  constructor() {
    super('Nenhuma alteração para salvar');
    this.name = 'NothingChangedError';
  }
}

/**
 * Save a single record (create or update) inside a transaction. The
 * transaction also runs `writeAuditEntry`, which is a no-op stub today but
 * will record a per-mutation audit row in the same atomic write.
 *
 * Why a transaction for a one-doc write? Two reasons:
 *  1. Forces the audit entry to ride the same atomic boundary as the data
 *     write when the stub gets activated.
 *  2. The caller's API surface ("save" returns Promise<void>) doesn't need
 *     to change later when more sibling writes (e.g. denormalized counters)
 *     join the same transaction.
 */
export async function saveRecord<
  S extends ZodTypeAny,
  T extends Record<string, unknown> = z.infer<S> & Record<string, unknown>,
>(input: SaveRecordInput<S, T>): Promise<SaveRecordResult<T>> {
  const isUpdate = !!input.recordId;
  const patch: Partial<T> | T = isUpdate
    ? (pickDirty(input.values, input.dirtyFields) as Partial<T>)
    : input.values;

  if (isUpdate && isEmpty(patch)) throw new NothingChangedError();

  // Stamp the last-modified field (when the schema has one) on every write,
  // after the no-op check so an unchanged update still throws. This lets the
  // TableView update-monitor detect edits, not just creations. On create
  // `patch` aliases `input.values`, so stamping `input.values` covers both.
  if ('ultimaModificacao' in input.values) {
    const now = new Date().toISOString();
    if (isUpdate) {
      (patch as Record<string, unknown>).ultimaModificacao = now;
    } else {
      (input.values as Record<string, unknown>).ultimaModificacao = now;
    }
  }

  // Resolve the ref outside the transaction — refs don't need to be
  // re-derived inside it (only reads/writes do).
  const ref = isUpdate
    ? input.collection.docRef(input.db, input.pathContext, input.recordId!)
    : fsDoc(fsCollection(input.db, input.collection.resolvePath(input.pathContext)).withConverter(
        input.collection.converter,
      ));

  await runTransaction(input.db, async (tx: Transaction) => {
    if (isUpdate) {
      // tx.update bypasses the Firestore converter (only set/add invoke it).
      // The dirty-field patch already passed zodResolver per-field on the
      // client, so we accept the partial write as-is.
      tx.update(ref, patch as never);
    } else {
      // Full create — runs through the converter, which calls schema.parse.
      tx.set(ref, input.values as never);
    }

    writeAuditEntry(tx, {
      collectionPath: input.collection.resolvePath(input.pathContext),
      docId: ref.id,
      uid: input.currentUserUid,
      kind: isUpdate ? 'update' : 'create',
      patch: patch as Record<string, unknown>,
    });
  });

  return { id: ref.id, patch };
}
