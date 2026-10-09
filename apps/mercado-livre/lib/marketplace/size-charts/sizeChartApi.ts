import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { CHART_WORKER_MS } from './sizeChartOperation';

/** The journal owns retries; an unknown POST must never be retried by fetch. */
export function createChartApi(accessToken: string) {
  const deadlineMs = Date.now() + CHART_WORKER_MS;
  return createMercadoLivreApi({
    getAccessToken: async () => accessToken,
    maxRetries: 0,
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadlineMs - Date.now()))),
      }),
  });
}
