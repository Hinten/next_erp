import {
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type FirestoreDataConverter,
  type Firestore,
  type QueryDocumentSnapshot,
  collection,
  doc,
  setDoc,
} from 'firebase/firestore';
import type { z } from 'zod';
import {
  type PathContext,
  parseForWrite,
  parseMergePatch,
  parseSoftRead,
  resolvePath,
} from './zodParse';

export type { PathContext };

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
  docRef(db: Firestore, ctx: PathContext, id: string): DocumentReference<z.infer<T>>;
  converter: FirestoreDataConverter<z.infer<T>>;
  /**
   * Validate (partial) + merge-write at `id` — the only safe way to write a
   * partial patch. Never `setDoc(docRef(...), patch, { merge: true })`: the
   * converter's `toFirestore` runs a full `schema.parse`, which fills every
   * `.default()`, and Firestore computes the merge field-mask from the
   * converter OUTPUT — so the defaults silently overwrite stored siblings.
   */
  merge(db: Firestore, ctx: PathContext, id: string, patch: Record<string, unknown>): Promise<void>;
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
      return parseForWrite(options.schema, value) as DocumentData;
    },
    fromFirestore(snap: QueryDocumentSnapshot) {
      // Soft-parse on read: log instead of throw, so we can migrate fields
      // without bricking the UI when old documents don't yet match.
      return parseSoftRead(options.schema, snap.data(), snap.ref.path) as Doc;
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
    async merge(db, ctx, id, patch) {
      // Raw (unconverted) ref on purpose — see the interface doc comment.
      await setDoc(
        doc(db, resolvePath(options.path, ctx), id),
        parseMergePatch(options.schema, patch),
        {
          merge: true,
        },
      );
    },
  };
}
