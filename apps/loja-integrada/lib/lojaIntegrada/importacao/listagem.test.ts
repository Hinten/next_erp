/**
 * The product import's list phases (`listagem.ts`) — the live listing and the trash list — on the
 * fake Firestore, through the REAL context loader, client and produto page reader.
 *
 * Nothing reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file, and
 * the context's client calls a scripted store (`testing/produtosLi.ts`) whose every request is
 * recorded — the call counts below are exact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { LiHttpError } from '@delfrance/integrations-loja-integrada';
import {
  LIMITE_PAGINA_PRODUTOS_LI,
  type PaginaListagemLi,
  TIPO_PAGINA_IMPORTACAO_LI,
  type TipoPaginaImportacaoLi,
  idPaginaImportacaoLi,
  importacaoLojaIntegradaSchema,
  paginaListagemLiSchema,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import type { ChamadaCatalogoLi, RespostaCatalogoLi } from '../testing/catalogoLi';
import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS, gravadorDeLog, seedConta, seedCredencial } from '../testing/fixtures';
import { caminhoJobLi } from '../testing/importacaoLi';
import {
  contextoDeTesteLi,
  filhoLi,
  linhaProdutoLi,
  paiLi,
  paginaProdutosLi,
  respostasDaLojaLi,
  uriOpcaoLi,
  uriProdutoLi,
} from '../testing/produtosLi';
import {
  type CursorListaProdutosLi,
  type ListagemDeps,
  type PassoDaListaLi,
  executarUnidadeDaListaLi,
  lerPaginasDoJobLi,
  unidadeDaListaLi,
} from './listagem';
import { UNIDADE_IMPORTACAO_LI } from './orcamento';

const CONTA = 'conta-li-listagem';
const JOB = 'job-listagem';
const LISTAGEM = TIPO_PAGINA_IMPORTACAO_LI.listagem;
const LIXEIRA = TIPO_PAGINA_IMPORTACAO_LI.lixeira;

let db: FakeDb;
let fetchGlobal: ReturnType<typeof vi.fn>;
let gravador: ReturnType<typeof gravadorDeLog>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  fetchGlobal = vi.fn(() => {
    throw new Error('listagem.test: só o fetch roteirizado do contexto pode ser chamado');
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

/** A list's initial cursor, through the job schema (the default a created job has). */
function cursorInicial(): CursorListaProdutosLi {
  return importacaoLojaIntegradaSchema.parse({
    integracaoId: CONTA,
    status: 'executando',
    iniciadoEmMs: AGORA_MS,
  }).listagem;
}

async function deps(
  responder: (c: ChamadaCatalogoLi) => RespostaCatalogoLi,
): Promise<{ d: ListagemDeps; chamadas: ChamadaCatalogoLi[] }> {
  const { contexto, chamadas } = await contextoDeTesteLi(
    asDb(db),
    CONTA,
    responder,
    gravador.escrever,
  );
  return {
    d: { db: asDb(db), cliente: contexto.cliente, jobId: JOB, agoraMs: () => AGORA_MS },
    chamadas,
  };
}

function cursorDe(passo: PassoDaListaLi): CursorListaProdutosLi {
  return passo.cursor;
}

/** Runs a list phase to its closing count. */
async function percorrer(d: ListagemDeps, tipo: TipoPaginaImportacaoLi): Promise<PassoDaListaLi[]> {
  const passos: PassoDaListaLi[] = [];
  let cursor = cursorInicial();
  for (let i = 0; i < 200; i += 1) {
    const passo = await executarUnidadeDaListaLi(d, tipo, cursor);
    passos.push(passo);
    if (passo.tipo === 'fechada') return passos;
    cursor = passo.cursor;
  }
  throw new Error('percorrer: a lista não terminou');
}

function paginaGravada(tipo: TipoPaginaImportacaoLi, offset: number): PaginaListagemLi {
  const dados = db.ler(`${caminhoJobLi(JOB)}/paginas/${idPaginaImportacaoLi(tipo, offset)}`);
  return paginaListagemLiSchema.parse(dados);
}

function simples(n: number, desde = 1): DocData[] {
  return Array.from({ length: n }, (_, i) => linhaProdutoLi(desde + i));
}

describe('the cost of the next unit', () => {
  it('a page is ONE call; the closing count calls nothing', () => {
    expect(unidadeDaListaLi(cursorInicial())).toBe(UNIDADE_IMPORTACAO_LI.chamada);
    expect(unidadeDaListaLi({ ...cursorInicial(), proximoOffset: 100 })).toBe(
      UNIDADE_IMPORTACAO_LI.chamada,
    );
    expect(unidadeDaListaLi({ ...cursorInicial(), proximoOffset: null })).toBe(
      UNIDADE_IMPORTACAO_LI.familia,
    );
  });
});

describe('a page', () => {
  it(`asks exactly limit=${String(LIMITE_PAGINA_PRODUTOS_LI)}, removido and offset, and stores the ROW views — never the description, a price or the store URL`, async () => {
    const pai = paiLi(10, [11], {
      descricao_completa: '<p>texto longo da loja</p>',
      preco_cheio: '10.00',
      categorias: ['/api/v1/categoria/7'],
      grades: ['/api/v1/grades/8946'],
    });
    const { d, chamadas } = await deps(
      respostasDaLojaLi({ ativos: [pai, filhoLi(11), linhaProdutoLi(12)] }),
    );
    const passo = await executarUnidadeDaListaLi(
      d,
      TIPO_PAGINA_IMPORTACAO_LI.listagem,
      cursorInicial(),
    );

    expect(chamadas).toEqual([
      {
        caminho: '/v1/produto/',
        query: [
          ['limit', String(LIMITE_PAGINA_PRODUTOS_LI)],
          ['removido', 'false'],
          ['offset', '0'],
        ],
      },
    ]);
    const pagina = paginaGravada(LISTAGEM, 0);
    expect(pagina).toMatchObject({
      tipo: LISTAGEM,
      offset: 0,
      linhasSemId: 0,
      limiteLido: LIMITE_PAGINA_PRODUTOS_LI,
      totalLi: 3,
      lidaEmMs: AGORA_MS,
    });
    expect(pagina.linhas.map((l) => [l.id, l.tipo])).toEqual([
      [10, 'atributo'],
      [11, 'atributo_opcao'],
      [12, 'normal'],
    ]);
    expect(pagina.linhas[0]).toMatchObject({
      filhoIds: [11],
      categoriaIds: [7],
      categorias: ['/api/v1/categoria/7'],
      grades: ['/api/v1/grades/8946'],
    });
    const texto = JSON.stringify(db.ler(`${caminhoJobLi(JOB)}/paginas/listagem-000000000`));
    for (const proibido of ['descricao', 'texto longo', 'preco', 'loja.invalid', 'seo']) {
      expect(texto).not.toContain(proibido);
    }
    expect(passo).toEqual({
      tipo: 'pagina',
      cursor: {
        proximoOffset: null,
        paginas: 1,
        linhas: 0,
        limiteLido: LIMITE_PAGINA_PRODUTOS_LI,
        totalLi: 3,
        divergente: false,
      },
      contagem: { linhas: 3, semId: 0, foraDoFiltro: 0 },
      correlationId: expect.any(String) as string,
    });
  });

  it('writes ONLY its page, whole, at its offset: a unit re-run overwrites its own page', async () => {
    const { d } = await deps(respostasDaLojaLi({ ativos: simples(3) }));
    await executarUnidadeDaListaLi(d, LISTAGEM, cursorInicial());
    await executarUnidadeDaListaLi(d, LISTAGEM, cursorInicial());
    const caminho = `${caminhoJobLi(JOB)}/paginas/listagem-000000000`;
    expect(db.escritas.map((e) => [e.verbo, e.caminho, e.sobrescrita])).toEqual([
      ['set', caminho, true],
      ['set', caminho, true],
    ]);
    expect(paginaGravada(LISTAGEM, 0).linhas).toHaveLength(3);
  });

  it('the next offset is the package’s; the store’s total is the FIRST page’s', async () => {
    const linhas = simples(250);
    let total = 250;
    const loja = respostasDaLojaLi({ ativos: linhas });
    const { d } = await deps((c) => {
      const r = loja(c);
      // A later page announcing another total changes nothing.
      const corpo = r.corpo as { meta: { total_count: number } };
      corpo.meta.total_count = total;
      total = 999;
      return r;
    });
    const p1 = await executarUnidadeDaListaLi(d, LISTAGEM, cursorInicial());
    expect(cursorDe(p1)).toMatchObject({ proximoOffset: 100, paginas: 1, totalLi: 250 });
    const p2 = await executarUnidadeDaListaLi(d, LISTAGEM, cursorDe(p1));
    expect(cursorDe(p2)).toMatchObject({ proximoOffset: 200, paginas: 2, totalLi: 250 });
    expect(paginaGravada(LISTAGEM, 100).totalLi).toBe(999);
  });

  it('`meta.limit` is read back: a store applying a smaller page is followed by its own next offset', async () => {
    const { d, chamadas } = await deps(
      respostasDaLojaLi({ ativos: simples(45), limiteAplicado: 20 }),
    );
    const passos = await percorrer(d, LISTAGEM);
    expect(chamadas.map((c) => c.query.find(([k]) => k === 'offset')?.[1])).toEqual([
      '0',
      '20',
      '40',
    ]);
    expect(cursorDe(passos.at(-1)!)).toMatchObject({ limiteLido: 20, linhas: 45, paginas: 3 });
  });

  it('⚠️ a row of the LIVE list that says removido: true is skipped and counted', async () => {
    const { d } = await deps(
      respostasDaLojaLi({ ativos: [linhaProdutoLi(1), linhaProdutoLi(2, { removido: true })] }),
    );
    const passo = await executarUnidadeDaListaLi(d, LISTAGEM, cursorInicial());
    expect(passo.tipo === 'pagina' && passo.contagem).toEqual({
      linhas: 1,
      semId: 0,
      foraDoFiltro: 1,
    });
    expect(paginaGravada(LISTAGEM, 0).linhas.map((l) => l.id)).toEqual([1]);
  });

  it('a row with no usable id is dropped and counted on the page', async () => {
    const { d } = await deps(respostasDaLojaLi({ ativos: [linhaProdutoLi(1), linhaProdutoLi(0)] }));
    await executarUnidadeDaListaLi(d, LISTAGEM, cursorInicial());
    expect(paginaGravada(LISTAGEM, 0)).toMatchObject({ linhasSemId: 1 });
    expect(paginaGravada(LISTAGEM, 0).linhas.map((l) => l.id)).toEqual([1]);
  });

  it('an EMPTY page ends the list whatever its next says', async () => {
    const { d, chamadas } = await deps(() =>
      paginaProdutosLi([], { offset: 0, limite: 100, removido: false, temProxima: true }),
    );
    const passo = await executarUnidadeDaListaLi(d, LISTAGEM, cursorInicial());
    expect(cursorDe(passo).proximoOffset).toBeNull();
    expect(chamadas).toHaveLength(1);
  });

  it('a refusal propagates unchanged, and no page is written', async () => {
    const { d } = await deps(() => ({ status: 500, corpo: {} }));
    await expect(executarUnidadeDaListaLi(d, LISTAGEM, cursorInicial())).rejects.toBeInstanceOf(
      LiHttpError,
    );
    expect(db.escritas).toEqual([]);
  });
});

describe('the trash list', () => {
  it('asks removido=true and writes its own pages, apart from the listing’s', async () => {
    const trash = [paiLi(50, [51, 52], { removido: true })];
    const { d, chamadas } = await deps(respostasDaLojaLi({ ativos: [], lixeira: trash }));
    await executarUnidadeDaListaLi(d, LIXEIRA, cursorInicial());
    expect(chamadas[0]?.query).toEqual([
      ['limit', String(LIMITE_PAGINA_PRODUTOS_LI)],
      ['removido', 'true'],
      ['offset', '0'],
    ]);
    expect(paginaGravada(LIXEIRA, 0).linhas.map((l) => [l.id, l.filhoIds])).toEqual([
      [50, [51, 52]],
    ]);
  });

  it('⚠️ only an explicit removido: true belongs to the trash: false, null or absent is skipped and counted (fail safe: a detail read, never a product lost)', async () => {
    const trash = [
      paiLi(50, [], { removido: true }),
      paiLi(60, [], { removido: false }),
      paiLi(70, [], { removido: null }),
      paiLi(80, [], { removido: 'true' }),
    ];
    const { d } = await deps(respostasDaLojaLi({ ativos: [], lixeira: trash }));
    const passo = await executarUnidadeDaListaLi(d, LIXEIRA, cursorInicial());
    expect(passo.tipo === 'pagina' && passo.contagem.foraDoFiltro).toBe(3);
    expect(paginaGravada(LIXEIRA, 0).linhas.map((l) => l.id)).toEqual([50]);
  });
});

describe('never relying on the order — the closing count', () => {
  it('a row repeated across pages counts ONCE; the store’s total against the distinct rows ⇒ not divergent', async () => {
    // 150 distinct rows; the second page repeats the first page's last row (a product created
    // mid-listing shifted the offsets), so the store answers 151 rows for a total of 150.
    const linhas = simples(150);
    const paginadas = [...linhas.slice(0, 100), linhas[99]!, ...linhas.slice(100)];
    const { d, chamadas } = await deps(
      respostasDaLojaLi({ ativos: paginadas, totais: { ativos: 150 } }),
    );
    const passos = await percorrer(d, LISTAGEM);
    const fechada = passos.at(-1)!;
    expect(fechada.tipo).toBe('fechada');
    expect(fechada.cursor).toMatchObject({ linhas: 150, totalLi: 150, divergente: false });
    // The closing count called nothing.
    expect(chamadas).toHaveLength(2);
  });

  it('⚠️ NEAR-MISS: a row SKIPPED by concurrent edits ⇒ divergente, with both numbers kept', async () => {
    const { d } = await deps(respostasDaLojaLi({ ativos: simples(149), totais: { ativos: 150 } }));
    const fechada = (await percorrer(d, LISTAGEM)).at(-1)!;
    expect(fechada.cursor).toMatchObject({ linhas: 149, totalLi: 150, divergente: true });
  });

  it('a store that announced no total is never divergent', async () => {
    const { d } = await deps(respostasDaLojaLi({ ativos: simples(3), totais: { ativos: null } }));
    const fechada = (await percorrer(d, LISTAGEM)).at(-1)!;
    expect(fechada.cursor).toMatchObject({ linhas: 3, totalLi: null, divergente: false });
  });

  it('the listing’s closing count reads only the listing’s pages, and the trash’s only the trash’s', async () => {
    const { d } = await deps(
      respostasDaLojaLi({
        ativos: simples(3),
        lixeira: [paiLi(90, [], { removido: true })],
        totais: { ativos: 3, lixeira: 1 },
      }),
    );
    await percorrer(d, LISTAGEM);
    const lixeira = (await percorrer(d, LIXEIRA)).at(-1)!;
    expect(lixeira.cursor).toMatchObject({ linhas: 1, totalLi: 1, divergente: false });
    // Both lists' pages, in key order: the listing by offset, then the trash list.
    expect((await lerPaginasDoJobLi(asDb(db), JOB)).map((p) => [p.tipo, p.offset])).toEqual([
      [LISTAGEM, 0],
      [LIXEIRA, 0],
    ]);
  });

  it('reads the pages back in ONE key-ordered query of the job’s own subcollection, with no filter', async () => {
    const { d } = await deps(respostasDaLojaLi({ ativos: simples(3) }));
    await percorrer(d, LISTAGEM);
    const consultas = db.consultas.filter((q) => q.colecao.endsWith('/paginas'));
    expect(consultas).toEqual([
      {
        colecao: `${caminhoJobLi(JOB)}/paginas`,
        filtros: [],
        ordens: [['__name__', 'asc']],
        limite: null,
        apos: null,
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Doc size                                   */
/* -------------------------------------------------------------------------- */

/** UTF-8 bytes of a string. */
function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Firestore's documented storage size of a value: a string is its UTF-8 bytes + 1, a number 8, a
 * boolean or `null` 1, an array the sum of its values, a map the sum of its keys (bytes + 1) and
 * values.
 */
function tamanhoFirestore(v: unknown): number {
  if (typeof v === 'string') return bytes(v) + 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'boolean' || v === null) return 1;
  if (Array.isArray(v))
    return (v as unknown[]).reduce<number>((s, e) => s + tamanhoFirestore(e), 0);
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).reduce(
      (s, [k, e]) => s + bytes(k) + 1 + tamanhoFirestore(e),
      0,
    );
  }
  throw new TypeError(`tamanhoFirestore: ${typeof v}`);
}

/** A text of `n` characters, each 2 UTF-8 bytes (an accented letter). */
function texto(n: number): string {
  return 'ã'.repeat(n);
}

describe('a page stays far under the 1 MiB document limit', () => {
  it(`${String(LIMITE_PAGINA_PRODUTOS_LI)} rows with maximal row fields: 255-character texts, 50 variations, 30 categories, 20 grades`, async () => {
    // The ceilings: the ERP's 255 for a SKU, a name and a GTIN; the store's 50 variations per
    // product; and a generous 30 categories, 20 grades and 3 options per row.
    const linhas = Array.from({ length: LIMITE_PAGINA_PRODUTOS_LI }, (_, i) => {
      const id = 900_000_000 + i * 100;
      return linhaProdutoLi(id, {
        tipo: 'atributo',
        sku: texto(255),
        nome: texto(255),
        gtin: texto(255),
        filhos: Array.from({ length: 50 }, (_, j) => uriProdutoLi(id + j + 1)),
        categorias: Array.from(
          { length: 30 },
          (_, j) => `/api/v1/categoria/${String(800_000_000 + j)}`,
        ),
        grades: Array.from({ length: 20 }, (_, j) => `/api/v1/grades/${String(700_000_000 + j)}`),
        variacoes: Array.from({ length: 3 }, (_, j) =>
          uriOpcaoLi(700_000_000 + j, 600_000_000 + j),
        ),
      });
    });
    const { d } = await deps(respostasDaLojaLi({ ativos: linhas }));
    await executarUnidadeDaListaLi(d, LISTAGEM, cursorInicial());

    const caminho = `${caminhoJobLi(JOB)}/paginas/listagem-000000000`;
    const pagina = db.ler(caminho);
    expect(paginaGravada(LISTAGEM, 0).linhas).toHaveLength(LIMITE_PAGINA_PRODUTOS_LI);
    // Document size = name + fields + 32. Under HALF the limit: the margin is the point.
    const tamanho = bytes(caminho) + 1 + 16 + tamanhoFirestore(pagina) + 32;
    expect(tamanho).toBeLessThan(512 * 1024);
  });
});
