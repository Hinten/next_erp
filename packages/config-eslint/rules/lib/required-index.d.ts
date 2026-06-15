// Hand-written types for the pure JS derivation helper. Kept in lockstep with
// `required-index.js` (the package ships no build step / `exports` map, so the
// `@delfrance/schemas` meta-test deep-imports the `.js` and picks up these
// declarations via Bundler/nodenext resolution of the sibling `.d.ts`).

export interface RequiredIndexField {
  fieldPath: string;
  order: 'ASCENDING' | 'DESCENDING';
}

export interface RequiredIndex {
  collectionGroup: string;
  queryScope: 'COLLECTION';
  fields: RequiredIndexField[];
}

export interface DerivableDefaultQuery {
  where?: ReadonlyArray<{ field: string }>;
  orderBy: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>;
}

export function collectionGroupOf(collectionPath: string): string;

export function deriveRequiredIndex(
  collectionPath: string,
  defaultQuery: DerivableDefaultQuery,
): RequiredIndex;

export function indexSatisfies(candidate: unknown, required: RequiredIndex): boolean;

export function formatIndexJson(required: RequiredIndex): string;
