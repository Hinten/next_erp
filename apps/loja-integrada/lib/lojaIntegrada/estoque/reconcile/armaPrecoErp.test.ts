/**
 * `armaPrecoErp.ts` (master plan step 13, PR 13-f1): the price arm over one walk page — every
 * verdict row, the parent rule (`paiDoProdutoErp`, then a document id), the produto's OWN readings
 * in centavos, and that every entry is parsed inside the arm. Pure; invented ids and prices.
 */
import { describe, expect, it } from 'vitest';
import { type ProdutoPrecoLi, entradaSnapshotPrecoLiSchema } from '@delfrance/schemas';

import { avaliarPrecoDaPaginaLi } from './armaPrecoErp';
import type { GrupoDeVinculosLi } from './caminhadaVinculos';
import type { ContaPrecoDoRunLi } from './estadoPrecoReconcile';

const CONTA: ContaPrecoDoRunLi = {
  idx: 0,
  contaId: 'C1',
  tabelas: { normal: 'tab-n', promocional: 'tab-p' },
};
const SEM_PROMO: ContaPrecoDoRunLi = { ...CONTA, tabelas: { normal: 'tab-n', promocional: null } };

/** A counting child link of `conta` to store id `id`. */
function filho(id: number | string, conta = 'C1'): Record<string, unknown> {
  return {
    contaLojaIntegrada: `documents/integracao/${conta}`,
    id,
    paiProdutoIntegradaId: 900,
    removido: false,
  };
}
const raizComGrades = (id: number): Record<string, unknown> => ({
  ...filho(id),
  paiProdutoIntegradaId: null,
  grades: [1],
});
const raizSemGrades = (id: number): Record<string, unknown> => ({
  ...filho(id),
  paiProdutoIntegradaId: null,
});

const grupo = (produtoId: string, ...links: Record<string, unknown>[]): GrupoDeVinculosLi => ({
  produtoId,
  links,
});
const produto = (id: string, dados: Record<string, unknown>): ProdutoPrecoLi => ({ id, dados });
const preco = (valor: unknown) => ({ valor });

function avaliar(
  grupos: readonly GrupoDeVinculosLi[],
  produtos: Record<string, ProdutoPrecoLi | null>,
  conta: ContaPrecoDoRunLi = CONTA,
) {
  const r = avaliarPrecoDaPaginaLi({ grupos, produtos: new Map(Object.entries(produtos)), conta });
  return { entradas: Object.fromEntries(r.entradas), contadores: Object.fromEntries(r.contadores) };
}

describe('every verdict row', () => {
  it('pai / nao-suportado / vinculo-ambiguo ⇒ a flag entry per store id the conta’s links name; sem-vinculo ⇒ nothing', () => {
    const r = avaliar(
      [
        grupo('pai-1', raizComGrades(1000)),
        grupo('ns-1', raizSemGrades(1005)),
        grupo('amb-1', filho(1011), filho(1012)),
        grupo('outro-1', filho(3001, 'C9')),
      ],
      {},
    );
    expect(r.entradas).toEqual({
      '1000': { p: 'pai-1', f: 'pai' },
      '1005': { p: 'ns-1', f: 'ns' },
      '1011': { p: 'amb-1', f: 'amb' },
      '1012': { p: 'amb-1', f: 'amb' },
    });
    expect(r.contadores).toEqual({ pais: 1, naoSuportados: 1, ambiguos: 1 });
  });

  it('vinculado, the produto ABSENT ⇒ no entry, counted `ausentes`', () => {
    const r = avaliar([grupo('sumiu', filho(1001))], { sumiu: null });
    expect(r).toEqual({ entradas: {}, contadores: { ausentes: 1 } });
  });

  it('vinculado, a parent id no document can have ⇒ held `pai-ausente` already, no pai / n / pr, counted `paiInvalido`', () => {
    for (const pai of ['a/b', '__x__', '.', '..']) {
      const r = avaliar([grupo('f1', filho(1001))], {
        f1: produto('f1', { paiId: pai, precos: { 'tab-n': preco(11.11) } }),
      });
      expect(r.entradas, pai).toEqual({ '1001': { p: 'f1', f: 'v', a: { r: 'pai-ausente' } } });
      expect(r.contadores, pai).toEqual({ paiInvalido: 1 });
    }
  });

  it('vinculado otherwise ⇒ `v` with its parent and its OWN readings in centavos, counted `validos`', () => {
    const r = avaliar([grupo('f1', filho(1001))], {
      f1: produto('f1', {
        paiId: 'pai-1',
        precos: { 'tab-n': preco(22.22), 'tab-p': preco(11.11) },
      }),
    });
    expect(r.entradas).toEqual({ '1001': { p: 'f1', f: 'v', pai: 'pai-1', n: 2222, pr: 1111 } });
    expect(r.contadores).toEqual({ validos: 1 });
  });

  it('a store id written as text and as a number is ONE id, in canonical text', () => {
    const r = avaliar([grupo('f1', filho('1001'), filho(1001))], { f1: produto('f1', {}) });
    expect(Object.keys(r.entradas)).toEqual(['1001']);
  });

  it('a conta with no link on the page ⇒ no entry and no counter', () => {
    expect(avaliar([grupo('f1', filho(1001, 'C2'))], {})).toEqual({ entradas: {}, contadores: {} });
  });
});

describe('the parent rule and the readings', () => {
  it("a `''` root and a self-parent are ROOTS (`paiDoProdutoErp`): no `pai`, never held", () => {
    for (const paiId of ['', 'f1']) {
      const r = avaliar([grupo('f1', filho(1001))], {
        f1: produto('f1', { paiId, precos: { 'tab-n': preco(33.33) } }),
      });
      expect(r.entradas['1001'], JSON.stringify(paiId)).toEqual({ p: 'f1', f: 'v', n: 3333 });
      expect(r.contadores).toEqual({ validos: 1 });
    }
  });

  it('a child of a propagating parent records its OWN readings, never the parent’s — even with the parent on the same page', () => {
    const r = avaliar([grupo('pai-1', raizComGrades(1000)), grupo('f1', filho(1001))], {
      'pai-1': produto('pai-1', { precos: { 'tab-n': preco(99.99), 'tab-p': preco(88.88) } }),
      f1: produto('f1', { paiId: 'pai-1', precos: { 'tab-n': preco(44.44) } }),
    });
    expect(r.entradas['1001']).toEqual({ p: 'f1', f: 'v', pai: 'pai-1', n: 4444 });
  });

  it('a bare-number entry or a negative ⇒ `il`; one that rounds to 0 ⇒ absent (no key)', () => {
    const r = avaliar(
      [grupo('f1', filho(1001)), grupo('f2', filho(1002)), grupo('f3', filho(1003))],
      {
        f1: produto('f1', { precos: { 'tab-n': 12 } }),
        f2: produto('f2', { precos: { 'tab-n': preco(-5), 'tab-p': preco(-0.004) } }),
        f3: produto('f3', { precos: { 'tab-n': preco(0.004), 'tab-p': preco(10.004) } }),
      },
    );
    expect(r.entradas).toEqual({
      '1001': { p: 'f1', f: 'v', n: 'il' },
      '1002': { p: 'f2', f: 'v', n: 'il', pr: 'il' },
      '1003': { p: 'f3', f: 'v', pr: 1000 },
    });
  });

  it('no promotional tabela in the run ⇒ no `pr` key, whatever the produto holds', () => {
    const r = avaliar(
      [grupo('f1', filho(1001))],
      { f1: produto('f1', { precos: { 'tab-n': preco(11.11), 'tab-p': preco(5.55) } }) },
      SEM_PROMO,
    );
    expect(r.entradas['1001']).toEqual({ p: 'f1', f: 'v', n: 1111 });
  });

  it('an inherited `precos` is not stored data', () => {
    const dados = Object.create({ precos: { 'tab-n': preco(11.11) } }) as Record<string, unknown>;
    const r = avaliar([grupo('f1', filho(1001))], { f1: produto('f1', dados) });
    expect(r.entradas['1001']).toEqual({ p: 'f1', f: 'v' });
  });
});

describe('every entry is parsed inside the arm', () => {
  it('each returned entry is one the snapshot schema accepts', () => {
    const r = avaliarPrecoDaPaginaLi({
      grupos: [grupo('f1', filho(1001)), grupo('pai-1', raizComGrades(1000))],
      produtos: new Map([['f1', produto('f1', { precos: { 'tab-n': preco(11.11) } })]]),
      conta: CONTA,
    });
    for (const [, e] of r.entradas)
      expect(entradaSnapshotPrecoLiSchema.safeParse(e).success).toBe(true);
  });

  it('a produto whose id no entry can carry ⇒ the arm THROWS (ZodError), before anything is returned', () => {
    expect(() =>
      avaliarPrecoDaPaginaLi({
        grupos: [grupo('a/b', filho(1001))],
        produtos: new Map([['a/b', produto('a/b', {})]]),
        conta: CONTA,
      }),
    ).toThrowError(expect.objectContaining({ name: 'ZodError' }) as Error);
  });

  it('a vinculado produto the caller did not read is a caller bug: RangeError', () => {
    expect(() =>
      avaliarPrecoDaPaginaLi({
        grupos: [grupo('f1', filho(1001))],
        produtos: new Map(),
        conta: CONTA,
      }),
    ).toThrow(RangeError);
  });
});
