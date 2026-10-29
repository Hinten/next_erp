/**
 * `GET …/conta/[id]/grades/[gradeId]` — one grade and its options (master plan step 10), end to
 * end through the REAL catalogue core, context loader, package client, park and cache, against
 * the fake. This is the detail the web linker calls (`apps/web/lib/loja-integrada/client.ts`).
 *
 * Mocked as in the category route's suite: the Admin singleton, `FieldValue.increment` and the
 * pacer's sleep. The global `fetch` throws unless a case scripts it; every case asserts the exact
 * number of calls (D17).
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { CAMINHO_GRADES_LI } from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_ERRO_LI,
  erroContaLojaIntegradaSchema,
  respostaGradeLiSchema,
} from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import {
  type ChamadaCatalogoLi,
  type RespostaCatalogoLi,
  detalheGradeLi,
  gradeIdDaCapturaC9,
  json,
  ok,
  respostasDasCapturasC9,
} from '@/lib/lojaIntegrada/testing/catalogoLi';
import { FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { caminhoCredencial, seedConta, seedCredencial } from '@/lib/lojaIntegrada/testing/fixtures';
import { ESTRANHO, LEITOR, URL_CONTAS, espiarConsole } from '@/lib/lojaIntegrada/testing/rotas';

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

const CONTA = 'conta-li-grade-http';
const GRADE = 8946;

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

function get(
  gradeId: string,
  opts: { semAuth?: boolean; conta?: string; sufixo?: string; sinal?: AbortSignal } = {},
) {
  const conta = opts.conta ?? CONTA;
  const headers: Record<string, string> = {};
  if (opts.semAuth !== true) headers.authorization = 'Bearer id-token-de-teste';
  const req = new Request(
    `${URL_CONTAS}/${encodeURIComponent(conta)}/grades/${encodeURIComponent(gradeId)}${opts.sufixo ?? ''}`,
    { method: 'GET', headers, signal: opts.sinal },
  );
  return GET(req, { params: Promise.resolve({ id: conta, gradeId }) });
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

describe('GET …/conta/[id]/grades/[gradeId] — the caller and the ids: nothing read', () => {
  it('401 without a bearer token; 403 without integracao.read', async () => {
    expect((await get(String(GRADE), { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get(String(GRADE))).status).toBe(403);
    expect(db.leituras).toEqual([]);
  });

  it('⚠️ the caller answers FIRST: a malformed grade id from a caller without a token is a 401, from one without the permission a 403', async () => {
    expect((await get('08946', { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get('08946')).status).toBe(403);
    expect(db.leituras).toEqual([]);
  });

  it('400 LI_ID_INVALIDO for a malformed conta id', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    const res = await get(String(GRADE), { conta: 'a.b' });

    expect(res.status).toBe(400);
    expect(db.leituras).toEqual([]);
  });

  it.each(['08946', ' 8946', '8946.0', '1e3', '0', '-1', 'abc', '1/2'])(
    '⚠️ NEAR-MISS: the grade id %j ⇒ 400 LI_ID_INVALIDO before ANYTHING is read, switch on',
    async (gradeId) => {
      vi.stubEnv(CHAMADAS_ENV_LI, 'on');

      const res = await get(gradeId);

      expect(res.status).toBe(400);
      expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
        code: CODIGO_ERRO_LI.idInvalido,
      });
      expect(db.leituras).toEqual([]);
      expect(h.esperas).toEqual([]);
    },
  );
});

describe('GET …/grades/[gradeId] — the read', () => {
  it('the switch unset ⇒ 503 LI_CHAMADAS_DESLIGADAS, zero calls, zero Firestore reads', async () => {
    const res = await get(String(GRADE));

    expect(res.status).toBe(503);
    expect(db.leituras).toEqual([]);
  });

  it('200: the grade and its options, from ONE GET on the slash path with no query', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ok(detalheGradeLi(GRADE, [37097, 37098])));

    const res = await get(String(GRADE));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const corpo = respostaGradeLiSchema.parse(await corpoDe(res));
    expect(corpo.grade.id).toBe(GRADE);
    expect(corpo.opcoes.map((o) => o.id)).toEqual([37097, 37098]);
    expect(chamadas).toEqual([{ caminho: `${CAMINHO_GRADES_LI}${String(GRADE)}/`, query: [] }]);
  });

  it.each([
    'c9-loja1-grade-propria.json',
    'c9-loja1-grade-sistema.json',
    'c9-loja2-grade-propria.json',
    'c9-loja2-grade-sistema.json',
  ])(
    'end to end over the capture %s: the grade its path names, every option offered',
    async (nome) => {
      vi.stubEnv(CHAMADAS_ENV_LI, 'on');
      scriptarLoja(respostasDasCapturasC9([nome]));
      const gradeId = gradeIdDaCapturaC9(nome);

      const res = await get(gradeId);

      expect(res.status).toBe(200);
      const corpo = respostaGradeLiSchema.parse(await corpoDe(res));
      expect(String(corpo.grade.id) === gradeId).toBe(true);
      expect(corpo.opcoes.length > 0).toBe(true);
      expect(chamadas).toHaveLength(1);
    },
  );

  it('a 404 ⇒ 409 LI_GRADE_AUSENTE_NA_LOJA, and the next request asks again (never cached)', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ({ status: 404, corpo: { erro: 'nao encontrado' } }));

    const res = await get(String(GRADE));

    expect(res.status).toBe(409);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.gradeAusenteNaLoja,
    });
    await get(String(GRADE));
    expect(chamadas).toHaveLength(2);
  });

  it('⚠️ a detail of ANOTHER grade ⇒ 502 LI_LOJA_INDISPONIVEL, never cached', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ok(detalheGradeLi(GRADE + 1, [1])));

    const res = await get(String(GRADE));

    expect(res.status).toBe(502);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.lojaIndisponivel,
    });
    await get(String(GRADE));
    expect(chamadas).toHaveLength(2);
  });

  it('⚠️ a 403 ⇒ 502 LI_RECURSO_NAO_PERMITIDO, and the conta is NOT parked', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ({ status: 403, corpo: { erro: 'proibido' } }));

    const res = await get(String(GRADE));

    expect(res.status).toBe(502);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.recursoNaoPermitido,
    });
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toBeNull();
  });

  it('`?atualizar=1` reads the grade again', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    scriptarLoja(() => ok(detalheGradeLi(GRADE, [1])));

    await get(String(GRADE));
    await get(String(GRADE));
    // Only the exact `1` is a refresh.
    await get(String(GRADE), { sufixo: '?atualizar=true' });
    expect(chamadas).toHaveLength(1);
    await get(String(GRADE), { sufixo: '?atualizar=1' });
    expect(chamadas).toHaveLength(2);
  });

  it('the caller going away during the read ⇒ 499 with an EMPTY body', async () => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
    const controle = new AbortController();
    scriptarLoja(() => {
      controle.abort();
      return ok(detalheGradeLi(GRADE, [1]));
    });

    const res = await get(String(GRADE), { sinal: controle.signal });

    expect(res.status).toBe(499);
    expect(await res.text()).toBe('');
  });
});
