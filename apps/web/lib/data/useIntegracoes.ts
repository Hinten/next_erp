'use client';

/**
 * The shared `integracao` (canal de venda) lookup.
 *
 * Every surface that renders an integração by name needs the same handful of
 * rows, so they share ONE cached query rather than each reading the collection:
 * `/produtos` resolves a produto's `integracoesComProduto` ids into badges for
 * up to 50 rows at a time, and the pickers turn the same rows into options.
 *
 * ⚠️ The `['integracoes']` key is load-bearing. Two `useQuery` calls sharing a
 * key with different `queryFn` return SHAPES do not each get their own cache
 * entry — whichever mounts first wins and the other reads the wrong object. So
 * every consumer of this key goes through this hook. (`chat`'s FiltersBar keeps
 * its own `['inboxIntegracoes']` key: different query, different shape,
 * no collision.)
 */

import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getDocs, type Firestore } from 'firebase/firestore';
import { buildQuery, orderByField } from '@delfrance/data';
import type { Integracao } from '@delfrance/schemas';
import { integracaoCollection } from '@/lib/data/integracaoCollection';

export interface IntegracaoRow {
  id: string;
  data: Integracao;
}

/**
 * Whether the shared read has produced a usable lookup yet.
 *
 * ⚠️ Consumers MUST branch on this rather than treating an empty `byId` as
 * "these ids do not exist". `byId` is empty in three very different situations
 * — still loading, the read failed (a user without `PERM.integracao.read` gets
 * `permission-denied`), and the collection really is empty — and a renderer
 * that cannot tell them apart reports a system problem as a data problem.
 */
export type IntegracoesStatus = 'pending' | 'error' | 'success';

export interface UseIntegracoesResult {
  /** All integrações, ordered by `nome` ascending. Empty unless `success`. */
  rows: IntegracaoRow[];
  /** The same rows keyed by document id, for resolving a denormalized id. */
  byId: Map<string, Integracao>;
  /** Read {@link IntegracoesStatus} before interpreting an empty `byId`. */
  status: IntegracoesStatus;
  query: UseQueryResult<IntegracaoRow[]>;
}

/**
 * Read every integração once, ordered by `nome`.
 *
 * Deliberately NOT filtered to `ativo == true`. Legacy's produto table did
 * filter (`produtoTableView.dart:77-84`), but it only ever used the result to
 * build labels — and a produto's `integracoesComProduto` can name a conta that
 * has since been deactivated. Dropping those rows here would turn a resolvable
 * badge into an "unknown id" one. Callers that only want live channels filter
 * on `data.ativo` themselves.
 *
 * The `orderBy nome` rides the `integracao(nome ASC)` index. The collection is
 * a cadastro with a handful of rows and this is cached for 5 minutes, so the
 * whole table costs one read.
 */
export function useIntegracoes(db: Firestore): UseIntegracoesResult {
  const query = useQuery({
    queryKey: ['integracoes'],
    // Channels are created once and edited rarely.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<IntegracaoRow[]> => {
      const snap = await getDocs(
        buildQuery(integracaoCollection.ref(db, {}), [orderByField('nome', 'asc')]),
      );
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    },
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r.data])), [rows]);

  return { rows, byId, status: query.status, query };
}
