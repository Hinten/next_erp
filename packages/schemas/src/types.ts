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
 * Canonical "recency" sort shared by every schema-driven picker built on
 * `CollectionSelect` (FilialPicker today; future entity pickers tomorrow):
 * most-recently-touched first, falling back to creation order. Pipeline sorts
 * treat a missing field as null (legacy Flutter-written docs sort last) instead
 * of excluding the doc the way a classic `orderBy` would.
 *
 * Single-sourced here so the picker's `orderBy` prop and the
 * `defaultQuery.indexes` meta-test derive the SAME composite index
 * (`[ultimaModificacao desc, timestamp desc]`) — see
 * {@link CollectionMetadata.pickerRecencySort}. Use this constant instead of
 * re-declaring the two-key order at each picker call site.
 */
export const RECENCY_SORT: ReadonlyArray<DefaultQueryOrderBy> = [
  { field: 'ultimaModificacao', direction: 'desc' },
  { field: 'timestamp', direction: 'desc' },
];

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
  /**
   * Ordered default column set for the list, by key: either a top-level schema
   * field or one of the page's `VirtualColumn` keys. Omit to fall back to every
   * non-opaque schema field followed by every virtual column.
   *
   * This lives beside `where`/`orderBy`/`limit` because it is part of the
   * query's COST, not just its presentation: `TableView` derives the Pipelines
   * `select()` projection from the visible columns (widened by each visible
   * virtual column's `dependsOn`), and Enterprise bills data scanned. A page
   * may still override it with the `defaultColumns` prop — needed where one
   * meta backs several screens with different column sets.
   *
   * NOTE the keys are not statically checkable from this package: virtual
   * columns are declared in `apps/web`. An unresolvable key renders nothing.
   */
  columns?: ReadonlyArray<string>;
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
  /**
   * Set when this collection is exposed through a schema-driven picker
   * (`CollectionSelect`) whose option list is ordered by {@link RECENCY_SORT}
   * (`[ultimaModificacao desc, timestamp desc]`) — e.g. `FilialPicker`.
   *
   * The `defaultQuery.indexes` meta-test derives the matching composite index
   * from this flag and asserts it exists in `firestore.indexes.json`, so picker
   * recency sorts are indexed by convention rather than one-off hand-tracking.
   * Independent of `defaultQuery` (the picker query is separate from the
   * collection's `TableView` list query, and may be set without one).
   */
  pickerRecencySort?: boolean;
  /**
   * Fields the CLIENT may never write — server-owned state maintained through
   * the Admin SDK (which bypasses rules). The rules generator denies any client
   * UPDATE touching them, and allows a CREATE only when the value is `null`
   * (what the client-side Zod parse fills in via `.default(null)`), so a forged
   * value can never enter through a client write. Like the field validators,
   * the `su` super-user claim does NOT bypass this.
   */
  serverOwnedFields?: ReadonlyArray<string>;
  /**
   * Suppresses the `match /{path=**}/<leaf>/{docId}` collection-group READ
   * block the generator emits for every subcollection by default.
   *
   * That block exists so a client can run a `collectionGroup` query across all
   * parents; it carries the same read claim as the parent-scoped block, so it
   * widens the query *shape*, not who may read. Set this when no such query
   * exists — a collection whose every read is scoped to one parent gains
   * nothing from the block and only offers one more surface to get wrong.
   * Ignored on top-level collections, which never get a group block.
   */
  noCollectionGroupRead?: boolean;
  /**
   * Marks a collection written EXCLUSIVELY by the Admin SDK (a Cloud
   * Function trigger, never a client). The rules generator denies all client
   * writes outright — `allow create, update, delete: if false;` — with no
   * `su` super-user bypass, unlike the per-field `serverOwnedFields` guard.
   * Read access still follows `permissions.read` as usual. Mutually
   * exclusive with `serverOwnedFields` and with a `VALIDATOR_WHITELIST`
   * entry for the collection — declaring either alongside `serverOwned` is a
   * contradiction (a field-level write guard is meaningless when writes are
   * denied entirely) and the generator throws at generation time.
   */
  serverOwned?: boolean;
}

export interface DomainSchema<T extends z.ZodTypeAny> {
  schema: T;
  meta: CollectionMetadata;
}
