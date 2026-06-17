'use client';

/**
 * `useFreightClient()` — a memoized `FreightHttpClient` bound to the
 * current Firebase auth state, talking to the apps/melhor-envio Melhor
 * Envio routes (its own App Hosting backend, separate from apps/integrations).
 * Mirrors `useNFeClient` (lib/nfe/client.ts): returns `null` while logged out
 * so components can disable their buttons, and passes `() => user.getIdToken()`
 * so token refreshes propagate.
 */
import { useMemo } from 'react';

import {
  type FreightHttpClient,
  createFreightHttpClient,
} from '@delfrance/integrations-freight-br/http-client';

import { useAuth } from '@/lib/auth/useAuth';

const DEFAULT_MELHOR_ENVIO_URL = 'http://localhost:3005';

export function useFreightClient(): FreightHttpClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_MELHOR_ENVIO_URL ?? DEFAULT_MELHOR_ENVIO_URL;
    return createFreightHttpClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
