/**
 * What to send a model, in a shape no specific AI runtime owns.
 *
 * `AiPromptRequest` is deliberately a plain description of *what to send* — a
 * system instruction, some text, optionally one inline image — rather than any
 * SDK's message type. Genkit, `@google/genai` and Vertex's REST API all accept a
 * trivial adaptation of it, which is what keeps the runtime decision reversible.
 *
 * ⚠️ These types used to live in `packages/integrations/mercado-livre/src/ai/`,
 * which made `provider.ts` — the one module that talks to a model — depend on a
 * *channel* package for its own vocabulary. They moved here so a second agent
 * (and eventually a second channel) can reuse the runtime without importing
 * Mercado Livre. The ML package re-exports them, so no call site there changed.
 */

/** An image sent to the model as bytes, never as a URL. */
export interface AiInlineImage {
  /** Raw bytes, base64-encoded. */
  base64: string;
  /** e.g. `image/jpeg`. */
  mimeType: string;
}

export interface AiPromptRequest {
  systemInstruction: string;
  /** The user turn: the facts the model reasons from. */
  text: string;
  /**
   * Every image the record could supply, in order. Empty when it has none.
   *
   * ⚠️ A LIST, not a single `image`, and there is deliberately no singular field
   * beside it. A supplier's size table is routinely two or three photos (front
   * and back, or several pages), and sending only the first threw the rest away
   * silently. Two fields for one concept is the drift trap this package has
   * already paid for elsewhere.
   */
  images: AiInlineImage[];
  /** What the answer must look like. */
  responseSchema: JsonSchemaNode;
}

/**
 * A minimal JSON Schema node — only the keywords our builders ever emit.
 *
 * ⚠️ `required` is declared **so that tests can assert it is never set**, and
 * the same goes for the absence of `nullable` and `anyOf` from this type
 * entirely. That is not stylistic: a schema builder that forces an answer gets
 * one, and the legacy Dart generator's `Schema.object({properties})` marked
 * every property required while nulling exactly the wrong ones — a
 * hallucination factory pointed at a fiscal-adjacent payload. Omission has to
 * stay the cheapest thing a model can do. See `attributeSchema.ts` for the full
 * account and the tree-walk test that enforces it.
 */
export interface JsonSchemaNode {
  type: 'object' | 'string';
  description?: string;
  enum?: string[];
  maxLength?: number;
  properties?: Record<string, JsonSchemaNode>;
  /** Always ABSENT on purpose — declared so tests can assert it is not set. */
  required?: string[];
  additionalProperties?: false;
}
