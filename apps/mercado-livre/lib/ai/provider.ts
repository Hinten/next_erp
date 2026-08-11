/**
 * The one place in this repo that talks to a model.
 *
 * `GenerateFn` is the seam: everything above it — the schema, the prompt, the
 * applier, the route — is provider-neutral, and every test drives a fake. That
 * matters more here than usual, because `apps/mercado-livre` is **not** in
 * `ci.yml`'s exclusion list, so its suite runs on every PR and must never reach
 * Gemini, Vertex, ADC or the network.
 *
 * ## Why `@google/genai` and not Genkit
 *
 * Decided 2026-08-11 with the numbers in hand. `@google/genai` has four direct
 * dependencies and its `google-auth-library ^10.3.0` **dedupes** with the
 * repo's catalogued `^10.6.2`. Genkit brings 21, including express, cors and
 * eight OpenTelemetry packages, still pins `zod ^3.23.8` against this repo's
 * Zod 4 — a mismatch with no type error to warn you — and its plugin pins a
 * second major of the auth library. Both cover Imagen and Veo, so future image
 * and video generation is not a differentiator.
 *
 * The one thing Genkit has that this does not is Vertex **Model Garden**
 * (Claude, Llama, Mistral). That is not a lock-out: Claude on Vertex speaks
 * Anthropic's own API, and `@anthropic-ai/vertex-sdk` authenticates through the
 * same ADC, project and IAM — one lean SDK behind this same seam, added only
 * for a vendor actually adopted.
 *
 * ## Auth
 *
 * Vertex mode with Application Default Credentials. **No API key exists
 * anywhere in this repo**, and `apphosting.yaml` gains no `secret:` entry — the
 * App Hosting compute service account authenticates itself, exactly as
 * `firebase-admin` already does here.
 */
import { GoogleGenAI, type Part } from '@google/genai';
import type { AiPromptRequest } from '@delfrance/integrations-mercado-livre';

export interface GenerateArgs {
  model: string;
  request: AiPromptRequest;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  signal?: AbortSignal;
}

/**
 * Runs one model call and returns its **parsed JSON** answer, untrusted.
 *
 * Deliberately `unknown`: `applyAiAttributes` is the boundary that validates
 * it, and typing this as anything friendlier would invite callers to skip that.
 */
export type GenerateFn = (args: GenerateArgs) => Promise<unknown>;

/** Thrown when the model returns something that is not JSON at all. */
export class AiUnparseableAnswerError extends Error {
  constructor(readonly raw: string) {
    super('O modelo respondeu em um formato inesperado.');
    this.name = 'AiUnparseableAnswerError';
  }
}

/** Thrown when the backend is missing the project/location it needs. */
export class AiNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`Configuração de IA ausente: ${missing}.`);
    this.name = 'AiNotConfiguredError';
  }
}

/** Vertex's default region; overridable per deployment. */
const DEFAULT_LOCATION = 'us-central1';

let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  // `GOOGLE_CLOUD_PROJECT` is injected by App Hosting / Cloud Run; the fallback
  // covers a local `pnpm dev`, where it comes from .env.local.
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID;
  if (!project) throw new AiNotConfiguredError('GOOGLE_CLOUD_PROJECT');
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? DEFAULT_LOCATION;
  cachedClient = new GoogleGenAI({ vertexai: true, project, location });
  return cachedClient;
}

/** Test seam — the client memoizes, and a test that swaps env must reset it. */
export function __resetAiClient(): void {
  cachedClient = null;
}

/**
 * The real Vertex call.
 *
 * ⚠️ The schema goes in **`responseJsonSchema`**, not `responseSchema`. They are
 * different fields: the older one takes a restricted OpenAPI subset, and the
 * SDK's own migration note says JSON Schema moved to `responseJsonSchema`. Our
 * schema carries `additionalProperties: false` and deliberately carries **no
 * `required`** — put it in the wrong field and those are dropped or rejected,
 * which quietly removes the anti-hallucination guarantee `attributeSchema.ts`
 * exists to provide.
 */
export function createVertexGenerateFn(): GenerateFn {
  return async ({ model, request, temperature, maxOutputTokens, signal }) => {
    const parts: Part[] = [{ text: request.text }];
    if (request.image) {
      // Inline bytes, never a URL — the legacy passed a tokened Storage HTTPS
      // URL as Vertex `fileUri`, a field documented for gs:// and YouTube only.
      parts.push({
        inlineData: { data: request.image.base64, mimeType: request.image.mimeType },
      });
    }

    const response = await getClient().models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: request.systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: request.responseSchema,
        ...(temperature != null ? { temperature } : {}),
        ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      },
    });

    const text = response.text ?? '';
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      // Narrow: only a parse failure becomes our error. Anything else is a bug
      // and must not be disguised as a bad model answer.
      if (err instanceof SyntaxError) throw new AiUnparseableAnswerError(text);
      throw err;
    }
  };
}
