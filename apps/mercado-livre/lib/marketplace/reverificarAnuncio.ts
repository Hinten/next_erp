/**
 * Re-read ONE listing from Mercado Livre and record its real state on the link
 * doc — the operator's way out of a stock latch (#781).
 *
 * The stock sender stops sending to a listing whose link carries `estado 'E'`,
 * which it writes only after ML confirmed the anúncio itself is healthy, i.e.
 * our payload was the problem. An `items` webhook normally re-arms it, but a
 * listing nobody touches never fires one.
 *
 * Extracted from `app/api/marketplace/mercado-livre/reverificar-anuncio/route.ts`
 * so the manual stock push (#819) re-arms through the SAME code rather than a
 * second copy — the discipline that produced `applyItemStatusToLink` itself.
 * The route is now a thin wrapper around this.
 */
import {
  type MlItem,
  MercadoLivreHttpError,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import type { Firestore } from 'firebase-admin/firestore';

import { podeEnviarEstoque } from './bulkEstoquePlan';
import { type LinkStatusTarget, applyItemStatusToLink } from './itemsStatusSync';

/** The minimal ML surface a re-verification needs (injectable for tests). */
export interface ReverificarApi {
  getItem(id: string): Promise<MlItem>;
}

export interface ReverificacaoResultado {
  /** Old-shape estado code derived from the listing's fresh ML status. */
  estado: string;
  /** Raw ML `status` as of the re-check (`active`/`paused`/`closed`/…). */
  status: string | null;
  subStatus: string[] | null;
  /** Whether the stock sender will send to this listing again. */
  enviavel: boolean;
}

/**
 * Ask ML what the listing IS and record THAT (never derive the state from a
 * rejection alone — ML publishes no canonical cause table for `PUT /items/{id}`).
 * Always clears `errors`: a re-verification is the operator saying "tell me the
 * truth now", so a stale diagnosis must not survive it.
 *
 * A 404 means the listing is GONE. Recording `closed` explicitly is deliberate —
 * treating it as a no-op would leave a stale `status: 'active'` standing and the
 * sweep would keep trying.
 *
 * Transient failures (5xx / network / Firestore) THROW: nothing was confirmed,
 * so nothing may be recorded.
 */
export async function reverificarAnuncio(
  db: Firestore,
  integracaoId: string,
  target: LinkStatusTarget,
  api: ReverificarApi,
  nowMs: number,
): Promise<ReverificacaoResultado> {
  let item: MlItem;
  try {
    item = await api.getItem(target.itemId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      await applyItemStatusToLink(
        db,
        integracaoId,
        target,
        { status: 'closed', sub_status: [] },
        { nowMs, extra: { errors: [] } },
      );
      return {
        estado: estadoFromMlStatus('closed'),
        status: 'closed',
        subStatus: [],
        enviavel: false,
      };
    }
    throw err;
  }

  await applyItemStatusToLink(db, integracaoId, target, item, {
    nowMs,
    // Drop the stale diagnosis so the produto tab stops showing a fault the
    // listing may no longer have.
    extra: { errors: [] },
  });

  return {
    estado: estadoFromMlStatus(item.status),
    status: item.status ?? null,
    subStatus: item.sub_status ?? null,
    enviavel: podeEnviarEstoque(item.status, item.sub_status).enviar,
  };
}
