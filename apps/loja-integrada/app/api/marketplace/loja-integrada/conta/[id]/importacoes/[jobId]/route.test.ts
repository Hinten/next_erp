/**
 * `GET …/conta/[id]/importacoes/[jobId]` — one product import's status (master plan step 9), end to
 * end through the REAL lifecycle reads against the fake. Mocked: the Admin singleton only. The
 * global `fetch` THROWS for the whole file and is never called: the route reads only the ERP.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODIGO_ERRO_LI, respostaImportacaoLiSchema } from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import { FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { caminhoJobLi, seedJobLi } from '@/lib/lojaIntegrada/testing/importacaoLi';
import { ESTRANHO, LEITOR, requisicao } from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

const { GET } = await import('./route');

const CONTA = 'conta-li-status-http';
const JOB = 'jobStatus01';

let db: FakeDb;
let fetchFalso: Mock<typeof globalThis.fetch>;

function get(conta = CONTA, jobId = JOB, semAuth = false) {
  return GET(
    requisicao('GET', `${encodeURIComponent(conta)}/importacoes/${encodeURIComponent(jobId)}`, {
      semAuth,
    }),
    { params: Promise.resolve({ id: conta, jobId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(LEITOR);
  fetchFalso = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('a rota de status não chama a Loja Integrada');
  });
  vi.stubGlobal('fetch', fetchFalso);
  // The switch as every environment has it until the window: the route answers anyway.
  vi.stubEnv(CHAMADAS_ENV_LI, undefined);
});

afterEach(() => {
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET …/importacoes/[jobId]', () => {
  it('401 without a bearer token; 403 without integracao.read; nothing read', async () => {
    expect((await get(CONTA, JOB, true)).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get()).status).toBe(403);
    expect(db.leituras).toEqual([]);
  });

  it.each<[string, string, string]>([
    ['a conta id with a dot', 'a.b', JOB],
    ['a job id with a slash', CONTA, 'a/b'],
    ['a job id with a space', CONTA, 'job 1'],
    ['an empty job id', CONTA, ''],
  ])('400 LI_ID_INVALIDO for %s, before anything is read', async (_c, conta, jobId) => {
    const res = await get(conta, jobId);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_LI.idInvalido });
    expect(db.leituras).toEqual([]);
  });

  it('200: the job projected — status, phase, counters — never its seq, cursors or maps', async () => {
    seedJobLi(db, JOB, CONTA, {
      status: 'executando',
      fase: 'listagem',
      seq: 12,
      selecionados: [],
      contadores: { familias: 3, vinculados: 2 },
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const corpo = (await res.json()) as Record<string, unknown>;
    expect(respostaImportacaoLiSchema.parse(corpo)).toMatchObject({
      jobId: JOB,
      integracaoId: CONTA,
      status: 'executando',
      fase: 'listagem',
      contadores: { familias: 3, vinculados: 2, criados: 0 },
    });
    expect(corpo).not.toHaveProperty('seq');
    expect(corpo).not.toHaveProperty('catalogo');
    expect(corpo).not.toHaveProperty('mapaCategorias');
    expect(db.leituras).toEqual([caminhoJobLi(JOB)]);
  });

  it('EQUAL/NEAR-MISS: a missing job and another conta’s job are the SAME 404', async () => {
    seedJobLi(db, JOB, 'conta-li-outra');
    const deOutra = await get();
    const ausente = await get(CONTA, 'jobQueNaoExiste');
    expect(deOutra.status).toBe(404);
    expect(ausente.status).toBe(404);
    expect(await deOutra.json()).toEqual(await ausente.json());
  });

  it('a stored job that no longer parses is a 500 (rethrown), never a 404', async () => {
    db.seed(caminhoJobLi(JOB), { integracaoId: CONTA, status: 'rodando', iniciadoEmMs: 1 });
    await expect(get()).rejects.toThrow();
  });
});
