import { describe, expect, it } from 'vitest';

import {
  buildAttributePrompt,
  DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION,
  type AttributePromptInput,
} from '../src/ai/attributePrompt';
import { buildAttributeSchema, type AiAttributeSpec } from '../src/ai/attributeSchema';

const ATTRS: AiAttributeSpec[] = [
  {
    id: 'BRAND',
    name: 'Marca',
    valueType: 'string',
    values: [],
    hint: null,
    valueMaxLength: null,
    defaultUnit: null,
    required: true,
  },
];

function input(over: Partial<AttributePromptInput> = {}): AttributePromptInput {
  return {
    produtoNome: 'Camiseta Básica',
    attrs: ATTRS,
    responseSchema: buildAttributeSchema(ATTRS),
    ...over,
  };
}

describe('DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION', () => {
  it('tells the model it may omit what it cannot determine', () => {
    // The load-bearing sentence. The legacy prompt had no equivalent and its
    // schema forced an answer for every property, so the model had no way to
    // say "I don't know" and duly invented values.
    expect(DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION).toMatch(/OMITA a chave/);
  });

  it('ALLOWS "N/A" for an attribute that genuinely does not apply', () => {
    // Many attributes truly do not apply — voltage on a t-shirt, sole material
    // on a notebook. Forbidding the answer forced the model to choose between
    // inventing a value and omitting an attribute it had judged correctly.
    expect(DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION).toMatch(/N\/A/);
    expect(DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION).toMatch(/NÃO SE APLICA/);
  });

  it('separates "does not apply" from "I do not know", with an example of each', () => {
    // ⚠️ The load-bearing distinction. The two look alike to a model and must
    // produce OPPOSITE outputs: N/A is a positive claim that goes onto a live
    // listing, omission is an admission of ignorance. Naming the rule once is
    // not enough — each branch carries a concrete example.
    expect(DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION).toMatch(/NÃO SEI/);
    expect(DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION).toMatch(/OMITA a chave/);
    expect(DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION).toMatch(
      /Nunca use "N\/A" para dizer que não sabe/,
    );
    // And a tie-break, because the ambiguous case is common.
    expect(DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION).toMatch(/Na dúvida.*omita a chave/i);
  });

  it('forbids inventing measurements and codes', () => {
    expect(DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION).toMatch(/Nunca invente/);
  });
});

describe('buildAttributePrompt', () => {
  it('uses the shipped instruction by default', () => {
    expect(buildAttributePrompt(input()).systemInstruction).toBe(
      DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION,
    );
  });

  it('lets the settings page override the instruction', () => {
    const prompt = buildAttributePrompt(input({ systemInstruction: 'Instrução própria.' }));
    expect(prompt.systemInstruction).toBe('Instrução própria.');
  });

  it('ignores a blank override rather than sending an empty instruction', () => {
    // A cleared textarea must fall back, not silently strip every guard.
    expect(buildAttributePrompt(input({ systemInstruction: '   ' })).systemInstruction).toBe(
      DEFAULT_ATTRIBUTE_SYSTEM_INSTRUCTION,
    );
  });

  it('sends the produto facts the legacy sent', () => {
    const prompt = buildAttributePrompt(
      input({ marca: 'Hering', descricao: 'Malha 100% algodão', categoriaNome: 'Camisetas' }),
    );
    expect(prompt.text).toContain('Camiseta Básica');
    expect(prompt.text).toContain('Hering');
    expect(prompt.text).toContain('Malha 100% algodão');
    expect(prompt.text).toContain('Camisetas');
  });

  it('omits absent facts instead of sending empty labels', () => {
    const prompt = buildAttributePrompt(input({ marca: '  ', descricao: null }));
    expect(prompt.text).not.toContain('Marca:');
    expect(prompt.text).not.toContain('Descrição:');
  });

  it('names the attributes it wants filled', () => {
    expect(buildAttributePrompt(input()).text).toContain('BRAND');
  });

  it('asks only for attributes the response schema actually accepts', () => {
    // The schema caps at `maxProperties` and sets `additionalProperties: false`.
    // Asking for a key the schema dropped can only produce an answer that
    // constrained decoding rejects — prompt and schema must agree.
    const many: AiAttributeSpec[] = [
      ...ATTRS,
      { ...ATTRS[0]!, id: 'MODEL', name: 'Modelo' },
      { ...ATTRS[0]!, id: 'COLOR', name: 'Cor' },
    ];
    const prompt = buildAttributePrompt({
      ...input(),
      attrs: many,
      responseSchema: buildAttributeSchema(many, { maxProperties: 2 }),
    });
    expect(prompt.text).toContain('BRAND');
    expect(prompt.text).toContain('MODEL');
    expect(prompt.text).not.toContain('COLOR');
  });

  it('leaves the list out entirely when the schema wants nothing', () => {
    // A dangling "Atributos a preencher:" header with no items reads as a
    // truncated prompt to the model.
    const prompt = buildAttributePrompt({
      ...input(),
      attrs: [],
      responseSchema: buildAttributeSchema([]),
    });
    expect(prompt.text).not.toContain('Atributos a preencher');
  });

  it('carries an image as INLINE BYTES, never a URL', () => {
    // The legacy passed a tokened `firebasestorage.googleapis.com/…?alt=media`
    // HTTPS URL as Vertex `FileData.fileUri`, a field documented for `gs://`
    // and YouTube only — so the photo was very likely never seen at all.
    // Bytes-in also means no fetch here, and so no SSRF surface.
    const prompt = buildAttributePrompt(
      input({ image: { base64: 'QUJD', mimeType: 'image/jpeg' } }),
    );
    expect(prompt.images).toEqual([{ base64: 'QUJD', mimeType: 'image/jpeg' }]);
    expect(JSON.stringify(prompt)).not.toMatch(/https?:\/\//);
  });

  it('works for a produto with no photo', () => {
    expect(buildAttributePrompt(input()).images).toEqual([]);
  });

  it('sends AT MOST one photo — a second angle buys nothing here', () => {
    // `AiPromptRequest` carries a list because the size-chart agent needs
    // several. This agent is looking at a product photo to decide "sleeve:
    // short", so a second one is pure token cost; the shape is shared, the
    // policy is not.
    const prompt = buildAttributePrompt(
      input({ image: { base64: 'QUJD', mimeType: 'image/jpeg' } }),
    );
    expect(prompt.images).toHaveLength(1);
  });

  it('carries the response schema through untouched', () => {
    const schema = buildAttributeSchema(ATTRS);
    expect(buildAttributePrompt(input({ responseSchema: schema })).responseSchema).toBe(schema);
  });

  it('binds to no AI SDK — the request is a plain object', () => {
    // This is what keeps the Genkit vs @google/genai decision out of A1.
    const prompt = buildAttributePrompt(input());
    expect(JSON.parse(JSON.stringify(prompt))).toEqual(prompt);
  });
});
