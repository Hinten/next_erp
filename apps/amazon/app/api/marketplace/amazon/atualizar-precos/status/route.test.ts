/**
 * `GET /api/marketplace/amazon/atualizar-precos/status` — the thin route over
 * `resumoAtualizacaoPrecosAmazon` (covered with the summary it maps by
 * `envioManualPreco.test.ts` and `inicioExecucaoPreco.test.ts`). Here: the
 * permission, the query, the bindings through the Admin singleton and the wall
 * clock, both headers on every answer, and that the status is READ-ONLY: no
 * write, no enqueue, no Amazon call.
 *
 * Mocked: the Admin singleton (the fake db, a token verifier) and the Admin
 * SDK's `getFunctions` (never called).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_PRECO_AMAZON,
  FASE_EXECUCAO_PRECO_AMAZON,
  INTEGRACAO_TIPO,
  erroPrecoAmazonSchema,
  execucaoPrecoAmazonSchema,
  resumoExecucaoPrecoAmazonSchema,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import { ESCRITOR, LEITOR, espiaoDeFetch, stubAmbiente } from '@/lib/amazon/testing/fixtures';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
  getFunctions: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
  getAdminApp: () => ({ name: 'app-de-teste' }),
}));

vi.mock('firebase-admin/functions', async (importOriginal) => {
  const original = await importOriginal<typeof import('firebase-admin/functions')>();
  return { ...original, getFunctions: h.getFunctions };
});

const { GET } = await import('./route');

const CONTA = 'conta-teste';
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/atualizar-precos/status';
const AGORA_MS = 1_800_000_000_000;
const MINUTO_MS = 60_000;
const EXPEDICAO = { uid: 'u-expedicao', permissions: PERM.pedido.write.toString() };

let db: FakeDb;
let chamadasFetch: unknown[];

function get(consulta: string, opts: { semAuth?: boolean } = {}): Promise<Response> {
  const headers = new Headers();
  if (opts.semAuth !== true) headers.set('authorization', 'Bearer id-token-de-teste');
  return GET(new Request(`${URL_ROTA}${consulta}`, { method: 'GET', headers }));
}

function cabecalhosOk(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

const CONSULTA = `?integracaoId=${CONTA}`;

function semear(run: Record<string, unknown> | null) {
  db.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.amazon,
    ativo: true,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
  });
  if (run !== null) {
    db.seed(
      `precosAmazon/${CONTA}`,
      execucaoPrecoAmazonSchema.parse({
        execucaoId: 'exec-1',
        fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
        baixarPreco: false,
        solicitadaPor: 'uid-antigo',
        iniciadaEmMs: AGORA_MS - 60 * MINUTO_MS,
        ...run,
      }),
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Date, 'now').mockReturnValue(AGORA_MS);
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  stubAmbiente({ AMAZON_CHAMADAS: 'on', AMAZON_MODO_PRECO: 'off', AMAZON_PRECO_SO_VALIDACAO: '1' });
  const espiao = espiaoDeFetch();
  chamadasFetch = espiao.chamadas;
  vi.stubGlobal('fetch', espiao.fetch);
});

afterEach(() => {
  // ★ READ-ONLY: no Amazon call, no write, no enqueue.
  expect(chamadasFetch).toHaveLength(0);
  expect(db.escritas).toEqual([]);
  expect(h.getFunctions).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/marketplace/amazon/atualizar-precos/status', () => {
  it('exports GET only, on the node runtime, never cached', async () => {
    const rota = await import('./route');
    expect(Object.keys(rota).sort()).toEqual(['GET', 'dynamic', 'runtime']);
    expect(rota.dynamic).toBe('force-dynamic');
    expect(rota.runtime).toBe('nodejs');
  });

  it('no Bearer token ⇒ 401; a reader, or PERM.pedido.write alone ⇒ 403 — nothing read', async () => {
    semear({});
    const sem = await get(CONSULTA, { semAuth: true });
    expect(sem.status).toBe(401);
    cabecalhosOk(sem);
    for (const quem of [LEITOR, EXPEDICAO]) {
      h.verifyIdToken.mockResolvedValue(quem);
      const res = await get(CONSULTA);
      expect(res.status).toBe(403);
      cabecalhosOk(res);
    }
    expect(db.operacoes).toBe(0);
  });

  it('★ 200 end to end: the summary on the WALL clock — a live run 15 min without progress is `parada` (NEAR-MISS: 14 min is not)', async () => {
    semear({ progressoEmMs: AGORA_MS - 15 * MINUTO_MS });
    const res = await get(CONSULTA);
    expect(res.status).toBe(200);
    cabecalhosOk(res);
    expect(resumoExecucaoPrecoAmazonSchema.parse(await res.json())).toMatchObject({
      execucaoId: 'exec-1',
      parada: true,
      feedEmCurso: null,
    });
    semear({ progressoEmMs: AGORA_MS - 14 * MINUTO_MS });
    expect(await (await get(CONSULTA)).json()).toMatchObject({ parada: false });
  });

  it('★ no run ⇒ 404 AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA, with both headers', async () => {
    semear(null);
    const res = await get(CONSULTA);
    expect(res.status).toBe(404);
    cabecalhosOk(res);
    expect(erroPrecoAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA,
    });
  });

  it('a stray query parameter ⇒ 400 CORPO_INVALIDO naming it; the read switch off ⇒ 503 — nothing read', async () => {
    semear({});
    const estranho = await get(`${CONSULTA}&execucaoId=x`);
    expect(estranho.status).toBe(400);
    cabecalhosOk(estranho);
    expect(erroPrecoAmazonSchema.parse(await estranho.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO,
      issues: ['execucaoId'],
    });
    vi.stubEnv('AMAZON_CHAMADAS', '');
    const desligada = await get(CONSULTA);
    expect(desligada.status).toBe(503);
    expect(await desligada.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(db.operacoes).toBe(0);
  });
});
