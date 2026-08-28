'use client';

/**
 * The shared `listaDePrecos` lookup.
 *
 * `/produtos` needs two things from this collection on every paint: which lista
 * is the default (the value the Preço column shows inline) and the NAME of every
 * lista (the rows behind that column's icon button). Both come from the same
 * handful of documents, so they share ONE cached read for the whole table
 * rather than one per row — the shape legacy used too, loading the price lists
 * once in `initState` (`.old/lib/produtos/pages/produtoTableView.dart:1343`).
 *
 * ⚠️ It reads the whole (small) collection rather than
 * `where('padrao','==',true).limit(1)`. The narrower query scans less per call
 * but needs its own `listaDePrecos(padrao)` index — another entry in a
 * coordinated index deploy — plus a second round trip whenever no lista is
 * flagged padrão, which is exactly the fallback legacy relied on
 * (`produtoTableView.dart:1759`). And it would answer only half the question:
 * the price modal needs the names either way.
 */

import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getDocs, type Firestore } from 'firebase/firestore';
import { buildQuery, orderByField } from '@delfrance/data';
import type { ListaDePrecos } from '@delfrance/schemas';
import { listaDePrecosCollection } from '@/lib/data/listaDePrecosCollection';

export interface ListaDePrecosRow {
  id: string;
  data: ListaDePrecos;
}

export interface UseListasDePrecosResult {
  /** Every lista, ordered by `nome` ascending. Empty until the read lands. */
  rows: ListaDePrecosRow[];
  /** The same rows keyed by document id, for resolving a `precos` key. */
  byId: Map<string, ListaDePrecos>;
  /**
   * The DEFAULT lista's id — `padrao === true`, falling back to the first by
   * nome, exactly as legacy picked it (`produtoTableView.dart:1759`). `null`
   * while loading and when the collection is empty; a caller rendering a price
   * must treat both the same way (there is no default price to show).
   */
  padraoId: string | null;
  query: UseQueryResult<ListaDePrecosRow[]>;
}

export function useListasDePrecos(db: Firestore): UseListasDePrecosResult {
  const query = useQuery({
    // ⚠️ A key of its own, NOT the `['listaPrecoPadraoId']` this replaces: two
    // `useQuery` calls sharing a key with different return SHAPES do not each
    // get a cache entry — whichever mounts first wins and the other reads the
    // wrong object. Same trap `useIntegracoes` documents for `['integracoes']`.
    queryKey: ['listasDePrecos'],
    // The price book changes about as often as the listas themselves.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ListaDePrecosRow[]> => {
      // The `orderBy nome` rides the `listaDePrecos(nome ASC)` index declared
      // for `listaDePrecosMeta.defaultQuery` (#159) — without it this
      // full-scans on Enterprise.
      const snap = await getDocs(
        buildQuery(listaDePrecosCollection.ref(db, {}), [orderByField('nome', 'asc')]),
      );
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    },
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r.data])), [rows]);
  const padraoId = useMemo(
    () => (rows.find((r) => r.data.padrao === true) ?? rows[0])?.id ?? null,
    [rows],
  );

  return { rows, byId, padraoId, query };
}
