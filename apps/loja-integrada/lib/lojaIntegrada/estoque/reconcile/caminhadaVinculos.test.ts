/**
 * `caminhadaVinculos.ts` (master plan step 12, PR 12-g): one page of the ERP link walk — key order,
 * the cursor always the page's last link, a trailing produto completed by its own listing and
 * skipped on the next page, and nothing but a produto's own link attributed to a produto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDb, asDb } from '../../testing/fakeDb';
import {
  CAMPOS_VINCULO_CAMINHADA_LI,
  TAMANHO_PAGINA_CAMINHADA_LI,
  donoDoVinculoLi,
  lerPaginaCaminhadaLi,
} from './caminhadaVinculos';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('caminhadaVinculos.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const link = (id: number) => ({
  contaLojaIntegrada: 'documents/integracao/C1',
  id,
  paiProdutoIntegradaId: 9,
  removido: false,
  nome: 'fora da projeção',
});

/** Walks to the end, page by page, collecting each page. */
async function caminhar(db: FakeDb, tamanho: number) {
  const paginas = [];
  let cursor: string | null = null;
  for (let n = 0; n < 50; n += 1) {
    const pagina = await lerPaginaCaminhadaLi(asDb(db), cursor, tamanho);
    paginas.push(pagina);
    cursor = pagina.ultimoDocPath;
    if (pagina.concluida) return paginas;
  }
  throw new Error('a caminhada não terminou');
}

describe('lerPaginaCaminhadaLi — every produto’s links evaluated TOGETHER, exactly once', () => {
  it('a produto straddling a page boundary is completed by ONE listing; the next page skips it', async () => {
    const db = new FakeDb();
    db.seed('produtos/p/produtolojaintegrada/a', link(5));
    db.seed('produtos/p/produtolojaintegrada/b', link(5));
    db.seed('produtos/p-1/produtolojaintegrada/a', link(6));
    db.seed('produtos/p0/produtolojaintegrada/a', link(7));
    db.seed('produtos/p0/produtolojaintegrada/b', link(7));
    db.seed('produtos/p0/produtolojaintegrada/c', link(7));
    const paginas = await caminhar(db, 2);
    expect(paginas.map((p) => p.grupos.map((g) => [g.produtoId, g.links.length]))).toEqual([
      [['p', 2]],
      [
        ['p-1', 1],
        ['p0', 3],
      ],
      [],
      [],
    ]);
    expect(paginas.map((p) => p.ultimoDocPath)).toEqual([
      'produtos/p/produtolojaintegrada/b',
      'produtos/p0/produtolojaintegrada/a',
      'produtos/p0/produtolojaintegrada/c',
      'produtos/p0/produtolojaintegrada/c',
    ]);
    // Each produto appears ONCE across the whole walk.
    const vistos = paginas.flatMap((p) => p.grupos.map((g) => g.produtoId));
    expect(new Set(vistos).size).toBe(vistos.length);
    // 4 key queries + 2 own listings (p, then p0) — never one per page per produto.
    const grupo = db.consultas.filter((c) => c.grupo === true);
    const proprias = db.consultas.filter((c) => c.grupo !== true);
    expect(grupo).toHaveLength(4);
    expect(proprias.map((c) => c.colecao)).toEqual([
      'produtos/p/produtolojaintegrada',
      'produtos/p0/produtolojaintegrada',
    ]);
  });

  it('⚠️ NEAR-MISS (the stuck walk): ONE produto filling the whole page still advances the cursor', async () => {
    const db = new FakeDb();
    for (const l of ['a', 'b', 'c']) db.seed(`produtos/x/produtolojaintegrada/${l}`, link(8));
    const paginas = await caminhar(db, 2);
    expect(paginas.map((p) => p.ultimoDocPath)).toEqual([
      'produtos/x/produtolojaintegrada/b',
      'produtos/x/produtolojaintegrada/c',
    ]);
    expect(paginas[0]?.grupos).toEqual([{ produtoId: 'x', links: [link(8), link(8), link(8)] }]);
    expect(paginas[1]?.grupos).toEqual([]);
    expect(paginas[1]?.concluida).toBe(true);
  });

  it('a page projects the readers’ fields; a completed produto carries its whole documents', async () => {
    const db = new FakeDb();
    db.seed('produtos/a/produtolojaintegrada/l1', link(1));
    db.seed('produtos/b/produtolojaintegrada/l1', link(2));
    const [pagina] = await caminhar(db, 2);
    expect(db.consultas[0]).toMatchObject({
      grupo: true,
      selecao: [...CAMPOS_VINCULO_CAMINHADA_LI],
      ordens: [['__name__', 'asc']],
      limite: 2,
      apos: null,
    });
    const [primeiro, ultimo] = pagina?.grupos ?? [];
    expect(primeiro?.links).toEqual([
      {
        contaLojaIntegrada: 'documents/integracao/C1',
        id: 1,
        paiProdutoIntegradaId: 9,
        removido: false,
      },
    ]);
    expect(ultimo?.links).toEqual([link(2)]);
  });

  it('⚠️ only a produto’s own link counts: another root’s, or a root-level one, is counted and never attributed — but moves the cursor', async () => {
    const db = new FakeDb();
    db.seed('e2e_produtos/p1/produtolojaintegrada/l1', link(3));
    db.seed('produtolojaintegrada/raiz', link(3));
    db.seed('produtos/p1/produtolojaintegrada/l1', link(3));
    const paginas = await caminhar(db, TAMANHO_PAGINA_CAMINHADA_LI);
    expect(paginas).toHaveLength(1);
    expect(paginas[0]?.grupos.map((g) => g.produtoId)).toEqual(['p1']);
    expect(paginas[0]?.ignorados).toBe(2);
    expect(paginas[0]?.lidos).toBe(3);
  });

  it('an empty walk ends at once with no cursor', async () => {
    const pagina = await lerPaginaCaminhadaLi(asDb(new FakeDb()), null, 3);
    expect(pagina).toMatchObject({ grupos: [], ultimoDocPath: null, concluida: true, lidos: 0 });
  });

  it('donoDoVinculoLi reads exactly produtos/{p}/produtolojaintegrada/{l}', () => {
    expect(donoDoVinculoLi('produtos/p1/produtolojaintegrada/l1')).toBe('p1');
    expect(donoDoVinculoLi('e2e_produtos/p1/produtolojaintegrada/l1')).toBeNull();
    expect(donoDoVinculoLi('a/b/produtos/p1/produtolojaintegrada/l1')).toBeNull();
    expect(donoDoVinculoLi('produtos/p1/produtoshopee/l1')).toBeNull();
    expect(donoDoVinculoLi('produtolojaintegrada/l1')).toBeNull();
  });

  it('refuses a page size that is not a positive integer (a caller bug)', async () => {
    await expect(lerPaginaCaminhadaLi(asDb(new FakeDb()), null, 0)).rejects.toThrow(RangeError);
  });
});
