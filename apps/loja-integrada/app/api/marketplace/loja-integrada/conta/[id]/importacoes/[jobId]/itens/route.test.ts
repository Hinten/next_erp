/**
 * `GET …/conta/[id]/importacoes/[jobId]/itens?depois=` — one page of a product import's report
 * (master plan step 9), end to end through the REAL lifecycle reads against the fake: the job's
 * ownership first, then its own `itens` in document-key order. Mocked: the Admin singleton only.
 * The global `fetch` THROWS for the whole file and is never called.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODIGO_ERRO_LI,
  LIMITE_ITENS_IMPORTACAO_LI,
  respostaItensImportacaoLiSchema,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { caminhoJobLi, seedItemLi, seedJobLi } from '@/lib/lojaIntegrada/testing/importacaoLi';
import { ESTRANHO, LEITOR, URL_CONTAS } from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

const { GET } = await import('./route');

const CONTA = 'conta-li-itens-http';
const JOB = 'jobItens01';

let db: FakeDb;
let fetchFalso: Mock<typeof globalThis.fetch>;

function get(query = '', conta = CONTA, jobId = JOB, auth = true) {
  return GET(
    new Request(`${URL_CONTAS}/${conta}/importacoes/${jobId}/itens${query}`, {
      headers: auth ? { authorization: 'Bearer id-token-de-teste' } : {},
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
    throw new Error('o relatório não chama a Loja Integrada');
  });
  vi.stubGlobal('fetch', fetchFalso);
});

afterEach(() => {
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('GET …/itens', () => {
  it('401 without a bearer token; 403 without integracao.read', async () => {
    expect((await get('', CONTA, JOB, false)).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get()).status).toBe(403);
    expect(db.leituras).toEqual([]);
  });

  it.each([
    ['a cursor that is not an item id', '?depois=abc'],
    ['a negative cursor', '?depois=-1'],
    ['a cursor with a slash', '?depois=1%2F2'],
    ['a repeated cursor', '?depois=1&depois=2'],
  ])('400 LI_ID_INVALIDO for %s, before anything is read', async (_c, query) => {
    seedJobLi(db, JOB, CONTA);
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_LI.idInvalido, issues: ['depois'] });
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
  });

  it('400 for a bad job id, before anything is read', async () => {
    const res = await get('', CONTA, 'job.1');
    expect(res.status).toBe(400);
    expect(db.leituras).toEqual([]);
  });

  it('the first page, then the next through `proximo`; absent and empty `depois` are the same first page', async () => {
    seedJobLi(db, JOB, CONTA);
    for (let i = 0; i < LIMITE_ITENS_IMPORTACAO_LI + 2; i += 1) seedItemLi(db, JOB, 300_000 + i);
    const p1 = respostaItensImportacaoLiSchema.parse(await (await get()).json());
    expect(p1.itens).toHaveLength(LIMITE_ITENS_IMPORTACAO_LI);
    expect(p1.proximo).toBe(String(300_000 + LIMITE_ITENS_IMPORTACAO_LI - 1));
    const vazio = respostaItensImportacaoLiSchema.parse(await (await get('?depois=')).json());
    expect(vazio).toEqual(p1);

    const res2 = await get(`?depois=${p1.proximo ?? ''}`);
    expect(res2.headers.get('cache-control')).toBe('no-store');
    const p2 = respostaItensImportacaoLiSchema.parse(await res2.json());
    expect(p2.itens.map((i) => i.liId)).toEqual([
      300_000 + LIMITE_ITENS_IMPORTACAO_LI,
      300_000 + LIMITE_ITENS_IMPORTACAO_LI + 1,
    ]);
    expect(p2.proximo).toBeNull();
  });

  it('⚠️ another conta’s job is never paged: 404 after the ONE job read, no items query', async () => {
    seedJobLi(db, JOB, 'conta-li-outra');
    seedItemLi(db, JOB, 1);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_LI.importacaoNaoEncontrada });
    expect(db.leituras).toEqual([caminhoJobLi(JOB)]);
    expect(db.consultas).toEqual([]);
  });

  it('a job with no items yet is an empty last page', async () => {
    seedJobLi(db, JOB, CONTA);
    expect(await (await get()).json()).toEqual({ itens: [], proximo: null });
  });
});
