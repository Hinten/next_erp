import { describe, expect, it } from 'vitest';

import { collectFreteErrors, flattenFieldErrors } from './freteErrors';

describe('collectFreteErrors', () => {
  it('returns [] for no errors', () => {
    expect(collectFreteErrors(undefined)).toEqual([]);
    expect(collectFreteErrors(null)).toEqual([]);
    expect(collectFreteErrors({})).toEqual([]);
  });

  it('flattens a top-level field error and labels it', () => {
    // The #218 case: an enum error on a field with no rendered input.
    const errors = {
      externalOptionIntegracao: {
        type: 'invalid_enum_value',
        message: 'Invalid enum value.',
        ref: {},
      },
    };
    expect(collectFreteErrors(errors)).toEqual([
      {
        path: 'externalOptionIntegracao',
        label: 'Integração da opção',
        message: 'Invalid enum value.',
      },
    ]);
  });

  it('flattens a nested array error (volumes[0].dimensoes.altura)', () => {
    const errors = {
      volumes: [
        {
          dimensoes: {
            altura: { type: 'too_small', message: 'Altura inválida.' },
          },
        },
      ],
    };
    expect(collectFreteErrors(errors)).toEqual([
      { path: 'volumes.0.dimensoes.altura', label: 'Volumes', message: 'Altura inválida.' },
    ]);
  });

  it('collects multiple errors across fields', () => {
    const errors = {
      valorCobrado: { type: 'invalid_type', message: 'Obrigatório.' },
      estado: { type: 'invalid_enum_value', message: 'Estado inválido.' },
    };
    const result = collectFreteErrors(errors);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.label)).toEqual(['Valor cobrado', 'Status do frete']);
  });

  it('handles an object-level (root / cross-field) error', () => {
    const errors = { root: { type: 'custom', message: 'Frete inconsistente.' } };
    expect(collectFreteErrors(errors)).toEqual([
      { path: 'root', label: 'Frete', message: 'Frete inconsistente.' },
    ]);
  });

  it('falls back to the raw segment for an unmapped field', () => {
    const errors = { algumCampoNovo: { type: 'custom', message: 'x' } };
    expect(collectFreteErrors(errors)[0]).toMatchObject({ label: 'algumCampoNovo' });
  });
});

describe('flattenFieldErrors', () => {
  it('uses the supplied labeller', () => {
    const errors = { foo: { type: 'x', message: 'bar' } };
    const result = flattenFieldErrors(errors, (p) => `LABEL:${p}`);
    expect(result).toEqual([{ path: 'foo', label: 'LABEL:foo', message: 'bar' }]);
  });
});
