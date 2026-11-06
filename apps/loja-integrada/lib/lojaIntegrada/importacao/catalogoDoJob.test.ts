/**
 * The product import's `catalogo` phase (`catalogoDoJob.ts`) on the fake Firestore, through the
 * REAL context loader, client and one-page reader.
 *
 * Nothing reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file, and
 * the context's client calls a scripted store (`testing/catalogoLi.ts`) whose every request is
 * recorded — the call counts below are exact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  CAMINHO_CATEGORIAS_LI,
  CAMINHO_MARCAS_LI,
  LiThrottleError,
} from '@delfrance/integrations-loja-integrada';
import {
  type CategoriaDoJobLi,
  LIMITE_PAGINA_CATALOGO_LI,
  MAX_PAGINAS_CATALOGO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  RECURSO_CATALOGO_IMPORTACAO_LI,
  VINCULO_CATEGORIA_IMPORTACAO_LI,
  importacaoLojaIntegradaSchema,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import {
  type ChamadaCatalogoLi,
  type RespostaCatalogoLi,
  categoriaLi,
  marcaLi,
  offsetDe,
  paginaCatalogoLi,
} from '../testing/catalogoLi';
import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS, gravadorDeLog, seedConta, seedCredencial } from '../testing/fixtures';
import { contextoDeTesteLi } from '../testing/produtosLi';
import {
  type CatalogoDoJobDeps,
  type EstadoCatalogoDoJobLi,
  OPERACAO_PAGINA_CATEGORIAS_LI,
  type PassoCatalogoDoJobLi,
  executarUnidadeDoCatalogoDoJobLi,
  unidadeDoCatalogoDoJobLi,
} from './catalogoDoJob';
import { UNIDADE_IMPORTACAO_LI } from './orcamento';

const CONTA = 'conta-li-catalogo-job';
const OUTRA_CONTA = 'conta-li-catalogo-job-2';

let db: FakeDb;
let fetchGlobal: ReturnType<typeof vi.fn>;
let gravador: ReturnType<typeof gravadorDeLog>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  fetchGlobal = vi.fn(() => {
    throw new Error('catalogoDoJob.test: só o fetch roteirizado do contexto pode ser chamado');
  });
  vi.stubGlobal('fetch', fetchGlobal);
  db = new FakeDb();
  seedConta(db, CONTA);
  seedCredencial(db, CONTA);
  gravador = gravadorDeLog();
});
afterEach(() => {
  expect(fetchGlobal).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

/** The job's initial state of the phase, through the job schema (every default a create has). */
function estadoInicial(): EstadoCatalogoDoJobLi {
  const job = importacaoLojaIntegradaSchema.parse({
    integracaoId: CONTA,
    status: 'executando',
    iniciadoEmMs: AGORA_MS,
  });
  return { catalogo: job.catalogo, mapaCategorias: job.mapaCategorias, marcas: job.marcas };
}

/** A store with `nCategorias` categories (ids 1000…) and `nMarcas` brands (ids 2000…). */
function loja(nCategorias: number, nMarcas: number) {
  const categorias = Array.from({ length: nCategorias }, (_, i) =>
    categoriaLi(1000 + i, i === 0 ? null : '/v1/categoria/1000'),
  );
  const marcas = Array.from({ length: nMarcas }, (_, i) => marcaLi(2000 + i));
  return (c: ChamadaCatalogoLi): RespostaCatalogoLi => {
    const lista =
      c.caminho === CAMINHO_CATEGORIAS_LI
        ? { recurso: 'categoria', linhas: categorias }
        : c.caminho === CAMINHO_MARCAS_LI
          ? { recurso: 'marca', linhas: marcas }
          : null;
    if (lista === null) return { status: 500, corpo: { erro: 'rota nao roteirizada' } };
    const offset = offsetDe(c);
    return paginaCatalogoLi(
      lista.recurso,
      lista.linhas.slice(offset, offset + LIMITE_PAGINA_CATALOGO_LI),
      { offset, limite: LIMITE_PAGINA_CATALOGO_LI, total: lista.linhas.length },
    );
  };
}

async function deps(
  responder: (c: ChamadaCatalogoLi) => RespostaCatalogoLi,
  conta = CONTA,
): Promise<{ d: CatalogoDoJobDeps; chamadas: ChamadaCatalogoLi[]; esperas: number[] }> {
  const { contexto, chamadas, esperas } = await contextoDeTesteLi(
    asDb(db),
    conta,
    responder,
    gravador.escrever,
  );
  return { d: { db: asDb(db), cliente: contexto.cliente, contaId: conta }, chamadas, esperas };
}

function estadoDe(passo: PassoCatalogoDoJobLi): EstadoCatalogoDoJobLi {
  if (passo.tipo === 'falhou') throw new TypeError('esperava um passo que avança');
  return passo.estado;
}

/** Runs units until the phase concludes or fails, returning every step. */
async function percorrer(
  d: CatalogoDoJobDeps,
  estado: EstadoCatalogoDoJobLi,
): Promise<PassoCatalogoDoJobLi[]> {
  const passos: PassoCatalogoDoJobLi[] = [];
  let atual = estado;
  for (let i = 0; i < 50; i += 1) {
    const passo = await executarUnidadeDoCatalogoDoJobLi(d, atual);
    passos.push(passo);
    if (passo.tipo !== 'pagina') return passos;
    atual = passo.estado;
  }
  throw new Error('percorrer: a fase não terminou');
}

describe('the cost of the next unit', () => {
  it('a page of either list is ONE call; the link read after the brands calls nothing', () => {
    expect(unidadeDoCatalogoDoJobLi(estadoInicial().catalogo)).toBe(UNIDADE_IMPORTACAO_LI.chamada);
    expect(
      unidadeDoCatalogoDoJobLi({
        recurso: RECURSO_CATALOGO_IMPORTACAO_LI.categorias,
        proximoOffset: 50,
        paginas: 1,
      }),
    ).toBe(UNIDADE_IMPORTACAO_LI.chamada);
    // An exhausted category list goes on with the brands: still a call.
    expect(
      unidadeDoCatalogoDoJobLi({
        recurso: RECURSO_CATALOGO_IMPORTACAO_LI.categorias,
        proximoOffset: null,
        paginas: 2,
      }),
    ).toBe(UNIDADE_IMPORTACAO_LI.chamada);
    expect(
      unidadeDoCatalogoDoJobLi({
        recurso: RECURSO_CATALOGO_IMPORTACAO_LI.marcas,
        proximoOffset: null,
        paginas: 1,
      }),
    ).toBe(UNIDADE_IMPORTACAO_LI.familia);
  });
});

describe('the lists, one page per unit', () => {
  it('walks both lists page by page with step 10’s path and page size, ONE call per page unit', async () => {
    const { d, chamadas, esperas } = await deps(loja(60, 3));
    const passos = await percorrer(d, estadoInicial());

    expect(passos.map((p) => p.tipo)).toEqual(['pagina', 'pagina', 'pagina', 'concluido']);
    expect(chamadas.map((c) => [c.caminho, c.query])).toEqual([
      [
        CAMINHO_CATEGORIAS_LI,
        [
          ['limit', '50'],
          ['offset', '0'],
        ],
      ],
      [
        CAMINHO_CATEGORIAS_LI,
        [
          ['limit', '50'],
          ['offset', '50'],
        ],
      ],
      [
        CAMINHO_MARCAS_LI,
        [
          ['limit', '50'],
          ['offset', '0'],
        ],
      ],
    ]);
    // Every call paced by the context, exactly once.
    expect(esperas).toHaveLength(3);
    const final = estadoDe(passos.at(-1)!);
    expect(final.mapaCategorias.map((c) => c.id)).toEqual(
      Array.from({ length: 60 }, (_, i) => 1000 + i),
    );
    expect(final.mapaCategorias[1]).toEqual({
      id: 1001,
      nome: 'Categoria 1001',
      pai: { tipo: 'id', id: 1000 },
      erpCategoriaId: null,
      vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo,
    });
    expect(final.marcas.map((m) => m.id)).toEqual([2000, 2001, 2002]);
    // The context's call lines name each page's operation.
    expect(
      gravador.linhas.filter((l) => l.campos.operacao === OPERACAO_PAGINA_CATEGORIAS_LI),
    ).toHaveLength(2);
  });

  it('each page unit returns the cursor of the next page, then of the next list', async () => {
    const { d } = await deps(loja(60, 3));
    const p1 = await executarUnidadeDoCatalogoDoJobLi(d, estadoInicial());
    expect(p1.tipo === 'pagina' && p1.estado.catalogo).toEqual({
      recurso: RECURSO_CATALOGO_IMPORTACAO_LI.categorias,
      proximoOffset: 50,
      paginas: 1,
    });
    const p2 = await executarUnidadeDoCatalogoDoJobLi(d, estadoDe(p1));
    expect(p2.tipo === 'pagina' && p2.estado.catalogo).toEqual({
      recurso: RECURSO_CATALOGO_IMPORTACAO_LI.categorias,
      proximoOffset: null,
      paginas: 2,
    });
    const p3 = await executarUnidadeDoCatalogoDoJobLi(d, estadoDe(p2));
    expect(p3.tipo === 'pagina' && p3.estado.catalogo).toEqual({
      recurso: RECURSO_CATALOGO_IMPORTACAO_LI.marcas,
      proximoOffset: null,
      paginas: 1,
    });
  });

  it('a unit re-run from the same state reads the same page again and appends it ONCE', async () => {
    const { d } = await deps(loja(60, 3));
    const estado = estadoInicial();
    const a = estadoDe(await executarUnidadeDoCatalogoDoJobLi(d, estado));
    const b = estadoDe(await executarUnidadeDoCatalogoDoJobLi(d, estado));
    expect(b).toEqual(a);
    expect(b.mapaCategorias).toHaveLength(50);
  });

  it('counts the rows the projection could not read, and keeps a repeated row as read', async () => {
    const { d } = await deps((c) =>
      c.caminho === CAMINHO_CATEGORIAS_LI
        ? paginaCatalogoLi('categoria', [
            categoriaLi(10),
            categoriaLi(11, { nao: 'uma uri' }),
            categoriaLi(0),
            categoriaLi(10),
          ])
        : { status: 500, corpo: {} },
    );
    const passo = await executarUnidadeDoCatalogoDoJobLi(d, estadoInicial());
    expect(passo.tipo === 'pagina' && passo.naoLidas).toEqual({ paisIlegiveis: 1, linhasSemId: 1 });
    expect(estadoDe(passo).mapaCategorias.map((c) => c.id)).toEqual([10, 11, 10]);
  });

  it(`a list with a next page after ${String(MAX_PAGINAS_CATALOGO_LI)} pages FAILS the job, and the page past the ceiling is never requested`, async () => {
    const { d, chamadas } = await deps(
      loja(LIMITE_PAGINA_CATALOGO_LI * MAX_PAGINAS_CATALOGO_LI + 1, 1),
    );
    const passos = await percorrer(d, estadoInicial());
    expect(passos.at(-1)).toEqual({
      tipo: 'falhou',
      motivo: MOTIVO_FALHA_IMPORTACAO_LI.catalogoExcedeLimite,
      recurso: RECURSO_CATALOGO_IMPORTACAO_LI.categorias,
    });
    expect(chamadas).toHaveLength(MAX_PAGINAS_CATALOGO_LI);
  });

  it(`a list of exactly ${String(MAX_PAGINAS_CATALOGO_LI)} pages is read whole`, async () => {
    const { d } = await deps(loja(LIMITE_PAGINA_CATALOGO_LI * MAX_PAGINAS_CATALOGO_LI, 1));
    const passos = await percorrer(d, estadoInicial());
    expect(passos.at(-1)?.tipo).toBe('concluido');
    expect(estadoDe(passos.at(-1)!).mapaCategorias).toHaveLength(500);
  });

  it('a 429 propagates unchanged, and nothing of the page is kept', async () => {
    const { d } = await deps(() => ({ status: 429, corpo: {} }));
    await expect(executarUnidadeDoCatalogoDoJobLi(d, estadoInicial())).rejects.toBeInstanceOf(
      LiThrottleError,
    );
    expect(db.escritas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                              The category links                             */
/* -------------------------------------------------------------------------- */

/** The state the link read starts from: the brands exhausted, the store's categories listed. */
function estadoComCategorias(ids: readonly number[]): EstadoCatalogoDoJobLi {
  return {
    catalogo: { recurso: RECURSO_CATALOGO_IMPORTACAO_LI.marcas, proximoOffset: null, paginas: 1 },
    mapaCategorias: ids.map(
      (id): CategoriaDoJobLi => ({
        id,
        nome: `Categoria ${String(id)}`,
        pai: { tipo: 'raiz' },
        erpCategoriaId: null,
        vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo,
      }),
    ),
    marcas: [],
  };
}

function seedCategoriaErp(id: string): void {
  db.seed(`categorias/${id}`, { nome: `ERP ${id}`, nomeCompleto: `ERP ${id}` });
}

function seedVinculo(erpId: string, docId: string, dados: DocData): void {
  db.seed(`categorias/${erpId}/categorialojaintegrada/${docId}`, dados);
}

async function lerVinculos(ids: readonly number[]) {
  const { d, chamadas } = await deps(() => ({ status: 500, corpo: {} }));
  const passo = await executarUnidadeDoCatalogoDoJobLi(d, estadoComCategorias(ids));
  expect(chamadas).toEqual([]);
  if (passo.tipo !== 'concluido') throw new TypeError(`esperava concluido, veio ${passo.tipo}`);
  const porId = new Map(passo.estado.mapaCategorias.map((c) => [c.id, c]));
  return { passo, porId };
}

describe('which ERP categoria serves each store category', () => {
  it('reads the WHOLE link group once — unfiltered, unordered — and makes NO call', async () => {
    seedCategoriaErp('erp-a');
    seedVinculo('erp-a', `${CONTA}-10`, {
      id: '10',
      nome: 'x',
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
    });
    await lerVinculos([10]);
    const grupo = db.consultas.filter((q) => q.grupo === true);
    expect(grupo).toEqual([
      {
        colecao: 'categorialojaintegrada',
        grupo: true,
        filtros: [],
        ordens: [],
        limite: null,
        apos: null,
      },
    ]);
    // The owner is read BY ID, never queried.
    expect(db.leituras).toContain('categorias/erp-a');
  });

  it('EQUAL: a new link of this conta (both ref forms) and a migrated conta-less link this store lists ⇒ vinculada', async () => {
    for (const erp of ['erp-a', 'erp-b', 'erp-c']) seedCategoriaErp(erp);
    seedVinculo('erp-a', 'a', { id: '10', contaLojaIntegrada: `documents/integracao/${CONTA}` });
    seedVinculo('erp-b', 'b', { id: '11', contaLojaIntegrada: `integracao/${CONTA}` });
    seedVinculo('erp-c', 'c', { id: '12', nome: 'migrado' });
    const { passo, porId } = await lerVinculos([10, 11, 12, 13]);
    expect(porId.get(10)).toMatchObject({ erpCategoriaId: 'erp-a', vinculo: 'vinculada' });
    expect(porId.get(11)).toMatchObject({ erpCategoriaId: 'erp-b', vinculo: 'vinculada' });
    expect(porId.get(12)).toMatchObject({ erpCategoriaId: 'erp-c', vinculo: 'vinculada' });
    expect(porId.get(13)).toMatchObject({ erpCategoriaId: null, vinculo: 'sem-vinculo' });
    expect(passo.vinculos).toMatchObject({ vinculadas: 3, ambiguas: 0, semVinculo: 1 });
  });

  it('⚠️ NEAR-MISS: a link of ANOTHER conta never serves this one, even for an id this store lists', async () => {
    seedCategoriaErp('erp-a');
    seedVinculo('erp-a', 'a', {
      id: '10',
      contaLojaIntegrada: `documents/integracao/${OUTRA_CONTA}`,
    });
    const { porId } = await lerVinculos([10]);
    expect(porId.get(10)).toMatchObject({ erpCategoriaId: null, vinculo: 'sem-vinculo' });
  });

  it('⚠️ NEAR-MISS: a migrated link whose id this store does not list serves nothing here', async () => {
    seedCategoriaErp('erp-a');
    seedVinculo('erp-a', 'a', { id: '99' });
    const { porId, passo } = await lerVinculos([10]);
    expect(porId.get(10)?.vinculo).toBe('sem-vinculo');
    expect(passo.estado.mapaCategorias).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: a text id that is not canonical (a leading zero) is not this category', async () => {
    seedCategoriaErp('erp-a');
    seedVinculo('erp-a', 'a', { id: '010', contaLojaIntegrada: `documents/integracao/${CONTA}` });
    const { porId } = await lerVinculos([10]);
    expect(porId.get(10)?.vinculo).toBe('sem-vinculo');
  });

  it('⚠️ NEAR-MISS: links under TWO different ERP categorias ⇒ ambigua, never the first one', async () => {
    seedCategoriaErp('erp-a');
    seedCategoriaErp('erp-b');
    seedVinculo('erp-a', 'a', { id: '10', contaLojaIntegrada: `documents/integracao/${CONTA}` });
    seedVinculo('erp-b', 'b', { id: '10' });
    const { porId, passo } = await lerVinculos([10]);
    expect(porId.get(10)).toMatchObject({ erpCategoriaId: null, vinculo: 'ambigua' });
    expect(passo.vinculos.ambiguas).toBe(1);
  });

  it('EQUAL: two links under ONE ERP categoria naming the same store category give one answer ⇒ vinculada', async () => {
    seedCategoriaErp('erp-a');
    seedVinculo('erp-a', 'migrado', { id: '10' });
    seedVinculo('erp-a', 'novo', { id: '10', contaLojaIntegrada: `documents/integracao/${CONTA}` });
    const { porId } = await lerVinculos([10]);
    expect(porId.get(10)).toMatchObject({ erpCategoriaId: 'erp-a', vinculo: 'vinculada' });
  });

  it('a link under an ERP categoria that no longer exists is ignored — the other one wins', async () => {
    seedCategoriaErp('erp-b');
    seedVinculo('erp-apagada', 'a', {
      id: '10',
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
    });
    seedVinculo('erp-b', 'b', { id: '10' });
    const { porId, passo } = await lerVinculos([10]);
    expect(porId.get(10)).toMatchObject({ erpCategoriaId: 'erp-b', vinculo: 'vinculada' });
    expect(passo.vinculos.donosAusentes).toBe(1);
  });

  it('a doc of the group under any other parent than a categoria is ignored and counted', async () => {
    db.seed('produtos/p1', { nome: 'x' });
    db.seed('produtos/p1/categorialojaintegrada/a', {
      id: '10',
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
    });
    const { porId, passo } = await lerVinculos([10]);
    expect(porId.get(10)?.vinculo).toBe('sem-vinculo');
    expect(passo.vinculos.foraDeCategorias).toBe(1);
  });

  it('leaves the cursor and the brands as they were, and writes nothing', async () => {
    seedCategoriaErp('erp-a');
    seedVinculo('erp-a', 'a', { id: '10' });
    const estado = estadoComCategorias([10]);
    const { passo } = await lerVinculos([10]);
    expect(passo.estado.catalogo).toEqual(estado.catalogo);
    expect(passo.estado.marcas).toEqual(estado.marcas);
    expect(db.escritas).toEqual([]);
  });
});
