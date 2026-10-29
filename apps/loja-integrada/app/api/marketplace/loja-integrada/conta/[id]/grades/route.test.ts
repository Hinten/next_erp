/**
 * `GET …/conta/[id]/grades` — the store's grade list (master plan step 10), end to end through the
 * REAL catalogue core, context loader, package client, park and cache, against the fake. This is
 * the list the web linker calls (`apps/web/lib/loja-integrada/client.ts`).
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
  respostaGradesLiSchema,
} from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import {
  type ChamadaCatalogoLi,
  type RespostaCatalogoLi,
  gradeLi,
  json,
  paginaCatalogoLi,
  respostasDasCapturasC9,
  totalDaCapturaC9,
} from '@/lib/lojaIntegrada/testing/catalogoLi';
import { FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import {
  AGORA_MS,
  TOKEN_B,
  caminhoCredencial,
  seedConta,
  seedCredencial,
} from '@/lib/lojaIntegrada/testing/fixtures';
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

const CONTA = 'conta-li-grades-http';

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

function get(sufixo = '', opts: { semAuth?: boolean } = {}) {
  return GET(requisicao('GET', `${CONTA}/grades${sufixo}`, opts), contexto(CONTA));
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

describe('GET …/conta/[id]/grades', () => {
  it('401 without a bearer token; 403 without integracao.read — nothing read', async () => {
    expect((await get('', { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get()).status).toBe(403);
    expect(db.leituras).toEqual([]);
  });

  it('the switch unset ⇒ 503 LI_CHAMADAS_DESLIGADAS, zero calls, zero Firestore reads', async () => {
    const res = await get();

    expect(res.status).toBe(503);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.chamadasDesligadas,
    });
    expect(db.leituras).toEqual([]);
  });

  it('200, then a cache hit; `?atualizar=1` (what the web’s "Atualizar" sends) reads again', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => paginaCatalogoLi('grades', [gradeLi(7), gradeLi(8, 'Cor')]));

    const res = await get();
    expect(res.status).toBe(200);
    expect(respostaGradesLiSchema.parse(await corpoDe(res)).grades).toEqual([
      { id: 7, nome: 'Grade 7', nomeVisivel: null },
      { id: 8, nome: 'Grade 8', nomeVisivel: 'Cor' },
    ]);
    await get();
    expect(chamadas).toHaveLength(1);
    await get('?atualizar=1');
    expect(chamadas).toHaveLength(2);
  });

  it.each(['c9-loja1-grades.json', 'c9-loja2-grades.json'])(
    'end to end over the capture %s: every grade of the store',
    async (nome) => {
      vi.stubEnv(CHAMADAS_ENV_LI, 'on');
      scriptarLoja(respostasDasCapturasC9([nome]));

      const res = await get();

      expect(res.status).toBe(200);
      const corpo = respostaGradesLiSchema.parse(await corpoDe(res));
      expect(corpo.grades.length > 0).toBe(true);
      expect(corpo.grades.length === totalDaCapturaC9(nome)).toBe(true);
      expect(chamadas).toHaveLength(1);
    },
  );

  it('⚠️ a 403 on the grade list ⇒ 502 LI_RECURSO_NAO_PERMITIDO, and the conta is NOT parked', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ({ status: 403, corpo: { erro: 'proibido' } }));

    const res = await get();

    expect(res.status).toBe(502);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.recursoNaoPermitido,
    });
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toBeNull();
  });

  it('a 401 ⇒ parked, then 409 LI_RECONEXAO_PENDENTE', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ({ status: 401, corpo: { erro: 'token' } }));

    const res = await get();

    expect(res.status).toBe(409);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.reconexaoPendente,
    });
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 401 });
  });

  it('⚠️ a 401 to a token REPLACED while the list was read ⇒ 409 LI_CREDENCIAL_ALTERADA, nothing parked; a retry reads under the new token', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    let trocado = false;
    scriptarLoja(() => {
      if (!trocado) {
        // An operator saves a new token while the first request is in flight; the store then
        // refuses the token that request carried.
        trocado = true;
        seedCredencial(db, CONTA, { personalToken: TOKEN_B, tokenAtualizadoEmMs: AGORA_MS });
        return { status: 401, corpo: { erro: 'token' } };
      }
      return paginaCatalogoLi('grades', [gradeLi(7)]);
    });

    const res = await get();

    expect(res.status).toBe(409);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.credencialAlterada,
    });
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toBeNull();
    expect(chamadas).toHaveLength(1);

    // The new token is the stored one: a plain retry answers.
    const depois = await get();
    expect(depois.status).toBe(200);
    expect(respostaGradesLiSchema.parse(await corpoDe(depois)).grades.map((g) => g.id)).toEqual([
      7,
    ]);
    expect(chamadas).toHaveLength(2);
  });

  it('a 429 ⇒ 503 LI_LIMITE_DE_CHAMADAS', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ({ status: 429, corpo: {} }));

    const res = await get();

    expect(res.status).toBe(503);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.limiteDeChamadas,
    });
  });
});
