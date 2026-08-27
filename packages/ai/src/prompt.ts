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
  /**
   * A prior exchange to revise, rather than start over.
   *
   * ⚠️ The whole point is that the model CORRECTS its own answer. Sending the
   * operator's complaint alone would make it re-derive everything from the same
   * facts and very likely repeat the mistake; sending the previous answer next
   * to the complaint is what makes "a cor está errada, é azul-marinho" a fix
   * rather than a re-roll.
   *
   * Absent on a first run. Agent-neutral on purpose — the size-chart agent gets
   * this for free the day it wants it.
   */
  anterior?: {
    /** The previous answer, serialised as the model returned it. */
    resposta: string;
    /** What the operator asked to change. */
    feedback: string;
  };
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
  type: 'object' | 'string' | 'array';
  description?: string;
  enum?: string[];
  maxLength?: number;
  properties?: Record<string, JsonSchemaNode>;
  /**
   * The member schema of an `array` node.
   *
   * ⚠️ An array is still an OMITTABLE property — it never gets a `minItems`, for
   * the same reason nothing here gets a `required`. A model that cannot read a
   * multi-valued cell must be able to leave it out; a floor of one would make
   * inventing a member the cheapest legal answer.
   */
  items?: JsonSchemaNode;
  /** Always ABSENT on purpose — declared so tests can assert it is not set. */
  required?: string[];
  additionalProperties?: false;
}
