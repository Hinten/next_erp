/**
 * Server-only half of `@delfrance/ai` — everything that reaches `@google/genai`
 * or `firebase-admin`.
 *
 * Split out so the browser can never reach it. `apps/web` imports the prompt
 * types transitively through the Mercado Livre package; if the model client and
 * the Admin SDK sat behind the same entry, they would ride along.
 */
export {
  AiNotConfiguredError,
  AiUnparseableAnswerError,
  createVertexGenerateFn,
  createVertexListModelsFn,
  DEFAULT_AI_LOCATION,
  __resetAiClient,
  type GenerateArgs,
  type GenerateFn,
  type ListModelsFn,
} from './provider';

export { getAiModelosCached, modelosParaValidacao, __resetAiModelosCache } from './modelosCache';

export {
  loadConfigIa,
  __resetConfigIaCache,
  CONFIG_IA_MODELO_PADRAO,
  PROVEDOR_IA,
} from './configIa';

export {
  loadFotoImage,
  loadFotoImages,
  FOTO_IMAGE_VARIANTS,
  type FotoImageVariant,
  type LoadFotoImageDeps,
  type LoadFotoImageOptions,
} from './fotoImage';
