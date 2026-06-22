// Import side-effect first: registers global function options (region) + wires
// the bundled data-file dirs (NFE_CA_DIR / NFE_SCHEMA_DIR) before any trigger is
// defined. See options.ts.
import './options';

/**
 * NF-e async reconciler Cloud Functions (gen2), codebase `nfe`. These EXECUTE the
 * reconcile/sweep logic in-process (no HTTP hop back to apps/nfe) — the heavy
 * NF-e library (cert, SOAP, XSD) is bundled here, which is why this is a
 * dedicated codebase, separate from the lean `storage` functions.
 */
export { reconciliarNfe } from './reconciliar';
export { nfeReconcileSweep } from './sweep';
