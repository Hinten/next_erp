// Import side-effect first: registers the global options (region, cost caps)
// before any trigger is defined. See options.ts.
import './options';

import { logger } from 'firebase-functions/v2';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

import { SOURCE_DATABASE_ID, credentialPolicy, sourceDb, targetDb } from './admin';
import { mirrorPath } from './mirror';

/**
 * `legacy-mirror` codebase — TEMPORARY, migration-only (ADR 0013, amendment
 * 2026-11-26). Deployed INTO the legacy Flutter project; copies every write there
 * into the new Enterprise project until the cutover, then is deleted.
 *
 * One trigger per document depth. A wildcard in a COLLECTION segment matches every
 * collection at that depth, and the legacy data goes three levels deep
 * (`produtos/{p}/estoques/{e}/historicoEstoque/{h}`, `pedidos/{p}/nfev4/{n}/cce/{c}`,
 * …), so three triggers cover every path without a list that could miss one —
 * including paths that only the legacy Python/Node functions write.
 *
 * `retry: true`: a failed copy is redelivered (Eventarc, up to 7 days), and the
 * watermark makes a late redelivery harmless. Errors propagate on purpose — a
 * swallowed one would be a silently missing document in the new project.
 */
function mirrorTrigger(document: string) {
  return onDocumentWritten(
    { document, database: SOURCE_DATABASE_ID, retry: true },
    async (event) => {
      const outcome = await mirrorPath(event.document, sourceDb(), targetDb(), {
        credentials: credentialPolicy(),
      });
      // Only the interesting case is logged: an applied copy is the norm, and one
      // log line per legacy write would be the largest line item of this codebase.
      if (outcome === 'skipped') {
        logger.info('[legacy-mirror] stale observation skipped', { document: event.document });
      }
    },
  );
}

export const legacyMirrorDepth1 = mirrorTrigger('{c1}/{d1}');
export const legacyMirrorDepth2 = mirrorTrigger('{c1}/{d1}/{c2}/{d2}');
export const legacyMirrorDepth3 = mirrorTrigger('{c1}/{d1}/{c2}/{d2}/{c3}/{d3}');
