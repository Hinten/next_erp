import type { z } from 'zod';

/** Scalar a `defaultQuery` equality filter may compare against. */
export type DefaultQueryValue = string | number | boolean | null;

/**
 * One equality filter of a collection's default list query. Two forms:
 * - `{ field, value }` — a literal bound at declaration time (e.g. the
 *   catalog listing only parent products: `paiId == null`).
 * - `{ field, param: true }` — the value is supplied at runtime by the
 *   `TableView` `queryParams` prop (e.g. a channel screen slicing the shared
 *   `integracao` collection by `tipo`). The required Firestore index depends
 *   only on the field, so both forms derive the same index.
 */
export type DefaultQueryWhere =
  | { field: string; value: DefaultQueryValue }
  | { field: string; param: true };

/** One `orderBy` clause of a collection's default list query. */
export interface DefaultQueryOrderBy {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * The default list query a collection's `TableView` issues before the user
 * sorts or filters. Declared here so it is the single source of truth: the
 * UI consumes it, and the `delfrance/default-query-needs-index` ESLint rule
 * plus the `defaultQuery.indexes` meta-test statically derive the Firestore
 * index it requires and assert that index exists in `firestore.indexes.json`.
 *
 * Firestore Enterprise edition creates NO indexes automatically — an
 * unindexed query silently degrades to a full collection scan (billed by data
 * scanned) — so every declared default query needs a matching index.
 *
 * MUST be a plain JSON literal (no spreads, identifiers, or calls): the lint
 * rule evaluates it statically at lint time and rejects anything it cannot.
 */
export interface CollectionDefaultQuery {
  /** Equality filters, AND-combined, applied before `orderBy`. */
  where?: ReadonlyArray<DefaultQueryWhere>;
  /** Sort clauses, at least one. */
  orderBy: ReadonlyArray<DefaultQueryOrderBy>;
  /** Initial page size. */
  limit: number;
}

/**
 * Metadata attached to every domain schema. The data layer and the rules
 * generator both read this to drive collection access and Firestore rules.
 */
export interface CollectionMetadata {
  /**
   * Firestore collection path. Use `{parentId}` placeholders for
   * subcollections (e.g. `'clientes/{clienteId}/enderecos'`). The runtime
   * resolves placeholders using the context passed to the data layer.
   *
   * Multi-tenancy in Delfrance is enforced via document fields
   * (`grupoEconomico`, `userCliente`, etc.) inside Firestore rules — not via
   * path prefixes — to keep parity with the Flutter app's existing data.
   */
  collectionPath: string;
  /**
   * Permission bits required to read/write/delete. BigInt literals so we can
   * express permission sets larger than 53 bits (Firestore claims store them
   * as strings).
   */
  permissions: {
    read: bigint;
    write: bigint;
    delete: bigint;
  };
  /**
   * Cascade declarations: subcollection paths that must be deleted with the
   * parent (`onDelete: 'cascade'`) or that must block parent deletion when
   * non-empty (`onDelete: 'restrict'`).
   */
  cascade?: ReadonlyArray<{
    path: string;
    onDelete: 'cascade' | 'restrict';
  }>;
  /**
   * Default list query for this collection's `TableView`. See
   * {@link CollectionDefaultQuery}. Optional, but when present it must be a
   * plain literal so its Firestore index can be derived statically.
   */
  defaultQuery?: CollectionDefaultQuery;
}

export interface DomainSchema<T extends z.ZodTypeAny> {
  schema: T;
  meta: CollectionMetadata;
}
