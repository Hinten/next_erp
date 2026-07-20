// Import side-effect first: registers global function options (region) + wires
// the bundled data-file dirs (NFE_CA_DIR / NFE_SCHEMA_DIR) before any trigger is
// defined. See options.ts.
import './options';

import { RECONCILE_FUNCTION } from '../../lib/nfe/tasks';
import * as reconcileHandlers from './reconciliar';

/**
 * NF-e async reconciler Cloud Functions (gen2), codebase `nfe`. These EXECUTE the
 * reconcile/sweep logic in-process (no HTTP hop back to apps/nfe) — the heavy
 * NF-e library (cert, SOAP, XSD) is bundled here, which is why this is a
 * dedicated codebase, separate from the lean `storage` functions.
 */

// Rename-safety (#437): the DEPLOYED function name — and thus its
// auto-provisioned Cloud Tasks queue — is the export KEY of the handler below,
// while the producer (apps/nfe/lib/nfe/tasks.ts) enqueues against
// `RECONCILE_FUNCTION`. ESM export names must be static literals (you can't
// compute an `export const` name), so instead of deriving one from the other we
// assert — at module load, i.e. during Firebase's deploy codebase-analysis —
// that they never drifted. A rename that updates only one side fails the deploy
// loudly here instead of silently enqueuing onto a queue that doesn't exist.
// (The reconciliar.test.ts coupling test catches the same drift in CI.)
if (!(RECONCILE_FUNCTION in reconcileHandlers)) {
  throw new Error(
    `[nfe] function-name drift: functions/src/reconciliar.ts must export a ` +
      `trigger named '${RECONCILE_FUNCTION}' (the enqueue target). ` +
      `Rename the export and the RECONCILE_FUNCTION constant together.`,
  );
}

export { reconciliarNfe } from './reconciliar';
export { nfeReconcileSweep } from './sweep';
