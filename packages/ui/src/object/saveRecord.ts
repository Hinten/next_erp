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
import type { CollectionHandle, PathContext } from '@delfrance/data';
import { isEmpty, pickDirty, valuesEqual } from './diff';
import type { DocumentBaseline } from './ObjectViewTransactionDocuments';

export interface TransactionDocumentGuard {
  /** null means server-confirmed absence; undefined means not yet loaded. */
  baseline: DocumentBaseline | undefined;
  label: string;
  formField: string;
  ignoreFields?: ReadonlySet<string>;
  /** Pure adapter; array rows must be selected by stable document identity. */
  toFormValue: (current: DocumentBaseline, formValue: unknown) => unknown;
}

export interface TransactionDocumentConflict {
  path: string;
  current: DocumentBaseline;
  fields: string[];
  guard: TransactionDocumentGuard;
}

export interface CommittedTransactionDocument {
  path: string;
  data: DocumentBaseline;
  guard: TransactionDocumentGuard;
}

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
export type TransactionWrite = (
  | { type: 'set'; ref: DocumentReference<unknown>; data: Record<string, unknown> }
  | { type: 'update'; ref: DocumentReference<unknown>; data: Record<string, unknown> }
  | { type: 'delete'; ref: DocumentReference<unknown> }
) & { guard?: TransactionDocumentGuard };

/** Pure delta derived from the current document on every transaction attempt. */
export type DeriveTransactionPatch = (
  current: Readonly<Record<string, unknown>> | null,
  patch: Readonly<Record<string, unknown>>,
) => Record<string, unknown>;

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
   *
   * Updates require a server-seeded guard for EVERY sibling. Full replacements
   * and deletes compare the whole document; partial updates compare written
   * fields. Confirmed absence is null; undefined refuses the save. Parent
   * deletion and conflicting sibling changes abort the entire transaction.
   */
  siblingWrites?: (id: string) => TransactionWrite[];
  /** Additional validated fields, recomputed from the transaction's fresh read. */
  deriveTransactionPatch?: DeriveTransactionPatch;
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
  /**
   * The record as it was LOADED into the form — the ADR 0011 **tier 3**
   * baseline. When present (and this is an update), the transaction re-reads the
   * doc and refuses with {@link RecordConflictError} if anyone changed a field
   * this save also writes.
   *
   * ⚠️ It must come from **server truth**, not from a Firestore cache paint. A
   * baseline taken from the IndexedDB snapshot is stale by construction right
   * after an edit, so the guard fires on every save and the operator learns to
   * click through it. `ObjectView` seeds it only from a `fromCache === false`
   * snapshot for exactly this reason.
   *
   * Omit to keep the previous last-write-wins behaviour (creates always do).
   */
  baseline?: Record<string, unknown>;
  /**
   * Fields a remote change to which must NOT raise a conflict — server-written
   * values the operator could not have authored, so interrupting them over one
   * would be noise. The stamp fields are added automatically; pass domain
   * additions (a `<domain>Meta.serverOwnedFields`, a trigger's write-back).
   */
  ignoreFields?: ReadonlySet<string>;
}

export interface SaveRecordResult<T> {
  id: string;
  /** What actually went to Firestore — full doc on create, patch on update. */
  patch: Partial<T> | T;
  documents: CommittedTransactionDocument[];
}

export class MissingTransactionBaselineError extends Error {
  constructor(label: string) {
    super(`Aguarde o carregamento de ${label} no servidor antes de salvar.`);
    this.name = 'MissingTransactionBaselineError';
  }
}

export class NothingChangedError extends Error {
  constructor() {
    super('Nenhuma alteração para salvar');
    this.name = 'NothingChangedError';
  }
}

/**
 * ADR 0011 **tier 3** — the record changed underneath the operator on a field
 * this save would overwrite, so a human decides instead of one write silently
 * winning.
 *
 * Carries the remote document so the UI can show the diff and offer an override
 * that RE-BASELINES on the version the operator just reviewed (never a blind
 * force-write: a third change arriving meanwhile must raise this again).
 *
 * `fields` is empty when the document was deleted outright — `missing` says so.
 */
export class RecordConflictError extends Error {
  constructor(
    readonly current: Record<string, unknown> | null,
    readonly fields: string[],
    readonly missing = false,
    readonly documents: TransactionDocumentConflict[] = [],
  ) {
    super(
      missing
        ? 'Este registro foi excluído por outra pessoa enquanto você o editava.'
        : 'Este registro foi alterado por outra pessoa desde que você o abriu.',
    );
    this.name = 'RecordConflictError';
  }
}

/**
 * Keys whose value the operator never types, so a remote change to one is not
 * worth interrupting them over. Mirrors `CONCURRENCY_IGNORE` in
 * `@delfrance/data/pedido`, minus the pedido-specific entries — the caller adds
 * those through `ignoreFields`.
 */
const ALWAYS_IGNORED = ['ultimaModificacao', 'timestamp', 'dataCadastro', 'lastMarketplaceUpdate'];

function siblingIgnored(guard: TransactionDocumentGuard): Set<string> {
  return new Set(['id', ...ALWAYS_IGNORED, ...(guard.ignoreFields ?? [])]);
}

/** Full replacements/deletes compare every field, including removed keys. */
function siblingConflictingFields(
  write: TransactionWrite,
  baseline: DocumentBaseline,
  current: DocumentBaseline,
): string[] {
  if (baseline === null || current === null) return baseline === current ? [] : ['@exists'];
  const keys =
    write.type === 'update'
      ? Object.keys(write.data)
      : [...new Set([...Object.keys(baseline), ...Object.keys(current)])];
  const ignored = siblingIgnored(write.guard!);
  return keys.filter((key) => !ignored.has(key) && !valuesEqual(baseline[key], current[key]));
}

function siblingUnchanged(write: TransactionWrite): boolean {
  const baseline = write.guard?.baseline;
  if (baseline === undefined) return false;
  if (write.type === 'delete') return baseline === null;
  if (baseline === null) return false;
  const ignored = siblingIgnored(write.guard!);
  const keys =
    write.type === 'update'
      ? Object.keys(write.data)
      : [...new Set([...Object.keys(baseline), ...Object.keys(write.data)])];
  return keys.every((key) => ignored.has(key) || valuesEqual(baseline[key], write.data[key]));
}

/** Ignoring server metadata must never cause a stale copy to overwrite it. */
function siblingData(
  write: Exclude<TransactionWrite, { type: 'delete' }>,
  current: DocumentBaseline,
) {
  const data = { ...write.data };
  if (current && write.guard) {
    for (const field of siblingIgnored(write.guard)) {
      if (write.type === 'update') delete data[field];
      else if (field in current) data[field] = current[field];
      else delete data[field];
    }
  }
  return data;
}

/**
 * Fields whose stored value differs from the baseline AND which this save would
 * overwrite.
 *
 * Compared against `patch`'s own keys rather than the whole document: an
 * untouched field is not in the dirty patch, so it is not written, so it cannot
 * lose a race it never entered. That is the tier-0-by-disjointness half, and it
 * is what keeps the guard quiet on screens whose docs a trigger writes back to.
 */
function conflictingFields(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  ignored: ReadonlySet<string>,
): string[] {
  return Object.keys(patch).filter(
    (key) => !ignored.has(key) && !valuesEqual(baseline[key], current[key]),
  );
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

  const proposedSiblings = input.siblingWrites?.(ref.id) ?? [];
  if (isUpdate) {
    for (const write of proposedSiblings) {
      if (write.guard?.baseline === undefined)
        throw new MissingTransactionBaselineError(write.guard?.label ?? 'dados adicionais');
    }
  }
  const siblings = isUpdate
    ? proposedSiblings.filter((write) => !siblingUnchanged(write))
    : proposedSiblings;

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

  // ADR 0011 tier 3. Tier 1 is unreachable here — this is the browser SDK,
  // which has no `lastUpdateTime` precondition (`apps/web/CLAUDE.md` rule 3) —
  // and tier 0 does not apply: a form field is neither commutative nor
  // monotonic. So the doc is re-read inside the transaction and compared
  // against what the form was seeded with.
  //
  // ⚠️ Reading it also FIXES a second, quieter problem: without a `tx.get` this
  // transaction has an EMPTY READ SET, so there is no version for Firestore to
  // check at commit and it can never abort. It was a `WriteBatch` with extra
  // latency. The read alone restores real OCC, before any comparison.
  const guarded = isUpdate && input.baseline != null;
  const ignored = new Set([...ALWAYS_IGNORED, ...(input.ignoreFields ?? [])]);

  const result = await runTransaction(input.db, async (tx: Transaction) => {
    let current: Record<string, unknown> | null = null;
    let fields: string[] = [];
    if (isUpdate && (guarded || siblings.length > 0 || input.deriveTransactionPatch)) {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new RecordConflictError(null, [], true);
      current = snap.data() as Record<string, unknown>;
      if (guarded) fields = conflictingFields(input.baseline!, current, patch, ignored);
    }

    // All reads precede all writes, and every OCC retry repeats the comparisons.
    const siblingCurrent = new Map<string, DocumentBaseline>();
    const documentConflicts: TransactionDocumentConflict[] = [];
    if (isUpdate) {
      for (const write of siblings) {
        const snap = await tx.get(write.ref);
        const data = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
        siblingCurrent.set(write.ref.path, data);
        const changed = siblingConflictingFields(write, write.guard!.baseline!, data);
        if (changed.length > 0)
          documentConflicts.push({
            path: write.ref.path,
            current: data,
            fields: changed,
            guard: write.guard!,
          });
      }
    }
    if (fields.length > 0 || documentConflicts.length > 0)
      throw new RecordConflictError(current, fields, false, documentConflicts);

    // A fresh object per attempt: a losing attempt's derived history must never
    // become input to its retry. The callback cannot perform reads or writes.
    const effectivePatch =
      writeMainDoc && input.deriveTransactionPatch
        ? { ...patch, ...input.deriveTransactionPatch(current, { ...patch }) }
        : { ...patch };

    if (writeMainDoc) {
      if (isUpdate) {
        // tx.update bypasses the Firestore converter (only set/add invoke it).
        // The dirty-field patch already passed zodResolver per-field on the
        // client, so we accept the partial write as-is.
        tx.update(ref, effectivePatch as never);
      } else {
        // Full create — runs through the converter, which calls schema.parse.
        tx.set(ref, effectivePatch as never);
      }
    }

    // Sibling writes ride the SAME atomic boundary — they commit with the main
    // record (or on their own, for a sibling-only save) or not at all, in one
    // round-trip (robust on a flaky connection).
    const committedDocuments: CommittedTransactionDocument[] = [];
    for (const w of siblings) {
      const before = siblingCurrent.get(w.ref.path) ?? null;
      let data: DocumentBaseline = null;
      if (w.type === 'delete') tx.delete(w.ref as DocumentReference);
      else {
        const payload = siblingData(w, before);
        if (w.type === 'update') tx.update(w.ref as DocumentReference, payload as never);
        else tx.set(w.ref as DocumentReference, payload as never);
        data = w.type === 'update' ? { ...before, ...payload } : payload;
      }
      if (w.guard) committedDocuments.push({ path: w.ref.path, data, guard: w.guard });
    }
    return { documents: committedDocuments, patch: effectivePatch };
  });

  return { id: ref.id, patch: result.patch as Partial<T> | T, documents: result.documents };
}
