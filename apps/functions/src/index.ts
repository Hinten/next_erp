/**
 * Cloud Functions entrypoint (gen2). Firebase deploys each exported trigger.
 */
export { resizeProductImage } from './resizeProductImage';
export { onArquivoDeleted } from './onArquivoDeleted';
export { cleanupOrphanArquivos } from './cleanupOrphanArquivos';
