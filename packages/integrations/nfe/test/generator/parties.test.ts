import { describe, expect, it } from 'vitest';
import type { Cliente, Endereco, Filial } from '@delfrance/schemas';

import { NFePartiesError, buildDest, buildEmit } from '../../src/generator/parties';

/**
 * `cMun` validation (#785).
 *
 * `enderecoSchema.codigoMunicipio` is `z.string().max(8).regex(/^\d*$/)`, so an
 * EMPTY STRING is perfectly storable — and the old `requireField` only rejected
 * `== null`, so `''` sailed through and emitted `<cMun></cMun>`: malformed XML
 * that SEFAZ rejects with no hint of which field was to blame. `ide.ts`'s
 * `cMunFG` check already used a falsy test, so the two disagreed.
 */

const SEDE: Endereco = {
  idExterno: null,
  logradouro: 'Rua Direita',
  numero: '100',
  bairro: 'Centro',
  complemento: null,
  cep: '01001000',
  codigoMunicipio: '3550308',
  cidade: 'São Paulo',
  estado: 'SP',
  cPais: null,
  pais: null,
  nome: null,
  cpf_cnpj: null,
  rg: null,
  ie: null,
  imun: null,
  email: null,
  telefone: null,
  timestamp: null,
} as unknown as Endereco;

const FILIAL: Filial = {
  razaoSocial: 'Loja Acmé S.A.',
  fantasia: null,
  cnae: null,
  cnpj: '14200166000187',
  ie: '111111111111',
  iest: null,
  imun: null,
  sede: SEDE,
} as unknown as Filial;

const CLIENTE: Cliente = {
  tipo: '0',
  nome: 'Maria Silva',
  cpf_cnpj: '52998224725',
  idEstrangeiro: null,
  ie: null,
  imun: null,
  email: null,
} as unknown as Cliente;

/** Every value that is storable but is NOT a 7-digit IBGE code. */
const INVALID: ReadonlyArray<readonly [string, string | null]> = [
  ['an empty string', ''],
  ['6 digits', '355030'],
  ['8 digits', '35503080'],
  ['null', null],
];

describe('buildEmit — filial.sede.codigoMunicipio', () => {
  it('accepts a 7-digit código', () => {
    expect(buildEmit(FILIAL).enderEmit.cMun).toBe('3550308');
  });

  it.each(INVALID)('rejects %s, naming the field and what arrived', (_label, codigoMunicipio) => {
    const filial = { ...FILIAL, sede: { ...SEDE, codigoMunicipio } } as Filial;

    expect(() => buildEmit(filial)).toThrow(NFePartiesError);
    expect(() => buildEmit(filial)).toThrow(/filial\.sede\.codigoMunicipio/);
  });
});

describe('buildDest — endereco.codigoMunicipio', () => {
  it('accepts a 7-digit código', () => {
    expect(buildDest(CLIENTE, SEDE, 'producao').enderDest.cMun).toBe('3550308');
  });

  it.each(INVALID)('rejects %s, naming the field and what arrived', (_label, codigoMunicipio) => {
    const endereco = { ...SEDE, codigoMunicipio } as Endereco;

    expect(() => buildDest(CLIENTE, endereco, 'producao')).toThrow(NFePartiesError);
    expect(() => buildDest(CLIENTE, endereco, 'producao')).toThrow(/endereco\.codigoMunicipio/);
  });

  it('reports the received value so an operator can see what is stored', () => {
    const endereco = { ...SEDE, codigoMunicipio: '' } as Endereco;

    // The whole point: `''` used to be invisible in the failure.
    expect(() => buildDest(CLIENTE, endereco, 'producao')).toThrow(/got ""/);
  });
});
