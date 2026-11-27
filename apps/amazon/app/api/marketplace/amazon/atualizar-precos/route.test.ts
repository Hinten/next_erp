/**
 * `POST /api/marketplace/amazon/atualizar-precos` — the thin route over
 * `iniciarAtualizacaoPrecosAmazon` (the body and the claim it maps are covered
 * by `envioManualPreco.test.ts` and `inicioExecucaoPreco.test.ts`). Here: the
 * permission, the caller as the run's `solicitadaPor`, the bindings END TO END
 * through the REAL App Hosting root (the jobs queue's path, the valve, a fresh
 * run id from the Web Crypto global), both headers on every answer, and that
 * nothing reaches Amazon, whatever the price valve, its canary list and the
 * preview flag say.
 *
 * Mocked: the Admin singleton (the fake db, a token verifier) and the Admin
 * SDK's `getFunctions` (a recording queue). D11: nothing reaches Amazon or
 * Cloud Tasks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_PRECO_AMAZON,
  ID_LOTE_FEED_AMAZON_REGEX,
  INTEGRACAO_TIPO,
  erroPrecoAmazonSchema,
  execucaoPrecoAmazonSchema,
  respostaInicioExecucaoPrecoAmazonSchema,
} from '@delfrance/schemas';

import {
  nomePaginaPrecoAmazon,
  type TarefaPaginaPrecoAmazon,
} from '@/lib/amazon/preco/tarefaPreco';
import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import {
  ESCRITOR,
  LEITOR,
  espiaoDeFetch,
  espiarStdout,
  stubAmbiente,
} from '@/lib/amazon/testing/fixtures';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
  getFunctions: vi.fn(),
  caminhos: [] as string[],
  chamadas: [] as unknown[][],
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
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/atualizar-precos';
const EXPEDICAO = { uid: 'u-expedicao', permissions: PERM.pedido.write.toString() };

let db: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
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

const CORPO = { integracaoId: CONTA };

function semear() {
  db.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste',
    ativo: true,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db = new FakeDb();
  h.db = asDb(db);
  h.caminhos.length = 0;
  h.chamadas.length = 0;
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.getFunctions.mockImplementation(() => ({
    taskQueue: (caminho: string) => {
      h.caminhos.push(caminho);
      return {
        enqueue: (...args: unknown[]) => {
          h.chamadas.push(args);
          return Promise.resolve();
        },
      };
    },
  }));
  stubAmbiente({
    AMAZON_CHAMADAS: 'on',
    AMAZON_TASKS_REGION: 'xx-tarefas-1',
    FUNCTIONS_REGION: '',
    AMAZON_TASKS_DISABLED: '',
    AMAZON_MODO_PRECO: 'off',
    AMAZON_CANARIO_PRECO: '',
    AMAZON_PRECO_SO_VALIDACAO: '1',
  });
  stdout = espiarStdout();
  const espiao = espiaoDeFetch();
  chamadasFetch = espiao.chamadas;
  vi.stubGlobal('fetch', espiao.fetch);
});

afterEach(() => {
  // ★ No arm calls Amazon.
  expect(chamadasFetch).toHaveLength(0);
  stdout.restaurar();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/marketplace/amazon/atualizar-precos', () => {
  it('exports POST only, on the node runtime, never cached', async () => {
    const rota = await import('./route');
    expect(Object.keys(rota).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(rota.dynamic).toBe('force-dynamic');
    expect(rota.runtime).toBe('nodejs');
  });

  it('no Bearer token ⇒ 401, with both headers, nothing read or claimed', async () => {
    semear();
    const res = await post(CORPO, { semAuth: true });
    expect(res.status).toBe(401);
    cabecalhosOk(res);
    expect(db.operacoes).toBe(0);
  });

  it.each([
    ['a reader of integrações', LEITOR],
    ['★ a caller with PERM.pedido.write alone', EXPEDICAO],
  ])('PERM.integracao.write is required: %s ⇒ 403, nothing read', async (_nome, quem) => {
    semear();
    h.verifyIdToken.mockResolvedValue(quem);
    const res = await post(CORPO);
    expect(res.status).toBe(403);
    cabecalhosOk(res);
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('★ 202 end to end: the run claimed for THE CALLER, page 0 NAMED onto the REGION-QUALIFIED jobs queue, the run id a fresh id of the feed core’s grammar — the price valve `off` and the preview flag set change nothing here', async () => {
    semear();
    const res = await post({ ...CORPO, baixarPreco: true });
    expect(res.status).toBe(202);
    cabecalhosOk(res);
    const corpo = respostaInicioExecucaoPrecoAmazonSchema.parse(await res.json());
    expect(corpo.retomada).toBe(false);
    expect(corpo.execucaoId).toMatch(ID_LOTE_FEED_AMAZON_REGEX);
    expect(execucaoPrecoAmazonSchema.parse(db.ler(CAMINHO_RUN))).toMatchObject({
      execucaoId: corpo.execucaoId,
      fase: 'paginando',
      baixarPreco: true,
      confirmarReducaoEmMassa: false,
      solicitadaPor: ESCRITOR.uid,
    });
    expect(h.caminhos).toEqual(['locations/xx-tarefas-1/functions/processAmazonListingsJob']);
    const [payload, extras] = h.chamadas[0] as [TarefaPaginaPrecoAmazon, { id: string }];
    expect(payload).toEqual({
      v: 1,
      tipo: 'preco-pagina',
      contaId: CONTA,
      execucaoId: corpo.execucaoId,
      pagina: 0,
    });
    expect(extras).toEqual({ id: nomePaginaPrecoAmazon(CONTA, corpo.execucaoId, 0) });
  });

  it('★ the run is stamped by the wall clock (`iniciadaEmMs` = the request’s instant), and every claim mints its OWN run id: two runs never share page 0’s name', async () => {
    semear();
    const agoraMs = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(agoraMs);
    const primeira = respostaInicioExecucaoPrecoAmazonSchema.parse(
      await (await post(CORPO)).json(),
    );
    const run = execucaoPrecoAmazonSchema.parse(db.ler(CAMINHO_RUN));
    expect(run.iniciadaEmMs).toBe(agoraMs);
    // The first run ends; the next start claims a NEW one.
    db.seed(CAMINHO_RUN, { ...run, fase: 'concluida' });
    const segunda = respostaInicioExecucaoPrecoAmazonSchema.parse(await (await post(CORPO)).json());
    expect(segunda.retomada).toBe(false);
    expect(segunda.execucaoId).toMatch(ID_LOTE_FEED_AMAZON_REGEX);
    expect(segunda.execucaoId).not.toBe(primeira.execucaoId);
    const nomes = h.chamadas.map(([, extras]) => (extras as { id: string }).id);
    expect(nomes).toHaveLength(2);
    expect(nomes[0]).not.toBe(nomes[1]);
  });

  it('★ a second click while the run is live ⇒ 409 AMAZON_PRECO_EXECUCAO_EM_CURSO with ITS id, with both headers', async () => {
    semear();
    const primeira = respostaInicioExecucaoPrecoAmazonSchema.parse(
      await (await post(CORPO)).json(),
    );
    const res = await post(CORPO);
    expect(res.status).toBe(409);
    cabecalhosOk(res);
    expect(erroPrecoAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO,
      execucaoId: primeira.execucaoId,
    });
    expect(h.chamadas).toHaveLength(1);
  });

  it('★ AMAZON_TASKS_DISABLED=1 ⇒ 503 AMAZON_PRECO_ENFILEIRAMENTO_FALHOU `fila-desligada`, ZERO Firestore writes, the SDK untouched (NEAR-MISS: unset ⇒ 202)', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    const res = await post(CORPO);
    expect(res.status).toBe(503);
    cabecalhosOk(res);
    expect(erroPrecoAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU,
      motivo: 'fila-desligada',
    });
    expect(db.escritas).toEqual([]);
    expect(h.getFunctions).not.toHaveBeenCalled();

    vi.stubEnv('AMAZON_TASKS_DISABLED', '');
    expect((await post(CORPO)).status).toBe(202);
  });

  it('★ `confirmarReducaoEmMassa` as the STRING "true" ⇒ 400 AMAZON_PRECO_CORPO_INVALIDO, nothing read', async () => {
    semear();
    const res = await post({ ...CORPO, confirmarReducaoEmMassa: 'true' });
    expect(res.status).toBe(400);
    cabecalhosOk(res);
    expect(erroPrecoAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO,
      issues: ['confirmarReducaoEmMassa'],
    });
    expect(db.operacoes).toBe(0);
  });

  it('the read switch off ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS, ZERO Firestore operations', async () => {
    semear();
    vi.stubEnv('AMAZON_CHAMADAS', 'off');
    const res = await post(CORPO);
    expect(res.status).toBe(503);
    cabecalhosOk(res);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(db.operacoes).toBe(0);
  });

  it('an unset region PROPAGATES before ANY Firestore read: nothing claimed', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_REGION', '');
    await expect(post(CORPO)).rejects.toThrow(/AMAZON_TASKS_REGION/);
    expect(db.operacoes).toBe(0);
  });
});
