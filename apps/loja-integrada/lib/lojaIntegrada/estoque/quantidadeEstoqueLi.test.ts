import type { ComponentesKit } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import {
  type DocEstoqueLi,
  type ProdutoEstoqueLi,
  alvoEstoqueLi,
  caminhoEstoqueLi,
  corpoEstoqueLi,
  membroEstoqueLi,
  opcoesEstoqueLi,
  quantidadeEstoqueLi,
} from './quantidadeEstoqueLi';

/** A stock record at the conta's depósito, owned by `produtoId` (the PATH says so). */
function registro(
  produtoId: string,
  estoqueId: string,
  dados: Record<string, unknown>,
): DocEstoqueLi {
  return { caminho: `produtos/${produtoId}/estoques/${estoqueId}`, dados };
}

/** A kit's components: component produto id → its quantity in one kit. */
function componentes(q: Record<string, number>): ComponentesKit {
  return Object.fromEntries(
    Object.entries(q).map(([id, quantidade]) => [
      id,
      { quantidade, limitarEstoque: true, timestamp: null },
    ]),
  );
}

/** S for one produto, through the binding exactly as a send run calls it. */
function S(args: {
  produto?: ProdutoEstoqueLi;
  estoque?: Record<string, unknown> | null;
  comps?: DocEstoqueLi[];
}): number {
  return quantidadeEstoqueLi(
    membroEstoqueLi({
      produtoId: 'p1',
      produto: args.produto ?? {},
      estoque:
        args.estoque === undefined || args.estoque === null
          ? null
          : registro('p1', 'est-p1-dep1', args.estoque),
      componentes: args.comps ?? [],
    }),
  );
}

describe('opcoesEstoqueLi: the three parameters, pinned', () => {
  it('own kit stock off, virtual kits never skipped, no ceiling — and the ceiling is +∞, never 0', () => {
    expect(opcoesEstoqueLi).toEqual({
      incluirEstoqueProprioDoKit: false,
      pularKitVirtual: false,
      estoqueMax: Number.POSITIVE_INFINITY,
    });
    expect(opcoesEstoqueLi.estoqueMax).not.toBe(0);
  });

  it('is frozen: no caller can adjust it for the rest of a run', () => {
    expect(Object.isFrozen(opcoesEstoqueLi)).toBe(true);
  });
});

describe('quantidadeEstoqueLi: the shared core, bound', () => {
  it('a non-kit is its own available quantity, floored and clamped at 0', () => {
    expect(S({ estoque: { quantidade: 7.6, quantidadeReservada: 2 } })).toBe(5);
    expect(S({ estoque: { quantidade: 2, quantidadeReservada: 5 } })).toBe(0);
    expect(S({ estoque: { quantidade: 4 } })).toBe(4);
  });

  it('a negative stored reservation is no reservation: 8 with −2 reserved is 8, never 10', () => {
    expect(S({ estoque: { quantidade: 8, quantidadeReservada: -2 } })).toBe(8);
  });

  it('no record at the depósito reads 0', () => {
    expect(S({ estoque: null })).toBe(0);
  });

  it('no ceiling here: a large quantity is not clamped (the configured cap is the caller’s)', () => {
    expect(S({ estoque: { quantidade: 1_000_000 } })).toBe(1_000_000);
  });

  it('a kit is the min over its components of ⌊available / quantity in the kit⌋', () => {
    const produto = { ehKit: true, componentesKit: componentes({ blank: 1, print: 2 }) };
    const comps = [
      registro('blank', 'est-blank-dep1', { quantidade: 9 }),
      registro('print', 'est-print-dep1', { quantidade: 9, quantidadeReservada: 1 }),
    ];
    expect(S({ produto, comps })).toBe(4); // min(9 / 1, 8 / 2)
  });

  it('⚠️ #932: a component is keyed by the owner in its PATH, never by its stored parentId', () => {
    const produto = { ehKit: true, componentesKit: componentes({ blank: 1, print: 1 }) };
    const comps = [
      // A legacy row with no denorm, and one whose denorm names someone else.
      registro('blank', 'auto-id-1', { quantidade: 6 }),
      registro('print', 'auto-id-2', { quantidade: 5, parentId: 'outro-produto' }),
    ];
    // Keyed on the stored field, both would be missing and the kit would read 0.
    expect(S({ produto, comps })).toBe(5);
  });

  it('a component with no record counts 0 (#238): the kit publishes 0', () => {
    const produto = { ehKit: true, componentesKit: componentes({ blank: 1, print: 1 }) };
    expect(S({ produto, comps: [registro('blank', 'est-blank-dep1', { quantidade: 6 })] })).toBe(0);
  });

  it('⚠️ NEAR-MISS (#1087): a VIRTUAL kit alone takes the kit branch, never its own record', () => {
    const produto = {
      ehKit: false,
      ehKitVirtual: true,
      componentesKit: componentes({ blank: 2 }),
    };
    const comps = [registro('blank', 'est-blank-dep1', { quantidade: 7 })];
    // Keyed on `ehKit` alone, the run would send the kit's own 50.
    expect(S({ produto, estoque: { quantidade: 50 }, comps })).toBe(3);
  });

  it('a constrained kit never adds its own record: components allow 3, own 7 ⇒ 3, never 10', () => {
    const produto = { ehKit: true, componentesKit: componentes({ blank: 1 }) };
    const comps = [registro('blank', 'est-blank-dep1', { quantidade: 3 })];
    expect(S({ produto, estoque: { quantidade: 7 }, comps })).toBe(3);
  });

  it('a kit no component constrains falls back to its own record', () => {
    expect(S({ produto: { ehKit: true, componentesKit: {} }, estoque: { quantidade: 6 } })).toBe(6);
    expect(S({ produto: { ehKit: true, componentesKit: null }, estoque: { quantidade: 6 } })).toBe(
      6,
    );
  });

  it('the kit flags are read exactly: a stored "true" or 1 is not a kit', () => {
    const comps = [registro('blank', 'est-blank-dep1', { quantidade: 1 })];
    const componentesKit = componentes({ blank: 1 });
    expect(
      S({ produto: { ehKit: 'true', componentesKit }, estoque: { quantidade: 9 }, comps }),
    ).toBe(9);
    expect(S({ produto: { ehKit: 1, componentesKit }, estoque: { quantidade: 9 }, comps })).toBe(9);
    expect(S({ produto: { ehKit: true, componentesKit }, estoque: { quantidade: 9 }, comps })).toBe(
      1,
    );
  });
});

describe('membroEstoqueLi: refuses what only a bug can produce', () => {
  it('an own record of another produto', () => {
    expect(() =>
      membroEstoqueLi({
        produtoId: 'p1',
        produto: {},
        estoque: registro('p2', 'est-p2-dep1', { quantidade: 1 }),
        componentes: [],
      }),
    ).toThrow(RangeError);
  });

  it('a path that does not parse, own or component', () => {
    const torto: DocEstoqueLi = { caminho: 'produtos/p1/estoque/e1', dados: {} };
    expect(() =>
      membroEstoqueLi({ produtoId: 'p1', produto: {}, estoque: torto, componentes: [] }),
    ).toThrow(RangeError);
    expect(() =>
      membroEstoqueLi({ produtoId: 'p1', produto: {}, estoque: null, componentes: [torto] }),
    ).toThrow(RangeError);
  });

  it('the member carries the record ids and the path owners', () => {
    const membro = membroEstoqueLi({
      produtoId: 'p1',
      produto: { ehKit: true },
      estoque: registro('p1', 'e-own', { quantidade: 1, parentId: 'lixo' }),
      componentes: [registro('blank', 'e-blank', { quantidade: 2 })],
    });
    expect(membro.estoque).toMatchObject({ estoqueDocId: 'e-own' });
    expect(membro.componentEstoques).toEqual([
      { quantidade: 2, estoqueDocId: 'e-blank', parentId: 'blank' },
    ]);
  });
});

describe('caminhoEstoqueLi', () => {
  it('splits produtos/{produto}/estoques/{record}', () => {
    expect(caminhoEstoqueLi('produtos/p1/estoques/est-p1-dep1')).toEqual({
      produtoId: 'p1',
      estoqueId: 'est-p1-dep1',
    });
  });

  it.each([
    '/produtos/p1/estoques/e1',
    'documents/produtos/p1/estoques/e1',
    'produtos/p1/produtolojaintegrada/e1',
    'produtos/p1/estoques/e1/x/y',
    'produtos//estoques/e1',
    'produtos/p1/estoques/',
    '',
  ])('refuses %j', (caminho) => {
    expect(caminhoEstoqueLi(caminho)).toBeNull();
  });
});

describe('model A: alvoEstoqueLi and corpoEstoqueLi', () => {
  it('R = 2 ⇒ S + 2', () => {
    expect(alvoEstoqueLi(10, 2)).toBe(12);
  });

  it('⚠️ NEAR-MISS: R = −3 ⇒ S, never S − R = S + 3 (a negative reservation is none)', () => {
    expect(alvoEstoqueLi(10, -3)).toBe(10);
    expect(alvoEstoqueLi(10, -3)).not.toBe(13);
  });

  it('R = 0 ⇒ S, and S = 0 ⇒ R', () => {
    expect(alvoEstoqueLi(10, 0)).toBe(10);
    expect(alvoEstoqueLi(0, 4)).toBe(4);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined, 2 ** 53, true])(
    'an unreadable reservation %j REFUSES (null): nothing is derived from it',
    (R) => {
      expect(alvoEstoqueLi(10, R)).toBeNull();
      expect(corpoEstoqueLi(10, R)).toBeNull();
    },
  );

  it('a sum past the safe integers refuses', () => {
    expect(alvoEstoqueLi(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('S = %j is a bug: throws', (s) => {
    expect(() => alvoEstoqueLi(s, 0)).toThrow(RangeError);
    expect(() => corpoEstoqueLi(s, 0)).toThrow(RangeError);
  });

  it('the body is exactly the four fields, model A in `quantidade`', () => {
    expect(corpoEstoqueLi(10, 2)).toStrictEqual({
      gerenciado: true,
      quantidade: 12,
      situacao_em_estoque: 0,
      situacao_sem_estoque: -1,
    });
    expect(Object.keys(corpoEstoqueLi(0, -3) ?? {})).toHaveLength(4);
    expect(corpoEstoqueLi(0, -3)?.quantidade).toBe(0);
  });
});
