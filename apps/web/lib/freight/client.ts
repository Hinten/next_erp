'use client';

/**
 * `useFreightClient()` — a memoized `FreightHttpClient` bound to the
 * current Firebase auth state, talking to the apps/integrations Melhor
 * Envio routes. Mirrors `useNFeClient` (lib/nfe/client.ts): returns
 * `null` while logged out so components can disable their buttons, and
 * passes `() => user.getIdToken()` so token refreshes propagate.
 */
import { useMemo } from 'react';

import {
  type FreightHttpClient,
  createFreightHttpClient,
} from '@delfrance/integrations-freight-br/http-client';

import { useAuth } from '@/lib/auth/useAuth';

const DEFAULT_INTEGRATIONS_URL = 'http://localhost:3001';

export function useFreightClient(): FreightHttpClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_INTEGRATIONS_URL ?? DEFAULT_INTEGRATIONS_URL;
    return createFreightHttpClient({
      baseUrl,
      getAuthToken: () => user.getIdToken(),
    });
  }, [user]);
}
