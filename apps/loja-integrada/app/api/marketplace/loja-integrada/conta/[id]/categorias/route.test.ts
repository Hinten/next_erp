/**
 * `GET …/conta/[id]/categorias` — the store's category list (master plan step 10), end to end
 * through the REAL catalogue core (`lib/lojaIntegrada/catalogo/catalogo.ts`), the REAL context
 * loader, package client and pager, the REAL park and the REAL cache, against the fake.
 *
 * Mocked: the Admin singleton (`verifyIdToken` and the fake as Firestore), `FieldValue.increment`
 * (the fake's sentinel) and the pacer's sleep (recorded, never slept). The global `fetch` is
 * stubbed for the WHOLE file with a default that THROWS: a case that needs Loja Integrada scripts
 * it, and every case asserts the exact number of calls (D17).
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { LiNotFoundError } from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_ERRO_LI,
  erroContaLojaIntegradaSchema,
  respostaCategoriasLiSchema,
} from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import {
  type ChamadaCatalogoLi,
  type RespostaCatalogoLi,
  categoriaLi,
  json,
  paginaCatalogoLi,
  respostasDasCapturasC9,
  totalDaCapturaC9,
} from '@/lib/lojaIntegrada/testing/catalogoLi';
import { FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { caminhoCredencial, seedConta, seedCredencial } from '@/lib/lojaIntegrada/testing/fixtures';
import {
  ESTRANHO,
  LEITOR,
  contexto,
  espiarConsole,
  requisicao,
} from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
  esperas: [] as number[],
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));
// The fake's increment sentinel (`testing/fakeDb.ts`), spelled inline: the factory is hoisted.
vi.mock('firebase-admin/firestore', async (original) => ({
  ...(await original<typeof import('firebase-admin/firestore')>()),
  FieldValue: { increment: (by: number) => ({ __increment: by }) },
}));
// The pacer's 2 s sleep, recorded instead of slept: the interval itself is the real one.
vi.mock('@/lib/lojaIntegrada/core/ritmo', async (original) => {
  const real = await original<typeof import('@/lib/lojaIntegrada/core/ritmo')>();
  return {
    ...real,
    ritmoDeLeituraLi: () => ({
      intervaloMs: real.RITMO_LEITURA_LI_MS,
      esperar: (ms: number) => {
        h.esperas.push(ms);
        return Promise.resolve();
      },
    }),
  };
});

const { GET } = await import('./route');

const CONTA = 'conta-li-categorias-http';

let db: FakeDb;
let fetchFalso: Mock<typeof globalThis.fetch>;
let chamadas: ChamadaCatalogoLi[];
let console_: ReturnType<typeof espiarConsole>;

/** Answer every Loja Integrada call with `responder`, recording each one. */
function scriptarLoja(responder: (c: ChamadaCatalogoLi) => RespostaCatalogoLi): void {
  fetchFalso.mockImplementation((input) => {
    const url = new URL(String(input));
    const c: ChamadaCatalogoLi = { caminho: url.pathname, query: [...url.searchParams] };
    chamadas.push(c);
    return Promise.resolve(json(responder(c)));
  });
}

function get(sufixo = '', opts: { semAuth?: boolean; sinal?: AbortSignal; conta?: string } = {}) {
  const conta = opts.conta ?? CONTA;
  return GET(
    requisicao('GET', `${encodeURIComponent(conta)}/categorias${sufixo}`, opts),
    contexto(conta),
  );
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  h.esperas.length = 0;
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(LEITOR);
  chamadas = [];
  fetchFalso = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('o catálogo só chama a Loja Integrada quando o teste roteiriza');
  });
  vi.stubGlobal('fetch', fetchFalso);
  console_ = espiarConsole();
  seedConta(db, CONTA);
  seedCredencial(db, CONTA);
  // Every case starts with the switch as every environment has it until the window: unset.
  vi.stubEnv(CHAMADAS_ENV_LI, undefined);
});

afterEach(() => {
  console_.restaurar();
  expect(fetchFalso).toHaveBeenCalledTimes(chamadas.length);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetAllReadCaches();
});

describe('GET …/conta/[id]/categorias — the caller and the id: nothing read', () => {
  it('401 without a bearer token; 403 without integracao.read', async () => {
    expect((await get('', { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get()).status).toBe(403);
    expect(db.leituras).toEqual([]);
  });

  it.each(['..', '.', 'a.b'])('400 LI_ID_INVALIDO for the conta id %j', async (id) => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    const res = await get('', { conta: id });

    expect(res.status).toBe(400);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.idInvalido,
    });
    expect(db.leituras).toEqual([]);
  });
});

describe('GET …/categorias — the read switch (D17)', () => {
  it.each([
    ['unset', undefined],
    ['off', 'off'],
    ['ON', 'ON'],
  ])('%s ⇒ 503 LI_CHAMADAS_DESLIGADAS: zero calls, zero Firestore reads', async (_caso, valor) => {
    vi.stubEnv(CHAMADAS_ENV_LI, valor);

    const res = await get();

    expect(res.status).toBe(503);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.chamadasDesligadas,
    });
    expect(db.leituras).toEqual([]);
    expect(h.esperas).toEqual([]);
  });
});

describe('GET …/categorias — the switch ON', () => {
  beforeEach(() => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
  });

  it('200: the contract, built through its schema, never cached by the browser', async () => {
    scriptarLoja(() =>
      paginaCatalogoLi('categoria', [categoriaLi(1), categoriaLi(2, '/v1/categoria/1')]),
    );

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(respostaCategoriasLiSchema.parse(await corpoDe(res)).categorias).toEqual([
      { id: 1, nome: 'Categoria 1', pai: { tipo: 'raiz' } },
      { id: 2, nome: 'Categoria 2', pai: { tipo: 'id', id: 1 } },
    ]);
    expect(chamadas).toHaveLength(1);
  });

  it('end to end over the C9 captures: both pages of the larger store, every row, every parent read', async () => {
    const nomes = ['c9-loja1-categorias.json', 'c9-loja1-categorias-p2.json'];
    scriptarLoja(respostasDasCapturasC9(nomes));

    const res = await get();

    expect(res.status).toBe(200);
    const corpo = respostaCategoriasLiSchema.parse(await corpoDe(res));
    expect(corpo.categorias.length === totalDaCapturaC9(nomes[0] ?? '')).toBe(true);
    expect(corpo.categorias.some((c) => c.pai.tipo === 'ilegivel')).toBe(false);
    expect(corpo.categorias.some((c) => c.pai.tipo === 'id')).toBe(true);
    expect(chamadas).toHaveLength(2);
  });

  it('a second request is served from the cache; `?atualizar=1` reads again; `?atualizar=true` does not', async () => {
    scriptarLoja(() => paginaCatalogoLi('categoria', [categoriaLi(1)]));

    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect(chamadas).toHaveLength(1);
    expect((await get('?atualizar=true')).status).toBe(200);
    expect(chamadas).toHaveLength(1);
    expect((await get('?atualizar=1')).status).toBe(200);
    expect(chamadas).toHaveLength(2);
  });

  it('a 401 ⇒ the conta is parked, then 409 LI_RECONEXAO_PENDENTE', async () => {
    scriptarLoja(() => ({ status: 401, corpo: { erro: 'token' } }));

    const res = await get();

    expect(res.status).toBe(409);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.reconexaoPendente,
    });
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 401 });
  });

  it('a 403 on the category list ⇒ parked too (the token check’s own path)', async () => {
    scriptarLoja(() => ({ status: 403, corpo: { erro: 'proibido' } }));

    const res = await get();

    expect(res.status).toBe(409);
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 403 });
  });

  it('a 5xx ⇒ 502 LI_LOJA_INDISPONIVEL in the envelope', async () => {
    scriptarLoja(() => ({ status: 503, corpo: {} }));

    const res = await get();

    expect(res.status).toBe(502);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.lojaIndisponivel,
    });
  });

  it('⚠️ a 404 on the LIST is a refusal of our request: rethrown, so it surfaces as a 500', async () => {
    scriptarLoja(() => ({ status: 404, corpo: {} }));

    await expect(get()).rejects.toBeInstanceOf(LiNotFoundError);
  });

  it('the caller going away during the read ⇒ 499 with an EMPTY body', async () => {
    const controle = new AbortController();
    scriptarLoja(() => {
      controle.abort();
      return paginaCatalogoLi('categoria', [categoriaLi(1)]);
    });

    const res = await get('', { sinal: controle.signal });

    expect(res.status).toBe(499);
    expect(await res.text()).toBe('');
  });
});
