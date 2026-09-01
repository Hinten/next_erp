'use client';

import { useMemo } from 'react';
import { getDocFromServer, type Firestore } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import { buildQuery } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import {
  componentesKitEntries,
  estoqueDisponivel,
  estoqueDisponivelComKit,
  makeEstoqueUid,
  unidadeVendavel,
  type ComponentesKit,
  type EstoqueProduto,
} from '@delfrance/schemas';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getDocsByIds } from '@/lib/data/getDocsByIds';

/** The produto fields the badge needs — id always, kit fields for kits. */
export interface ProdutoParaEstoqueBadge {
  id: string;
  ehKit: boolean;
  componentesKit: ComponentesKit | null;
  /**
   * Family fields, so the badge reads the produto that actually owns the stock
   * (#1398). A parent of a family of one is a wrapper holding nothing, and the
   * line naming it would otherwise read a truthful, useless `0`.
   *
   * ⚠️ Both optional, and the caller supplies them from the produto doc it is
   * already subscribed to — no extra read. Absent (the doc has not landed yet)
   * means "not known to be a family of one", which is exactly the previous
   * behaviour: the badge reads the produto the line names.
   */
  paiId?: string | null;
  filhoUnicoId?: string | null;
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
 * With a depósito, own stock is a single-doc real-time read (`useDocSnapshot`
 * on the deterministic `est-<produtoId>-<depositoId>` id); the all-depósito
 * fallback subscribes to the whole subcollection only when no depósito is set.
 * Kit component reads are one-shot, one deterministic doc per component
 * (`getDocFromServer` via `useQuery`) — the query's staleTime plays the legacy
 * 1-minute cache's role.
 */
export function useEstoqueDisponivel(
  db: Firestore,
  produto: ProdutoParaEstoqueBadge | null,
  depositoId: string | null,
): number | null {
  // ⚠️ The produto that owns the AVAILABLE stock, which for a family of one is
  // the child. A parent may still hold a RESERVED remainder — a reservation is
  // keyed on the produto the pedido LINE names — but this badge answers
  // availability, and the reserved half is the Estoque tab's residual panel.
  const produtoId = produto ? unidadeVendavel(produto) : null;
  const ehKit = produto?.ehKit ?? false;
  const componentesKit = produto?.componentesKit ?? null;

  // Single-depósito own stock: the one deterministic estoque doc (real-time).
  const ownDocRef = useMemo(
    () =>
      produtoId && depositoId
        ? estoqueProdutoCollection.docRef(db, { produtoId }, makeEstoqueUid(produtoId, depositoId))
        : null,
    [db, produtoId, depositoId],
  );
  const ownDocSnap = useDocSnapshot(ownDocRef);

  // Fallback (no depósito): subscribe to the whole subcollection for the Σ.
  const ownCollQuery = useMemo(
    () =>
      produtoId && !depositoId
        ? buildQuery(estoqueProdutoCollection.ref(db, { produtoId }), [])
        : null,
    [db, produtoId, depositoId],
  );
  const ownCollSnap = useSnapshot(ownCollQuery);

  // Normalize both sources to the `ownRows` the pure combiner expects (a
  // 0-or-1 element list in single-depósito mode). `undefined` = still loading.
  const ownDocData = ownDocSnap.data;
  const ownDocLoading = ownDocSnap.loading;
  const ownCollData = ownCollSnap.data;
  const ownRows = useMemo<readonly OwnRow[] | undefined>(() => {
    if (!produtoId) return undefined;
    if (depositoId) {
      if (ownDocLoading) return undefined;
      return ownDocData ? [{ id: ownDocData.id, data: ownDocData.data }] : [];
    }
    return ownCollData;
  }, [produtoId, depositoId, ownDocLoading, ownDocData, ownCollData]);

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
    queryKey: ['pedidoKitEstoque', depositoId, countableIds],
    enabled: countableIds.length > 0,
    queryFn: async () => {
      const dep = depositoId;
      if (!dep) return {};

      // ⚠️ A kit component can itself be the PARENT of a family of one, and then
      // its own estoque row holds nothing — the stock is on its child (#1398).
      // That is the case #1398 was opened on: a kit reading 0 while both its
      // components had stock.
      //
      // ⚠️ ONE chunked query for the whole component set, not one read per
      // component. `getDocsByIds` splits at the SDK's 30-id `in` cap and runs the
      // chunks concurrently, so a kit of any realistic size costs ONE extra
      // query — not N extra reads on a form the operator is typing into.
      // `source: 'server'` matches the estoque reads below: this query is already
      // server-only, and a cached produto could carry a stale pointer.
      const produtos = await getDocsByIds(
        db,
        produtoCollection,
        countableIds,
        {},
        {
          source: 'server',
        },
      );
      const alvoDe = new Map(
        countableIds.map((id) => {
          const p = produtos.get(id);
          // A component we could not read resolves to ITSELF — today's behaviour,
          // and the safe direction: it counts as 0 rather than as some other
          // produto's stock.
          return [id, p ? unidadeVendavel({ ...p, id }) : id] as const;
        }),
      );

      const porAlvo = new Map<string, number>();
      await Promise.all(
        // Distinct targets: two components can resolve to one produto, and a
        // component that IS another's sole member collapses onto it.
        [...new Set(alvoDe.values())].map(async (alvo) => {
          // One deterministic doc, not a subcollection scan (a target beyond a
          // page limit would wrongly read as missing).
          const snap = await getDocFromServer(
            estoqueProdutoCollection.docRef(db, { produtoId: alvo }, makeEstoqueUid(alvo, dep)),
          );
          const disp = snap.exists() ? estoqueDisponivel(snap.data()) : NaN;
          // Non-finite (missing doc / soft-parsed junk) → leave absent so the
          // pure helper counts the component as 0 (#238).
          if (Number.isFinite(disp)) porAlvo.set(alvo, disp);
        }),
      );

      // Keyed by the id the KIT names, whatever answered for it — `componentesKit`
      // is not rewritten by any of this.
      const disponivel: Record<string, number> = {};
      for (const [id, alvo] of alvoDe) {
        const disp = porAlvo.get(alvo);
        if (disp !== undefined) disponivel[id] = disp;
      }
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
