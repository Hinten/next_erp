/**
 * `@delfrance/ai` — the model runtime, shared by every AI agent in the repo.
 *
 * Everything here is **agent-neutral and provider-neutral**. What an agent asks
 * for (its response schema, its prompt, the boundary that validates the answer)
 * stays with that agent, next to the domain it understands; what every agent
 * needs identically — the call itself, the model list, the settings document,
 * the in-flight guard — lives here.
 *
 * ⚠️ **This entry is browser-safe and must stay that way.** `apps/web` reaches
 * it transitively (the Mercado Livre package re-exports `AiPromptRequest` from
 * here), so anything importing `@google/genai` or `firebase-admin` belongs
 * behind the `./admin` subpath instead — that is the whole reason for the split,
 * not tidiness. Adding an admin import here is a silent bundle regression.
 *
 * ⚠️ This package is **not** in `ci.yml`'s exclusion list, so its suite runs on
 * every PR and must never reach Gemini, Vertex, ADC or the network. `GenerateFn`
 * and `ListModelsFn` are the seams that make that possible — keep every test on
 * a fake.
 */
export type { AiInlineImage, AiPromptRequest, JsonSchemaNode } from './prompt';

export { coerceText, normalizeLoose } from './text';

export { aiCellKey, preCheckedCells, type AiGridCellRef } from './cells';

export {
  AI_MODELOS_FALLBACK,
  bareModelId,
  isSuggestionCapable,
  projectModelos,
  resolveModelo,
  type AiModelo,
  type AiModelosFonte,
  type AiModelosResult,
  type ProviderModelRow,
} from './models';

export { AlreadyRunningError, runSingleFlight, __resetSingleFlight } from './singleFlight';
