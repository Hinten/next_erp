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
  collectionGroup(db: Firestore): Query;

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
  /** Validate (partial) + merge-write at `id`. */
  merge(
    db: Firestore,
    ctx: PathContext,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
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
  const docRef = (
    db: Firestore,
    ctx: PathContext,
    id: string,
  ): DocumentReference => db.collection(resolvePath(options.path, ctx)).doc(id);

  const parse = (data: unknown): z.infer<T> =>
    parseForWrite(options.schema, data);
  const parseMerge = (patch: Record<string, unknown>): Partial<z.infer<T>> =>
    parseMergePatch(options.schema, patch) as Partial<z.infer<T>>;

  return {
    resolvePath: (ctx) => resolvePath(options.path, ctx),
    docPath: (ctx, id) => `${resolvePath(options.path, ctx)}/${id}`,
    ref,
    docRef,
    collectionGroup: (db) => db.collectionGroup(groupId),
    parse,
    parseMerge,
    parseRead: (raw, path) =>
      parseSoftRead(options.schema, raw, path ?? options.path),
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
  };
}
