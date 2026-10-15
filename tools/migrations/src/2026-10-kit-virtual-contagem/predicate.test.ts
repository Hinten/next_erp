import { describe, expect, it } from 'vitest';

import {
  entraNaContagem,
  montarLinhaDaContagem,
  resumirContagem,
  type FilhoContado,
  type LinhaDaContagem,
  type ProdutoContado,
  type VinculosDoProduto,
} from './predicate';

const SEM_VINCULOS: VinculosDoProduto = {
  produtoMercadoLivre: false,
  variacaoMercadoLivre: false,
  prodshopee: false,
  variashopee: false,
};

function produto(over: Partial<ProdutoContado> = {}): ProdutoContado {
  return {
    id: 'kit-1',
    paiId: null,
    ehKit: true,
    ehKitVirtual: true,
    componentesKit: { 'comp-a': { quantidade: 1 }, 'comp-b': { quantidade: 2 } },
    ...over,
  };
}

const filho = (id: string, variacaoMercadoLivre: boolean): FilhoContado => ({
  id,
  variacaoMercadoLivre,
});

describe('entraNaContagem — ehKitVirtual === true, strictly', () => {
  it('counts a stored literal true', () => {
    expect(entraNaContagem({ ehKitVirtual: true })).toBe(true);
  });

  // NEAR-MISSES: every one of these is a corpus oddity, not a kit flag. L7 asks
  // for `=== true`, and a fold here would grow the list Lucas reviews by rows the
  // publisher never reads as virtual.
  it.each([
    ['false', false],
    ['null (legacy)', null],
    ['absent', undefined],
    ["the string 'true'", 'true'],
    ['the number 1', 1],
  ])('does NOT count %s', (_rotulo, valor) => {
    expect(entraNaContagem({ ehKitVirtual: valor })).toBe(false);
  });

  it('does NOT gate on ehKit — the ehKit !== true rows are part of what Lucas reviews', () => {
    expect(entraNaContagem({ ehKitVirtual: true, ehKit: false } as { ehKitVirtual: unknown })).toBe(
      true,
    );
  });
});

describe('montarLinhaDaContagem — the Mercado Livre split (M161)', () => {
  // The truth table over (ML on the produto, ML on child 1, ML on child 2). The
  // load-bearing row is the THIRD: a family whose ML link sits on the SECOND child
  // only. A predicate that asks the first child alone (or every child) reads it
  // "sem Mercado Livre" and Lucas flips a flag the ML side still means.
  it.each([
    // [rotulo, mlProduto, ml1, ml2, mlNoProduto, mlNosFilhos, comMercadoLivre]
    ['nothing anywhere', false, false, false, false, false, false],
    ['only the produto', true, false, false, true, false, true],
    ['only the SECOND child (M161)', false, false, true, false, true, true],
    ['only the first child', false, true, false, false, true, true],
    ['both children', false, true, true, false, true, true],
    ['the produto and a child', true, false, true, true, true, true],
  ])('%s', (_rotulo, mlProduto, ml1, ml2, mlNoProduto, mlNosFilhos, comMercadoLivre) => {
    const linha = montarLinhaDaContagem(
      produto(),
      { ...SEM_VINCULOS, produtoMercadoLivre: mlProduto },
      [filho('f-1', ml1), filho('f-2', ml2)],
    );
    expect(linha).toMatchObject({ mlNoProduto, mlNosFilhos, comMercadoLivre });
  });

  it('a family of three with the link on the LAST child still counts (no positional shortcut)', () => {
    const linha = montarLinhaDaContagem(produto(), SEM_VINCULOS, [
      filho('f-1', false),
      filho('f-2', false),
      filho('f-3', true),
    ]);
    expect(linha.mlNosFilhos).toBe(true);
    expect(linha.comMercadoLivre).toBe(true);
  });

  it('no children at all is "nothing on the children", never an error', () => {
    const linha = montarLinhaDaContagem(produto(), SEM_VINCULOS, []);
    expect(linha.mlNosFilhos).toBe(false);
    expect(linha.comMercadoLivre).toBe(false);
  });

  // A família-de-um MEMBER mirrors the flag and holds the VARIATION kinds. Reading
  // only the listing kinds on the produto itself would print it "sem ML".
  it('a mirrored member whose ML link is a variacaoMercadoLivre is "com Mercado Livre"', () => {
    const linha = montarLinhaDaContagem(
      produto({ id: 'membro-1', paiId: 'kit-1' }),
      { ...SEM_VINCULOS, variacaoMercadoLivre: true },
      [],
    );
    expect(linha).toMatchObject({
      paiId: 'kit-1',
      mlNoProduto: true,
      mlNosFilhos: false,
      comMercadoLivre: true,
    });
  });

  it('a Shopee link of either kind is comShopee; a Mercado Livre link is NOT', () => {
    expect(
      montarLinhaDaContagem(produto(), { ...SEM_VINCULOS, prodshopee: true }, []).comShopee,
    ).toBe(true);
    expect(
      montarLinhaDaContagem(produto(), { ...SEM_VINCULOS, variashopee: true }, []).comShopee,
    ).toBe(true);
    // NEAR-MISS: the channels never leak into each other.
    const soMl = montarLinhaDaContagem(produto(), { ...SEM_VINCULOS, produtoMercadoLivre: true }, [
      filho('f-1', true),
    ]);
    expect(soMl.comShopee).toBe(false);
    const soShopee = montarLinhaDaContagem(
      produto(),
      { ...SEM_VINCULOS, prodshopee: true, variashopee: true },
      [],
    );
    expect(soShopee.comMercadoLivre).toBe(false);
  });
});

describe('montarLinhaDaContagem — the other fields', () => {
  it('emits exactly the field set the window issue (#1854) promises, in order', () => {
    const linha = montarLinhaDaContagem(produto(), SEM_VINCULOS, []);
    expect(Object.keys(linha)).toEqual([
      'produtoId',
      'paiId',
      'ehKit',
      'temComponentes',
      'comMercadoLivre',
      'mlNoProduto',
      'mlNosFilhos',
      'comShopee',
    ]);
  });

  it('ehKit is strictly === true: null, absent, "true" and 1 all read false', () => {
    expect(montarLinhaDaContagem(produto({ ehKit: true }), SEM_VINCULOS, []).ehKit).toBe(true);
    for (const valor of [false, null, undefined, 'true', 1]) {
      expect(montarLinhaDaContagem(produto({ ehKit: valor }), SEM_VINCULOS, []).ehKit).toBe(false);
    }
  });

  it('temComponentes: a map with one key counts; empty, null, an array or a string do not', () => {
    const com = (componentesKit: unknown) =>
      montarLinhaDaContagem(produto({ componentesKit }), SEM_VINCULOS, []).temComponentes;
    expect(com({ 'comp-a': { quantidade: 1 } })).toBe(true);
    expect(com({})).toBe(false);
    expect(com(null)).toBe(false);
    expect(com(undefined)).toBe(false);
    expect(com(['comp-a'])).toBe(false);
    expect(com('comp-a')).toBe(false);
  });

  it("paiId: a root reads null — the legacy '' too; a child keeps its parent's id", () => {
    const pai = (paiId: unknown) =>
      montarLinhaDaContagem(produto({ paiId }), SEM_VINCULOS, []).paiId;
    expect(pai(null)).toBeNull();
    expect(pai(undefined)).toBeNull();
    expect(pai('')).toBeNull();
    expect(pai('kit-1')).toBe('kit-1');
  });
});

describe('resumirContagem', () => {
  const linha = (over: Partial<LinhaDaContagem>): LinhaDaContagem => ({
    produtoId: 'p',
    paiId: null,
    ehKit: true,
    temComponentes: true,
    comMercadoLivre: false,
    mlNoProduto: false,
    mlNosFilhos: false,
    comShopee: false,
    ...over,
  });

  it('splits by comMercadoLivre and counts the ehKit !== true subset apart', () => {
    const resumo = resumirContagem([
      linha({ produtoId: 'a', comMercadoLivre: true, mlNosFilhos: true }),
      linha({ produtoId: 'b', comMercadoLivre: true, mlNoProduto: true, comShopee: true }),
      linha({ produtoId: 'c', ehKit: false }),
      linha({ produtoId: 'd', paiId: 'a' }),
    ]);
    expect(resumo).toEqual({
      total: 4,
      comMercadoLivre: 2,
      semMercadoLivre: 2,
      semEhKit: 1,
      comShopee: 1,
      filhos: 1,
    });
  });

  it('an empty contagem is all zeros — a measured zero, the run did look', () => {
    expect(resumirContagem([])).toEqual({
      total: 0,
      comMercadoLivre: 0,
      semMercadoLivre: 0,
      semEhKit: 0,
      comShopee: 0,
      filhos: 0,
    });
  });
});
