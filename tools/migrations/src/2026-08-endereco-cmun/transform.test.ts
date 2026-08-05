import { describe, expect, it, vi } from 'vitest';
import { decideCodigoMunicipio } from './transform';

/**
 * The offline table is vendored separately (#841). These tests stub the lookup
 * so every branch is exercised regardless of whether real data is present —
 * and so they never depend on a specific município's real CEP faixa.
 */
vi.mock('@delfrance/core/cep/cmun', () => ({
  resolveCodigoMunicipioSync: vi.fn(({ cep }: { cep: string }) =>
    cep.startsWith('013') ? '3550308' : cep.startsWith('200') ? '3304557' : null,
  ),
}));

describe('decideCodigoMunicipio', () => {
  describe('already valid', () => {
    it('leaves a stored 7-digit código alone', () => {
      expect(
        decideCodigoMunicipio({ cep: '01310100', codigoMunicipio: '3550308', estado: 'SP' }),
      ).toEqual({ kind: 'ok', codigoMunicipio: '3550308' });
    });

    it('accepts a stored código when the endereço has no estado to check against', () => {
      expect(
        decideCodigoMunicipio({ cep: '01310100', codigoMunicipio: '3550308', estado: '' }),
      ).toEqual({ kind: 'ok', codigoMunicipio: '3550308' });
    });
  });

  describe('resolution', () => {
    it.each([
      ['null', null],
      ['an empty string', ''],
      ['a 6-digit value', '355030'],
      ['a missing field', undefined],
    ])('resolves from the CEP when the stored value is %s', (_label, stored) => {
      // `enderecoSchema.codigoMunicipio` is `.max(8).regex(/^\d*$/)`, so '' is
      // storable — and reaches the NF-e generator as an empty <cMun>.
      expect(
        decideCodigoMunicipio({ cep: '01310100', codigoMunicipio: stored, estado: 'SP' }),
      ).toEqual({ kind: 'resolve', codigoMunicipio: '3550308' });
    });
  });

  describe('skips — never guess, never overwrite', () => {
    it('never auto-corrects a stored código that contradicts the UF', () => {
      // One of the two fields is wrong and the migration cannot know which.
      // Surfacing the conflict beats silently rewriting operator data.
      const outcome = decideCodigoMunicipio({
        cep: '01310100',
        codigoMunicipio: '3550308',
        estado: 'AC',
      });

      expect(outcome.kind).toBe('skip');
      expect(outcome).toMatchObject({ reason: expect.stringContaining('conflito') });
    });

    it('skips a CEP outside every faixa rather than guessing', () => {
      const outcome = decideCodigoMunicipio({
        cep: '99999999',
        codigoMunicipio: null,
        estado: 'SP',
      });

      expect(outcome.kind).toBe('skip');
      expect(outcome).toMatchObject({ reason: expect.stringContaining('fora de todas as faixas') });
    });

    it('skips a resolved código that contradicts the endereço UF', () => {
      // A value we can already tell is wrong is worse than none: it would sail
      // through the generator and earn SEFAZ rejection 273.
      const outcome = decideCodigoMunicipio({
        cep: '01310100',
        codigoMunicipio: null,
        estado: 'RJ',
      });

      expect(outcome.kind).toBe('skip');
      expect(outcome).toMatchObject({ reason: expect.stringContaining('não pertence à UF RJ') });
    });

    it.each([
      ['missing', undefined],
      ['non-string', 12345678],
      ['too short', '0131010'],
      ['punctuated', '01310-100'],
    ])('skips an endereço whose cep is %s', (_label, cep) => {
      const outcome = decideCodigoMunicipio({ cep, codigoMunicipio: null, estado: 'SP' });

      expect(outcome.kind).toBe('skip');
      expect(outcome).toMatchObject({ reason: expect.stringContaining('cep') });
    });
  });

  it('is idempotent — re-running over its own output changes nothing', () => {
    const first = decideCodigoMunicipio({ cep: '01310100', codigoMunicipio: null, estado: 'SP' });
    expect(first.kind).toBe('resolve');

    const second = decideCodigoMunicipio({
      cep: '01310100',
      codigoMunicipio: (first as { codigoMunicipio: string }).codigoMunicipio,
      estado: 'SP',
    });
    expect(second.kind).toBe('ok');
  });
});
