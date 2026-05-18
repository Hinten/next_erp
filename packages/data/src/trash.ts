import {
  type DocumentData,
  type Firestore,
  type Transaction,
  collection as fsCollection,
  deleteDoc,
  doc as fsDoc,
  runTransaction,
} from 'firebase/firestore';

/**
 * Client-side helpers for the "deleted items recovery" flow.
 *
 * The capture side (snapshotting a deleted document into the `lixeira`
 * collection) is owned by the `onDelete` Cloud Function trigger — see the
 * `@delfrance/functions` package. These helpers only cover what the recovery
 * UI does: restoring an entry back to its origin, and purging it for good.
 */

/** Top-level collection where the trigger writes deleted-document snapshots. */
export const LIXEIRA_PATH = 'lixeira';

/** Thrown when a `lixeira` entry no longer exists (e.g. restored twice). */
export class TrashEntryNotFoundError extends Error {
  constructor(trashId: string) {
    super(`Entrada da lixeira "${trashId}" não encontrada.`);
    this.name = 'TrashEntryNotFoundError';
  }
}

/**
 * Thrown when a restore would overwrite a document that already exists at the
 * original path — e.g. a new document was created with the same id after the
 * delete. The caller decides how to surface this; we never clobber live data.
 */
export class RestoreConflictError extends Error {
  constructor(path: string) {
    super(`Já existe um documento em "${path}" — restauração cancelada.`);
    this.name = 'RestoreConflictError';
  }
}

/** Shape of a `lixeira` document as read back inside a transaction. */
interface TrashEntryData {
  collectionPath: string;
  docId: string;
  data: DocumentData;
}

export interface RestoreFromTrashInput {
  db: Firestore;
  /** Firestore id of the `lixeira` document to restore. */
  trashId: string;
}

/**
 * Restore a trashed document back to its original collection under its
 * original id, then delete the `lixeira` entry — atomically.
 *
 * Writes the snapshot raw (no schema converter): the data already round-tripped
 * through the schema when it was first written, and re-parsing here would brick
 * recovery if the schema drifted since the delete.
 */
export async function restoreFromTrash(input: RestoreFromTrashInput): Promise<void> {
  const trashRef = fsDoc(input.db, LIXEIRA_PATH, input.trashId);

  await runTransaction(input.db, async (tx: Transaction) => {
    const trashSnap = await tx.get(trashRef);
    if (!trashSnap.exists()) throw new TrashEntryNotFoundError(input.trashId);

    const entry = trashSnap.data() as TrashEntryData;
    const targetRef = fsDoc(
      fsCollection(input.db, entry.collectionPath),
      entry.docId,
    );

    const targetSnap = await tx.get(targetRef);
    if (targetSnap.exists()) {
      throw new RestoreConflictError(`${entry.collectionPath}/${entry.docId}`);
    }

    tx.set(targetRef, entry.data);
    tx.delete(trashRef);
  });
}

export interface PurgeTrashEntryInput {
  db: Firestore;
  /** Firestore id of the `lixeira` document to delete permanently. */
  trashId: string;
}

/**
 * Permanently delete a `lixeira` entry. There is no recovery after this — the
 * snapshot is gone.
 */
export async function purgeTrashEntry(input: PurgeTrashEntryInput): Promise<void> {
  await deleteDoc(fsDoc(input.db, LIXEIRA_PATH, input.trashId));
}
