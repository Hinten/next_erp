// Import side-effect first: registers global function options (region) before
// any trigger is defined. Throws if FUNCTIONS_REGION is unset (see options.ts).
import './options';

/**
 * Cloud Functions entrypoint (gen2). Firebase deploys each exported trigger.
 */
export { resizeProductImage } from './product-images/resizeProductImage';
export { reconcileProductImages } from './product-images/reconcileSweep';

// NF-e async reconciler (#77/#81): Cloud Tasks dispatcher (auto-provisions its
// queue) + the scheduled backstop sweep. Both forward to apps/nfe over OIDC.
export { reconciliarNfe } from './nfe/reconciliar';
export { nfeReconcileSweep } from './nfe/sweep';
