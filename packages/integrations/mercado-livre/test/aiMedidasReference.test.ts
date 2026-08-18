import { describe, expect, it } from 'vitest';

import { pickMedidaReference, type MedidaReferenceChart } from '../src/ai/medidasReference';

function chart(over: Partial<MedidaReferenceChart>): MedidaReferenceChart {
  return { id: null, nome: null, rows: [], ...over };
}

function row(size: string, medidas: Record<string, string>) {
  return {
    attributes: [
      { id: 'SIZE', value_name: size },
      ...Object.entries(medidas).map(([id, value_name]) => ({ id, value_name })),
    ],
  };
}

describe('pickMedidaReference — exactly one chart', () => {
  it('returns null when there is nothing to reference', () => {
    expect(pickMedidaReference([], 'SIZE')).toBeNull();
  });

  it('flattens a filled chart to size → measurements', () => {
    const built = pickMedidaReference(
      [
        chart({
          nome: 'Camiseta',
          rows: [row('P', { CHEST: '52 cm' }), row('M', { CHEST: '56 cm' })],
        }),
      ],
      'SIZE',
    );
    expect(built).toEqual({
      nome: 'Camiseta',
      rows: [
        { size: 'P', medidas: { CHEST: '52 cm' } },
        { size: 'M', medidas: { CHEST: '56 cm' } },
      ],
    });
  });

  it('picks the RICHEST chart when several qualify', () => {
    // Deterministic on purpose: the same tabela must produce the same reference
    // twice, or a re-run would silently change the answer.
    const thin = chart({ nome: 'magra', rows: [row('P', { CHEST: '52' })] });
    const rich = chart({
      nome: 'cheia',
      rows: [row('P', { CHEST: '52', WAIST: '40' }), row('M', { CHEST: '56', WAIST: '44' })],
    });
    expect(pickMedidaReference([thin, rich], 'SIZE')?.nome).toBe('cheia');
    // Order must not decide it.
    expect(pickMedidaReference([rich, thin], 'SIZE')?.nome).toBe('cheia');
  });

  it('NEVER returns the chart being edited', () => {
    // Feeding the model the grid it is about to fill is circular — it would
    // "confirm" whatever is already there, including the blanks.
    const editing = chart({ id: 'MLB-1', nome: 'editando', rows: [row('P', { CHEST: '52' })] });
    expect(pickMedidaReference([editing], 'SIZE', { excludeChartId: 'MLB-1' })).toBeNull();
  });

  it('skips a chart whose rows carry only their size label', () => {
    // The same empty grid back, at full token cost.
    const empty = chart({ nome: 'vazia', rows: [row('P', {}), row('M', {})] });
    expect(pickMedidaReference([empty], 'SIZE')).toBeNull();
  });

  it('omits the size label from the measurements it copies', () => {
    // The caller already supplies the sizes; echoing them invites the model to
    // "suggest" a value it was handed.
    const built = pickMedidaReference([chart({ rows: [row('P', { CHEST: '52' })] })], 'SIZE');
    expect(built?.rows[0]?.medidas).toEqual({ CHEST: '52' });
  });

  it('reads a footwear row through sizeCalculado', () => {
    // A footwear chart's main attribute is EU_SIZE and ML computes the row's
    // SIZE, so the row carries none of its own.
    const footwear = chart({
      rows: [
        {
          sizeCalculado: { value_name: '38' },
          attributes: [{ id: 'FOOT_LENGTH', value_name: '24 cm' }],
        },
      ],
    });
    expect(pickMedidaReference([footwear], 'EU_SIZE')?.rows).toEqual([
      { size: '38', medidas: { FOOT_LENGTH: '24 cm' } },
    ]);
  });

  it('caps the rows so one big chart cannot dominate the prompt', () => {
    const many = chart({
      rows: Array.from({ length: 40 }, (_, i) => row(`S${String(i)}`, { CHEST: String(i) })),
    });
    expect(pickMedidaReference([many], 'SIZE', { maxRows: 5 })?.rows).toHaveLength(5);
  });

  it('tolerates a Flutter-authored chart with fields missing', () => {
    // Stored charts are passthrough; any field may be absent.
    expect(pickMedidaReference([{}, { rows: null }, { rows: [{}] }], 'SIZE')).toBeNull();
  });
});
