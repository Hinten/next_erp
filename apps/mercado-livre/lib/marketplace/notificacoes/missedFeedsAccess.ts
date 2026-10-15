/** App-scoped feed access discovery (#1292). No enqueue or credential revocation. */
import type { Firestore } from 'firebase-admin/firestore';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  createMercadoLivreApi,
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  type MercadoLivreApi,
  type MlMissedFeeds,
} from '@delfrance/integrations-mercado-livre';
import { loadMercadoLivreContext, MercadoLivreContaNotConfiguredError } from '../core/mercadoLivre';

export const PAGE_LIMIT = 50;
export const MISSED_FEEDS_SITES_ENV = 'MERCADO_LIVRE_MISSED_FEEDS_SITE_IDS';

export class MissedFeedsConfigError extends Error {
  constructor() {
    super('MERCADO_LIVRE_MISSED_FEEDS_SITE_IDS must contain comma-separated ML site codes.');
    this.name = 'MissedFeedsConfigError';
  }
}

export function missedFeedsSites(raw = process.env[MISSED_FEEDS_SITES_ENV]): string[] {
  if (raw == null || raw.trim() === '') return ['MLB'];
  const sites = raw.split(',').map((site) => site.trim());
  if (sites.some((site) => !/^[A-Z]{3}$/.test(site))) throw new MissedFeedsConfigError();
  return [...new Set(sites)];
}

export interface MissedFeedsAccess {
  examined: number;
  rejected: number;
  selected: {
    integracaoId: string;
    api: MercadoLivreApi;
    getAccessToken: () => Promise<string>;
    /** Reuse this page, including an empty one; it already proved access. */
    firstItemsPage: MlMissedFeeds;
  } | null;
}

/** Shared stable enumeration; diagnostics must not assume endpoint access. */
export async function listMissedFeedsCandidates(db: Firestore): Promise<string[]> {
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .where('ativo', '==', true)
    .get();
  // Sort in memory: retain the existing indexed (tipo, ativo) query shape.
  return snap.docs.map((doc) => doc.id).sort();
}

export async function findMissedFeedsAccess(
  db: Firestore,
  appId: string,
  siteId: string,
  checkBudget: () => void,
  progress?: (examined: number, rejected: number) => void,
): Promise<MissedFeedsAccess> {
  checkBudget();
  const candidates = await listMissedFeedsCandidates(db);
  const result: MissedFeedsAccess = { examined: 0, rejected: 0, selected: null };
  for (const integracaoId of candidates) {
    checkBudget();
    result.examined += 1;
    progress?.(result.examined, result.rejected);
    try {
      const ctx = await loadMercadoLivreContext(db, integracaoId);
      const channelCtx = await ctx.resolveChannelContext();
      checkBudget();
      const api = createMercadoLivreApi({
        getAccessToken: channelCtx.getAccessToken,
        onAccessTokenRejected: channelCtx.invalidateAccessToken,
        // Each HTTP read is bounded too: a stalled provider must leave time
        // to persist incomplete health before the 540-second function limit.
        fetch: (input, init) => {
          checkBudget();
          return fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
        },
      });
      const firstItemsPage = await api.getMissedFeeds({
        appId,
        topic: 'items',
        siteId,
        limit: PAGE_LIMIT,
        offset: 0,
      });
      result.selected = {
        integracaoId,
        api,
        getAccessToken: channelCtx.getAccessToken,
        firstItemsPage,
      };
      return result;
    } catch (err) {
      // A seller's owner-only rejection says nothing about its seller grant.
      // Never revoke it, and never retry the full feed for every seller.
      if (
        err instanceof MercadoLivreContaNotConfiguredError ||
        err instanceof MercadoLivreReauthRequiredError ||
        (err instanceof MercadoLivreHttpError && (err.status === 401 || err.status === 403))
      ) {
        result.rejected += 1;
        progress?.(result.examined, result.rejected);
        continue;
      }
      // 429, 5xx, bad wire data, transport failures and bugs are NOT no-account.
      throw err;
    }
  }
  return result;
}

/** Only an explicit missing-site error may switch the unfiltered query shape. */
export function isMissedFeedsSiteRequired(err: unknown): boolean {
  if (!(err instanceof MercadoLivreHttpError) || err.status !== 400) return false;
  if (err.body == null || typeof err.body !== 'object') return false;
  const body = err.body as Record<string, unknown>;
  const message = [body.message, body.error, body.error_description]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return (
    /site[_ -]?id/i.test(message) && /required|missing|obrigat|requer|must|inform/i.test(message)
  );
}
