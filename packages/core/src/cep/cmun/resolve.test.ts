import { describe, expect, it, vi } from 'vitest';
import { type CMunRange, decodeCMunTable, encodeCMunTable } from './codec';
import {
  CodigoMunicipioNaoResolvidoError,
  resolveCodigoMunicipio,
  resolveCodigoMunicipioSync,
} from './resolve';
import { type ViaCepClient, ViaCepError } from '../viaCep';

const RANGES: readonly CMunRange[] = [
  { cepInicial: 1_000_000, cepFinal: 1_099_999, cMun: 3_550_308 }, // SP
  { cepInicial: 2_000_000, cepFinal: 2_099_999, cMun: 3_304_557 }, // RJ
];
const table = decodeCMunTable(encodeCMunTable(RANGES));

/** A ViaCEP client that fails the test if it is ever consulted. */
const forbiddenViaCep: ViaCepClient = {
  buscarCep: vi.fn(() => {
    throw new Error('ViaCEP must not be consulted here');
  }),
};

function viaCepReturning(codigoMunicipio: string | null): ViaCepClient {
  return {
    buscarCep: vi.fn(() =>
      Promise.resolve(
        codigoMunicipio == null
          ? null
          : { logradouro: '', bairro: '', cidade: '', estado: '', codigoMunicipio },
      ),
    ),
  };
}

describe('resolveCodigoMunicipio', () => {
  describe('stored value short-circuits', () => {
    it('returns a stored 7-digit code without touching the table or ViaCEP', async () => {
      // The CEP is outside every faixa AND ViaCEP throws — so a pass proves
      // neither leg ran.
      const resolved = await resolveCodigoMunicipio(
        { cep: '99999999', codigoMunicipio: '3550308' },
        { table, viaCep: forbiddenViaCep },
      );

      expect(resolved).toBe('3550308');
    });

    it('does not UF-check a stored value', async () => {
      // Stored data is the operator's; the backfill reports conflicts rather
      // than silently "fixing" them.
      const resolved = await resolveCodigoMunicipio(
        { cep: '01050000', codigoMunicipio: '3550308', estado: 'AC' },
        { table, viaCep: forbiddenViaCep },
      );

      expect(resolved).toBe('3550308');
    });

    it.each([
      ['an empty string', ''],
      ['a 6-digit code', '355030'],
      ['an 8-digit code', '35503080'],
      ['null', null],
      ['undefined', undefined],
    ])('treats %s as absent and re-resolves', async (_label, stored) => {
      // `enderecoSchema.codigoMunicipio` is `.max(8).regex(/^\d*$/)`, so '' is
      // storable and reaches the NF-e generator as an empty <cMun>.
      const resolved = await resolveCodigoMunicipio(
        { cep: '01050000', codigoMunicipio: stored },
        { table, viaCep: forbiddenViaCep },
      );

      expect(resolved).toBe('3550308');
    });
  });

  describe('offline table', () => {
    it('resolves from the table without calling ViaCEP', async () => {
      const viaCep = viaCepReturning('9999999');

      expect(await resolveCodigoMunicipio({ cep: '02050000' }, { table, viaCep })).toBe('3304557');
      expect(viaCep.buscarCep).not.toHaveBeenCalled();
    });

    it('cross-checks a table hit against estado', async () => {
      // The ML mapper's `resolveUf` defaults a missing estado to 'AC'; a São
      // Paulo cMun under UF=AC earns SEFAZ rejection 273.
      const err = await resolveCodigoMunicipio(
        { cep: '01050000', estado: 'AC' },
        { table, viaCep: forbiddenViaCep },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CodigoMunicipioNaoResolvidoError);
      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('uf-divergente');
    });

    it('accepts a table hit whose UF agrees', async () => {
      expect(
        await resolveCodigoMunicipio(
          { cep: '01050000', estado: 'SP' },
          { table, viaCep: forbiddenViaCep },
        ),
      ).toBe('3550308');
    });
  });

  describe('ViaCEP fallback', () => {
    it('falls through when the CEP is in a gap', async () => {
      const viaCep = viaCepReturning('3550308');

      expect(await resolveCodigoMunicipio({ cep: '01500000' }, { table, viaCep })).toBe('3550308');
      expect(viaCep.buscarCep).toHaveBeenCalledWith('01500000');
    });

    it('reports viacep-sem-ibge when ViaCEP does not know the CEP', async () => {
      const err = await resolveCodigoMunicipio(
        { cep: '01500000' },
        { table, viaCep: viaCepReturning(null) },
      ).catch((e: unknown) => e);

      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('viacep-sem-ibge');
    });

    it('reports viacep-sem-ibge when ViaCEP omits ibge', async () => {
      const err = await resolveCodigoMunicipio(
        { cep: '01500000' },
        { table, viaCep: viaCepReturning('') },
      ).catch((e: unknown) => e);

      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('viacep-sem-ibge');
    });

    it('reports viacep-indisponivel and preserves the cause', async () => {
      const cause = new ViaCepError('boom', '01500000');
      const viaCep: ViaCepClient = { buscarCep: vi.fn(() => Promise.reject(cause)) };

      const err = await resolveCodigoMunicipio({ cep: '01500000' }, { table, viaCep }).catch(
        (e: unknown) => e,
      );

      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('viacep-indisponivel');
      expect((err as CodigoMunicipioNaoResolvidoError).cause).toBe(cause);
    });

    it('rethrows a non-ViaCepError from the client untouched', async () => {
      const boom = new RangeError('bug');
      const viaCep: ViaCepClient = { buscarCep: vi.fn(() => Promise.reject(boom)) };

      await expect(resolveCodigoMunicipio({ cep: '01500000' }, { table, viaCep })).rejects.toBe(
        boom,
      );
    });

    it('cross-checks a ViaCEP hit against estado', async () => {
      const err = await resolveCodigoMunicipio(
        { cep: '01500000', estado: 'RJ' },
        { table, viaCep: viaCepReturning('3550308') },
      ).catch((e: unknown) => e);

      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('uf-divergente');
    });
  });

  describe('offline mode', () => {
    it('reports fora-das-faixas instead of calling ViaCEP', async () => {
      const viaCep = viaCepReturning('3550308');

      const err = await resolveCodigoMunicipio(
        { cep: '01500000' },
        { table, viaCep, offline: true },
      ).catch((e: unknown) => e);

      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('fora-das-faixas');
      expect(viaCep.buscarCep).not.toHaveBeenCalled();
    });
  });

  it('reports cep-invalido before consulting anything', async () => {
    const err = await resolveCodigoMunicipio(
      { cep: '123' },
      { table, viaCep: forbiddenViaCep },
    ).catch((e: unknown) => e);

    expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('cep-invalido');
  });
});

describe('resolveCodigoMunicipioSync', () => {
  it('returns a stored value, then a table hit', () => {
    expect(
      resolveCodigoMunicipioSync({ cep: '99999999', codigoMunicipio: '3550308' }, { table }),
    ).toBe('3550308');
    expect(resolveCodigoMunicipioSync({ cep: '02050000' }, { table })).toBe('3304557');
  });

  it('returns null instead of throwing or reaching the network', () => {
    expect(resolveCodigoMunicipioSync({ cep: '01500000' }, { table })).toBeNull(); // gap
    expect(resolveCodigoMunicipioSync({ cep: '123' }, { table })).toBeNull(); // malformed
  });
});
