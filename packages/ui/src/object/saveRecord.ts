import {
  type DocumentReference,
  type Firestore,
  type Transaction,
  collection as fsCollection,
  doc as fsDoc,
  runTransaction,
} from 'firebase/firestore';
import type { z, ZodTypeAny } from 'zod';
import { nowMicros, nowMillis } from '@delfrance/core/datetime';
import { type CollectionHandle, type PathContext } from '@delfrance/data';
import { writeAuditEntry } from '@delfrance/data/audit';
import { isEmpty, pickDirty } from './diff';

/**
 * A sibling document write that must ride the SAME transaction as the main
 * record — so the two commit together or not at all, in a single round-trip.
 * The motivating case: a produto's `extraData` singleton, which on a flaky
 * connection used to be a separate `writeBatch` that could be lost while the
 * produto doc committed (orphan state). `ref` is a converter-bound
 * `DocumentReference` (the caller resolves it via a `defineCollection` handle);
 * `set` runs the converter (validation), `update` is a partial patch.
 */
export interface TransactionWrite {
  type: 'set' | 'update';
  ref: DocumentReference<unknown>;
  data: Record<string, unknown>;
}

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
  /**
   * Additional documents to write atomically with the main record, in the SAME
   * transaction. Called with the resolved record id (the freshly-minted id on
   * create), so a sibling under that id — e.g. `produtos/<id>/extraData/singleton`
   * — can target the right path. The main-record write is SKIPPED when its patch
   * is empty but siblings exist (so a save that only touched a sibling still
   * commits it); `NothingChangedError` is thrown only when BOTH are empty.
   */
  siblingWrites?: (id: string) => TransactionWrite[];
  /**
   * Wire unit for the `ultimaModificacao` stamp, resolved from the schema by
   * the caller (ObjectView reads the field descriptor). `'iso'` (the default)
   * writes an ISO-8601 string; `'ms'` / `'us'` write a numeric epoch for
   * collections whose timestamp fields use `millisSinceEpoch()` /
   * `microsSinceEpoch()`. Without this, a numeric-epoch collection would get an
   * ISO string stamped into a `z.number()` field.
   */
  stampUnit?: 'iso' | 'ms' | 'us';
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

  // Resolve the ref outside the transaction — refs don't need to be re-derived
  // inside it (only reads/writes do). Done BEFORE the no-op check so the sibling
  // writes can target docs under this record's id (the freshly-minted id on
  // create, e.g. `produtos/<id>/extraData/singleton`).
  const ref = isUpdate
    ? input.collection.docRef(input.db, input.pathContext, input.recordId!)
    : fsDoc(
        fsCollection(input.db, input.collection.resolvePath(input.pathContext)).withConverter(
          input.collection.converter,
        ),
      );

  const siblings = input.siblingWrites?.(ref.id) ?? [];

  // Nothing to write only when the doc patch is empty AND there are no siblings.
  // A save that touched only a sibling (e.g. just the Descrição) still commits it.
  if (isUpdate && isEmpty(patch) && siblings.length === 0) throw new NothingChangedError();

  // Stamp the last-modified field (when the schema has one) on every write,
  // after the no-op check so an unchanged update still throws. This lets the
  // TableView update-monitor detect edits, not just creations. On create
  // `patch` aliases `input.values`, so stamping `input.values` covers both.
  if ('ultimaModificacao' in input.values) {
    const now =
      input.stampUnit === 'us'
        ? nowMicros()
        : input.stampUnit === 'ms'
          ? nowMillis()
          : new Date().toISOString();
    if (isUpdate) {
      (patch as Record<string, unknown>).ultimaModificacao = now;
    } else {
      (input.values as Record<string, unknown>).ultimaModificacao = now;
    }
  }

  await runTransaction(input.db, async (tx: Transaction) => {
    if (isUpdate) {
      // tx.update bypasses the Firestore converter (only set/add invoke it).
      // The dirty-field patch already passed zodResolver per-field on the
      // client, so we accept the partial write as-is. Skip it entirely when the
      // doc itself is unchanged but a sibling write is pending.
      if (!isEmpty(patch)) tx.update(ref, patch as never);
    } else {
      // Full create — runs through the converter, which calls schema.parse.
      tx.set(ref, input.values as never);
    }

    // Sibling writes ride the SAME atomic boundary — they commit with the main
    // record or not at all, in one round-trip (robust on a flaky connection).
    for (const w of siblings) {
      if (w.type === 'update') tx.update(w.ref as DocumentReference, w.data as never);
      else tx.set(w.ref as DocumentReference, w.data as never);
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
