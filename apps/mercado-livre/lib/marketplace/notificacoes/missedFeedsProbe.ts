/** Read-only provider diagnostic. Summaries contain no raw bodies or headers. */
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
} from '@delfrance/integrations-mercado-livre';
import { loadMercadoLivreContext, MercadoLivreContaNotConfiguredError } from '../core/mercadoLivre';
import { listMissedFeedsCandidates } from './missedFeedsAccess';

export interface MissedFeedsProbeRow {
  query: 'unfiltered' | 'items-without-site' | 'items-with-site';
  status: number;
  shape: 'invalid-json' | 'non-object' | 'missing-messages' | 'invalid-messages' | 'messages-array';
  count: number | null;
  topics: Record<string, number>;
}

export async function probeMissedFeeds(
  appId: string,
  getAccessToken: () => Promise<string>,
  siteId = 'MLB',
  fetchImpl: typeof fetch = fetch,
  checkBudget: () => void = () => {},
): Promise<MissedFeedsProbeRow[]> {
  const rows: MissedFeedsProbeRow[] = [];
  for (const query of ['unfiltered', 'items-without-site', 'items-with-site'] as const) {
    const url = new URL('https://api.mercadolibre.com/missed_feeds');
    url.searchParams.set('app_id', appId);
    url.searchParams.set('limit', '5');
    if (query !== 'unfiltered') url.searchParams.set('topic', 'items');
    if (query === 'items-with-site') url.searchParams.set('site_id', siteId);
    checkBudget();
    const token = await getAccessToken();
    checkBudget();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new MercadoLivreNetworkError('Missed-feeds probe transport failed.', err);
    }
    const row: MissedFeedsProbeRow = {
      query,
      status: response.status,
      shape: 'invalid-json',
      count: null,
      topics: {},
    };
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      rows.push(row);
      continue;
    }
    if (body == null || typeof body !== 'object' || Array.isArray(body)) row.shape = 'non-object';
    else {
      const messages = (body as Record<string, unknown>).messages;
      if (messages === undefined) row.shape = 'missing-messages';
      else if (!Array.isArray(messages)) row.shape = 'invalid-messages';
      else {
        row.shape = 'messages-array';
        row.count = messages.length;
        for (const message of messages as unknown[]) {
          const topic =
            message != null && typeof message === 'object'
              ? (message as Record<string, unknown>).topic
              : null;
          // A malformed field must not smuggle arbitrary provider content into logs.
          const key =
            typeof topic === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(topic)
              ? topic
              : '(invalid)';
          const previous = Object.hasOwn(row.topics, key) ? row.topics[key]! : 0;
          Object.defineProperty(row.topics, key, {
            value: previous + 1,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Capture failed query shapes too, then try the next connected credential. */
export async function probeMissedFeedsAccounts(
  db: Firestore,
  appId: string,
  siteId: string,
  checkBudget: () => void,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  examined: number;
  rejected: number;
  selectedIntegracaoId: string | null;
  attempts: Array<{ integracaoId: string; rows: MissedFeedsProbeRow[] }>;
}> {
  checkBudget();
  const candidates = await listMissedFeedsCandidates(db);
  const result = {
    examined: 0,
    rejected: 0,
    selectedIntegracaoId: null as string | null,
    attempts: [] as Array<{ integracaoId: string; rows: MissedFeedsProbeRow[] }>,
  };
  for (const integracaoId of candidates) {
    checkBudget();
    result.examined += 1;
    try {
      const ctx = await loadMercadoLivreContext(db, integracaoId);
      const channelCtx = await ctx.resolveChannelContext();
      const rows = await probeMissedFeeds(
        appId,
        channelCtx.getAccessToken,
        siteId,
        fetchImpl,
        checkBudget,
      );
      result.attempts.push({ integracaoId, rows });
      const items = rows.find((row) => row.query === 'items-with-site')!;
      if (items.status >= 200 && items.status < 300 && items.shape === 'messages-array') {
        result.selectedIntegracaoId = integracaoId;
        break;
      }
    } catch (err) {
      if (
        !(err instanceof MercadoLivreContaNotConfiguredError) &&
        !(err instanceof MercadoLivreReauthRequiredError)
      )
        throw err;
    }
    result.rejected += 1;
  }
  return result;
}
