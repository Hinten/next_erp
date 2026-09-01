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
  const alvoId = produto ? unidadeVendavel(produto) : null;
  const proprioId = produto?.id ?? null;
  /**
   * The id the line NAMES, when it is not the one that owns the stock.
   *
   * ⚠️ `filhoUnicoId` records that the family has exactly one child; it says
   * NOTHING about where the units sit. `upSoleMember` moves them, but that is
   * the Mercado Livre publish path — a produto whose stock was lançado on the
   * parent and never moved still has the number there. Resolving past it would
   * render a confident red "0 em estoque" on the screen where the operator picks
   * quantities, which is worse than hiding the badge.
   *
   * So the produto's own row is subscribed as a FALLBACK and used only when the
   * sole member has no row at all. ⚠️ When BOTH hold units the sole member's
   * answers, matching what the ERP does for any parent/child split; the parent's
   * remainder is `residualEstoquePai`'s job.
   */
  const fallbackId =
    alvoId !== null && proprioId !== null && alvoId !== proprioId ? proprioId : null;
  const ehKit = produto?.ehKit ?? false;
  const componentesKit = produto?.componentesKit ?? null;

  // Single-depósito own stock: the one deterministic estoque doc (real-time).
  const ownDocRef = useMemo(
    () =>
      alvoId && depositoId
        ? estoqueProdutoCollection.docRef(
            db,
            { produtoId: alvoId },
            makeEstoqueUid(alvoId, depositoId),
          )
        : null,
    [db, alvoId, depositoId],
  );
  const ownDocSnap = useDocSnapshot(ownDocRef);

  // No depósito: subscribe to the whole subcollection for the Σ.
  const ownCollQuery = useMemo(
    () =>
      alvoId && !depositoId
        ? buildQuery(estoqueProdutoCollection.ref(db, { produtoId: alvoId }), [])
        : null,
    [db, alvoId, depositoId],
  );
  const ownCollSnap = useSnapshot(ownCollQuery);

  // The same two reads against the produto the line NAMES — null, and therefore
  // never subscribed, unless it differs from the one that owns the stock.
  const fbDocRef = useMemo(
    () =>
      fallbackId && depositoId
        ? estoqueProdutoCollection.docRef(
            db,
            { produtoId: fallbackId },
            makeEstoqueUid(fallbackId, depositoId),
          )
        : null,
    [db, fallbackId, depositoId],
  );
  const fbDocSnap = useDocSnapshot(fbDocRef);
  const fbCollQuery = useMemo(
    () =>
      fallbackId && !depositoId
        ? buildQuery(estoqueProdutoCollection.ref(db, { produtoId: fallbackId }), [])
        : null,
    [db, fallbackId, depositoId],
  );
  const fbCollSnap = useSnapshot(fbCollQuery);

  // Normalize both sources to the `ownRows` the pure combiner expects (a
  // 0-or-1 element list in single-depósito mode). `undefined` = still loading.
  //
  // ⚠️ The ANSWERING id travels with the rows. `combineEstoqueDisponivel` finds
  // the single-depósito row by `makeEstoqueUid(produtoId, depositoId)`, so if the
  // fallback answered, the combiner has to be told the row belongs to the
  // produto the line names — otherwise it looks for the sole member's id, finds
  // nothing, and reports the `0` this fallback exists to prevent.
  const ownDocData = ownDocSnap.data;
  const ownDocLoading = ownDocSnap.loading;
  const ownCollData = ownCollSnap.data;
  const fbDocData = fbDocSnap.data;
  const fbDocLoading = fbDocSnap.loading;
  const fbCollData = fbCollSnap.data;
  const leitura = useMemo<{ rows: readonly OwnRow[] | undefined; id: string } | null>(() => {
    if (!alvoId) return null;
    if (depositoId) {
      if (ownDocLoading) return { rows: undefined, id: alvoId };
      if (ownDocData) return { rows: [{ id: ownDocData.id, data: ownDocData.data }], id: alvoId };
      if (!fallbackId) return { rows: [], id: alvoId };
      if (fbDocLoading) return { rows: undefined, id: fallbackId };
      return {
        rows: fbDocData ? [{ id: fbDocData.id, data: fbDocData.data }] : [],
        id: fallbackId,
      };
    }
    // Σ across depósitos: the sole member answers whenever it has ANY row.
    if (ownCollData === undefined) return { rows: undefined, id: alvoId };
    if (ownCollData.length > 0 || !fallbackId) return { rows: ownCollData, id: alvoId };
    return { rows: fbCollData, id: fallbackId };
  }, [
    alvoId,
    fallbackId,
    depositoId,
    ownDocLoading,
    ownDocData,
    ownCollData,
    fbDocLoading,
    fbDocData,
    fbCollData,
  ]);
  const ownRows = leitura?.rows;

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
      const disponivel: Record<string, number> = {};
      await Promise.all(
        countableIds.map(async (compId) => {
          // One deterministic doc, not a subcollection scan (a target beyond a
          // page limit would wrongly read as missing).
          const snap = await getDocFromServer(
            estoqueProdutoCollection.docRef(db, { produtoId: compId }, makeEstoqueUid(compId, dep)),
          );
          const disp = snap.exists() ? estoqueDisponivel(snap.data()) : NaN;
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

  const produtoIdDasLinhas = leitura?.id ?? null;
  return useMemo(
    () =>
      produtoIdDasLinhas === null
        ? null
        : combineEstoqueDisponivel({
            ownRows,
            depositoId,
            produtoId: produtoIdDasLinhas,
            ehKit,
            componentesKit,
            componentDisponivel,
          }),
    [ownRows, depositoId, produtoIdDasLinhas, ehKit, componentesKit, componentDisponivel],
  );
}
