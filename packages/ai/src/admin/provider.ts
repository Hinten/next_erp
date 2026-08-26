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
import type { AiPromptRequest } from '../prompt';

import type { ProviderModelRow } from '../models';

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

/**
 * ⚠️ **`global`, not a region.** Verified against Vertex on 2026-08-11: the
 * models this feature is built around — `gemini-3.5-flash-lite` (the shipped
 * default), `gemini-3.1-flash-lite`, `gemini-3.6-flash` — are served at
 * `global` and **404 at `us-central1`**, which is what this constant said
 * first. Vertex's per-region availability is not uniform and the newest
 * lightweight models land on `global` before anywhere else, so a regional
 * default is a deploy-time 404 for the exact models we chose.
 *
 * Overridable per deployment via `GOOGLE_CLOUD_LOCATION` for the case where a
 * future model is region-pinned, or where data residency demands one.
 */
export const DEFAULT_AI_LOCATION = 'global';

let cachedClient: GoogleGenAI | null = null;

/**
 * `projectId` out of `FIREBASE_CONFIG`, the JSON blob Firebase-managed runtimes
 * inject — `null` when the variable is absent, unparseable, or carries nothing
 * usable.
 *
 * Mirrors `resolveProjectId` in each app's `lib/firebase/admin.ts`, narrow catch
 * included (root CLAUDE.md rule 6). COPIED rather than imported: those are
 * deliberately per-app, dependency-free bootstraps, and this package keeps a
 * minimal dependency surface of its own — it must not grow one to read an env
 * var.
 */
function firebaseConfigProjectId(): string | null {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed.projectId;
    return typeof value === 'string' && value ? value : null;
  } catch (err) {
    // Malformed FIREBASE_CONFIG — treat as absent and keep falling back.
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  // ⚠️ **`GOOGLE_CLOUD_PROJECT` is NOT injected by App Hosting / Cloud Run.**
  // This comment used to say it was, and the claim was load-bearing: every AI
  // call on the deployed backend threw `AiNotConfiguredError`. Cloud Run's
  // container contract sets only PORT / K_SERVICE / K_REVISION / K_CONFIGURATION;
  // the project id is reachable from the METADATA SERVER, never as an env var.
  // Verified against the deployed service — neither `GOOGLE_CLOUD_PROJECT` nor
  // `FIREBASE_PROJECT_ID` is present there.
  //
  // What IS injected is `FIREBASE_CONFIG`, carrying the projectId. That is the
  // same ladder every `lib/firebase/admin.ts` already ends with, and for exactly
  // this reason.
  //
  // ⚠️ Truthiness, not `??` — unlike `location` below. An env var explicitly
  // set to `''` must not short-circuit a ladder whose LATER tier holds the real
  // answer; that would reproduce the bug this tier exists to fix.
  const explicit = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  const project = explicit || firebaseConfigProjectId();
  if (!project) {
    throw new AiNotConfiguredError(
      'GOOGLE_CLOUD_PROJECT / FIREBASE_PROJECT_ID / FIREBASE_CONFIG.projectId',
    );
  }
  // `??`, not `||`: an env var explicitly set to '' is a misconfiguration worth
  // failing on downstream, not something to silently paper over.
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? DEFAULT_AI_LOCATION;
  cachedClient = new GoogleGenAI({ vertexai: true, project, location });
  return cachedClient;
}

/** Test seam — the client memoizes, and a test that swaps env must reset it. */
export function __resetAiClient(): void {
  cachedClient = null;
}

/**
 * One page of the provider's base-model list, projected to the two fields the
 * settings page needs. The seam mirrors `GenerateFn`: nothing in this app's
 * suite touches the SDK.
 *
 * ⚠️ **One page, deliberately.** `models.list` returns a pager and the caller
 * only ever fills a Select; walking every page would trade an unbounded number
 * of round trips for models nobody scrolls to. `pageSize` is the whole bound —
 * and the shipped fallback covers the case where this answers nothing usable.
 *
 * `queryBase: true` asks for the publisher's catalogue rather than this
 * project's tuned models, which is what "which Gemini can I pick" means.
 */
export type ListModelsFn = () => Promise<ProviderModelRow[]>;

const MODEL_LIST_PAGE_SIZE = 100;

export function createVertexListModelsFn(): ListModelsFn {
  return async () => {
    const pager = await getClient().models.list({
      config: { queryBase: true, pageSize: MODEL_LIST_PAGE_SIZE },
    });
    return pager.page.map((m) => ({
      name: m.name,
      displayName: m.displayName,
      supportedActions: m.supportedActions,
    }));
  };
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
    for (const image of request.images) {
      // Inline bytes, never a URL — the legacy passed a tokened Storage HTTPS
      // URL as Vertex `fileUri`, a field documented for gs:// and YouTube only.
      parts.push({ inlineData: { data: image.base64, mimeType: image.mimeType } });
    }

    // ⚠️ A REVISION is a real multi-turn exchange, not a longer prompt. The
    // previous answer goes back as the `model` turn and the operator's
    // correction as a fresh `user` turn, so the model is amending something it
    // said rather than being told about it second-hand.
    const contents =
      request.anterior == null
        ? [{ role: 'user', parts }]
        : [
            { role: 'user', parts },
            { role: 'model', parts: [{ text: request.anterior.resposta }] },
            { role: 'user', parts: [{ text: request.anterior.feedback }] },
          ];

    const response = await getClient().models.generateContent({
      model,
      contents,
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
