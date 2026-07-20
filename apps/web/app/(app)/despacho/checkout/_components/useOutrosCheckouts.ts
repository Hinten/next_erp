'use client';

import { useMemo } from 'react';
import type { Firestore, FirestoreError } from 'firebase/firestore';
import { useSnapshot, type SnapshotRow } from '@delfrance/data/hooks';
import type { CheckoutFretePedido, FreteDoPedido, ItemCheckoutPedido } from '@delfrance/schemas';
import { outrosCheckoutsQuery } from '@/lib/checkout/queries';

/**
 * One FROZEN row of the "Outros Checkouts" panel — a past checkout of the
 * current operator, across all pedidos. The `pedidoId` is parsed from the doc
 * PATH (`pedidos/<pedidoId>/checkout/<checkoutId>`), NOT from any denormalized
 * field, so a reprint driven off this row can only ever target the row's OWN
 * pedido. `frete` is the checkout-time snapshot (`freteNoMomentoDoCheckout`) —
 * used for DISPLAY and the sem-frete gate only; a reprint re-fetches the pedido's
 * LIVE frete (see `reprintCheckoutEtiqueta`). This is the wrong-label-bug armor.
 */
export interface OutroCheckoutRow {
  readonly checkoutId: string;
  readonly pedidoId: string;
  /** `title` = the pedido número at checkout time; null falls back to the id. */
  readonly numero: string | null;
  readonly timestampMs: number | null;
  readonly obs: string | null;
  /** The frozen frete snapshot at checkout time (display + sem-frete gate only). */
  readonly frete: FreteDoPedido;
  readonly itens: readonly ItemCheckoutPedido[];
}

/**
 * Parse one collection-group snapshot row into a frozen {@link OutroCheckoutRow}.
 * Returns `null` for a path that isn't the expected 4-segment checkout path
 * (defensive — a `checkout` group query only ever yields those leaves).
 */
export function parseOutroCheckoutRow(
  row: SnapshotRow<CheckoutFretePedido>,
): OutroCheckoutRow | null {
  // pedidos/<pedidoId>/checkout/<checkoutId>
  const segs = row.path.split('/');
  if (segs.length !== 4 || segs[0] !== 'pedidos' || segs[2] !== 'checkout') return null;
  const pedidoId = segs[1];
  if (!pedidoId) return null;
  const d = row.data;
  return {
    checkoutId: row.id,
    pedidoId,
    numero: d.title ?? null,
    timestampMs: d.timestamp ?? null,
    obs: d.obs ?? null,
    frete: d.freteNoMomentoDoCheckout,
    itens: d.itensCheckout ?? [],
  };
}

/**
 * Realtime "Outros Checkouts" for the current operator (`uid`) — the most-recent
 * 50 checkout docs across all pedidos, newest first. The query is memoized on
 * `(db, uid)` so the `onSnapshot` listener isn't torn down and re-created every
 * render; passing `uid === null` (logged out / unresolved) yields an empty,
 * non-subscribing result.
 */
export function useOutrosCheckouts(
  db: Firestore,
  uid: string | null,
): { rows: OutroCheckoutRow[]; loading: boolean; error: FirestoreError | undefined } {
  const q = useMemo(() => (uid ? outrosCheckoutsQuery(db, uid) : null), [db, uid]);
  const { data, loading, error } = useSnapshot(q);
  const rows = useMemo(
    () => (data ?? []).map(parseOutroCheckoutRow).filter((r): r is OutroCheckoutRow => r !== null),
    [data],
  );
  return { rows, loading, error };
}
