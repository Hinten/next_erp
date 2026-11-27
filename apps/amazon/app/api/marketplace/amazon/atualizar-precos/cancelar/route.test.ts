/**
 * `POST /api/marketplace/amazon/atualizar-precos/cancelar` — the thin route
 * over `cancelarAtualizacaoPrecosAmazon` (covered with the cancel it maps by
 * `envioManualPreco.test.ts` and `inicioExecucaoPreco.test.ts`). Here: the
 * permission, the strict body, the bindings through the Admin singleton and the
 * wall clock, both headers on every answer, ONE write on the run and nothing
 * else: no enqueue, no Amazon call.
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
  respostaCancelamentoExecucaoPrecoAmazonSchema,
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

const { POST } = await import('./route');

const CONTA = 'conta-teste';
const CAMINHO_RUN = `precosAmazon/${CONTA}`;
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/atualizar-precos/cancelar';
const AGORA_MS = 1_800_000_000_000;
const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;
const EXPEDICAO = { uid: 'u-expedicao', permissions: PERM.pedido.write.toString() };
const CORPO = { integracaoId: CONTA };

let db: FakeDb;
let chamadasFetch: unknown[];

function post(corpo: unknown, opts: { semAuth?: boolean } = {}): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.semAuth !== true) headers.set('authorization', 'Bearer id-token-de-teste');
  return POST(new Request(URL_ROTA, { method: 'POST', headers, body: JSON.stringify(corpo) }));
}

function cabecalhosOk(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

function semear(run: Record<string, unknown> | null) {
  db.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.amazon,
    ativo: true,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
  });
  if (run !== null) {
    db.seed(
      CAMINHO_RUN,
      execucaoPrecoAmazonSchema.parse({
        execucaoId: 'exec-1',
        fase: FASE_EXECUCAO_PRECO_AMAZON.concluida,
        baixarPreco: true,
        solicitadaPor: 'uid-antigo',
        iniciadaEmMs: AGORA_MS - 3 * HORA_MS,
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
  stubAmbiente({ AMAZON_CHAMADAS: 'on', AMAZON_MODO_PRECO: 'on', AMAZON_CANARIO_PRECO: '*' });
  const espiao = espiaoDeFetch();
  chamadasFetch = espiao.chamadas;
  vi.stubGlobal('fetch', espiao.fetch);
});

afterEach(() => {
  // ★ No Amazon call and no enqueue: the cancel is one write on the run.
  expect(chamadasFetch).toHaveLength(0);
  expect(h.getFunctions).not.toHaveBeenCalled();
  expect(db.escritas.filter((e) => e.caminho !== CAMINHO_RUN)).toEqual([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/marketplace/amazon/atualizar-precos/cancelar', () => {
  it('exports POST only, on the node runtime, never cached', async () => {
    const rota = await import('./route');
    expect(Object.keys(rota).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(rota.dynamic).toBe('force-dynamic');
    expect(rota.runtime).toBe('nodejs');
  });

  it('no Bearer token ⇒ 401; a reader, or PERM.pedido.write alone ⇒ 403 — nothing read or written', async () => {
    semear({ decisao: 'tarefas', progressoEmMs: AGORA_MS - MINUTO_MS });
    const sem = await post(CORPO, { semAuth: true });
    expect(sem.status).toBe(401);
    cabecalhosOk(sem);
    for (const quem of [LEITOR, EXPEDICAO]) {
      h.verifyIdToken.mockResolvedValue(quem);
      const res = await post(CORPO);
      expect(res.status).toBe(403);
      cabecalhosOk(res);
    }
    expect(db.operacoes).toBe(0);
  });

  it('★ 200 end to end on the WALL clock: a `concluida` run decided `tarefas` 10 min ago is `cancelada` (ONE write); NEAR-MISS: 2 h 1 min ago, every batch ended, it is answered unchanged', async () => {
    semear({ decisao: 'tarefas', progressoEmMs: AGORA_MS - 10 * MINUTO_MS });
    const res = await post(CORPO);
    expect(res.status).toBe(200);
    cabecalhosOk(res);
    expect(respostaCancelamentoExecucaoPrecoAmazonSchema.parse(await res.json())).toEqual({
      execucaoId: 'exec-1',
      fase: 'cancelada',
    });
    expect(db.escritasEm(CAMINHO_RUN)).toHaveLength(1);

    db = new FakeDb();
    h.db = asDb(db);
    semear({
      decisao: 'tarefas',
      progressoEmMs: AGORA_MS - 2 * HORA_MS - MINUTO_MS,
      lotes: {
        '0': {
          execucaoIdLote: 'exec-1-l0',
          parteInicial: 0,
          partes: 1,
          itens: 3,
          desfecho: 'concluido',
        },
      },
    });
    expect(await (await post(CORPO)).json()).toEqual({ execucaoId: 'exec-1', fase: 'concluida' });
    expect(db.escritas).toEqual([]);
  });

  it('★ no run ⇒ 404 AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA, with both headers, nothing written', async () => {
    semear(null);
    const res = await post(CORPO);
    expect(res.status).toBe(404);
    cabecalhosOk(res);
    expect(erroPrecoAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA,
    });
    expect(db.escritas).toEqual([]);
  });

  it('a stray key ⇒ 400 CORPO_INVALIDO; the read switch off ⇒ 503 — nothing read or written', async () => {
    semear({ fase: 'paginando' });
    const estranho = await post({ ...CORPO, execucaoId: 'exec-1' });
    expect(estranho.status).toBe(400);
    cabecalhosOk(estranho);
    expect(erroPrecoAmazonSchema.parse(await estranho.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO,
      issues: ['execucaoId'],
    });
    vi.stubEnv('AMAZON_CHAMADAS', '');
    const desligada = await post(CORPO);
    expect(desligada.status).toBe(503);
    expect(await desligada.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(db.operacoes).toBe(0);
  });
});
