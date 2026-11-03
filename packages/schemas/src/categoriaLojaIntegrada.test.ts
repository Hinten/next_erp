import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that `src/index.ts` exports the module.
import {
  MOTIVO_CADEIA_CATEGORIA_LI,
  PROFUNDIDADE_MAX_CATEGORIA_LI,
  TIPO_PAI_CATEGORIA_LI,
  arvoreCategoriasLi,
  categoriaLojaIntegradaLinkSchema,
  folhaDoProdutoLi,
  idCategoriaLiDoVinculo,
  vinculoCategoriaServeAConta,
  type CategoriaCatalogoLi,
} from './index';

const raiz = (id: number): CategoriaCatalogoLi => ({
  id,
  nome: `c${String(id)}`,
  pai: { tipo: TIPO_PAI_CATEGORIA_LI.raiz },
});
const sob = (id: number, pai: number): CategoriaCatalogoLi => ({
  id,
  nome: `c${String(id)}`,
  pai: { tipo: TIPO_PAI_CATEGORIA_LI.id, id: pai },
});
const ilegivel = (id: number): CategoriaCatalogoLi => ({
  id,
  nome: `c${String(id)}`,
  pai: { tipo: TIPO_PAI_CATEGORIA_LI.ilegivel },
});
const uri = (id: number) => `/v1/categoria/${String(id)}`;

describe('categoriaLojaIntegradaLinkSchema — the link doc', () => {
  it('parses a migrated doc (text id, no conta) and a new one (with the conta)', () => {
    expect(categoriaLojaIntegradaLinkSchema.parse({ id: '7645875', nome: 'A' })).toEqual({
      id: '7645875',
      nome: 'A',
      contaLojaIntegrada: null,
    });
    expect(
      categoriaLojaIntegradaLinkSchema.parse({
        id: '7645875',
        nome: 'A',
        contaLojaIntegrada: 'documents/integracao/C1',
      }).contaLojaIntegrada,
    ).toBe('documents/integracao/C1');
  });

  it('keeps the id a STRING: a written numeric id is refused', () => {
    expect(categoriaLojaIntegradaLinkSchema.safeParse({ id: 7645875 }).success).toBe(false);
  });
});

describe('idCategoriaLiDoVinculo — the store category a link names', () => {
  it.each([[{ id: '7645875' }], [{ id: 7645875 }], [{ id: '7645875', nome: null }]])(
    'EQUAL: %j ⇒ 7645875 (migrated text ≡ new text ≡ number)',
    (doc) => {
      expect(idCategoriaLiDoVinculo(doc)).toBe(7645875);
    },
  );

  it.each([
    [{ id: '07645875' }],
    [{ id: ' 7645875' }],
    [{ id: '7645875.0' }],
    [{ id: 'None' }],
    [{ id: '' }],
    [{ id: 0 }],
    [{}],
    [null],
    ['7645875'],
  ])('⚠️ NEAR-MISS: %j ⇒ null (not an id)', (doc) => {
    expect(idCategoriaLiDoVinculo(doc)).toBeNull();
  });
});

describe('vinculoCategoriaServeAConta — which link serves this conta', () => {
  const DA_LOJA = new Set([7645875]);

  it('EQUAL: a new doc of C1 serves C1, in both stored ref forms, listed or not', () => {
    expect(
      vinculoCategoriaServeAConta(
        { id: '7645875', contaLojaIntegrada: 'documents/integracao/C1' },
        'C1',
        DA_LOJA,
      ),
    ).toBe(true);
    expect(
      vinculoCategoriaServeAConta({ id: '1', contaLojaIntegrada: 'integracao/C1' }, 'C1', DA_LOJA),
    ).toBe(true);
  });

  it('EQUAL: a migrated doc with no conta serves a store whose list holds its id', () => {
    expect(vinculoCategoriaServeAConta({ id: '7645875' }, 'C1', DA_LOJA)).toBe(true);
    expect(
      vinculoCategoriaServeAConta({ id: '7645875', contaLojaIntegrada: null }, 'C1', DA_LOJA),
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS: a new doc of C2 never serves C1, even for an id C1’s store lists', () => {
    expect(
      vinculoCategoriaServeAConta(
        { id: '7645875', contaLojaIntegrada: 'documents/integracao/C2' },
        'C1',
        DA_LOJA,
      ),
    ).toBe(false);
  });

  it('⚠️ NEAR-MISS: a conta-less doc whose id this store does not list serves nobody here', () => {
    expect(vinculoCategoriaServeAConta({ id: '1' }, 'C1', DA_LOJA)).toBe(false);
  });

  it('⚠️ NEAR-MISS: an unreadable conta ref or id serves nobody', () => {
    expect(
      vinculoCategoriaServeAConta({ id: '7645875', contaLojaIntegrada: 'C1' }, 'C1', DA_LOJA),
    ).toBe(false);
    expect(vinculoCategoriaServeAConta({ id: '07645875' }, 'C1', new Set([7645875]))).toBe(false);
  });
});

describe('arvoreCategoriasLi — the chain of a category', () => {
  it('EQUAL: a root is its own chain; a child chains to its root, root first', () => {
    const arvore = arvoreCategoriasLi([sob(3, 2), raiz(1), sob(2, 1)]);
    expect(arvore.cadeia(1)).toEqual({ tipo: 'ok', ids: [1] });
    expect(arvore.cadeia(3)).toEqual({ tipo: 'ok', ids: [1, 2, 3] });
  });

  it('⚠️ NEAR-MISS: an unreadable ancestor refuses the chain — never read as a root', () => {
    const arvore = arvoreCategoriasLi([ilegivel(1), sob(2, 1)]);
    expect(arvore.cadeia(2)).toEqual({
      tipo: 'recusada',
      motivo: MOTIVO_CADEIA_CATEGORIA_LI.paiIlegivel,
    });
  });

  it('⚠️ NEAR-MISS: a parent missing from the list refuses the chain — never a root', () => {
    const arvore = arvoreCategoriasLi([sob(2, 99)]);
    expect(arvore.cadeia(2)).toEqual({
      tipo: 'recusada',
      motivo: MOTIVO_CADEIA_CATEGORIA_LI.paiAusente,
    });
  });

  it('⚠️ NEAR-MISS: a cycle refuses the chain', () => {
    const arvore = arvoreCategoriasLi([sob(1, 2), sob(2, 1)]);
    expect(arvore.cadeia(1)).toEqual({
      tipo: 'recusada',
      motivo: MOTIVO_CADEIA_CATEGORIA_LI.ciclo,
    });
    const propria = arvoreCategoriasLi([sob(5, 5)]);
    expect(propria.cadeia(5)).toEqual({
      tipo: 'recusada',
      motivo: MOTIVO_CADEIA_CATEGORIA_LI.ciclo,
    });
  });

  it(`a chain of ${String(PROFUNDIDADE_MAX_CATEGORIA_LI)} is accepted; one deeper is refused`, () => {
    const lista = [raiz(1)];
    for (let i = 2; i <= PROFUNDIDADE_MAX_CATEGORIA_LI + 1; i += 1) lista.push(sob(i, i - 1));
    const arvore = arvoreCategoriasLi(lista);
    const ok = arvore.cadeia(PROFUNDIDADE_MAX_CATEGORIA_LI);
    expect(ok.tipo === 'ok' ? ok.ids.length : 0).toBe(PROFUNDIDADE_MAX_CATEGORIA_LI);
    expect(arvore.cadeia(PROFUNDIDADE_MAX_CATEGORIA_LI + 1)).toEqual({
      tipo: 'recusada',
      motivo: MOTIVO_CADEIA_CATEGORIA_LI.profundidade,
    });
  });

  it('a category the store does not list is refused as absent', () => {
    expect(arvoreCategoriasLi([raiz(1)]).cadeia(2)).toEqual({
      tipo: 'recusada',
      motivo: MOTIVO_CADEIA_CATEGORIA_LI.ausente,
    });
  });

  it('a row repeated with the same parent is one category; with two parents it is refused', () => {
    expect(arvoreCategoriasLi([raiz(1), sob(2, 1), sob(2, 1)]).cadeia(2)).toEqual({
      tipo: 'ok',
      ids: [1, 2],
    });
    expect(arvoreCategoriasLi([raiz(1), raiz(3), sob(2, 1), sob(2, 3)]).cadeia(2)).toEqual({
      tipo: 'recusada',
      motivo: MOTIVO_CADEIA_CATEGORIA_LI.paiIlegivel,
    });
  });
});

describe('folhaDoProdutoLi — the linked-leaf rule', () => {
  // A > B > C, and a promotion branch P.
  const arvore = arvoreCategoriasLi([raiz(1), sob(2, 1), sob(3, 2), raiz(9)]);
  const nenhuma = () => false;

  it('EQUAL: [A, A>B, A>B>C] ⇒ C, the one leaf (unlinked)', () => {
    expect(folhaDoProdutoLi([uri(1), uri(2), uri(3)], arvore, nenhuma)).toEqual({
      tipo: 'folha',
      id: 3,
      vinculada: false,
    });
  });

  it('EQUAL: [A, A>B, P] with only B linked ⇒ B — the branch the operator linked wins', () => {
    expect(folhaDoProdutoLi([uri(1), uri(2), uri(9)], arvore, (id) => id === 2)).toEqual({
      tipo: 'folha',
      id: 2,
      vinculada: true,
    });
  });

  it('⚠️ NEAR-MISS: B and P both linked ⇒ ambigua, never the first one', () => {
    expect(folhaDoProdutoLi([uri(2), uri(9)], arvore, (id) => id === 2 || id === 9)).toEqual({
      tipo: 'ambigua',
      ids: [2, 9],
    });
  });

  it('⚠️ NEAR-MISS: neither linked with two leaves ⇒ ambigua (nothing is created)', () => {
    expect(folhaDoProdutoLi([uri(2), uri(9)], arvore, nenhuma)).toEqual({
      tipo: 'ambigua',
      ids: [2, 9],
    });
  });

  it('a linked ANCESTOR is not a leaf: the leaf below it is the answer', () => {
    expect(folhaDoProdutoLi([uri(1), uri(3)], arvore, (id) => id === 1)).toEqual({
      tipo: 'folha',
      id: 3,
      vinculada: false,
    });
  });

  it('[] ⇒ nenhuma', () => {
    expect(folhaDoProdutoLi([], arvore, nenhuma)).toEqual({ tipo: 'nenhuma' });
  });

  it('⚠️ an unreadable URI picks no leaf: the leaf could be the unreadable one', () => {
    expect(folhaDoProdutoLi([uri(3), '/api/v1/categoria/None'], arvore, nenhuma)).toEqual({
      tipo: 'ilegivel',
      uris: 1,
    });
  });
});
