'use client';

import { useMemo } from 'react';
import { getDocsFromServer, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import { buildQuery, limit } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  componentesKitEntries,
  estoqueDisponivel,
  estoqueDisponivelComKit,
  makeEstoqueUid,
  type ComponentesKit,
  type EstoqueProduto,
} from '@delfrance/schemas';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';

const ESTOQUE_LIMIT = 500;

/** The produto fields the badge needs — id always, kit fields for kits. */
export interface ProdutoParaEstoqueBadge {
  id: string;
  ehKit: boolean;
  componentesKit: ComponentesKit | null;
}

type OwnRow = { id: string; data: Pick<EstoqueProduto, 'quantidade' | 'quantidadeReservada'> };

/**
 * Pure badge value from the fetched inputs (exported for unit tests — the React
 * wiring is in {@link useEstoqueDisponivel}). Three cases:
 *  - no depósito (no integração / no integração depósito): Σ own `disponivel`
 *    across ALL depósitos — the pre-#427 fallback;
 *  - depósito + non-kit: own `disponivel` at THAT depósito (legacy single-depósito);
 *  - depósito + kit: own + `min` over `limitarEstoque` components (`estoqueDisponivelComKit`),
 *    a component with no stock at the depósito counting as 0 (#238 divergence).
 * `null` = still loading (own rows absent, or a kit whose component reads are in
 * flight) so the badge hides instead of flashing a wrong number.
 */
export function combineEstoqueDisponivel(input: {
  ownRows: readonly OwnRow[] | null | undefined;
  depositoId: string | null;
  produtoId: string;
  ehKit: boolean;
  componentesKit: ComponentesKit | null;
  /** compId → disponível at the target depósito; `undefined` while the kit reads load. */
  componentDisponivel: Record<string, number> | undefined;
}): number | null {
  const { ownRows, depositoId, produtoId, ehKit, componentesKit, componentDisponivel } = input;
  if (!ownRows) return null;

  // Reads soft-parse (`parseSoftRead`): a malformed doc can yield a non-numeric
  // quantidade → NaN. Skip such rows so the badge never shows NaN.
  if (!depositoId) {
    return ownRows.reduce((sum, row) => {
      const disp = estoqueDisponivel(row.data);
      return Number.isFinite(disp) ? sum + disp : sum;
    }, 0);
  }

  const ownRow = ownRows.find((r) => r.id === makeEstoqueUid(produtoId, depositoId));
  const ownRaw = ownRow ? estoqueDisponivel(ownRow.data) : 0;
  const ownDisp = Number.isFinite(ownRaw) ? ownRaw : 0;

  if (!ehKit) return ownDisp;
  if (componentDisponivel === undefined) return null; // kit component reads in flight
  return estoqueDisponivelComKit({ ehKit: true, componentesKit }, ownDisp, componentDisponivel);
}

/**
 * Available stock for the pedido item badge (#427). With the pedido's integração
 * `depositoId` resolved → single-depósito, kit-aware (own + assemblable-from-
 * components), matching legacy `cadastroPedidoProvider.dart` and the
 * pedido→estoque sync (which moves stock at that same depósito). Without one →
 * Σ own `disponivel` across all depósitos (the pre-#427 fallback). `null` while
 * loading or when no produto is picked.
 *
 * Own estoques stay real-time (`useSnapshot`); the kit component reads are
 * one-shot (`getDocsFromServer` via `useQuery`, mirroring `EstoqueManager`) —
 * the query's staleTime plays the legacy 1-minute cache's role.
 */
export function useEstoqueDisponivel(
  db: Firestore,
  produto: ProdutoParaEstoqueBadge | null,
  depositoId: string | null,
): number | null {
  const produtoId = produto?.id ?? null;
  const ehKit = produto?.ehKit ?? false;
  const componentesKit = produto?.componentesKit ?? null;

  const ownQuery = useMemo(
    () => (produtoId ? buildQuery(estoqueProdutoCollection.ref(db, { produtoId }), []) : null),
    [db, produtoId],
  );
  const { data: ownRows } = useSnapshot(ownQuery);

  // Countable kit components — only meaningful once a target depósito exists.
  const countableIds = useMemo(
    () =>
      ehKit && depositoId
        ? componentesKitEntries(componentesKit)
            .filter(([, kit]) => kit.limitarEstoque !== false)
            .map(([id]) => id)
            .sort()
        : [],
    [ehKit, componentesKit, depositoId],
  );

  const kitQuery = useQuery({
    queryKey: ['pedidoKitEstoque', produtoId, depositoId, countableIds],
    enabled: countableIds.length > 0,
    queryFn: async () => {
      const dep = depositoId;
      if (!dep) return {};
      const disponivel: Record<string, number> = {};
      await Promise.all(
        countableIds.map(async (compId) => {
          const snap = await getDocsFromServer(
            buildQuery(estoqueProdutoCollection.ref(db, { produtoId: compId }), [
              limit(ESTOQUE_LIMIT),
            ]),
          );
          const doc = snap.docs.find((d) => d.id === makeEstoqueUid(compId, dep));
          const disp = doc ? estoqueDisponivel(doc.data()) : NaN;
          // Non-finite (missing doc / soft-parsed junk) → leave absent so the
          // pure helper counts the component as 0 (#238).
          if (Number.isFinite(disp)) disponivel[compId] = disp;
        }),
      );
      return disponivel;
    },
  });

  // `{}` (kit, no countable components) resolves immediately; `undefined` = the
  // component reads are still loading (or not a kit / no depósito — unread then).
  const kitData = kitQuery.data;
  const componentDisponivel = useMemo(
    () => (countableIds.length === 0 ? (ehKit && depositoId ? {} : undefined) : kitData),
    [countableIds.length, ehKit, depositoId, kitData],
  );

  return useMemo(
    () =>
      produtoId === null
        ? null
        : combineEstoqueDisponivel({
            ownRows,
            depositoId,
            produtoId,
            ehKit,
            componentesKit,
            componentDisponivel,
          }),
    [ownRows, depositoId, produtoId, ehKit, componentesKit, componentDisponivel],
  );
}
