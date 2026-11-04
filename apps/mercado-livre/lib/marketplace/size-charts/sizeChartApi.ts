import {
  createMercadoLivreApi,
  type MercadoLivreApiConfig,
} from '@delfrance/integrations-mercado-livre';
import { CHART_WORKER_MS } from './sizeChartOperation';

/** The journal owns retries; an unknown POST must never be retried by fetch. */
export function createChartApi(
  config: Pick<MercadoLivreApiConfig, 'getAccessToken' | 'onAccessTokenRejected'>,
) {
  const deadlineMs = Date.now() + CHART_WORKER_MS;
  return createMercadoLivreApi({
    ...config,
    maxRetries: 0,
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadlineMs - Date.now()))),
      }),
  });
}
