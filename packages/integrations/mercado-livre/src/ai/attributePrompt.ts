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
import type { AiAttributeSpec, JsonSchemaNode } from './attributeSchema';

/** An image sent to the model as bytes, never as a URL. */
export interface AiInlineImage {
  /** Raw bytes, base64-encoded. */
  base64: string;
  /** e.g. `image/jpeg`. */
  mimeType: string;
}

export interface AiPromptRequest {
  systemInstruction: string;
  /** The user turn: the product facts the model reasons from. */
  text: string;
  /** At most one product photo. Absent when the produto has none. */
  image?: AiInlineImage;
  /** What the answer must look like — see `buildAttributeSchema`. */
  responseSchema: JsonSchemaNode;
}

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
 * ⚠️ The load-bearing part is the THREE-WAY split: a value, "N/A" (the attribute
 * does not apply to this kind of product), or an omitted key (the attribute
 * applies but the data does not say). The legacy prompt had none of this and its
 * schema forced an answer for every property, so the model could neither decline
 * nor disclaim and duly made things up. Collapsing the last two back together —
 * in either direction — recreates that: forbidding "N/A" makes the model invent
 * values for attributes that genuinely do not apply, and accepting "N/A" as
 * "I don't know" writes a false claim onto a live listing.
 */
export const DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION = [
  'Você preenche atributos de anúncios do Mercado Livre a partir dos dados de um produto.',
  'Responda SOMENTE com JSON no formato pedido.',
  'Nunca invente medidas, códigos, modelos ou números que não estejam nos dados.',
  'Quando o atributo tiver uma lista de valores possíveis, use exatamente um dos valores da lista.',
  // ⚠️ The distinction below is the whole design. Two different situations look
  // similar to a model and must produce OPPOSITE outputs, so they are spelled
  // out with an example each rather than named once and hoped for.
  'Existem três respostas possíveis para cada atributo, e escolher entre elas é a parte mais importante da tarefa:',
  '(1) VALOR — você sabe o valor a partir dos dados: responda o valor.',
  '(2) NÃO SE APLICA — o atributo não faz sentido para este tipo de produto: responda "N/A".',
  'Exemplo: "Voltagem" em uma camiseta, ou "Material da sola" em um caderno. O atributo existe na categoria, mas nada neste produto poderia preenchê-lo.',
  '(3) NÃO SEI — o atributo faz sentido para este produto, mas os dados fornecidos não dizem qual é o valor: OMITA a chave inteira do JSON.',
  'Exemplo: "Marca" de uma camiseta cuja marca não aparece no nome nem na descrição. A camiseta tem uma marca; você é que não sabe qual.',
  'Nunca use "N/A" para dizer que não sabe — "N/A" afirma que o atributo é inaplicável, e essa afirmação vai para o anúncio.',
  'Na dúvida entre (2) e (3), escolha (3) e omita a chave.',
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
