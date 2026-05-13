'use client';

import { useMemo } from 'react';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import type { Pedido } from '@delfrance/schemas';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Real-time read of the last N pedidos used to feed every report.
 * Aggregations in `lib/reports/aggregations.ts` consume the result.
 *
 * Caveat: client-side aggregation is fine while a tenant has tens of
 * thousands of pedidos at most. Big tenants want a server-aggregated
 * mirror collection (out of scope for Phase 3.4).
 */
export function useRecentPedidos(pageSize = 500) {
  const q = useMemo(() => {
    const base = pedidoCollection.ref(getFirebaseFirestore(), {});
    return buildQuery(base, [orderByField('numero', 'desc'), limit(pageSize)]);
  }, [pageSize]);

  return useSnapshot<Pedido>(q);
}
