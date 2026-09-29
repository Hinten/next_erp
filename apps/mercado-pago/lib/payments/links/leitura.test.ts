import { describe, expect, it } from 'vitest';
import { MODO_LINK_PAGAMENTO, STATUS_LINK_PAGAMENTO, linkCriadoSchema } from '@delfrance/schemas';

import {
  comoRegistro,
  contaOuterRef,
  lerLink,
  linkCriadoDoDoc,
  metodoIdDoRef,
  numeroOuZero,
  textoOuNull,
  userIdDaConta,
  usuarioOuterRef,
} from './leitura';
import { AGORA_MS, UM_DIA_MS, docLink, docLinkLegado, linkId } from './testing/suporte';

describe('comoRegistro', () => {
  it('passes a plain object through', () => {
    const o = { a: 1 };
    expect(comoRegistro(o)).toBe(o);
  });

  it.each([null, undefined, 'texto', 7, ['a']])('reads %s as empty', (valor) => {
    expect(comoRegistro(valor)).toEqual({});
  });
});

describe('textoOuNull / numeroOuZero', () => {
  it('keeps a real string and drops a blank or non-string one', () => {
    expect(textoOuNull('Maria')).toBe('Maria');
    expect(textoOuNull('   ')).toBeNull();
    expect(textoOuNull('')).toBeNull();
    expect(textoOuNull(12)).toBeNull();
    expect(textoOuNull(null)).toBeNull();
  });

  it('keeps a finite number and reads anything else as 0', () => {
    expect(numeroOuZero(49.9)).toBe(49.9);
    expect(numeroOuZero(0)).toBe(0);
    expect(numeroOuZero('50')).toBe(0);
    expect(numeroOuZero(Number.NaN)).toBe(0);
    expect(numeroOuZero(Infinity)).toBe(0);
    expect(numeroOuZero(null)).toBe(0);
  });
});

describe('outer refs', () => {
  it('spells an operator and an account the way every other ref is stored', () => {
    expect(usuarioOuterRef('u1')).toBe('documents/usuarios/u1');
    expect(contaOuterRef('m1')).toBe('documents/metodo_pgto/m1');
  });

  it('round-trips an account ref', () => {
    expect(metodoIdDoRef(contaOuterRef('m1'))).toBe('m1');
  });
});

describe('metodoIdDoRef', () => {
  it.each([
    ['the canonical form', 'documents/metodo_pgto/abc', 'abc'],
    ['the short form the legacy corpus carries', 'metodo_pgto/abc', 'abc'],
  ])('reads %s', (_nome, ref, esperado) => {
    expect(metodoIdDoRef(ref)).toBe(esperado);
  });

  it.each([
    ['another collection', 'documents/integracoes/abc'],
    ['no id', 'documents/metodo_pgto/'],
    ['an empty string', ''],
    ['null', null],
    ['a number', 7],
    ['an unrelated path', 'documents/usuarios/metodo_pgto'],
  ])('reads %s as no account', (_nome, ref) => {
    expect(metodoIdDoRef(ref)).toBeNull();
  });
});

describe('userIdDaConta', () => {
  it('reads a positive integer collector id', () => {
    expect(userIdDaConta({ user_id: 4242 })).toBe(4242);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -5],
    ['a fraction (a truncated id would name another seller)', 42.5],
    ['a numeric string', '4242'],
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['past the safe-integer range', 2 ** 60],
  ])('reads %s as no collector id', (_nome, valor) => {
    expect(userIdDaConta({ user_id: valor })).toBeNull();
  });
});

describe('lerLink', () => {
  it('reads a link the create flow wrote', () => {
    const doc = docLink({ modo: MODO_LINK_PAGAMENTO.compartilhado, quantidadeMaxima: 3 });
    expect(lerLink(doc)).toEqual({
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      status: STATUS_LINK_PAGAMENTO.aberto,
      preferenceId: 'pref-1',
      contaRef: 'documents/metodo_pgto/metodoMP',
      quantidadeMaxima: 3,
    });
  });

  it('reads a LEGACY link as untraceable and open', () => {
    expect(lerLink(docLinkLegado())).toEqual({
      modo: null,
      status: STATUS_LINK_PAGAMENTO.aberto,
      preferenceId: 'legacy-1',
      contaRef: 'documents/metodo_pgto/metodoMP',
      quantidadeMaxima: null,
    });
  });

  it('keeps a terminal status', () => {
    expect(lerLink(docLink({ status: STATUS_LINK_PAGAMENTO.concluido })).status).toBe(
      STATUS_LINK_PAGAMENTO.concluido,
    );
  });

  it.each([
    ['an unknown status', { status: 'expirado' }],
    ['a non-string status', { status: 7 }],
  ])('reads %s as the schema default, open', (_nome, over) => {
    expect(lerLink(docLink(over)).status).toBe(STATUS_LINK_PAGAMENTO.aberto);
  });

  it.each([
    ['a blank preference id', { id: '' }, 'preferenceId'],
    ['a null preference id', { id: null }, 'preferenceId'],
    ['a non-string preference id', { id: 12 }, 'preferenceId'],
    ['a blank account ref', { contaMercadoPagoOuterRef: '' }, 'contaRef'],
    ['a zero quota', { quantidadeMaxima: 0 }, 'quantidadeMaxima'],
    ['a fractional quota', { quantidadeMaxima: 1.5 }, 'quantidadeMaxima'],
  ] as const)('reads %s as absent', (_nome, over, campo) => {
    expect(lerLink(docLink(over))[campo]).toBeNull();
  });

  it('survives a value that is not a document at all', () => {
    expect(lerLink(undefined)).toEqual({
      modo: null,
      status: STATUS_LINK_PAGAMENTO.aberto,
      preferenceId: null,
      contaRef: null,
      quantidadeMaxima: null,
    });
  });
});

describe('linkCriadoDoDoc', () => {
  it('describes a link the create flow wrote, in the response shape', () => {
    const criado = linkCriadoDoDoc(linkId(1), docLink());
    expect(criado).toEqual({
      linkId: linkId(1),
      preferenceId: 'pref-1',
      link: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',
      valorCobrado: 50,
      nomePagador: 'Maria',
      dataExpiracao: AGORA_MS + 3 * UM_DIA_MS,
      modo: MODO_LINK_PAGAMENTO.individual,
      quantidadeMaxima: 1,
    });
    expect(linkCriadoSchema.safeParse(criado).success).toBe(true);
  });

  it('reports a missing payer label as null', () => {
    const doc = docLink();
    delete doc.nomePagador;
    expect(linkCriadoDoDoc(linkId(1), doc)?.nomePagador).toBeNull();
  });

  it('reads a deadline stored in microseconds as milliseconds', () => {
    const emMicros = (AGORA_MS + UM_DIA_MS) * 1000;
    const criado = linkCriadoDoDoc(linkId(1), docLink({ dataExpiracao: emMicros }));
    expect(criado?.dataExpiracao).toBe(AGORA_MS + UM_DIA_MS);
  });

  it('cannot describe a LEGACY link (no modo)', () => {
    expect(linkCriadoDoDoc(linkId(1), docLinkLegado())).toBeNull();
  });

  it.each([
    ['no preference id', { id: null }],
    ['no URL', { link: undefined }],
    ['no amount', { valorCobrado: undefined }],
    ['no deadline', { dataExpiracao: undefined }],
  ])('cannot describe a link with %s', (_nome, over) => {
    expect(linkCriadoDoDoc(linkId(1), docLink(over))).toBeNull();
  });

  it('cannot describe something that is not a document', () => {
    expect(linkCriadoDoDoc(linkId(1), null)).toBeNull();
  });
});
