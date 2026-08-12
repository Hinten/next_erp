/**
 * Process-scoped cache for the provider's model catalogue.
 *
 * The list changes when Google ships a model — months apart — and it is read
 * every time the settings page opens and again on every suggestion call (for the
 * re-validation). Caching it at the config TTL turns that into one call per
 * warm instance per 15 minutes.
 *
 * ⚠️ **A failed live call must not be cached as an answer**, or a transient
 * Vertex blip would pin the fallback list for 15 minutes and the page would keep
 * claiming the catalogue is unavailable after it recovered. `createReadCache`
 * never caches a rejection — so the rejection has to propagate out of the loader
 * and be turned into the fallback by the CALLER, not swallowed inside it.
 */
import { READ_CACHE_TTL, createReadCache } from '@delfrance/data/admin/cache';

import {
  AI_MODELOS_FALLBACK,
  projectModelos,
  type AiModelosResult,
  type ProviderModelRow,
} from './models';

const modelosCache = createReadCache<readonly ['base'], AiModelosResult>({
  name: 'ai:modelos',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 2,
});

/**
 * The model list, cached, with the shipped fallback on any failure.
 *
 * Returns `fonte: 'fallback'` when the provider could not be reached or answered
 * nothing usable, so the UI can say which list it is showing instead of
 * implying the catalogue is live.
 */
export async function getAiModelosCached(
  list: () => Promise<ProviderModelRow[]>,
): Promise<AiModelosResult> {
  try {
    return await modelosCache.get(['base'], async () => projectModelos(await list()));
  } catch (err) {
    // Narrow deliberately wide here, and ONLY here: this is a metadata read
    // whose whole purpose is to be optional. Anything the provider or the auth
    // layer can throw — a 403 from a missing IAM grant, a 404 from a location
    // that serves no models, a network reset — has the same correct answer,
    // which is "use the shipped list". Rethrowing would take the settings page
    // and every suggestion down over a nice-to-have dropdown.
    //
    // `Error` is the parent of every exception and normally banned as a sole
    // `instanceof` (the repo's `no-error-as-sole-instanceof` rule), so this
    // catch is intentionally NOT narrowed at all rather than narrowed
    // misleadingly: the recovery is the same for every class.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { modelos: [...AI_MODELOS_FALLBACK], fonte: 'fallback', erro: messageOf(err) };
  }
}

/** Test seam — the cache memoizes across calls within a process. */
export function __resetAiModelosCache(): void {
  modelosCache.clear();
}

/**
 * A short reason for the log and the page, never the raw object: a provider
 * error can carry a response body, and this string reaches a browser.
 */
function messageOf(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message.slice(0, 200);
  return 'Falha ao consultar os modelos disponíveis.';
}
