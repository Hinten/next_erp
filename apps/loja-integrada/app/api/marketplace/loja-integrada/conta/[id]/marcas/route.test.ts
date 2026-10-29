/**
 * `GET …/conta/[id]/marcas` — the store's brand list (master plan step 10), end to end through
 * the REAL catalogue core, context loader, package client, park and cache, against the fake.
 *
 * Mocked as in the category route's suite: the Admin singleton, `FieldValue.increment` and the
 * pacer's sleep. The global `fetch` throws unless a case scripts it; every case asserts the exact
 * number of calls (D17).
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  CODIGO_ERRO_LI,
  erroContaLojaIntegradaSchema,
  respostaMarcasLiSchema,
} from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import {
  type ChamadaCatalogoLi,
  type RespostaCatalogoLi,
  json,
  marcaLi,
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
vi.mock('firebase-admin/firestore', async (original) => ({
  ...(await original<typeof import('firebase-admin/firestore')>()),
  FieldValue: { increment: (by: number) => ({ __increment: by }) },
}));
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

const CONTA = 'conta-li-marcas-http';

let db: FakeDb;
let fetchFalso: Mock<typeof globalThis.fetch>;
let chamadas: ChamadaCatalogoLi[];
let console_: ReturnType<typeof espiarConsole>;

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
    requisicao('GET', `${encodeURIComponent(conta)}/marcas${sufixo}`, opts),
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
  vi.stubEnv(CHAMADAS_ENV_LI, undefined);
});

afterEach(() => {
  console_.restaurar();
  expect(fetchFalso).toHaveBeenCalledTimes(chamadas.length);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetAllReadCaches();
});

describe('GET …/conta/[id]/marcas', () => {
  it('401 without a bearer token; 403 without integracao.read — nothing read', async () => {
    expect((await get('', { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get()).status).toBe(403);
    expect(db.leituras).toEqual([]);
  });

  it.each(['..', 'a.b'])('400 LI_ID_INVALIDO for the conta id %j, nothing read', async (id) => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    const res = await get('', { conta: id });

    expect(res.status).toBe(400);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.idInvalido,
    });
    expect(db.leituras).toEqual([]);
  });

  it('a cache hit; `?atualizar=true` is not a refresh; `?atualizar=1` reads again', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => paginaCatalogoLi('marca', [marcaLi(1)]));

    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect((await get('?atualizar=true')).status).toBe(200);
    expect(chamadas).toHaveLength(1);
    expect((await get('?atualizar=1')).status).toBe(200);
    expect(chamadas).toHaveLength(2);
  });

  it('the caller going away during the read ⇒ 499 with an EMPTY body', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    const controle = new AbortController();
    scriptarLoja(() => {
      controle.abort();
      return paginaCatalogoLi('marca', [marcaLi(1)]);
    });

    const res = await get('', { sinal: controle.signal });

    expect(res.status).toBe(499);
    expect(await res.text()).toBe('');
  });

  it('the switch unset ⇒ 503 LI_CHAMADAS_DESLIGADAS, zero calls, zero Firestore reads', async () => {
    const res = await get();

    expect(res.status).toBe(503);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.chamadasDesligadas,
    });
    expect(db.leituras).toEqual([]);
  });

  it('200: inactive brands listed and marked', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => paginaCatalogoLi('marca', [marcaLi(1), marcaLi(2, false)]));

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(respostaMarcasLiSchema.parse(await corpoDe(res)).marcas).toEqual([
      { id: 1, nome: 'Marca 1', ativo: true },
      { id: 2, nome: 'Marca 2', ativo: false },
    ]);
  });

  it('end to end over a C9 capture: every brand of the store', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    const nome = 'c9-loja1-marcas.json';
    scriptarLoja(respostasDasCapturasC9([nome]));

    const res = await get();

    expect(res.status).toBe(200);
    const corpo = respostaMarcasLiSchema.parse(await corpoDe(res));
    expect(corpo.marcas.length === totalDaCapturaC9(nome)).toBe(true);
    expect(corpo.marcas.every((m) => m.ativo !== null)).toBe(true);
  });

  it('⚠️ a 403 on the brand list ⇒ 502 LI_RECURSO_NAO_PERMITIDO, and the conta is NOT parked', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ({ status: 403, corpo: { erro: 'proibido' } }));

    const res = await get();

    expect(res.status).toBe(502);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.recursoNaoPermitido,
    });
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toBeNull();
    expect(db.escritas).toEqual([]);
  });

  it('more pages than the ceiling ⇒ 502 LI_CATALOGO_EXCEDE_LIMITE', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja((c) => {
      const offset = Number(c.query.find(([k]) => k === 'offset')?.[1] ?? '0');
      return paginaCatalogoLi('marca', [marcaLi(offset + 1)], { offset, limite: 1, total: 999 });
    });

    const res = await get();

    expect(res.status).toBe(502);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.catalogoExcedeLimite,
    });
  });
});
