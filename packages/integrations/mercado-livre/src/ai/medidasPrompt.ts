/**
 * The prompt for size-chart measurement extraction.
 *
 * The input is almost always a **photo of a table**: a supplier's size chart,
 * often a phone shot of a printed sheet or a screenshot of a spreadsheet. That
 * makes this a transcription task, not an inference one, and the instruction is
 * written to keep it that way.
 */
import type { AiInlineImage, AiPromptRequest } from '@delfrance/ai';

import type { MedidaReference } from './medidasReference';
import type { BuiltMedidasSchema } from './medidasSchema';

export interface MedidasPromptInput {
  /** The tabela de medidas' own name — usually the supplier or model. */
  tabelaNome: string;
  /** Internal/supplier code. Sometimes the only thing naming which table a photo is. */
  codigo?: string | null;
  descricao?: string | null;
  /** `BODY_MEASURE` (body) or `CLOTHING_MEASURE` (garment). Changes what to read. */
  measureType?: string | null;
  /** The schema build — rows, columns and the tree, already capped. */
  built: BuiltMedidasSchema;
  /** Every size-table photo, in order. Empty when the tabela has none. */
  images?: AiInlineImage[];
  /**
   * ONE chart already filled for this same tabela on another conta, if any.
   * Real measurements a human typed — see `medidasReference.ts`.
   */
  referencia?: MedidaReference | null;
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
 *
 * ⚠️ The opening rule used to read *"A FOTO é a fonte da verdade; a descrição
 * serve apenas para desambiguar"*, and that is what taught the model to ignore a
 * description carrying real measurements. Every source the record offers is
 * context now, and the photo only wins a **conflict**. Note that "use everything
 * given" and "never invent what none of it states" are different rules — the
 * second one is what keeps this safe, and it is untouched below.
 */
export const DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION = [
  'Você transcreve tabelas de medidas de roupas para o formato do Mercado Livre.',
  'Responda SOMENTE com JSON no formato pedido.',
  'USE TODAS as informações fornecidas: as fotos, a descrição, o código e a guia de referência já preenchida.',
  'Quando as fontes se contradisserem, a FOTO da tabela prevalece sobre o texto e sobre a guia de referência.',
  'OMITA qualquer medida que você não conseguir determinar com certeza a partir das informações fornecidas.',
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
  if (nonBlank(input.codigo)) facts.push(`Código interno: ${input.codigo!.trim()}`);

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

  // The reference goes LAST, after the columns, so the model reads what it is
  // being asked for before it reads someone else's answer to a similar question.
  const referencia = renderReferencia(input.referencia);
  if (referencia) facts.push(referencia);

  return {
    systemInstruction: nonBlank(input.systemInstruction)
      ? input.systemInstruction!.trim()
      : DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION,
    text: facts.join('\n\n'),
    images: input.images ?? [],
    responseSchema: input.built.schema,
  };
}

/**
 * The reference chart, printed compactly.
 *
 * Labelled as a reference from ANOTHER conta rather than as data about this
 * guia: without that framing the model reads it as a partially-filled answer and
 * echoes it back, including for sizes the photo shows differently. The
 * conflict rule in the system instruction is what it is echoing against.
 */
function renderReferencia(referencia: MedidaReference | null | undefined): string | null {
  if (!referencia || referencia.rows.length === 0) return null;
  const titulo = nonBlank(referencia.nome)
    ? `Guia "${referencia.nome!.trim()}" já preenchida para esta mesma tabela em outra conta`
    : 'Guia já preenchida para esta mesma tabela em outra conta';
  const linhas = referencia.rows.map((row) => {
    const medidas = Object.entries(row.medidas)
      .map(([id, value]) => `${id}=${value}`)
      .join(', ');
    return `- ${row.size}: ${medidas}`;
  });
  return `${titulo} (use como referência; a foto prevalece se divergir):\n${linhas.join('\n')}`;
}

function unitSuffix(unitId: string | null): string {
  return unitId != null && unitId !== '' ? ` (em ${unitId})` : '';
}

function nonBlank(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
