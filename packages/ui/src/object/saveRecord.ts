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
import { isEmpty, pickDirty } from './diff';

/**
 * A sibling document write that must ride the SAME transaction as the main
 * record — so the two commit together or not at all.
 * The motivating case: a produto's `extraData` singleton, which on a flaky
 * connection used to be a separate `writeBatch` that could be lost while the
 * produto doc committed (orphan state). `ref` is a converter-bound
 * `DocumentReference` (the caller resolves it via a `defineCollection` handle);
 * `set` runs the converter (validation), `update` is a partial patch, `delete`
 * removes the doc (e.g. an imposto whose operação was cleared) — `data` is
 * ignored for `delete`.
 */
export type TransactionWrite =
  | { type: 'set'; ref: DocumentReference<unknown>; data: Record<string, unknown> }
  | { type: 'update'; ref: DocumentReference<unknown>; data: Record<string, unknown> }
  | { type: 'delete'; ref: DocumentReference<unknown> };

export interface SaveRecordInput<S extends ZodTypeAny, T extends Record<string, unknown>> {
  db: Firestore;
  collection: CollectionHandle<S>;
  pathContext: PathContext;
  /** undefined ⇒ create a new doc. */
  recordId?: string;
  values: T;
  /** RHF `formState.dirtyFields`. */
  dirtyFields: Partial<Record<keyof T, unknown>>;
  /**
   * Uid of the acting user. Unused internally since the audit-entry write it
   * fed was retired (the dormant `writeAuditEntry` stub — no feature ever
   * activated it); kept required because `ObjectView` and its many callers
   * already thread it through, and a future consumer (e.g. a real audit trail)
   * can pick it back up without a signature change.
   */
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
   * Wire unit for create/last-modified stamps, resolved from the schema by the
   * caller (ObjectView reads the field descriptor). `'iso'` (the default)
   * writes an ISO-8601 string; `'ms'` / `'us'` write a numeric epoch for
   * collections whose stamp fields use `millisSinceEpoch()` /
   * `microsSinceEpoch()`. Without this, a numeric-epoch collection would get an
   * ISO string stamped into a `z.number()` field.
   */
  stampUnit?: 'iso' | 'ms' | 'us';
  /**
   * Last-modified field name. Default `'ultimaModificacao'`. Pass `false` to
   * disable modified stamping entirely (e.g. schemas without that concept).
   */
  modifiedAtField?: string | false;
  /**
   * Creation field name (create-only, nullish coalesce — Flutter
   * `timestamp ??= now`). Default `'timestamp'`. Pass `false` to disable.
   * Domains that wire creation as `dataCadastro` pass that name (ObjectView
   * auto-detects from the schema descriptors).
   */
  createdAtField?: string | false;
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

/** Keys that must never be used as dynamic object property names. */
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Resolve a stamp field option to a safe key (or `undefined` when disabled /
 * invalid). Rejects prototype-polluting keys so a caller-supplied
 * `createdAtField` / `modifiedAtField` cannot mutate `Object.prototype`.
 */
function resolveStampKey(option: string | false | undefined, fallback: string): string | undefined {
  if (option === false) return undefined;
  const key = option ?? fallback;
  if (PROTOTYPE_POLLUTION_KEYS.has(key)) return undefined;
  return key;
}

/**
 * Save a single record (create or update) inside a transaction.
 *
 * Why a transaction for a one-doc write? The caller's API surface ("save"
 * returns Promise<void>) doesn't need to change later when more sibling
 * writes (e.g. denormalized counters) join the same transaction — the main
 * doc and every sibling write already commit atomically (the SDK may retry
 * the transaction internally; atomicity, not a single round-trip, is the
 * guarantee).
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

  // The main doc is written on every create, and on an update only when its
  // dirty patch is non-empty. A sibling-only update (empty patch) skips the main
  // write entirely — so neither the data NOR the last-modified stamp touches
  // the otherwise-unchanged doc.
  const writeMainDoc = !isUpdate || !isEmpty(patch);

  // Nothing to write at all → "no changes" (only reachable on update; a create
  // always writes). A pending sibling keeps the save alive (e.g. just the
  // Descrição), so the no-op only fires when neither side has work.
  if (!writeMainDoc && siblings.length === 0) throw new NothingChangedError();

  // Field names: default to the monorepo majority (`timestamp` /
  // `ultimaModificacao`); ObjectView overrides for `dataCadastro` etc.
  // `false` (or a prototype-polluting key) disables that stamp entirely.
  const modifiedKey = resolveStampKey(input.modifiedAtField, 'ultimaModificacao');
  const createdKey = resolveStampKey(input.createdAtField, 'timestamp');

  // Stamps run ONLY when the main doc is actually written — so the TableView
  // update-monitor sees real edits, and a sibling-only save doesn't bump an
  // otherwise-unchanged parent. On create `patch` aliases `input.values`, so
  // stamping `input.values` covers both.
  if (writeMainDoc) {
    const valuesRec = input.values as Record<string, unknown>;
    const needsModified = !!modifiedKey && modifiedKey in valuesRec;
    const needsCreated =
      !isUpdate && !!createdKey && createdKey in valuesRec && valuesRec[createdKey] == null;

    if (needsModified || needsCreated) {
      const now =
        input.stampUnit === 'us'
          ? nowMicros()
          : input.stampUnit === 'ms'
            ? nowMillis()
            : new Date().toISOString();

      if (needsModified && modifiedKey) {
        if (isUpdate) {
          (patch as Record<string, unknown>)[modifiedKey] = now;
        } else {
          valuesRec[modifiedKey] = now;
        }
      }
      if (needsCreated && createdKey) {
        valuesRec[createdKey] = now;
      }
    }
  }

  await runTransaction(input.db, async (tx: Transaction) => {
    if (writeMainDoc) {
      if (isUpdate) {
        // tx.update bypasses the Firestore converter (only set/add invoke it).
        // The dirty-field patch already passed zodResolver per-field on the
        // client, so we accept the partial write as-is.
        tx.update(ref, patch as never);
      } else {
        // Full create — runs through the converter, which calls schema.parse.
        tx.set(ref, input.values as never);
      }
    }

    // Sibling writes ride the SAME atomic boundary — they commit with the main
    // record (or on their own, for a sibling-only save) or not at all, in one
    // round-trip (robust on a flaky connection).
    for (const w of siblings) {
      if (w.type === 'update') tx.update(w.ref as DocumentReference, w.data as never);
      else if (w.type === 'delete') tx.delete(w.ref as DocumentReference);
      else tx.set(w.ref as DocumentReference, w.data as never);
    }
  });

  return { id: ref.id, patch };
}
