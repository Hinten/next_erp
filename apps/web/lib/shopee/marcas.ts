'use client';

/**
 * A Shopee conta's BRAND SHORTLIST, live (#1911, D10, P9) — the rows of
 * `integracao/{integracaoId}/brandshopee`, read through THE reader
 * (`marcasDaContaShopee`, `@delfrance/schemas` — #1369) so the Marcas section
 * and the draft editor's brand picker agree on which rows are one brand.
 *
 * ## The query (root `CLAUDE.md` rule 1)
 *
 * The WHOLE subcollection, `limit(500)`, no `where` and no `orderBy`, so it needs
 * no index: the shortlist is operator-curated (tens of brands, not thousands),
 * and the display order is the reader's (`rotulo`, pt-BR), never Firestore's. A
 * conta holding {@link LIMITE_MARCAS_SHOPEE} docs or more reads `truncada`, and
 * the screen says so — a brand past the cut is simply not listed, which is the
 * safe direction for both writes (`./marcasDaConta.ts`): an add at a path this
 * read never saw is proven absent by the save itself, and a duplicate doc past
 * the cut survives a removal.
 *
 * ## What a caller gets
 *
 * - `leitura` — the reader's result (`marcas`, `semMarca`, `ilegiveis`), or
 *   `undefined` until the first emission (and on an error).
 * - `documentos` — every doc as it came off the listener: id, full path and
 *   data (a soft-read: the RAW document when the schema refuses it). The Marcas
 *   section seeds ONE save baseline per path from these, only from server
 *   truth (`fromCache === false`, no pending writes) — the same data the save
 *   re-reads through the same handle, so a baseline and its re-read compare
 *   like for like.
 * - `fromCache` / `hasPendingWrites` — the latest emission's metadata, for that
 *   gate. The listener asks for metadata changes (`@delfrance/data/hooks`), so
 *   the cache → server transition is delivered even when no doc changed.
 */
import { useMemo } from 'react';
import type { Firestore, FirestoreError, Query } from 'firebase/firestore';
import { buildQuery, limit } from '@delfrance/data';
import { useSnapshot, type SnapshotRow, type SnapshotState } from '@delfrance/data/hooks';
import {
  marcasDaContaShopee,
  type LeituraMarcasShopee,
  type MarcaShopeeArmazenada,
} from '@delfrance/schemas';

import { marcaShopeeCollection } from '@/lib/data/marcaShopeeCollection';

/** The most `brandshopee` docs one read takes. At or past it, the read is `truncada`. */
export const LIMITE_MARCAS_SHOPEE = 500;

/** One `brandshopee` doc as the listener delivered it. */
export interface DocumentoMarcaShopee {
  readonly id: string;
  /** The full document path — the key a save baseline is seeded and read under. */
  readonly path: string;
  /**
   * A soft-read: the parsed row, or the RAW document when the schema refuses it
   * (a Firestore document is always an object, so it is one either way).
   */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface MarcasShopeeLidas {
  /** The reader's result; `undefined` before the first emission and on an error. */
  readonly leitura: LeituraMarcasShopee | undefined;
  /** Every doc read; `undefined` exactly when `leitura` is. */
  readonly documentos: readonly DocumentoMarcaShopee[] | undefined;
  /** The read hit {@link LIMITE_MARCAS_SHOPEE}: docs past the cut are not listed. */
  readonly truncada: boolean;
  readonly loading: boolean;
  readonly error: FirestoreError | undefined;
  /** The latest emission's `fromCache` (`undefined` before any). */
  readonly fromCache: boolean | undefined;
  /** The latest emission's `hasPendingWrites` (`undefined` before any). */
  readonly hasPendingWrites: boolean | undefined;
}

/**
 * The shortlist query: the whole subcollection, {@link LIMITE_MARCAS_SHOPEE}
 * docs at most, nothing else — no filter, no order, so no index.
 */
export function consultaMarcasShopee(
  db: Firestore,
  integracaoId: string,
): Query<MarcaShopeeArmazenada> {
  return buildQuery(marcaShopeeCollection.ref(db, { integracaoId }), [limit(LIMITE_MARCAS_SHOPEE)]);
}

/**
 * What one listener state reads as — pure, so the reading is pinned without a
 * Firestore. Rows reach the reader as `{id, data}`, whatever the soft-read
 * handed back.
 */
export function lerMarcasShopee(
  estado: SnapshotState<readonly SnapshotRow<Readonly<Record<string, unknown>>>[]>,
): MarcasShopeeLidas {
  const linhas = estado.data;
  const documentos =
    linhas === undefined
      ? undefined
      : linhas.map((l): DocumentoMarcaShopee => ({ id: l.id, path: l.path, data: l.data }));
  return {
    leitura:
      documentos === undefined
        ? undefined
        : marcasDaContaShopee(documentos.map((d) => ({ id: d.id, data: d.data }))),
    documentos,
    truncada: documentos !== undefined && documentos.length >= LIMITE_MARCAS_SHOPEE,
    loading: estado.loading,
    error: estado.error,
    fromCache: estado.fromCache,
    hasPendingWrites: estado.hasPendingWrites,
  };
}

/**
 * The conta's shortlist, live. `integracaoId: null` reads nothing (no listener),
 * for a screen that does not know its conta yet.
 */
export function useMarcasShopee(db: Firestore, integracaoId: string | null): MarcasShopeeLidas {
  const consulta = useMemo(
    () => (integracaoId === null ? null : consultaMarcasShopee(db, integracaoId)),
    [db, integracaoId],
  );
  const estado = useSnapshot(consulta);
  return useMemo(() => lerMarcasShopee(estado), [estado]);
}
