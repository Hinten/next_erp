/**
 * The emission-boundary gate against text whose encoding was lost upstream
 * (issue #788).
 *
 * The legacy Flutter app decoded some UTF-8 HTTP bodies as latin1 — Dart's
 * `Response.body` defaults to latin1 when the Content-Type names no charset —
 * and wrote the result to Firestore, where it still sits. The NF-e generator
 * reads those same documents, and `removerAcentos` + `removerCharRestrito`
 * launder the damage into pure, non-blank, in-length ASCII: the mojibake form of
 * `São Paulo` becomes `SAo Paulo`, a U+FFFD-bearing one becomes `So Paulo`. Every
 * downstream gate passes, so a wrong address is signed, authorised by SEFAZ and
 * printed on the DANFE at the buyer's door — and correcting it afterwards needs a
 * CC-e or a cancelamento. These tests pin the loud failure instead.
 *
 * Corrupted fixtures are BUILT FROM BYTES, never pasted as literals — that names
 * the mis-decode that produced each one and keeps the repo free of the very
 * characters the detector exists to find.
 */
import { describe, it, expect } from 'vitest';
import type { Cliente, Endereco, Filial } from '@delfrance/schemas';
import { TIPO_CLIENTE, UF_SIGLA } from '@delfrance/schemas';

import { buildDest, buildEmit, NFePartiesError } from '../../src/generator/parties';
import { buildProd, NFeDetError } from '../../src/generator/det';
import type { GeneratorItem } from '../../src/generator/types';

/** The legacy defect: a UTF-8 value read back as latin1. */
const comoLatin1 = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');

/** A genuine latin1 value run through a lenient UTF-8 decode → U+FFFD. */
const comFffd = (s: string): string => new TextDecoder('utf-8').decode(Buffer.from(s, 'latin1'));

const ENDERECO: Endereco = {
  idExterno: null,
  logradouro: 'Rua Aclimação',
  numero: '500',
  bairro: 'Jardins',
  complemento: null,
  cep: '04504010',
  codigoMunicipio: '3550308',
  cidade: 'São Paulo',
  estado: UF_SIGLA.SP,
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
};

const CLIENTE: Cliente = {
  tipo: TIPO_CLIENTE.pessoaFisica,
  nome: 'José Bonifácio',
  cpf_cnpj: '12345678909',
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
  idMercadoLivre: null,
};

const FILIAL: Filial = {
  razaoSocial: 'Loja de Bicicletas Acmé S.A.',
  fantasia: 'Bike Açaí',
  cnae: '4763602',
  cnpj: '14200166000187',
  ie: '111111111111',
  iest: null,
  imun: null,
  sede: { ...ENDERECO, logradouro: 'Rua Direita', numero: '100', bairro: 'Centro' },
};

const ITEM: GeneratorItem = {
  nItem: 1,
  cProd: 'BIKE-001',
  cEAN: 'SEM GTIN',
  xProd: 'Bicicleta Aro 29 — edição limitada',
  NCM: '87120000',
  CFOP: '5102',
  uCom: 'UN',
  qCom: 1,
  vUnCom: 1500,
  vProd: 1500,
  cEANTrib: 'SEM GTIN',
  uTrib: 'UN',
  qTrib: 1,
  vUnTrib: 1500,
  impostoXml: '<imposto/>',
};

const dest = (endereco = ENDERECO, cliente = CLIENTE) =>
  buildDest(cliente, endereco, 'producao', false);

describe('encoding gate — enderDest (issue #788)', () => {
  // `xLgr` is the field the issue names, and the one that ends up on the DANFE.
  it.each([
    ['a latin1 mis-read', comoLatin1('Rua Aclimação')],
    ['an unrecoverable U+FFFD', comFffd('Rua Aclimação')],
  ])('rejects %s in logradouro', (_label, logradouro) => {
    expect(() => dest({ ...ENDERECO, logradouro })).toThrow(NFePartiesError);
    expect(() => dest({ ...ENDERECO, logradouro })).toThrow(/corrupted text/);
  });

  it.each(['bairro', 'cidade', 'numero'] as const)('rejects a corrupted %s', (campo) => {
    const endereco = { ...ENDERECO, [campo]: comoLatin1('Aclimação') };
    expect(() => dest(endereco)).toThrow(NFePartiesError);
  });

  it('rejects a corrupted complemento even though the tag is optional', () => {
    // Optional is not safer — xCpl is printed on the DANFE like the rest.
    const endereco = { ...ENDERECO, complemento: comoLatin1('Fundos — portão azul') };
    expect(() => dest(endereco)).toThrow(NFePartiesError);
  });

  it('rejects a corrupted pais, which otherwise defaults to BRASIL', () => {
    const endereco = { ...ENDERECO, pais: comoLatin1('Estados Unidos da América') };
    expect(() => dest(endereco)).toThrow(NFePartiesError);
  });

  it('names the offending field so the operator knows which cadastro to fix', () => {
    expect(() => dest({ ...ENDERECO, bairro: comoLatin1('Aclimação') })).toThrow(
      /endereco\.bairro/,
    );
  });

  it('still emits correctly-encoded accented addresses', () => {
    const out = dest();
    expect(out.enderDest!.xLgr).toBe('Rua Aclimacao');
    expect(out.enderDest!.xMun).toBe('Sao Paulo');
  });

  it('the laundered value it now blocks was plausible ASCII, which is the danger', () => {
    // Pin what USED to be emitted, so the regression is unmistakable if the
    // gate is ever removed: a wrong street name that reads like a real one.
    const corrompido = comoLatin1('Rua Aclimação');
    expect(() => dest({ ...ENDERECO, logradouro: corrompido })).toThrow(NFePartiesError);
    expect(corrompido.normalize('NFD').replace(/\p{Diacritic}/gu, '')).toContain('AclimaA');
  });
});

describe('encoding gate — dest.xNome (issue #788)', () => {
  it('rejects a corrupted cliente.nome in produção', () => {
    expect(() => dest(ENDERECO, { ...CLIENTE, nome: comoLatin1('José Bonifácio') })).toThrow(
      NFePartiesError,
    );
  });

  it('rejects it in homologação too, where there is still time to fix it', () => {
    // The homologação override replaces xNome wholesale, so a naive check placed
    // after it would never see the corrupted cadastro.
    const cliente = { ...CLIENTE, nome: comoLatin1('José Bonifácio') };
    expect(() => buildDest(cliente, ENDERECO, 'homologacao', false)).toThrow(NFePartiesError);
  });

  it('still emits a correctly-encoded name', () => {
    expect(dest().xNome).toBe('Jose Bonifacio');
  });
});

describe('encoding gate — emit (issue #788)', () => {
  it('rejects a corrupted razaoSocial', () => {
    const filial = { ...FILIAL, razaoSocial: comoLatin1('Loja de Bicicletas Acmé S.A.') };
    expect(() => buildEmit(filial)).toThrow(NFePartiesError);
  });

  it('rejects a corrupted fantasia even though xFant is optional', () => {
    const filial = { ...FILIAL, fantasia: comoLatin1('Bike Açaí') };
    expect(() => buildEmit(filial)).toThrow(NFePartiesError);
  });

  it('rejects a corrupted sede address', () => {
    const filial = { ...FILIAL, sede: { ...FILIAL.sede, cidade: comoLatin1('São Paulo') } };
    expect(() => buildEmit(filial)).toThrow(NFePartiesError);
  });

  it('still emits a correctly-encoded filial', () => {
    const out = buildEmit(FILIAL);
    expect(out.xNome).toBe('Loja de Bicicletas Acme S.A.');
    expect(out.xFant).toBe('Bike Acai');
  });
});

describe('encoding gate — det.xProd (issue #788)', () => {
  // Produtos are legacy-written like the endereço is, and xProd is the line the
  // buyer reads on the DANFE.
  it.each([
    ['a latin1 mis-read', comoLatin1('Bicicleta Aro 29 — edição limitada')],
    ['an unrecoverable U+FFFD', comFffd('Bicicleta Aro 29 edição limitada')],
  ])('rejects %s in xProd', (_label, xProd) => {
    expect(() => buildProd({ ...ITEM, xProd })).toThrow(NFeDetError);
    expect(() => buildProd({ ...ITEM, xProd })).toThrow(/corrupted text/);
  });

  it('names the item so the operator knows which produto to fix', () => {
    const xProd = comoLatin1('Bicicleta edição limitada');
    expect(() => buildProd({ ...ITEM, nItem: 7, xProd })).toThrow(/item 7/);
  });

  it('still emits a correctly-encoded description, smart typography stripped', () => {
    expect(buildProd(ITEM).xProd).toBe('Bicicleta Aro 29 edicao limitada');
  });
});
