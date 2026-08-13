import { describe, expect, it } from 'vitest';

import { DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION, buildMedidasPrompt } from '../src/ai/medidasPrompt';
import {
  buildMedidasSchema,
  type MedidaColumnSpec,
  type MedidaRowSpec,
} from '../src/ai/medidasSchema';

const ROWS: MedidaRowSpec[] = [
  { key: 'g/1/v/p', size: 'P' },
  { key: 'g/1/v/m', size: 'M' },
];

const COLUMNS: MedidaColumnSpec[] = [
  {
    attributeId: 'CHEST',
    label: 'Tórax',
    kind: 'number',
    values: [],
    unitId: 'cm',
    required: true,
  },
];

const built = () => buildMedidasSchema(ROWS, COLUMNS);

describe('DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION — the load-bearing rules', () => {
  // Each of these exists because the model does it unprompted, plausibly, and
  // unverifiably from the answer alone.
  it('tells the model to omit what it cannot read', () => {
    expect(DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION).toContain('OMITA');
  });

  it('forbids inventing, estimating, interpolating or extrapolating', () => {
    expect(DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION).toContain('NUNCA invente');
    expect(DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION).toContain('interpole');
  });

  it('forbids converting units', () => {
    expect(DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION).toContain('NUNCA converta');
  });

  it('forbids collapsing a printed range into one number', () => {
    expect(DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION).toContain('média');
  });

  it('names the photo as the source of truth', () => {
    expect(DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION).toContain('FOTO');
  });
});

describe('buildMedidasPrompt', () => {
  it('uses the shipped instruction by default and the override when given', () => {
    expect(buildMedidasPrompt({ tabelaNome: 'T', built: built() }).systemInstruction).toBe(
      DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION,
    );
    expect(
      buildMedidasPrompt({ tabelaNome: 'T', built: built(), systemInstruction: '  custom  ' })
        .systemInstruction,
    ).toBe('custom');
  });

  it('falls back to the shipped instruction for a blank override', () => {
    // `null` means "no explicit choice, use the default" — and so does an empty
    // textarea, which is what a settings page hands over most often.
    expect(
      buildMedidasPrompt({ tabelaNome: 'T', built: built(), systemInstruction: '   ' })
        .systemInstruction,
    ).toBe(DEFAULT_MEDIDAS_SYSTEM_INSTRUCTION);
  });

  it('carries the schema through as the response schema', () => {
    const b = built();
    expect(buildMedidasPrompt({ tabelaNome: 'T', built: b }).responseSchema).toBe(b.schema);
  });

  it('says which measure family the guia records', () => {
    // A supplier sheet often prints body and garment blocks side by side, and
    // reading the wrong one is confidently wrong rather than obviously wrong.
    const body = buildMedidasPrompt({
      tabelaNome: 'T',
      built: built(),
      measureType: 'BODY_MEASURE',
    });
    expect(body.text).toContain('CORPO');
    const clothing = buildMedidasPrompt({
      tabelaNome: 'T',
      built: built(),
      measureType: 'CLOTHING_MEASURE',
    });
    expect(clothing.text).toContain('PEÇA');
  });

  it('omits the measure line entirely for an unknown measure type', () => {
    const p = buildMedidasPrompt({ tabelaNome: 'T', built: built(), measureType: 'MIXED_MEASURE' });
    expect(p.text).not.toContain('undefined');
  });

  it('lists the sizes and the columns with their unit', () => {
    const p = buildMedidasPrompt({ tabelaNome: 'Fornecedor X', built: built() });
    expect(p.text).toContain('- P');
    expect(p.text).toContain('- M');
    expect(p.text).toContain('CHEST: Tórax (em cm)');
  });

  it('names ONLY what the schema kept', () => {
    // `additionalProperties: false` makes constrained decoding reject anything
    // else, so naming a capped-out row would ask for an impossible answer.
    const capped = buildMedidasSchema(ROWS, COLUMNS, { maxRows: 1 });
    const p = buildMedidasPrompt({ tabelaNome: 'T', built: capped });
    expect(p.text).toContain('- P');
    expect(p.text).not.toContain('- M');
  });

  it('leaves the descrição out when blank, and includes it when set', () => {
    expect(buildMedidasPrompt({ tabelaNome: 'T', built: built() }).text).not.toContain('Descrição');
    expect(
      buildMedidasPrompt({ tabelaNome: 'T', built: built(), descricao: 'Modelagem PT-BR' }).text,
    ).toContain('Modelagem PT-BR');
  });

  it('attaches the image only when there is one', () => {
    expect(buildMedidasPrompt({ tabelaNome: 'T', built: built() }).image).toBeUndefined();
    const withImage = buildMedidasPrompt({
      tabelaNome: 'T',
      built: built(),
      image: { base64: 'AQID', mimeType: 'image/jpeg' },
    });
    expect(withImage.image).toEqual({ base64: 'AQID', mimeType: 'image/jpeg' });
  });
});
