'use client';

import { type ReactNode, useState } from 'react';
import { type DefaultOptions, QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The app's TanStack defaults. Exported so a component test can build its
 * `QueryClient` with THESE rather than its own: a per-query override (e.g.
 * `staleTime: 0`, `retry: false`) is only proved load-bearing against the
 * defaults it overrides.
 */
export const QUERY_DEFAULT_OPTIONS: DefaultOptions = {
  queries: {
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  },
};

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
