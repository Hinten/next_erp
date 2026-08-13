/**
 * The prompt for the Mercado Livre attribute suggestion, in a shape no specific
 * AI runtime owns.
 *
 * `AiPromptRequest` is deliberately a plain description of *what to send* —
 * a system instruction, some text, optionally one inline image — rather than
 * any SDK's message type. Genkit, `@google/genai` and Vertex's REST API all
 * accept a trivial adaptation of it, which is what lets the runtime decision
 * stay open until it is actually made.
 */
import type { AiInlineImage, AiPromptRequest } from '@delfrance/ai';

import type { AiAttributeSpec, JsonSchemaNode } from './attributeSchema';

/**
 * ⚠️ `AiPromptRequest` and `AiInlineImage` moved to `@delfrance/ai` when a
 * second agent needed them: `provider.ts` is the only module that talks to a
 * model, and having it import its own vocabulary from a *channel* package meant
 * every future agent would drag Mercado Livre in behind it. They are re-exported
 * here so no call site in this package changed.
 */
export type { AiInlineImage, AiPromptRequest };

export interface AttributePromptInput {
  produtoNome: string;
  descricao?: string | null;
  marca?: string | null;
  categoriaNome?: string | null;
  attrs: AiAttributeSpec[];
  responseSchema: JsonSchemaNode;
  image?: AiInlineImage;
  /** Overrides the shipped default; the settings page supplies this. */
  systemInstruction?: string | null;
}

/**
 * The shipped default system instruction.
 *
 * Exported so the settings page can seed its textarea with the real text rather
 * than an approximation, and so a test can assert the omission rule survives an
 * edit to the wording.
 *
 * The load-bearing sentence is the omission rule. The legacy prompt had no
 * equivalent, and its schema forced an answer for every property — so the model
 * had no way to say "I don't know" and duly made things up.
 */
export const DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION = [
  'Você preenche atributos de anúncios do Mercado Livre a partir dos dados de um produto.',
  'Responda SOMENTE com JSON no formato pedido.',
  'OMITA a chave de qualquer atributo que você não conseguir determinar com segurança a partir das informações fornecidas.',
  'Nunca invente medidas, códigos, modelos ou números que não estejam nos dados.',
  'Quando o atributo tiver uma lista de valores possíveis, use exatamente um dos valores da lista.',
  'Nunca responda "N/A", "não se aplica" ou "-1": deixar em branco é decisão do operador.',
].join(' ');

/**
 * Assemble the request. Pure — no IO, no SDK, no clock.
 *
 * The image arrives already read into bytes by the caller. The legacy passed
 * `getUriForAiVision()`, a tokened `firebasestorage.googleapis.com/…?alt=media`
 * HTTPS URL, as Vertex `FileData.fileUri` — a field Vertex documents for `gs://`
 * and YouTube URLs only, so the photo was very likely never seen by the model at
 * all. Bytes-in also means no `fetch` here, and therefore no SSRF surface.
 */
export function buildAttributePrompt(input: AttributePromptInput): AiPromptRequest {
  const facts: string[] = [`Nome do produto: ${input.produtoNome.trim()}`];
  if (nonBlank(input.marca)) facts.push(`Marca: ${input.marca!.trim()}`);
  if (nonBlank(input.categoriaNome)) {
    facts.push(`Categoria no Mercado Livre: ${input.categoriaNome!.trim()}`);
  }
  if (nonBlank(input.descricao)) facts.push(`Descrição: ${input.descricao!.trim()}`);

  // ⚠️ Ask for exactly what the schema will accept, not for every attribute the
  // category defines. `buildAttributeSchema` caps at `maxProperties` and sets
  // `additionalProperties: false`, so naming an attribute the schema dropped
  // invites an answer that constrained decoding then rejects — the prompt would
  // be pulling against the schema. An empty list is left out entirely rather
  // than sent as a dangling header.
  const allowed = input.responseSchema.properties ?? {};
  const wanted = input.attrs
    .filter((a) => Object.hasOwn(allowed, a.id))
    .map((a) => `- ${a.id}: ${a.name ?? a.id}`);
  if (wanted.length > 0) {
    facts.push(`Atributos a preencher quando possível:\n${wanted.join('\n')}`);
  }

  return {
    systemInstruction: nonBlank(input.systemInstruction)
      ? input.systemInstruction!.trim()
      : DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION,
    text: facts.join('\n\n'),
    ...(input.image ? { image: input.image } : {}),
    responseSchema: input.responseSchema,
  };
}

function nonBlank(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
