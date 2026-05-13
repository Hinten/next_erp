import {
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type FirestoreDataConverter,
  type Firestore,
  type QueryDocumentSnapshot,
  collection,
  doc,
} from 'firebase/firestore';
import type { z } from 'zod';

/**
 * Path-context object used to fill `{name}` placeholders in collection paths
 * (e.g. `clientes/{clienteId}/enderecos`). Apps pass whatever IDs they need
 * for the path being resolved.
 */
export type PathContext = Record<string, string | undefined>;

export interface DefineCollectionOptions<T extends z.ZodTypeAny> {
  /**
   * Firestore collection path with optional `{name}` placeholders for
   * subcollections (e.g. `'clientes/{clienteId}/enderecos'`). Placeholders
   * are resolved from the `ctx` passed to the returned helpers.
   */
  path: string;
  schema: T;
}

export interface CollectionHandle<T extends z.ZodTypeAny> {
  /** Resolved collection path string for a given context. */
  resolvePath(ctx: PathContext): string;
  ref(db: Firestore, ctx: PathContext): CollectionReference<z.infer<T>>;
  docRef(
    db: Firestore,
    ctx: PathContext,
    id: string,
  ): DocumentReference<z.infer<T>>;
  converter: FirestoreDataConverter<z.infer<T>>;
}

function resolvePath(template: string, ctx: PathContext): string {
  return template.replaceAll(/\{(\w+)\}/g, (_match, key: string) => {
    const v = ctx[key];
    if (!v) {
      throw new Error(`Path "${template}" requires "${key}" in context.`);
    }
    return v;
  });
}

/**
 * Define a typed Firestore collection from a Zod schema.
 * Wraps `withConverter` so reads/writes round-trip through `schema.parse`.
 *
 * No codegen — types come straight from `z.infer<T>`.
 */
export function defineCollection<T extends z.ZodTypeAny>(
  options: DefineCollectionOptions<T>,
): CollectionHandle<T> {
  type Doc = z.infer<T>;

  const converter: FirestoreDataConverter<Doc> = {
    toFirestore(value: Doc) {
      // Validate on write so bad data never lands in Firestore.
      return options.schema.parse(value) as DocumentData;
    },
    fromFirestore(snap: QueryDocumentSnapshot) {
      const raw = snap.data();
      // Soft-parse on read: log instead of throw, so we can migrate fields
      // without bricking the UI when old documents don't yet match.
      const result = options.schema.safeParse(raw);
      if (result.success) return result.data as Doc;
      // eslint-disable-next-line no-console
      console.warn(`[data] schema mismatch on ${snap.ref.path}`, result.error.issues);
      return raw as Doc;
    },
  };

  return {
    converter,
    resolvePath: (ctx) => resolvePath(options.path, ctx),
    ref(db, ctx) {
      return collection(db, resolvePath(options.path, ctx)).withConverter(converter);
    },
    docRef(db, ctx, id) {
      return doc(db, resolvePath(options.path, ctx), id).withConverter(converter);
    },
  };
}
