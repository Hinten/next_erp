/**
 * `tabelasLi.ts` (master plan step 13, PR 13-d): the conta's tabela refs folded to bare
 * `listaDePrecos` ids, and the bulk send's tabela check. Both are folds that decide sameness, so
 * each has an EQUAL pair and a NEAR-MISS that must stay distinct.
 */
import { describe, expect, it } from 'vitest';

import { mesmasTabelasDoEnvioLi, tabelasDaContaLi } from './tabelasLi';

const conta = (normal: unknown, promocional: unknown = null) => ({
  tabelaNormalOuterRef: normal,
  tabelaPromocionalOuterRef: promocional,
});

describe('tabelasDaContaLi: both stored forms read as the same bare id', () => {
  it('EQUAL pair: the canonical and the bare form ⇒ the same id, on both refs', () => {
    expect(tabelasDaContaLi(conta('documents/listaDePrecos/tab-n', 'listaDePrecos/tab-p'))).toEqual(
      { normal: 'tab-n', promocional: 'tab-p' },
    );
    expect(tabelasDaContaLi(conta('listaDePrecos/tab-n', 'documents/listaDePrecos/tab-p'))).toEqual(
      { normal: 'tab-n', promocional: 'tab-p' },
    );
  });

  it('the promotional tabela is kept AS STORED, even when it is the normal one', () => {
    expect(
      tabelasDaContaLi(conta('documents/listaDePrecos/tab-n', 'documents/listaDePrecos/tab-n')),
    ).toEqual({ normal: 'tab-n', promocional: 'tab-n' });
  });

  it.each<[string, unknown]>([
    ['another collection', 'documents/outraColecao/tab-n'],
    ['the bare form of another collection', 'depositos/tab-n'],
    ['a nested path (5 segments)', 'documents/listaDePrecos/tab-n/sub/x'],
    ['a collection alone', 'documents/listaDePrecos'],
    ['a bare id', 'tab-n'],
    ['the empty string', ''],
    ['a number', 7],
    ['null', null],
    ['an object', { id: 'tab-n' }],
    ['a reserved id', 'documents/listaDePrecos/__x__'],
    ['a dot id', 'documents/listaDePrecos/.'],
    ['another case of the collection', 'documents/ListaDePrecos/tab-n'],
  ])('⚠️ NEAR-MISS: %s ⇒ no tabela (null)', (_r, ref) => {
    expect(tabelasDaContaLi(conta(ref, ref))).toEqual({ normal: null, promocional: null });
  });

  it('⚠️ NEAR-MISS: an INHERITED key is no stored ref', () => {
    const herdada = Object.create({
      tabelaNormalOuterRef: 'documents/listaDePrecos/tab-n',
      tabelaPromocionalOuterRef: 'documents/listaDePrecos/tab-p',
    }) as object;
    expect(tabelasDaContaLi(herdada)).toEqual({ normal: null, promocional: null });
  });

  it('a conta with no ref at all names no tabela', () => {
    expect(tabelasDaContaLi({})).toEqual({ normal: null, promocional: null });
  });
});

describe('mesmasTabelasDoEnvioLi: promo == normal folded to null on BOTH sides', () => {
  const N = 'tab-n';
  const P = 'tab-p';

  it.each<[string, { normal: string | null; promocional: string | null }, object]>([
    ['the same pair', { normal: N, promocional: P }, { tabelaNormalId: N, tabelaPromocionalId: P }],
    [
      'no promo on either side',
      { normal: N, promocional: null },
      { tabelaNormalId: N, tabelaPromocionalId: null },
    ],
    [
      'the task {N, null} against the conta {N, N}',
      { normal: N, promocional: N },
      { tabelaNormalId: N, tabelaPromocionalId: null },
    ],
    [
      'the task {N, N} against the conta {N, null}',
      { normal: N, promocional: null },
      { tabelaNormalId: N, tabelaPromocionalId: N },
    ],
  ])('EQUAL: %s', (_r, tabelas, tarefa) => {
    expect(mesmasTabelasDoEnvioLi(tabelas, tarefa)).toBe(true);
  });

  it('EQUAL: a conta storing either ref form is the same conta pricing', () => {
    const canonica = tabelasDaContaLi(
      conta('documents/listaDePrecos/tab-n', 'documents/listaDePrecos/tab-p'),
    );
    const nua = tabelasDaContaLi(conta('listaDePrecos/tab-n', 'listaDePrecos/tab-p'));
    const tarefa = { tabelaNormalId: N, tabelaPromocionalId: P };
    expect(mesmasTabelasDoEnvioLi(canonica, tarefa)).toBe(true);
    expect(mesmasTabelasDoEnvioLi(nua, tarefa)).toBe(true);
  });

  it.each<[string, { normal: string | null; promocional: string | null }, object]>([
    [
      'another normal tabela',
      { normal: 'tab-m', promocional: P },
      { tabelaNormalId: N, tabelaPromocionalId: P },
    ],
    [
      'a promo P against none',
      { normal: N, promocional: P },
      { tabelaNormalId: N, tabelaPromocionalId: null },
    ],
    [
      'none against a promo P',
      { normal: N, promocional: null },
      { tabelaNormalId: N, tabelaPromocionalId: P },
    ],
    [
      'a promo P against Q',
      { normal: N, promocional: P },
      { tabelaNormalId: N, tabelaPromocionalId: 'tab-q' },
    ],
    [
      'a conta with no normal tabela',
      { normal: null, promocional: null },
      { tabelaNormalId: N, tabelaPromocionalId: null },
    ],
    [
      'a conta with no normal tabela against a task naming none either',
      { normal: null, promocional: null },
      { tabelaNormalId: null, tabelaPromocionalId: null },
    ],
    [
      'a conta with no normal tabela against a task with neither key',
      { normal: null, promocional: null },
      {},
    ],
    [
      'a task with no normal tabela',
      { normal: N, promocional: null },
      { tabelaNormalId: null, tabelaPromocionalId: null },
    ],
    ['a task with neither key', { normal: N, promocional: null }, {}],
    [
      'the normal in another case',
      { normal: N, promocional: null },
      { tabelaNormalId: 'TAB-N', tabelaPromocionalId: null },
    ],
  ])('⚠️ NEAR-MISS: %s ⇒ not the same', (_r, tabelas, tarefa) => {
    expect(mesmasTabelasDoEnvioLi(tabelas, tarefa)).toBe(false);
  });
});
