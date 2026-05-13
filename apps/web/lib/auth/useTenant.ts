'use client';

import { useEffect, useState } from 'react';
import { useAuth } from './useAuth';

export interface TenantClaims {
  grupoEconomico: string | null;
  // Permissions are encoded as a BigInt string in custom claims to avoid
  // the JS 53-bit number limit. Decode on read with BigInt(value).
  permissions: string | null;
}

export function useTenant(): { claims: TenantClaims | null; loading: boolean } {
  const { user, loading: authLoading } = useAuth();
  const [claims, setClaims] = useState<TenantClaims | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setClaims(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    user
      .getIdTokenResult()
      .then((result) => {
        if (cancelled) return;
        setClaims({
          grupoEconomico:
            (result.claims.grupoEconomico as string | undefined) ?? null,
          permissions: (result.claims.permissions as string | undefined) ?? null,
        });
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setClaims(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  return { claims, loading };
}
