/**
 * The catalogue core (`catalogo.ts`), against `testing/fakeDb.ts`, the REAL context loader, the
 * REAL package client and pager, the REAL park and the REAL caches.
 *
 * Nothing reaches the network (D17): every case stubs the GLOBAL `fetch` to throw for the whole
 * file, and a case that needs Loja Integrada hands the context a scripted `deps.fetch`
 * (`testing/catalogoLi.ts`) — the call counts below are exact, both of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  CAMINHO_CATEGORIAS_LI,
  CAMINHO_GRADES_LI,
  CAMINHO_MARCAS_LI,
  LiHttpError,
  LiNotFoundError,
  PRAZO_LI_MS,
} from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_ERRO_LI,
  LIMITE_PAGINA_CATALOGO_LI,
  MAX_PAGINAS_CATALOGO_LI,
  respostaCategoriasLiSchema,
  respostaGradeLiSchema,
  respostaGradesLiSchema,
  respostaMarcasLiSchema,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
} from '../core/erros';
import { RITMO_LEITURA_LI_MS } from '../core/ritmo';
import {
  type ChamadaCatalogoLi,
  type RespostaCatalogoLi,
  categoriaLi,
  detalheGradeLi,
  gradeLi,
  marcaLi,
  offsetDe,
  ok,
  paginaCatalogoLi,
  plataformaCatalogoLi,
} from '../testing/catalogoLi';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  caminhoConta,
  caminhoCredencial,
  gravadorDeLog,
  loggerEspiao,
  ritmoFalso,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { __setRelogioDoCatalogoParaTestes, type RecursoCatalogoLi } from './cache';
import {
  FLUXO_CATALOGO_LI,
  type CatalogoDeps,
  type PedidoCatalogoLi,
  type ResultadoCatalogoLi,
  lerCatalogoLi,
  pedeAtualizacaoLi,
} from './catalogo';

const CONTA = 'conta-li-catalogo';
const OUTRA_CONTA = 'conta-li-catalogo-2';
const GRADE_ID = 8946;
/** The route prefix of every WARN line this core writes. */
const PREFIXO = '[loja-integrada/catalogo]';

let db: FakeDb;
let globalFetch: ReturnType<typeof vi.fn>;
let pacer: ReturnType<typeof ritmoFalso>;
let gravador: ReturnType<typeof gravadorDeLog>;
let logger: ReturnType<typeof loggerEspiao>;
let agora: number;

/** The answer for each request: by default every resource answers one small page. */
function padrao(c: ChamadaCatalogoLi): RespostaCatalogoLi {
  if (c.caminho === CAMINHO_CATEGORIAS_LI) {
    return paginaCatalogoLi('categoria', [categoriaLi(10), categoriaLi(11, '/v1/categoria/10')]);
  }
  if (c.caminho === CAMINHO_MARCAS_LI) {
    return paginaCatalogoLi('marca', [marcaLi(20), marcaLi(21, false)]);
  }
  if (c.caminho === CAMINHO_GRADES_LI) {
    return paginaCatalogoLi('grades', [gradeLi(GRADE_ID), gradeLi(GRADE_ID + 1, 'Tamanho')]);
  }
  if (c.caminho === `${CAMINHO_GRADES_LI}${String(GRADE_ID)}/`) {
    return ok(detalheGradeLi(GRADE_ID, [37097, 37098]));
  }
  return { status: 500, corpo: { erro: 'rota nao roteirizada' } };
}

function plataforma(
  responder: (c: ChamadaCatalogoLi) => RespostaCatalogoLi | Promise<RespostaCatalogoLi> = padrao,
) {
  return plataformaCatalogoLi(responder);
}

function deps(over: Partial<CatalogoDeps> = {}): CatalogoDeps {
  return {
    db: asDb(db),
    ambiente: AMBIENTE_LIGADO,
    ritmo: pacer.ritmo,
    agoraMs: () => agora,
    increment,
    logger: logger.logger,
    escrever: gravador.escrever,
    ...over,
  };
}

const LISTAS = ['categorias', 'marcas', 'grades'] as const;
const GRADE: PedidoCatalogoLi<'grade'> = { recurso: 'grade', gradeId: String(GRADE_ID) };

/** The pedido of each resource (the grade detail asks for {@link GRADE_ID}). */
function pedidoDe(recurso: RecursoCatalogoLi): PedidoCatalogoLi {
  return recurso === 'grade' ? GRADE : { recurso };
}

function ler<R extends RecursoCatalogoLi>(
  d: CatalogoDeps,
  pedido: PedidoCatalogoLi<R>,
  atualizar = false,
  conta = CONTA,
) {
  return lerCatalogoLi(d, conta, pedido, { atualizar });
}

function respostaDe<T>(r: ResultadoCatalogoLi<T>): T {
  if (r.tipo !== 'resposta') throw new TypeError(`esperava uma resposta, veio ${r.tipo}`);
  return r.resposta;
}

function falhaDe<T>(r: ResultadoCatalogoLi<T>) {
  if (r.tipo !== 'falha') throw new TypeError(`esperava uma falha, veio ${r.tipo}`);
  return r.falha;
}

/** The WARN lines this core wrote (the park's own lines aside). */
function avisos(): unknown[][] {
  return logger.chamadas.filter((c) => typeof c[0] === 'string' && c[0].startsWith(PREFIXO));
}

/** A promise, and the function that resolves it. */
function portao(): { aberto: Promise<void>; abrir: () => void } {
  let abrir: () => void = () => undefined;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

beforeEach(() => {
  __resetAllReadCaches();
  agora = AGORA_MS;
  __setRelogioDoCacheParaTestes(() => agora);
  __setRelogioDoCatalogoParaTestes(() => agora);
  db = new FakeDb();
  pacer = ritmoFalso();
  gravador = gravadorDeLog();
  logger = loggerEspiao();
  globalFetch = vi.fn(() => {
    throw new Error('o catálogo não chama a Loja Integrada fora do fetch roteirizado');
  });
  vi.stubGlobal('fetch', globalFetch);
  seedConta(db, CONTA, { nome: 'Loja Catalogo' });
  seedCredencial(db, CONTA);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  __setRelogioDoCatalogoParaTestes();
});

/* -------------------------------------------------------------------------- */
/*                      The switch and the conta come first                    */
/* -------------------------------------------------------------------------- */

describe('lerCatalogoLi — the context first (D17)', () => {
  it.each([...LISTAS, 'grade' as const])(
    '%s with the switch OFF ⇒ LiChamadasDesligadasError: zero calls, zero Firestore reads',
    async (recurso) => {
      const p = plataforma();
      const r = await ler(deps({ ambiente: {}, fetch: p.fetch }), pedidoDe(recurso));

      expect(falhaDe(r)).toMatchObject({ tipo: 'conta', classe: 'configuracao' });
      expect(r.tipo === 'falha' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
        LiChamadasDesligadasError,
      );
      expect(p.chamadas).toEqual([]);
      expect(db.leituras).toEqual([]);
      expect(pacer.esperas).toEqual([]);
      expect(gravador.linhas).toEqual([
        expect.objectContaining({
          campos: expect.objectContaining({ evento: 'chamada-bloqueada', fluxo: 'catalogo' }),
        }),
      ]);
    },
  );

  it.each([
    ['absent', () => undefined, LiContaNaoEncontradaError],
    [
      'not a Loja Integrada conta',
      () => {
        seedConta(db, OUTRA_CONTA, { tipo: 1 });
        seedCredencial(db, OUTRA_CONTA);
      },
      LiContaNaoEncontradaError,
    ],
    [
      'inactive',
      () => {
        seedConta(db, OUTRA_CONTA, { ativo: false });
        seedCredencial(db, OUTRA_CONTA);
      },
      LiContaInativaError,
    ],
    ['without a credential', () => seedConta(db, OUTRA_CONTA), LiCredencialAusenteError],
    [
      'parked',
      () => {
        seedConta(db, OUTRA_CONTA);
        seedCredencial(db, OUTRA_CONTA, {
          reconexaoPendente: { desdeMs: AGORA_MS, status: 401, refCredencial: 'a.1' },
        });
      },
      LiContaParadaError,
    ],
  ])('a conta %s ⇒ its own app error, and no call', async (_caso, preparar, classe) => {
    preparar();
    const p = plataforma();

    const r = await ler(deps({ fetch: p.fetch }), { recurso: 'grades' }, false, OUTRA_CONTA);

    expect(r.tipo === 'falha' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(classe);
    expect(p.chamadas).toEqual([]);
    expect(db.leituras).toContain(caminhoConta(OUTRA_CONTA));
  });
});

/* -------------------------------------------------------------------------- */
/*                          The reads and their answers                        */
/* -------------------------------------------------------------------------- */

describe('lerCatalogoLi — the four reads', () => {
  it('categorias: one paced GET on the slash path with limit=50, the three-state parent, the load clock', async () => {
    const p = plataforma();

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' }));

    expect(respostaCategoriasLiSchema.parse(r)).toEqual({
      categorias: [
        { id: 10, nome: 'Categoria 10', pai: { tipo: 'raiz' } },
        { id: 11, nome: 'Categoria 11', pai: { tipo: 'id', id: 10 } },
      ],
      lidaEmMs: AGORA_MS,
    });
    expect(p.chamadas).toEqual([
      {
        caminho: CAMINHO_CATEGORIAS_LI,
        query: [['limit', String(LIMITE_PAGINA_CATALOGO_LI)]],
      },
    ]);
    expect(pacer.esperas).toEqual([RITMO_LEITURA_LI_MS]);
    // Every call line names this flow and this conta.
    expect(gravador.linhas.length).toBeGreaterThan(0);
    for (const linha of gravador.linhas) {
      expect(linha.campos).toMatchObject({ fluxo: FLUXO_CATALOGO_LI, conta: CONTA });
    }
    expect(avisos()).toEqual([]);
  });

  it('marcas: inactive brands listed and marked', async () => {
    const p = plataforma();

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'marcas' }));

    expect(respostaMarcasLiSchema.parse(r).marcas).toEqual([
      { id: 20, nome: 'Marca 20', ativo: true },
      { id: 21, nome: 'Marca 21', ativo: false },
    ]);
    expect(p.chamadas.map((c) => c.caminho)).toEqual([CAMINHO_MARCAS_LI]);
  });

  it('grades: `nomeVisivel` null for an empty name, kept otherwise', async () => {
    const p = plataforma();

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'grades' }));

    expect(respostaGradesLiSchema.parse(r).grades).toEqual([
      { id: GRADE_ID, nome: `Grade ${String(GRADE_ID)}`, nomeVisivel: null },
      { id: GRADE_ID + 1, nome: `Grade ${String(GRADE_ID + 1)}`, nomeVisivel: 'Tamanho' },
    ]);
  });

  it('grade: ONE GET on `/v1/grades/<id>/` with no query; its options', async () => {
    const p = plataforma();

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), GRADE));

    expect(respostaGradeLiSchema.parse(r)).toEqual({
      grade: { id: GRADE_ID, nome: `Grade ${String(GRADE_ID)}`, nomeVisivel: null },
      opcoes: [
        { id: 37097, nome: 'Opção 37097' },
        { id: 37098, nome: 'Opção 37098' },
      ],
      lidaEmMs: AGORA_MS,
    });
    expect(p.chamadas).toEqual([
      { caminho: `${CAMINHO_GRADES_LI}${String(GRADE_ID)}/`, query: [] },
    ]);
  });

  it('a list of two pages: both read, in order, at offset 50, before answering', async () => {
    const p = plataforma((c) =>
      offsetDe(c) === 0
        ? paginaCatalogoLi(
            'categoria',
            Array.from({ length: 50 }, (_, i) => categoriaLi(100 + i)),
            { total: 51 },
          )
        : paginaCatalogoLi('categoria', [categoriaLi(200)], { offset: 50, total: 51 }),
    );

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' }));

    expect(r.categorias).toHaveLength(51);
    expect(r.categorias.at(-1)?.id).toBe(200);
    expect(p.chamadas.map((c) => c.query)).toEqual([
      [['limit', '50']],
      [
        ['limit', '50'],
        ['offset', '50'],
      ],
    ]);
  });

  it('what the projection could not read is answered as such and logged ONCE per load, ids and counts only', async () => {
    const p = plataforma((c) =>
      c.caminho === CAMINHO_CATEGORIAS_LI
        ? paginaCatalogoLi('categoria', [
            categoriaLi(10),
            categoriaLi(11, 'https://loja.invalid/api/v1/categoria/10'),
          ])
        : padrao(c),
    );

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' }));
    // The near-miss of "unreadable": never folded into a root.
    expect(r.categorias[1]?.pai).toEqual({ tipo: 'ilegivel' });
    expect(avisos()).toEqual([
      [
        `${PREFIXO} linhas do catálogo que não puderam ser lidas`,
        { conta: CONTA, recurso: 'categorias', gradeId: null, paisIlegiveis: 1, linhasSemId: 0 },
      ],
    ]);

    // A cache hit logs nothing again.
    await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });
    expect(avisos()).toHaveLength(1);
  });

  it('a grade: an option of ANOTHER grade is not offered, one with an unreadable grade is kept; both counted', async () => {
    const detalhe = detalheGradeLi(GRADE_ID, [1, 2, 3]);
    const variacoes = detalhe.variacoes as Record<string, unknown>[];
    variacoes[1] = { ...variacoes[1], grade: `/api/v1/grades/${String(GRADE_ID + 1)}` };
    variacoes[2] = { ...variacoes[2], grade: 'REDACTED' };
    const p = plataforma(() => ok(detalhe));

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), GRADE));

    expect(r.opcoes.map((o) => o.id)).toEqual([1, 3]);
    expect(avisos()).toEqual([
      [
        `${PREFIXO} linhas do catálogo que não puderam ser lidas`,
        {
          conta: CONTA,
          recurso: 'grade',
          gradeId: String(GRADE_ID),
          opcoesDeOutraGrade: 1,
          opcoesComGradeIlegivel: 1,
          linhasSemId: 0,
        },
      ],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   The cache                                 */
/* -------------------------------------------------------------------------- */

describe('lerCatalogoLi — the cache', () => {
  it('a hit makes ZERO Loja Integrada calls (and no pacer wait) — but the context still reads the credential', async () => {
    const p = plataforma();
    const primeira = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'grades' }));
    const leiturasAntes = db.leituras.length;

    const segunda = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'grades' }));

    expect(segunda).toBe(primeira);
    expect(p.chamadas).toHaveLength(1);
    expect(pacer.esperas).toHaveLength(1);
    expect(db.leituras.slice(leiturasAntes)).toEqual([caminhoCredencial(CONTA)]);
  });

  it('`atualizar` reads again, and the new copy carries the new clock', async () => {
    const p = plataforma();
    await ler(deps({ fetch: p.fetch }), { recurso: 'marcas' });
    agora += 60_000;

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'marcas' }, true));

    expect(p.chamadas).toHaveLength(2);
    expect(r.lidaEmMs).toBe(AGORA_MS + 60_000);
  });

  it('the key: another grade, another conta, another resource ⇒ a fresh read each', async () => {
    seedConta(db, OUTRA_CONTA);
    seedCredencial(db, OUTRA_CONTA);
    const p = plataforma((c) =>
      c.caminho === `${CAMINHO_GRADES_LI}1/` ? ok(detalheGradeLi(1, [5])) : padrao(c),
    );
    await ler(deps({ fetch: p.fetch }), GRADE);
    await ler(deps({ fetch: p.fetch }), GRADE);
    expect(p.chamadas).toHaveLength(1);

    await ler(deps({ fetch: p.fetch }), { recurso: 'grade', gradeId: '1' });
    await ler(deps({ fetch: p.fetch }), GRADE, false, OUTRA_CONTA);
    await ler(deps({ fetch: p.fetch }), { recurso: 'grades' });

    expect(p.chamadas).toHaveLength(4);
  });

  it('a token saved between two requests (another version) ⇒ a fresh read', async () => {
    const p = plataforma();
    await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });

    seedCredencial(db, CONTA, { tokenAtualizadoEmMs: AGORA_MS });
    await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });

    expect(p.chamadas).toHaveLength(2);
  });

  it('a stored stamp with no version form (a negative one) still answers, and its copy is reused', async () => {
    seedCredencial(db, CONTA, { tokenAtualizadoEmMs: -1 });
    const p = plataforma();

    const primeira = await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });
    const segunda = await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });

    expect(respostaDe(primeira)).toBe(respostaDe(segunda));
    expect(p.chamadas).toHaveLength(1);
    expect(avisos()).toEqual([]);
  });

  it('⚠️ a token saved BETWEEN page 1 and page 2 ⇒ 502 `lojaIndisponivel` + one WARN, nothing cached; the next request reads under the new version', async () => {
    let salvo = false;
    const p = plataforma((c) => {
      if (offsetDe(c) === 0) {
        // Page 1 answered; page 2's request re-reads the credential and finds a new save.
        if (!salvo) {
          salvo = true;
          seedCredencial(db, CONTA, { tokenAtualizadoEmMs: AGORA_MS });
        }
        return paginaCatalogoLi('categoria', [categoriaLi(1)], { limite: 1, total: 2 });
      }
      return paginaCatalogoLi('categoria', [categoriaLi(2)], { offset: 1, limite: 1, total: 2 });
    });

    const r = await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });

    expect(falhaDe(r)).toMatchObject({
      tipo: 'loja',
      classe: 'transitorio',
      status: 502,
      code: CODIGO_ERRO_LI.lojaIndisponivel,
    });
    expect(p.chamadas).toHaveLength(2);
    expect(avisos()).toEqual([
      [
        `${PREFIXO} credencial trocada durante a leitura; nada foi guardado`,
        { conta: CONTA, recurso: 'categorias', gradeId: null },
      ],
    ]);

    // Never cached: the next request reads both pages again, under the new version, and answers.
    const depois = respostaDe(await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' }));
    expect(depois.categorias.map((c) => c.id)).toEqual([1, 2]);
    expect(p.chamadas).toHaveLength(4);
  });

  it('two concurrent requests make ONE read, and both get its answer', async () => {
    const segura = portao();
    const chegou = portao();
    const p = plataforma(async (c) => {
      chegou.abrir();
      await segura.aberto;
      return padrao(c);
    });

    const a = ler(deps({ fetch: p.fetch }), { recurso: 'grades' });
    const b = ler(deps({ fetch: p.fetch }), { recurso: 'grades' });
    await chegou.aberto;
    segura.abrir();

    expect(respostaDe(await a)).toBe(respostaDe(await b));
    expect(p.chamadas).toHaveLength(1);
  });

  it('`atualizar` while a load is in flight JOINS it: still one read', async () => {
    const segura = portao();
    const chegou = portao();
    const p = plataforma(async (c) => {
      chegou.abrir();
      await segura.aberto;
      return padrao(c);
    });

    const a = ler(deps({ fetch: p.fetch }), { recurso: 'grades' });
    await chegou.aberto;
    const b = ler(deps({ fetch: p.fetch }), { recurso: 'grades' }, true);
    // Let `b` reach the cache before the load settles.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    segura.abrir();

    expect(respostaDe(await a)).toBe(respostaDe(await b));
    expect(p.chamadas).toHaveLength(1);
  });

  it('⚠️ the FIRST caller going away ⇒ `cancelado` for it, while the second gets the answer of the SAME load', async () => {
    const segura = portao();
    const chegou = portao();
    const sinais: (AbortSignal | null | undefined)[] = [];
    const p = plataforma(async (c) => {
      chegou.abrir();
      await segura.aberto;
      return padrao(c);
    });
    const espiado: typeof globalThis.fetch = (input, init) => {
      sinais.push(init?.signal);
      return p.fetch(input, init);
    };
    const controle = new AbortController();

    const a = ler(deps({ fetch: espiado, sinal: controle.signal }), { recurso: 'grades' });
    await chegou.aberto;
    const b = ler(deps({ fetch: espiado }), { recurso: 'grades' });
    controle.abort();

    expect(await a).toEqual({ tipo: 'cancelado' });
    // The shared load never took the caller's signal: its request is still open.
    expect(sinais[0]?.aborted).toBe(false);
    segura.abrir();
    expect(respostaDe(await b).grades).toHaveLength(2);
    expect(p.chamadas).toHaveLength(1);
  });

  it.each([...LISTAS, 'grade' as const])(
    '⚠️ %s: the shared load never takes the first caller’s signal (its request stays open after the abort)',
    async (recurso) => {
      const segura = portao();
      const chegou = portao();
      const sinais: (AbortSignal | null | undefined)[] = [];
      const p = plataforma(async (c) => {
        chegou.abrir();
        await segura.aberto;
        return padrao(c);
      });
      const espiado: typeof globalThis.fetch = (input, init) => {
        sinais.push(init?.signal);
        return p.fetch(input, init);
      };
      const controle = new AbortController();

      const a = ler(deps({ fetch: espiado, sinal: controle.signal }), pedidoDe(recurso));
      await chegou.aberto;
      const b = ler(deps({ fetch: espiado }), pedidoDe(recurso));
      controle.abort();

      expect(await a).toEqual({ tipo: 'cancelado' });
      expect(sinais).toHaveLength(1);
      expect(sinais[0]?.aborted).toBe(false);
      segura.abrir();
      expect((await b).tipo).toBe('resposta');
      expect(p.chamadas).toHaveLength(1);
    },
  );

  it('⚠️ NEAR-MISS: a caller already gone, but the CONTEXT failing on its own ⇒ that failure, never `cancelado`', async () => {
    const p = plataforma();
    const controle = new AbortController();
    controle.abort();

    const r = await ler(
      deps({ fetch: p.fetch, sinal: controle.signal }),
      { recurso: 'grades' },
      false,
      OUTRA_CONTA,
    );

    expect(r.tipo === 'falha' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
      LiContaNaoEncontradaError,
    );
    expect(p.chamadas).toEqual([]);
  });

  it('a caller already gone before the read ⇒ `cancelado`, and no load starts', async () => {
    const p = plataforma();
    const controle = new AbortController();
    controle.abort();

    const r = await ler(deps({ fetch: p.fetch, sinal: controle.signal }), { recurso: 'grades' });

    expect(r).toEqual({ tipo: 'cancelado' });
    expect(p.chamadas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The error table                             */
/* -------------------------------------------------------------------------- */

describe('lerCatalogoLi — the error table (the shared mapper)', () => {
  it.each([...LISTAS, 'grade' as const])(
    'a 401 on %s ⇒ the conta is PARKED, then `LiContaParadaError`',
    async (recurso) => {
      const p = plataforma(() => ({ status: 401, corpo: { erro: 'token' } }));

      const r = await ler(deps({ fetch: p.fetch }), pedidoDe(recurso));

      expect(r.tipo === 'falha' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
        LiContaParadaError,
      );
      expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 401 });
      expect(p.chamadas).toHaveLength(1);
    },
  );

  it('a 403 on categorias (the token check’s own path) ⇒ PARKED', async () => {
    const p = plataforma(() => ({ status: 403, corpo: { erro: 'proibido' } }));

    const r = await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });

    expect(r.tipo === 'falha' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
      LiContaParadaError,
    );
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 403 });
    expect(avisos()).toEqual([]);
  });

  it.each(['marcas', 'grades', 'grade'] as const)(
    '⚠️ NEAR-MISS: a 403 on %s ⇒ 502 `recursoNaoPermitido` + one WARN, and NOTHING is parked',
    async (recurso) => {
      const p = plataforma(() => ({ status: 403, corpo: { erro: 'proibido' } }));

      const r = await ler(deps({ fetch: p.fetch }), pedidoDe(recurso));

      expect(falhaDe(r)).toMatchObject({
        tipo: 'loja',
        classe: 'nao-autorizado',
        status: 502,
        code: CODIGO_ERRO_LI.recursoNaoPermitido,
      });
      expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toBeNull();
      expect(db.escritas).toEqual([]);
      expect(avisos()).toEqual([
        [
          `${PREFIXO} leitura do catálogo sem resposta`,
          {
            conta: CONTA,
            recurso,
            gradeId: recurso === 'grade' ? String(GRADE_ID) : null,
            causa: CODIGO_ERRO_LI.recursoNaoPermitido,
          },
        ],
      ]);
    },
  );

  it('a 404 on the grade detail ⇒ 409 `gradeAusenteNaLoja`, never cached', async () => {
    const p = plataforma(() => ({ status: 404, corpo: { erro: 'nao encontrado' } }));

    const r = await ler(deps({ fetch: p.fetch }), GRADE);

    expect(falhaDe(r)).toMatchObject({
      tipo: 'loja',
      classe: 'nao-autorizado',
      status: 409,
      code: CODIGO_ERRO_LI.gradeAusenteNaLoja,
    });
    await ler(deps({ fetch: p.fetch }), GRADE);
    expect(p.chamadas).toHaveLength(2);
  });

  it.each(LISTAS)(
    '⚠️ NEAR-MISS: a 404 on the %s LIST is a refusal of OUR request: rethrown (a 500)',
    async (recurso) => {
      const p = plataforma(() => ({ status: 404, corpo: { erro: 'nao encontrado' } }));

      await expect(ler(deps({ fetch: p.fetch }), { recurso })).rejects.toBeInstanceOf(
        LiNotFoundError,
      );
    },
  );

  it.each([
    ['a 3xx (never followed)', 302],
    ['a 400', 400],
  ])('%s ⇒ rethrown, never answered as a code of ours', async (_caso, status) => {
    const p = plataforma(() => ({ status, corpo: {} }));

    await expect(ler(deps({ fetch: p.fetch }), { recurso: 'grades' })).rejects.toBeInstanceOf(
      LiHttpError,
    );
    expect(p.chamadas).toHaveLength(1);
  });

  it(`more pages than ${String(MAX_PAGINAS_CATALOGO_LI)} ⇒ 502 \`catalogoExcedeLimite\`, never a truncated list`, async () => {
    const p = plataforma((c) =>
      paginaCatalogoLi('marca', [marcaLi(offsetDe(c) + 1)], {
        offset: offsetDe(c),
        limite: 1,
        total: 1_000,
      }),
    );

    const r = await ler(deps({ fetch: p.fetch }), { recurso: 'marcas' });

    expect(falhaDe(r)).toMatchObject({
      tipo: 'loja',
      status: 502,
      code: CODIGO_ERRO_LI.catalogoExcedeLimite,
    });
    expect(p.chamadas).toHaveLength(MAX_PAGINAS_CATALOGO_LI);
    expect(avisos()).toEqual([
      [
        `${PREFIXO} leitura do catálogo sem resposta`,
        {
          conta: CONTA,
          recurso: 'marcas',
          gradeId: null,
          causa: CODIGO_ERRO_LI.catalogoExcedeLimite,
        },
      ],
    ]);
  });

  it.each([
    ['categorias', 'categoria', (n: number) => categoriaLi(n)],
    ['marcas', 'marca', (n: number) => marcaLi(n)],
    ['grades', 'grades', (n: number) => gradeLi(n)],
  ] as const)(
    '%s: the ceiling and a stuck offset are the list’s own answers (502), never a 500',
    async (recurso, caminho, linha) => {
      const longa = plataforma((c) =>
        paginaCatalogoLi(caminho, [linha(offsetDe(c) + 1)], {
          offset: offsetDe(c),
          limite: 1,
          total: 1_000,
        }),
      );
      const parada = plataforma(() =>
        ok({
          meta: {
            limit: 50,
            offset: 0,
            total_count: 2,
            previous: null,
            next: `/api/v1/${caminho}?limit=50&offset=0`,
          },
          objects: [linha(1)],
        }),
      );

      const teto = await ler(deps({ fetch: longa.fetch }), { recurso });
      const presa = await ler(deps({ fetch: parada.fetch }), { recurso });

      expect(falhaDe(teto)).toMatchObject({
        status: 502,
        code: CODIGO_ERRO_LI.catalogoExcedeLimite,
      });
      expect(falhaDe(presa)).toMatchObject({
        status: 502,
        code: CODIGO_ERRO_LI.lojaIndisponivel,
      });
      expect(longa.chamadas).toHaveLength(MAX_PAGINAS_CATALOGO_LI);
      expect(parada.chamadas).toHaveLength(1);
    },
  );

  it('a `next` whose offset does not advance ⇒ 502 `lojaIndisponivel`', async () => {
    const p = plataforma(() =>
      ok({
        meta: {
          limit: 50,
          offset: 0,
          total_count: 2,
          previous: null,
          next: '/api/v1/grades?limit=50&offset=0',
        },
        objects: [gradeLi(1)],
      }),
    );

    const r = await ler(deps({ fetch: p.fetch }), { recurso: 'grades' });

    expect(falhaDe(r)).toMatchObject({ status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel });
    expect(p.chamadas).toHaveLength(1);
  });

  it.each([
    ['a 5xx', () => ({ status: 503, corpo: {} }), 502, CODIGO_ERRO_LI.lojaIndisponivel],
    ['a body off the schema', () => ok({ objects: 'x' }), 502, CODIGO_ERRO_LI.lojaIndisponivel],
    ['a 429', () => ({ status: 429, corpo: {} }), 503, CODIGO_ERRO_LI.limiteDeChamadas],
  ])('%s ⇒ %s', async (_caso, resposta, status, code) => {
    const p = plataforma(resposta);

    const r = await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });

    expect(falhaDe(r)).toMatchObject({ tipo: 'loja', classe: 'transitorio', status, code });
    // Not one of the answers that log a WARN line (only the 403 and the ceiling do).
    expect(avisos()).toEqual([]);
    // Never cached: the next request reads again.
    await ler(deps({ fetch: p.fetch }), { recurso: 'categorias' });
    expect(p.chamadas).toHaveLength(2);
  });

  it('a network failure ⇒ 502 `lojaIndisponivel`', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')));

    const r = await ler(deps({ fetch }), GRADE);

    expect(falhaDe(r)).toMatchObject({ status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('⚠️ NEAR-MISS: the deadline passing ⇒ 504 `tempoEsgotadoLoja`, never the network 502', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const chegou = portao();
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      chegou.abrir();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        });
      });
    });

    const pendente = ler(deps({ fetch }), GRADE);
    await chegou.aberto;
    await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.leitura);

    expect(falhaDe(await pendente)).toMatchObject({
      status: 504,
      code: CODIGO_ERRO_LI.tempoEsgotadoLoja,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('⚠️ a detail of ANOTHER grade ⇒ 502 `lojaIndisponivel` + one WARN, never cached', async () => {
    const p = plataforma(() => ok(detalheGradeLi(GRADE_ID + 1, [1])));

    const r = await ler(deps({ fetch: p.fetch }), GRADE);

    expect(falhaDe(r)).toMatchObject({
      tipo: 'loja',
      classe: 'transitorio',
      status: 502,
      code: CODIGO_ERRO_LI.lojaIndisponivel,
    });
    expect(avisos()).toEqual([
      [
        `${PREFIXO} a Loja Integrada respondeu outra grade; nada foi guardado`,
        { conta: CONTA, recurso: 'grade', gradeId: String(GRADE_ID) },
      ],
    ]);
    await ler(deps({ fetch: p.fetch }), GRADE);
    expect(p.chamadas).toHaveLength(2);
  });

  it('the equal side of the identity: a detail whose id is the asked grade as a quoted number is the same grade', async () => {
    const p = plataforma(() => ok({ ...detalheGradeLi(GRADE_ID, [1]), id: String(GRADE_ID) }));

    const r = respostaDe(await ler(deps({ fetch: p.fetch }), GRADE));

    expect(r.grade.id).toBe(GRADE_ID);
    expect(avisos()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                              `?atualizar=1`, exactly                         */
/* -------------------------------------------------------------------------- */

describe('pedeAtualizacaoLi', () => {
  const base = 'http://localhost:3010/api/marketplace/loja-integrada/conta/c/grades';

  it('only a single `atualizar=1` asks for a fresh read', () => {
    expect(pedeAtualizacaoLi(`${base}?atualizar=1`)).toBe(true);
    expect(pedeAtualizacaoLi(`${base}?x=2&atualizar=1`)).toBe(true);
  });

  it.each([
    '',
    '?atualizar',
    '?atualizar=',
    '?atualizar=true',
    '?atualizar=01',
    '?atualizar=1%20',
    '?Atualizar=1',
    '?atualizar=1&atualizar=1',
    '?atualizar=0&atualizar=1',
  ])('⚠️ NEAR-MISS %j is not a refresh', (consulta) => {
    expect(pedeAtualizacaoLi(`${base}${consulta}`)).toBe(false);
  });
});
