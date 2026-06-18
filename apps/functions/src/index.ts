// Import side-effect first: registers global function options (region) before
// any trigger is defined. Throws if FUNCTIONS_REGION is unset (see options.ts).
import './options';

/**
 * Cloud Functions entrypoint (gen2). Firebase deploys each exported trigger.
 */
export { resizeProductImage } from './product-images/resizeProductImage';
export { reconcileProductImages } from './product-images/reconcileSweep';
export { onArquivoDeleted } from './arquivos/onArquivoDeleted';
export { reconcileArquivoOrphans } from './arquivos/arquivoOrphanSweep';
