'use client';

import { useMemo } from 'react';
import { useDocSnapshot } from '@delfrance/data/hooks';
import { useTenant } from '@/lib/auth';
import { grupoEconomicoCollection } from './grupoEconomicoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Real-time subscription to the current user's GrupoEconomico document.
 * Returns `loading: true` until both the auth claims AND the doc resolve;
 * `data: null` when the claim has no grupoEconomico bound (signed-in but
 * not yet onboarded to a tenant).
 */
export function useGrupoEconomico() {
  const { claims, loading: claimsLoading } = useTenant();

  const ref = useMemo(() => {
    if (claimsLoading) return null;
    if (!claims?.grupoEconomico) return null;
    return grupoEconomicoCollection.docRef(getFirebaseFirestore(), {}, claims.grupoEconomico);
  }, [claimsLoading, claims?.grupoEconomico]);

  const snapshot = useDocSnapshot(ref);

  return {
    data: snapshot.data,
    loading: claimsLoading || snapshot.loading,
    error: snapshot.error,
  };
}
