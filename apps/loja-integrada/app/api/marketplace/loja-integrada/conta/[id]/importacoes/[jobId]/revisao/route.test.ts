/**
 * `GET …/conta/[id]/importacoes/[jobId]/revisao` — a product import's tax-review list (master plan
 * step 9), end to end through the REAL reads against the fake: the job's ownership first, then its
 * own `revisao` list, read WHOLE. Mocked: the Admin singleton only. The global `fetch` THROWS for
 * the whole file and is never called, and the read switch is off as everywhere until the window.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODIGO_ERRO_LI,
  LIMITE_ITENS_IMPORTACAO_LI,
  MOTIVO_REVISAO_FISCAL_LI,
  type RevisaoFiscalLi,
  respostaRevisaoFiscalLiSchema,
  revisaoFiscalLiSchema,
} from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import { type DocData, FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { AGORA_MS } from '@/lib/lojaIntegrada/testing/fixtures';
import { caminhoJobLi, seedJobLi } from '@/lib/lojaIntegrada/testing/importacaoLi';
import { ESTRANHO, LEITOR, requisicao } from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

const { GET } = await import('./route');

const CONTA = 'conta-li-revisao-http';
const JOB = 'jobRevisao01';
const LISTA = `${caminhoJobLi(JOB)}/revisao`;

let db: FakeDb;
let fetchFalso: Mock<typeof globalThis.fetch>;

function get(conta = CONTA, jobId = JOB, semAuth = false) {
  return GET(
    requisicao(
      'GET',
      `${encodeURIComponent(conta)}/importacoes/${encodeURIComponent(jobId)}/revisao`,
      { semAuth },
    ),
    { params: Promise.resolve({ id: conta, jobId }) },
  );
}

function entrada(produtoId: string, over: Partial<Record<keyof RevisaoFiscalLi, unknown>> = {}) {
  return revisaoFiscalLiSchema.parse({
    produtoId,
    motivos: [MOTIVO_REVISAO_FISCAL_LI.produtoCriado],
    liId: 182904918,
    desdeJobId: JOB,
    desdeMs: AGORA_MS,
    ...over,
  });
}

/** Seed `revisao/<produtoId>` with `dados` as stored (a valid entry unless a test says otherwise). */
function seedEntrada(produtoId: string, dados: DocData = entrada(produtoId) as unknown as DocData) {
  db.seed(`${LISTA}/${produtoId}`, dados);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(LEITOR);
  fetchFalso = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('a lista de revisão fiscal não chama a Loja Integrada');
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

describe('GET …/importacoes/[jobId]/revisao', () => {
  it('401 without a bearer token; 403 without integracao.read; nothing read', async () => {
    expect((await get(CONTA, JOB, true)).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get()).status).toBe(403);
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
  });

  it.each([
    ['a conta id outside its grammar', 'conta/li', JOB],
    ['a job id outside its grammar', CONTA, 'job.1'],
  ])('400 LI_ID_INVALIDO for %s, before anything is read', async (_c, conta, jobId) => {
    const res = await get(conta, jobId);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_LI.idInvalido });
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
  });

  it('⚠️ another conta’s job is never listed: 404 after the ONE job read, no list read', async () => {
    seedJobLi(db, JOB, 'conta-li-outra');
    seedEntrada('p1');
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_LI.importacaoNaoEncontrada });
    expect(db.leituras).toEqual([caminhoJobLi(JOB)]);
    expect(db.consultas).toEqual([]);
  });

  it('a missing job is the same 404', async () => {
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_LI.importacaoNaoEncontrada });
    expect(db.consultas).toEqual([]);
  });

  it('the WHOLE list in ONE answer, in code-unit order, through ONE unfiltered, unordered, unlimited read (root rule 1)', async () => {
    seedJobLi(db, JOB, CONTA);
    // More entries than the report's page: nothing here cuts a page.
    const n = LIMITE_ITENS_IMPORTACAO_LI + 3;
    const ids = Array.from({ length: n }, (_, i) => `p-${String(n - i).padStart(4, '0')}`);
    for (const id of ids) seedEntrada(id);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const lido = respostaRevisaoFiscalLiSchema.parse(await res.json());
    expect(lido.proximo).toBeNull();
    expect(lido.entradas.map((e) => e.produtoId)).toEqual([...ids].sort());
    expect(lido.entradas[0]).toEqual({
      produtoId: 'p-0001',
      motivos: [MOTIVO_REVISAO_FISCAL_LI.produtoCriado],
      liId: 182904918,
      desdeJobId: JOB,
      desdeMs: AGORA_MS,
    });
    expect(db.leituras).toEqual([caminhoJobLi(JOB)]);
    expect(db.consultas).toEqual([
      { colecao: LISTA, filtros: [], ordens: [], limite: null, apos: null },
    ]);
  });

  it('PAIR: the order is the code units’ — an upper-case id sorts before a lower-case one ⟷ NEAR-MISS "10" sorts before "9" (never numeric)', async () => {
    seedJobLi(db, JOB, CONTA);
    for (const id of ['b', 'A', 'a', '9', '10']) seedEntrada(id);
    const lido = respostaRevisaoFiscalLiSchema.parse(await (await get()).json());
    expect(lido.entradas.map((e) => e.produtoId)).toEqual(['10', '9', 'A', 'a', 'b']);
  });

  it('a stored entry that does not parse is still answered: its produto is the document key, every field that reads is kept, the rest null', async () => {
    seedJobLi(db, JOB, CONTA);
    seedEntrada('p-boa');
    seedEntrada('p-ruim', {
      produtoId: 'outro-id',
      motivos: [MOTIVO_REVISAO_FISCAL_LI.semCategoria, 'motivo-desconhecido', 7],
      liId: 'nao-e-um-id',
      desdeJobId: JOB,
      desdeMs: 'ontem',
    });
    seedEntrada('p-vazia', {});
    const res = await get();
    expect(res.status).toBe(200);
    const lido = respostaRevisaoFiscalLiSchema.parse(await res.json());
    expect(lido.entradas).toEqual([
      entrada('p-boa'),
      {
        produtoId: 'p-ruim',
        motivos: [MOTIVO_REVISAO_FISCAL_LI.semCategoria],
        liId: null,
        desdeJobId: JOB,
        desdeMs: null,
      },
      { produtoId: 'p-vazia', motivos: [], liId: null, desdeJobId: null, desdeMs: null },
    ]);
  });

  it('a job with an empty list (a Simular job’s is always empty) answers an empty last page', async () => {
    seedJobLi(db, JOB, CONTA);
    expect(await (await get()).json()).toEqual({ entradas: [], proximo: null });
  });
});
