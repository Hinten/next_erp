/**
 * The prompt for size-chart measurement extraction.
 *
 * The input is almost always a **photo of a table**: a supplier's size chart,
 * often a phone shot of a printed sheet or a screenshot of a spreadsheet. That
 * makes this a transcription task, not an inference one, and the instruction is
 * written to keep it that way.
 */
import type { AiInlineImage, AiPromptRequest } from '@delfrance/ai';

import type { BuiltMedidasSchema } from './medidasSchema';

export interface MedidasPromptInput {
  /** The tabela de medidas' own name — usually the supplier or model. */
  tabelaNome: string;
  descricao?: string | null;
  /** `BODY_MEASURE` (body) or `CLOTHING_MEASURE` (garment). Changes what to read. */
  measureType?: string | null;
  /** The schema build — rows, columns and the tree, already capped. */
  built: BuiltMedidasSchema;
  /** The size-table photo. Absent when the tabela has none. */
  image?: AiInlineImage;
  /** Overrides the shipped default; the settings page supplies this. */
  systemInstruction?: string | null;
}

/**
 * The shipped default system instruction.
 *
 * Exported so the settings page seeds its textarea with the real text rather
 * than an approximation, and so a test can assert the load-bearing rules survive
 * an edit to the wording.
 *
 * Four of these exist because of how this task fails. A model asked to fill a
 * measurement grid will, unprompted: interpolate a missing size from its
 * neighbours, convert centimetres to inches because the column says inches,
 * average a printed range into one number, and read the body-measurement block
 * when the chart wanted garment measurements. Each is plausible, none is
 * verifiable from the answer, and all four ship to buyers as fact.
 */
export const DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION = [
  'Você transcreve tabelas de medidas de roupas para o formato do Mercado Livre.',
  'Responda SOMENTE com JSON no formato pedido.',
  'A FOTO é a fonte da verdade; a descrição serve apenas para desambiguar.',
  'OMITA qualquer medida que você não conseguir ler com certeza na imagem.',
  'NUNCA invente, estime, interpole ou extrapole uma medida a partir das outras.',
  'Informe o número na unidade indicada para a coluna, exatamente como está na tabela — NUNCA converta unidades.',
  'Se a tabela mostrar um intervalo (por exemplo 88-92), use os campos "de" e "até" correspondentes; nunca some, calcule a média nem escolha um dos extremos.',
  'Se a tabela usar nomes de tamanho diferentes dos pedidos, preencha apenas as linhas que você conseguir corresponder com segurança.',
].join(' ');

const MEASURE_TYPE_LABEL: Record<string, string> = {
  BODY_MEASURE: 'medidas do CORPO de quem veste',
  CLOTHING_MEASURE: 'medidas da PEÇA de roupa',
};

/**
 * Assemble the request. Pure — no IO, no SDK, no clock.
 *
 * The image arrives already read into bytes by the caller (server-side, through
 * the Admin SDK), so there is no `fetch` here and therefore no SSRF surface.
 */
export function buildMedidasPrompt(input: MedidasPromptInput): AiPromptRequest {
  const { rows, columns } = input.built;
  const facts: string[] = [`Tabela de medidas: ${input.tabelaNome.trim()}`];

  const measureLabel =
    input.measureType != null ? MEASURE_TYPE_LABEL[input.measureType] : undefined;
  if (measureLabel) {
    // A chart holds ONE measure family, and a supplier sheet often prints both
    // blocks side by side. Saying which one is wanted is the difference between
    // a usable answer and a confidently wrong one.
    facts.push(`Esta guia registra ${measureLabel}. Use apenas esse bloco da tabela.`);
  }
  if (nonBlank(input.descricao)) facts.push(`Descrição: ${input.descricao!.trim()}`);

  // ⚠️ Name only what the schema kept. `buildMedidasSchema` caps rows and
  // columns and drops duplicate size labels, and `additionalProperties: false`
  // makes constrained decoding reject anything outside — so listing a dropped
  // row here would ask for an answer the decoder cannot produce.
  if (rows.length > 0) {
    facts.push(
      `Tamanhos a preencher (use exatamente estes nomes como chaves):\n${rows
        .map((r) => `- ${r.size}`)
        .join('\n')}`,
    );
  }
  if (columns.length > 0) {
    facts.push(
      `Medidas a preencher em cada tamanho:\n${columns
        .map((c) => `- ${c.attributeId}: ${c.label}${unitSuffix(c.unitId)}`)
        .join('\n')}`,
    );
  }

  return {
    systemInstruction: nonBlank(input.systemInstruction)
      ? input.systemInstruction!.trim()
      : DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION,
    text: facts.join('\n\n'),
    ...(input.image ? { image: input.image } : {}),
    responseSchema: input.built.schema,
  };
}

function unitSuffix(unitId: string | null): string {
  return unitId != null && unitId !== '' ? ` (em ${unitId})` : '';
}

function nonBlank(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
