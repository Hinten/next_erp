import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  Firestore,
  Query,
} from 'firebase-admin/firestore';
import type { z } from 'zod';
import {
  type PathContext,
  parseForWrite,
  parseMergePatch,
  parseSoftRead,
  resolvePath,
} from '../zodParse';
import { isNotFound } from './grpcErrors';

export type { PathContext };

export interface DefineAdminCollectionOptions<T extends z.ZodTypeAny> {
  /**
   * Firestore collection path with optional `{name}` placeholders for
   * subcollections (e.g. `'pedidos/{pedidoId}/nfev4'`). Prefer passing the
   * schema's `xMeta.collectionPath` so the path stays a single source of truth.
   */
  path: string;
  schema: T;
}

export interface AdminCollectionHandle<T extends z.ZodTypeAny> {
  /** Resolved collection path string for a given context. */
  resolvePath(ctx: PathContext): string;
  /**
   * Resolved `collection/id` path for a single document. Handy as the `path`
   * argument to `parseRead` so soft-read warnings name the concrete document
   * (works without a snapshot ref, so it's safe in tests too).
   */
  docPath(ctx: PathContext, id: string): string;
  /** Raw admin `CollectionReference` (no converter). */
  ref(db: Firestore, ctx: PathContext): CollectionReference;
  /** Raw admin `DocumentReference` (no converter). */
  docRef(db: Firestore, ctx: PathContext, id: string): DocumentReference;
  /** Raw admin collection-group `Query` over the path's last segment. */
  groupQuery(db: Firestore): Query;
  /**
   * Mint a fresh auto-generated doc id WITHOUT writing anything. For flows
   * that need the id before the document exists (e.g. the Mercado Livre
   * publish sends the link-doc id as `seller_custom_field` before persisting
   * the doc). Pair with `set(db, ctx, id, data)`; prefer `add()` when the id
   * isn't needed up front.
   */
  newDocId(db: Firestore, ctx: PathContext): string;

  /** Validate a full document (throws on invalid/missing). For full writes / `.add`. */
  parse(data: unknown): z.infer<T>;
  /** Validate a partial patch for a merge write — keeps only the keys provided. */
  parseMerge(patch: Record<string, unknown>): Partial<z.infer<T>>;
  /** Soft read validation: logs + returns raw on mismatch (migration-tolerant). */
  parseRead(raw: unknown, path?: string): z.infer<T>;

  /** Validate + create a new doc with an auto-generated id. */
  add(db: Firestore, ctx: PathContext, data: unknown): Promise<DocumentReference>;
  /** Validate + write a full doc at `id` (overwrite). */
  set(db: Firestore, ctx: PathContext, id: string, data: unknown): Promise<void>;
  /** Validate (partial) + merge-write at `id`. UPSERT — creates an absent doc. */
  merge(db: Firestore, ctx: PathContext, id: string, patch: Record<string, unknown>): Promise<void>;
  /**
   * Validate (partial) + merge-write at `id` **only if the document already
   * exists**. Resolves `false` when the document was already gone; every other
   * failure rethrows.
   *
   * `true` means "nothing is known to be missing", NOT "a write definitely
   * happened": a patch that validates to zero keys resolves `true` without
   * issuing a write, so it never learns whether the document exists. Callers
   * branch on `false` (the document is gone) — never read `true` as proof of a
   * write. Nothing to write is not a failure, and the alternative readings are
   * worse: `false` would claim the document is missing, and probing existence
   * would spend a read to answer a question no caller asked.
   *
   * Use this for a best-effort stamp on a doc another actor may have deleted
   * meanwhile — a background writeback whose target id was resolved earlier
   * (a queued task payload, a sweep row). {@link merge} is an UPSERT: it would
   * silently recreate the doc carrying ONLY the patch keys, since `parseMerge`
   * fills no schema defaults — a ghost with none of the schema's required
   * fields, which Firestore will happily write under a deleted parent too
   * (missing ancestor docs are legal). Keep {@link merge} where create-on-first-
   * use is the point (per-account state docs).
   *
   * There is no native "merge only if exists": `SetOptions` is `{ merge }` /
   * `{ mergeFields }` and takes no precondition. The `exists` Precondition
   * rides on `update()`, which already enforces existence implicitly ("the
   * update will fail if applied to a document that does not exist"), so this
   * is `update()` plus a NOT_FOUND narrow.
   *
   * Because it IS `update()`, the patch must be FLAT — see
   * {@link assertFlatUpdatePatch}. A nested plain object or a dotted key throws
   * a `TypeError` rather than writing something subtly different from what the
   * same patch would do through {@link merge}.
   */
  mergeIfExists(
    db: Firestore,
    ctx: PathContext,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<boolean>;
}

/** Own-properties-only plain object (`{...}`), not a class instance / array / null. */
function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject a patch whose meaning would differ between `update()` and
 * `set(..., { merge: true })`, so `mergeIfExists` can never diverge silently
 * from `merge` for the same input:
 *
 *  - a **nested plain object** — `update({ a: { b: 1 } })` masks at `a` and
 *    REPLACES the whole map, while set-merge masks at `a.b` and merges into it;
 *  - a **dotted key** — `update()` reads `'a.b'` as a nested field PATH, while
 *    `set()` treats it as a literal top-level field name.
 *
 * Class instances (Timestamp, GeoPoint, Buffer…) are not plain objects and
 * pass, because `update()` and set-merge both treat them as leaf values.
 */
function assertFlatUpdatePatch(patch: Record<string, unknown>, collectionPath: string): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes('.')) {
      throw new TypeError(
        `mergeIfExists(${collectionPath}): key '${key}' contains a dot. ` +
          'update() would read it as a nested field path, unlike merge(). ' +
          'Rename the field, or use merge() if the upsert is intended.',
      );
    }
    if (isPlainObject(value)) {
      throw new TypeError(
        `mergeIfExists(${collectionPath}): key '${key}' holds a nested object. ` +
          'update() replaces the whole map where merge() deep-merges it. ' +
          'Flatten to dotted field paths on a raw docRef, or use merge().',
      );
    }
  }
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Admin-SDK counterpart of `defineCollection`. Same Zod-as-source-of-truth
 * contract, for `firebase-admin/firestore`. Validation is exposed as explicit
 * helpers (`parse` / `parseMerge` / `parseRead`) rather than a `withConverter`,
 * because the Admin SDK bypasses converters on `.update()` and on
 * `collectionGroup` snapshot refs, and because partial merge patches (used by
 * the NFe orchestrator) would be rejected by a full-schema converter.
 *
 * The `firebase-admin/firestore` imports are **type-only** (erased at emit via
 * `verbatimModuleSyntax` + `isolatedModules`), and this module makes no runtime
 * `firebase-admin` call — it operates on the `db` the app passes in — so it
 * never pulls firebase-admin into a client bundle.
 */
export function defineAdminCollection<T extends z.ZodTypeAny>(
  options: DefineAdminCollectionOptions<T>,
): AdminCollectionHandle<T> {
  const groupId = lastSegment(options.path);

  const ref = (db: Firestore, ctx: PathContext): CollectionReference =>
    db.collection(resolvePath(options.path, ctx));
  const docRef = (db: Firestore, ctx: PathContext, id: string): DocumentReference =>
    db.collection(resolvePath(options.path, ctx)).doc(id);

  const parse = (data: unknown): z.infer<T> => parseForWrite(options.schema, data);
  const parseMerge = (patch: Record<string, unknown>): Partial<z.infer<T>> =>
    parseMergePatch(options.schema, patch) as Partial<z.infer<T>>;

  return {
    resolvePath: (ctx) => resolvePath(options.path, ctx),
    docPath: (ctx, id) => `${resolvePath(options.path, ctx)}/${id}`,
    ref,
    docRef,
    groupQuery: (db) => db.collectionGroup(groupId),
    newDocId: (db, ctx) => ref(db, ctx).doc().id,
    parse,
    parseMerge,
    parseRead: (raw, path) => parseSoftRead(options.schema, raw, path ?? options.path),
    async add(db, ctx, data) {
      return ref(db, ctx).add(parse(data) as DocumentData);
    },
    async set(db, ctx, id, data) {
      await docRef(db, ctx, id).set(parse(data) as DocumentData);
    },
    async merge(db, ctx, id, patch) {
      await docRef(db, ctx, id).set(parseMerge(patch) as DocumentData, {
        merge: true,
      });
    },
    async mergeIfExists(db, ctx, id, patch) {
      const data = parseMerge(patch) as DocumentData;
      assertFlatUpdatePatch(data, options.path);
      // Nothing to write: `update({})` is rejected by the Admin SDK, and an
      // empty merge would only ever have created an empty doc — which is the
      // one thing this method exists to prevent.
      if (Object.keys(data).length === 0) return true;
      try {
        await docRef(db, ctx, id).update(data);
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
}
