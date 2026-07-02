import { describe, expect, it } from 'vitest';
import type { ClienteCnpjEndereco } from './consultaCnpj';
import { enderecoMatchesResolved } from './enderecoDedup';

const RESOLVED: ClienteCnpjEndereco = {
  cep: '01310100',
  logradouro: 'AVENIDA PAULISTA',
  numero: '1000',
  complemento: '',
  bairro: 'BELA VISTA',
  cidade: 'SAO PAULO',
  estado: 'SP',
  codigoMunicipio: '3550308',
};

describe('enderecoMatchesResolved', () => {
  it('matches on identical CEP + número', () => {
    expect(enderecoMatchesResolved({ cep: '01310100', numero: '1000' }, RESOLVED)).toBe(true);
  });

  it('matches despite CEP formatting and número whitespace', () => {
    expect(enderecoMatchesResolved({ cep: '01310-100', numero: ' 1000 ' }, RESOLVED)).toBe(true);
  });

  it('does not match a different número at the same CEP', () => {
    expect(enderecoMatchesResolved({ cep: '01310100', numero: '2000' }, RESOLVED)).toBe(false);
  });

  it('does not match a different CEP', () => {
    expect(enderecoMatchesResolved({ cep: '04567000', numero: '1000' }, RESOLVED)).toBe(false);
  });

  it('does not match (and never throws) on a soft-parsed non-string / missing field', () => {
    // Reads are soft-parsed, so a legacy/invalid doc can carry a missing or
    // non-string cep/numero — the matcher must treat those as no-match, not crash.
    const legacy = (existing: unknown) =>
      enderecoMatchesResolved(existing as Parameters<typeof enderecoMatchesResolved>[0], RESOLVED);
    expect(legacy({ cep: '01310100' })).toBe(false); // numero missing
    expect(legacy({ numero: '1000' })).toBe(false); // cep missing
    expect(legacy({ cep: 1310100, numero: 1000 })).toBe(false); // non-string
    expect(legacy({})).toBe(false);
  });
});
