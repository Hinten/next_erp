/**
 * The ONE reader behind the `['cliente', path]` TanStack key, moved here out of
 * `app/(app)/pedidos/_components/rowReadPrefetch.ts` (#852) so a plain `lib/`
 * module can share it without pulling that file's `'use client'` graph — React,
 * TanStack and `@/lib/firebase/client` — into `lib/checkout` and `lib/nfe`.
 * `rowReadPrefetch.ts` re-exports both functions, so its importers are unchanged.
 *
 * Plain on purpose: no `'use client'`, no React, no TanStack. The only imports
 * are `firebase/firestore` and the `clientes` collection handle.
 *
 * ⚠️ PROVENANCE, not just shape (#1303). A key written by one consumer and read
 * by another is only safe while they fill it with the SAME value: a
 * converter-parsed document and a raw `snap.data()` differ wherever the schema
 * has a `.default()`, a coercion or a transform. So every consumer of
 * {@link clienteQueryKey} — and every read that must agree with it — goes
 * through {@link readClienteByRef}:
 *
 *  - `ClienteCell` (`PedidoCells.tsx`),
 *  - `OrigemPedidoPicker` (`tabs/OrigemPedidoPicker.tsx`),
 *  - the `/pedidos` row batch (`rowReadPrefetch.ts`, which seeds the key from
 *    `getDocsByIds` — the same `clienteCollection` converter),
 *  - NFCell's `OrientacaoRejeicaoCliente` (the cStat 805 guidance, #852),
 *  - the `contextoRejeicao` loader (`lib/nfe/contextoRejeicao.ts`, #852).
 */
import { getDoc, type DocumentReference, type Firestore } from 'firebase/firestore';

import { clienteCollection } from '@/lib/data/clienteCollection';

/** The TanStack key `ClienteCell` reads its cliente under. */
export function clienteQueryKey(path: string): readonly unknown[] {
  return ['cliente', path];
}

/**
 * Does this (dereferenced) outer ref really address a document in `clientes`?
 * The ONE check behind {@link readClienteByRef}'s collection guard, and behind
 * every surface that turns a ref's id into a `/clientes/{id}` cadastro link
 * (the cStat 805 guidance, #852): the same id under another collection names a
 * DIFFERENT document, so a link built from it would open the wrong cadastro.
 */
export function ehRefDeCliente(ref: DocumentReference): boolean {
  return ref.parent.id === CLIENTES_COLLECTION_ID;
}

/**
 * Read ONE cliente exactly as the batch reads them, so every consumer of
 * {@link clienteQueryKey} fills that key with the same provenance. The
 * consumers are listed in this module's header — a key written by one and
 * read by another is only safe while they agree.
 *
 * ⚠️ Guards the collection rather than assuming it. `dereferenceOuterRef`
 * accepts three legacy ref shapes and nothing guarantees the path addresses
 * `clientes`; reading `clienteCollection.docRef(db, {}, ref.id)` for a ref that
 * points elsewhere would silently fetch a DIFFERENT document that happens to
 * share an id. Anything outside `clientes` is read as the ref given.
 */
export async function readClienteByRef<T>(
  db: Firestore,
  ref: DocumentReference,
): Promise<T | null> {
  const target = ehRefDeCliente(ref) ? clienteCollection.docRef(db, {}, ref.id) : ref;
  const snap = await getDoc(target);
  return (snap.data() as T | undefined) ?? null;
}

const CLIENTES_COLLECTION_ID = 'clientes';
