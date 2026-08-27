'use client';

/**
 * Page-level batching for the `/pedidos` row reads that would otherwise be
 * issued one per rendered row.
 *
 * Why (#1216). `ClienteCell` fetches its cliente with a `getDoc`, and
 * `FreteCell` fetches the owning `int_frete` with another — so a page of N rows
 * issues up to 2N one-shot reads on first paint, and that cost is what keeps
 * `pedidoMeta.defaultQuery.limit` at 50. #1283 made the NF *listener* releasable
 * but could not touch this: two attempts at deferring per-row work behind the
 * IntersectionObserver were rejected by the vendas lane, because anything that
 * *withholds* a read starves rows whose observer never reports.
 *
 * So this does not defer anything — it **batches**. One `getDocsByIds` per
 * collection (chunked at the SDK's 30-id `in` cap) replaces up to N `getDoc`s,
 * and the results are written into the TanStack cache under the exact keys the
 * cells already use. The cells are unchanged in what they read; they simply
 * find their answer already there.
 *
 * ⚠️ It must degrade gracefully, which is the whole lesson of #1283. Two things
 * guarantee that:
 *
 *  1. {@link PREFETCH_MAX_WAIT_MS} — the cells wait for the batch, but never
 *     longer than this. If `onRowsChange` never fires, the batch hangs, or the
 *     provider is absent entirely, every cell falls back to its own `getDoc`
 *     and the screen behaves exactly as it did before. The gate can only make
 *     first paint cheaper, never make data unreachable.
 *  2. {@link PEDIDO_ROW_READS_DEFAULT} is `'settled'`, so a `ClienteCell`
 *     rendered outside this provider is not gated at all.
 *
 * A miss is also safe: an id the batch did not return simply is not seeded, and
 * that cell's own query runs as usual.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { Pedido } from '@delfrance/schemas';

import { clienteCollection } from '@/lib/data/clienteCollection';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * How long a cell will wait for the page-level batch before falling back to its
 * own read. Generous enough for one chunked round trip on a slow connection,
 * short enough that a page whose batch never runs is barely slower than before.
 */
export const PREFETCH_MAX_WAIT_MS = 2_000;

/**
 * Ultimate backstop for the case where `onRowsChange` never fires **at all** —
 * a wiring mistake, or a TableView that changed shape. Deliberately much longer
 * than {@link PREFETCH_MAX_WAIT_MS}: this one is not a budget for the batch, it
 * is insurance against the batch never being asked for, and spending it early
 * is what makes the gate useless (see `onRows`).
 */
export const PREFETCH_MOUNT_BACKSTOP_MS = 10_000;

export type RowReadsStatus = 'pending' | 'settled';

/**
 * ⚠️ `'settled'`, not `'pending'` — a cell rendered without the provider must
 * read for itself immediately rather than wait for a batch that will never come.
 */
export const PEDIDO_ROW_READS_DEFAULT: RowReadsStatus = 'settled';

export const PedidoRowReadsContext = createContext<RowReadsStatus>(PEDIDO_ROW_READS_DEFAULT);

/** Cells gate their `useQuery` on this: `enabled: status === 'settled'`. */
export function usePedidoRowReads(): RowReadsStatus {
  return useContext(PedidoRowReadsContext);
}

/** The TanStack key `ClienteCell` reads its cliente under. */
export function clienteQueryKey(path: string): readonly unknown[] {
  return ['cliente', path];
}

/**
 * The TanStack key `FreteCell` / `EtiquetaRowAction` read the tipo under.
 *
 * ⛔ **NOT batched, deliberately.** Seeding this key is how PR #1303 broke
 * `pedidos-etiqueta-ml`, and the reason is worth keeping: `getDocsByIds` reads
 * through the collection handle's CONVERTER, so Zod applies
 * `tipo: integracoesFreteSchema.default('outros')` — while both consumers'
 * `queryFn` read RAW `snap.data()`. A doc whose stored `tipo` did not parse came
 * back as `'outros'`, `freightCapsFor('outros').labelMode` is `'generic'`, and
 * the cell rendered the generic-label branch instead of the Mercado Livre
 * fetch-label one. The ZPL2 button simply did not exist.
 *
 * ⚠️ Matching the seeded value's SHAPE is not enough — it must match its
 * PROVENANCE. A converter-parsed document and a raw `snap.data()` are different
 * values wherever the schema has a `.default()`, a coercion or a transform.
 *
 * It also bought almost nothing: a page references at most a handful of DISTINCT
 * `int_frete` docs (there are only a few freight integrations), and TanStack
 * already dedupes them by key — so this was ~3 reads, not ~N.
 */
export function intFreteTipoQueryKey(path: string): readonly unknown[] {
  return ['intFreteTipo', path];
}

/** `clientes/abc` → `abc`. Returns null for anything that is not a doc path. */
function idFromPath(path: string): string | null {
  const id = path.split('/').pop();
  return id && id.length > 0 ? id : null;
}

interface Target {
  readonly path: string;
  readonly id: string;
}

/**
 * Collect the distinct cliente / int_frete documents a page of pedidos points
 * at. Exported for unit tests — pure, no Firestore.
 */
export function collectRowReadTargets(
  rows: ReadonlyArray<SnapshotRow<Pedido>>,
  toRefPath: (ref: unknown) => string | null,
): { readonly clientes: Target[] } {
  const clientes = new Map<string, Target>();
  for (const row of rows) {
    const clientePath = toRefPath(row.data.clientePedidoOuterRef);
    if (clientePath) {
      const id = idFromPath(clientePath);
      if (id) clientes.set(clientePath, { path: clientePath, id });
    }
  }
  return { clientes: [...clientes.values()] };
}

/**
 * Seed the cells' cache entries from a batch result. Exported for unit tests.
 *
 * ⚠️ The seeded VALUE must match what each cell's `queryFn` would have
 * returned, or the cell renders a differently-shaped object: `ClienteCell`
 * stores the cliente document, `FreteCell` stores only its `tipo`.
 */
export function seedRowReads(
  queryClient: QueryClient,
  clientes: ReadonlyArray<Target>,
  clienteDocs: ReadonlyMap<string, unknown>,
): void {
  for (const t of clientes) {
    const doc = clienteDocs.get(t.id);
    if (doc !== undefined) queryClient.setQueryData(clienteQueryKey(t.path), doc);
  }
}

export interface RowReadPrefetch {
  readonly status: RowReadsStatus;
  /** Pass straight to `TableView`'s `onRowsChange`. */
  readonly onRows: (rows: SnapshotRow<Pedido>[]) => void;
}

export function usePedidoRowReadPrefetch(): RowReadPrefetch {
  const db = getFirebaseFirestore();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RowReadsStatus>('pending');
  const runIdRef = useRef(0);

  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Insurance against `onRowsChange` never firing at all. Long on purpose — it
  // must NOT double as the batch's budget, or a slow pedidos query spends it
  // before the batch is even asked for.
  useEffect(() => {
    const timer = setTimeout(() => setStatus('settled'), PREFETCH_MOUNT_BACKSTOP_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(
    () => () => {
      if (deadlineRef.current) clearTimeout(deadlineRef.current);
    },
    [],
  );

  const onRows = useCallback(
    (rows: SnapshotRow<Pedido>[]) => {
      // ⚠️ An EMPTY row set is "the page has not loaded yet", NOT "there is
      // nothing to batch". `TableView` fires `onRowsChange` once with `[]` on
      // mount, before its snapshot lands. Treating that as a settle — which an
      // earlier revision did — releases every cell BEFORE a single row exists,
      // so each one issues the `getDoc` this batch was meant to replace and the
      // batch then runs on top of them. The gate never gated, and the page paid
      // both costs. Returning here is what makes the batch subtract rather than
      // add.
      if (rows.length === 0) return;

      const runId = (runIdRef.current += 1);
      // Re-gate for every new row set — "Carregar mais", a column filter, an
      // update-monitor refresh all mount fresh cells that should wait for their
      // own batch. Cells already holding data keep rendering it: TanStack serves
      // a cached value while a query is disabled.
      setStatus('pending');
      if (deadlineRef.current) clearTimeout(deadlineRef.current);
      deadlineRef.current = setTimeout(() => {
        if (runId === runIdRef.current) setStatus('settled');
      }, PREFETCH_MAX_WAIT_MS);
      const { clientes } = collectRowReadTargets(rows, (ref) => {
        const deref = dereferenceOuterRef(db, ref);
        return deref?.path ?? null;
      });
      if (clientes.length === 0) {
        setStatus('settled');
        return;
      }
      void (async () => {
        try {
          const clienteDocs = await getDocsByIds(
            db,
            clienteCollection,
            clientes.map((c) => c.id),
          );
          // A newer page superseded this batch — its seeds are for rows nobody
          // is looking at, and its `settled` would race the newer run's.
          if (runId !== runIdRef.current) return;
          seedRowReads(queryClient, clientes, clienteDocs);
        } catch (err) {
          // A prefetch is pure optimisation: every cell reads for itself in the
          // `finally` below, so a Firestore failure here costs a fallback read
          // and nothing else. Swallowing it deliberately — but ONLY Firestore's
          // own errors. Anything else is a defect in this module and must not
          // be hidden behind "the batch failed" (root CLAUDE.md rule 6).
          //
          // ⚠️ Needed as a real `catch`, not just `finally`: without it the
          // rejection escapes this detached async IIFE as an UNHANDLED
          // rejection, which in the browser is an error event and in tests a
          // false positive attributed to whatever ran next.
          if (!(err instanceof FirebaseError)) throw err;
        } finally {
          // ⚠️ ALWAYS release the cells, including on a rejected batch — a
          // failed prefetch must cost a fallback read, never a blank column.
          if (runId === runIdRef.current) setStatus('settled');
        }
      })();
    },
    [db, queryClient],
  );

  return { status, onRows };
}
