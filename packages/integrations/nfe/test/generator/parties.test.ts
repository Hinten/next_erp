/**
 * `buildDest`'s `indIEDest` ladder and the `IE` element it gates.
 *
 * `cliente.ie` is free text carrying two sentinels (`IE_SENTINELA`) alongside
 * real inscrições estaduais. Deriving `indIEDest` from its mere TRUTHINESS
 * read a sentinel as a real IE — `'Não contribuinte'` produced
 * `indIEDest='1'` (Contribuinte ICMS) plus `<IE>Não contribuinte</IE>`, and
 * `indIEDest='1'` obliges a valid IE, so SEFAZ rejected the note and the pedido
 * could not be dispatched. Every case below is a row of the ladder ported from
 * `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:675-683,720`.
 */
import { describe, it, expect } from 'vitest';
import type { Cliente, Endereco } from '@delfrance/schemas';
import { IE_SENTINELA, TIPO_CLIENTE } from '@delfrance/schemas';

import { buildDest, NFePartiesError } from '../../src/generator/parties';

const ENDERECO: Endereco = {
  idExterno: null,
  logradouro: 'Av. Brasil',
  numero: '500',
  bairro: 'Jardins',
  complemento: null,
  cep: '04504010',
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
};

function cliente(overrides: Partial<Cliente> = {}): Cliente {
  return {
    tipo: TIPO_CLIENTE.pessoaJuridica,
    nome: 'Distribuidora Andre & Cia. Ltda.',
    cpf_cnpj: '99999999000191',
    idEstrangeiro: null,
    ie: null,
    imun: null,
    isUF: null,
    email: null,
    telefone: null,
    observacoesInternas: null,
    timestamp: null,
    nome_embedding: null,
    telefone_embedding: null,
    userCliente: null,
    ...overrides,
  };
}

/** Production ambiente + domestic operação — the ladder's default context. */
function dest(overrides: Partial<Cliente> = {}, ehExterior = false) {
  return buildDest(cliente(overrides), ENDERECO, 'producao', ehExterior);
}

describe('buildDest — indIEDest', () => {
  // The whole point of the fix: the sentinel never becomes an IE, whatever
  // casing/accents/spacing the cadastro screen let through over the years.
  it.each([
    'Não contribuinte',
    'NAO CONTRIBUINTE',
    'não contribuinte',
    'NÃO CONTRIBUINTE',
    '  Nao  Contribuinte ',
  ])('pessoa jurídica with ie=%j is Não Contribuinte (9) with no IE', (ie) => {
    const out = dest({ ie });
    expect(out.indIEDest).toBe('9');
    expect(out.IE).toBeUndefined();
  });

  it.each(['ISENTO', 'isento', ' Isento '])(
    'pessoa jurídica with ie=%j is Isento (2) with no IE',
    (ie) => {
      const out = dest({ ie });
      expect(out.indIEDest).toBe('2');
      expect(out.IE).toBeUndefined();
    },
  );

  // Legacy treats an absent IE on a PJ as isento, NOT as não-contribuinte.
  it.each([null, '', '   '])('pessoa jurídica with ie=%j is Isento (2)', (ie) => {
    const out = dest({ ie });
    expect(out.indIEDest).toBe('2');
    expect(out.IE).toBeUndefined();
  });

  it('pessoa jurídica with a real inscrição estadual is Contribuinte ICMS (1)', () => {
    const out = dest({ ie: '30703088534' });
    expect(out.indIEDest).toBe('1');
    expect(out.IE).toBe('30703088534');
  });

  // A stray `ie` on a PF used to yield indIEDest='1', which obliges an IE the
  // pessoa física does not have — an instant SEFAZ rejection.
  it.each([null, '30703088534', 'Não contribuinte', 'ISENTO'])(
    'pessoa física is always Não Contribuinte (9) with no IE, even with ie=%j',
    (ie) => {
      const out = dest({ tipo: TIPO_CLIENTE.pessoaFisica, cpf_cnpj: '12345678909', ie });
      expect(out.indIEDest).toBe('9');
      expect(out.IE).toBeUndefined();
    },
  );

  it('estrangeiro is Não Contribuinte (9) with no IE', () => {
    const out = dest({
      tipo: TIPO_CLIENTE.estrangeiro,
      cpf_cnpj: null,
      idEstrangeiro: 'PASSAPORTE123',
      ie: '30703088534',
    });
    expect(out.indIEDest).toBe('9');
    expect(out.IE).toBeUndefined();
  });

  // `ehExterior` overrides every other branch, including a PJ with a valid IE.
  it.each([null, '30703088534', 'ISENTO'])(
    'operação com o exterior forces Não Contribuinte (9) with no IE, ie=%j',
    (ie) => {
      const out = dest({ ie }, true);
      expect(out.indIEDest).toBe('9');
      expect(out.IE).toBeUndefined();
    },
  );
});

describe('buildDest — the IE element', () => {
  // dest.IE is XSD TIeDestNaoIsento: [0-9]{2,14}. Legacy's strip kept spaces,
  // which this XSD does not accept.
  it.each([
    ['110.042.490.114', '110042490114'],
    ['110 042 490 114', '110042490114'],
    ['IE: 123.456.789-00', '12345678900'],
    ['  30703088534  ', '30703088534'],
  ])('strips %j to the digits %j', (ie, expected) => {
    expect(dest({ ie }).IE).toBe(expected);
  });

  // These never classify as a sentinel, so they reach the indIEDest='1' branch
  // where SEFAZ obliges a valid IE. Degrading to '2' would mis-declare the
  // destinatário in a note SEFAZ ACCEPTS; emitting raw just moves the failure
  // to the pre-send XSD gate with a worse message.
  it.each(['-', 'x', '1', 'S/N', '...'])('throws on the unusable ie=%j', (ie) => {
    expect(() => dest({ ie })).toThrow(NFePartiesError);
    expect(() => dest({ ie })).toThrow(/inscrição estadual/);
  });

  it('throws on an ie with more than 14 digits rather than truncating', () => {
    expect(() => dest({ ie: '123456789012345' })).toThrow(NFePartiesError);
  });

  it('names the offending value so the operator can fix the cadastro', () => {
    expect(() => dest({ ie: 'S/N' })).toThrow(/S\/N/);
  });
});
