'use client';

/**
 * `useNFeClient()` — a memoized `NFeHttpClient` bound to the current
 * Firebase auth state. Returns `null` while the user is logged out so
 * components can disable their action buttons cleanly; once the user
 * is present, the client passes `() => user.getIdToken()` as the
 * `getAuthToken` callback so token refreshes propagate transparently.
 *
 * The client is wrapped with `withNFeRetry` so a transient network/5xx/503
 * blip doesn't surface to the operator on the first hiccup (#90). Retry policy
 * is per-endpoint — see `withNFeRetry`.
 */
import { useMemo } from 'react';

import { createNFeHttpClient, type NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';

import { useAuth } from '@/lib/auth/useAuth';
import { withNFeRetry } from './withNFeRetry';

const DEFAULT_NFE_URL = 'http://localhost:3004';

export function useNFeClient(): NFeHttpClient | null {
  const { user } = useAuth();
  return useMemo(() => {
    if (!user) return null;
    const baseUrl = process.env.NEXT_PUBLIC_NFE_URL ?? DEFAULT_NFE_URL;
    return withNFeRetry(
      createNFeHttpClient({
        baseUrl,
        getAuthToken: () => user.getIdToken(),
      }),
    );
  }, [user]);
}
