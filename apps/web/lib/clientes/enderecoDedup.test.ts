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
});
