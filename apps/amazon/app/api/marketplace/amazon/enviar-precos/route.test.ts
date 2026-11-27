/**
 * `POST /api/marketplace/amazon/enviar-precos` — the thin route over
 * `enviarPrecoManualAmazon` (whose ladder `envioManualPreco.test.ts` covers
 * step by step). Here: the permission, the bindings END TO END through the
 * REAL App Hosting root (`lib/firebase/filaLeitura.ts` — region, valve, the
 * jobs queue's path), the request's own reference, both headers on every
 * answer, and that nothing reaches Amazon or Firestore's write side, whatever
 * the price valve, its canary list and the preview flag say.
 *
 * Mocked: the Admin singleton (the fake db, a token verifier) and the Admin
 * SDK's `getFunctions` (a recording queue). D11: nothing reaches Amazon or
 * Cloud Tasks.
 */
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_PRECO_AMAZON,
  ID_LOTE_FEED_AMAZON_REGEX,
  INTEGRACAO_TIPO,
  envioPrecoManualAmazonSchema,
  erroPrecoAmazonSchema,
} from '@delfrance/schemas';

import {
  AmazonPrecoEnfileiramentoFalhouError,
  MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON,
} from '@/lib/amazon/preco/envioManualPreco';
import { type TarefaPrecoSkuAmazon, nomeDaTarefaPrecoAmazon } from '@/lib/amazon/preco/tarefaPreco';
import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDoFunctions,
} from '@/lib/amazon/testing/falhaDeEnfileiramento';
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
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/enviar-precos';

/** A caller who handles orders only: `PERM.pedido.write` and nothing else. */
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

const CORPO = { integracaoId: CONTA, produtoIds: ['p1'] };

function semear() {
  db.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta de teste',
    ativo: true,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
  });
  db.seed('produtos/p1', { nome: 'Produto 1', precos: { 'tab-normal': { valor: 10 } } });
  db.seed('produtos/p1/prodAmazon/l1', {
    contaAmazonOuterRef: `documents/integracao/${CONTA}`,
    sku: 'SKU-1',
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
    // What WOULD stop or shape a price write — the route must not care (the task reads it).
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
  // ★ No arm calls Amazon or writes Firestore.
  expect(chamadasFetch).toHaveLength(0);
  expect(db.escritas).toEqual([]);
  stdout.restaurar();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/marketplace/amazon/enviar-precos', () => {
  it('exports POST only, on the node runtime, never cached', async () => {
    const rota = await import('./route');
    expect(Object.keys(rota).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(rota.dynamic).toBe('force-dynamic');
    expect(rota.runtime).toBe('nodejs');
  });

  it('no Bearer token ⇒ 401, with both headers, nothing read or enqueued', async () => {
    semear();
    const res = await post(CORPO, { semAuth: true });
    expect(res.status).toBe(401);
    cabecalhosOk(res);
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
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

  it('★ 200 end to end: ONE NAMED price task onto the REGION-QUALIFIED jobs queue, identities only, the referência a fresh request id — the price valve `off` and the preview flag set change nothing here', async () => {
    semear();
    const res = await post({ ...CORPO, baixarPreco: true });
    expect(res.status).toBe(200);
    cabecalhosOk(res);
    const corpo: unknown = await res.json();
    expect(corpo).toEqual({
      listings: [
        {
          produtoId: 'p1',
          produtoNome: 'Produto 1',
          sku: 'SKU-1',
          resultado: 'enviado',
          mensagem: MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON.enfileirado,
        },
      ],
      produtosSemEnvio: [],
      pausadoAte: null,
    });
    expect(envioPrecoManualAmazonSchema.safeParse(corpo).success).toBe(true);
    expect(h.caminhos).toEqual(['locations/xx-tarefas-1/functions/processAmazonListingsJob']);
    expect(h.chamadas).toHaveLength(1);
    const [payload, extras] = h.chamadas[0] as [TarefaPrecoSkuAmazon, { id: string }];
    expect(payload).toEqual({
      v: 1,
      tipo: 'preco-sku',
      contaId: CONTA,
      sku: 'SKU-1',
      origem: 'manual',
      referencia: expect.stringMatching(ID_LOTE_FEED_AMAZON_REGEX) as unknown,
      parte: null,
      baixarPreco: true,
      solicitadoEmMs: expect.any(Number) as unknown,
      codigosAntes: [],
    });
    // NAMED by its own fields, and nothing else rides along (no delay, no uri).
    expect(extras).toEqual({ id: nomeDaTarefaPrecoAmazon(payload) });
    expect(h.getFunctions).toHaveBeenCalledWith({ name: 'app-de-teste' });
  });

  it('★ the route’s clock is the wall clock: every task’s `solicitadoEmMs` is the request’s own instant, where its consent window starts', async () => {
    semear();
    const agoraMs = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(agoraMs);
    expect((await post({ ...CORPO, baixarPreco: true })).status).toBe(200);
    const [payload] = h.chamadas[0] as [TarefaPrecoSkuAmazon];
    expect(payload.solicitadoEmMs).toBe(agoraMs);
  });

  it('★ every request mints its OWN referência: the same selection twice is two names', async () => {
    semear();
    await post(CORPO);
    await post(CORPO);
    const refs = h.chamadas.map(([t]) => (t as TarefaPrecoSkuAmazon).referencia);
    expect(refs).toHaveLength(2);
    expect(refs[0]).not.toBe(refs[1]);
  });

  it('the read switch off ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS, ZERO Firestore operations', async () => {
    semear();
    vi.stubEnv('AMAZON_CHAMADAS', '');
    const res = await post(CORPO);
    expect(res.status).toBe(503);
    cabecalhosOk(res);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('★ AMAZON_TASKS_DISABLED=1 ⇒ 200 with the rows `nao-tentado`, the SDK untouched, the region never resolved', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    vi.stubEnv('AMAZON_TASKS_REGION', '');
    const res = await post(CORPO);
    expect(res.status).toBe(200);
    cabecalhosOk(res);
    const corpo = envioPrecoManualAmazonSchema.parse(await res.json());
    expect(corpo.listings.map((l) => [l.resultado, l.mensagem])).toEqual([
      ['nao-tentado', MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON['fila-desligada']],
    ]);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('a stray key ⇒ 400 AMAZON_PRECO_CORPO_INVALIDO, with both headers, nothing read', async () => {
    semear();
    const res = await post({ ...CORPO, preco: 10 });
    expect(res.status).toBe(400);
    cabecalhosOk(res);
    expect(erroPrecoAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO,
      issues: ['preco'],
    });
    expect(db.operacoes).toBe(0);
  });

  it('a conta with no normal tabela ⇒ 400 AMAZON_PRECO_CONTA_SEM_TABELA_NORMAL, with both headers', async () => {
    semear();
    db.seed(`integracao/${CONTA}`, { tipo: INTEGRACAO_TIPO.amazon, ativo: true });
    const res = await post(CORPO);
    expect(res.status).toBe(400);
    cabecalhosOk(res);
    expect(erroPrecoAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.CONTA_SEM_TABELA_NORMAL,
    });
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('★ an unset region PROPAGATES before ANY Firestore read, after ONE ERROR line', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_REGION', '');
    await expect(post(CORPO)).rejects.toThrow(/AMAZON_TASKS_REGION/);
    expect(h.chamadas).toEqual([]);
    expect(db.operacoes).toBe(0);
    const linhas = stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        evento: 'preco',
        rota: 'enviar-precos',
        resultado: 'falhou',
        motivo: 'AMAZON_TASKS_REGION/MissingRegionError',
      }),
    ]);
  });

  it('★ a RAW SDK failure (permission-denied 403) leaves SANITIZED: nothing of the answered body reaches what the platform would print', async () => {
    semear();
    h.getFunctions.mockImplementation(() => ({
      taskQueue: () => ({
        enqueue: () => Promise.reject(falhaDoFunctions('permission-denied', 403)),
      }),
    }));
    const err: unknown = await post(CORPO).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AmazonPrecoEnfileiramentoFalhouError);
    expect(inspect(err, { depth: 5 })).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(stdout.linhas().join('\n')).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  it('the answer line goes to stdout as ONE JSON line, never carrying a SKU or a price', async () => {
    semear();
    await post(CORPO);
    const linhas = stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas).toEqual([
      expect.objectContaining({
        severity: 'INFO',
        evento: 'preco',
        rota: 'enviar-precos',
        resultado: 'enfileirado',
        enfileirados: 1,
        baixarPreco: false,
      }),
    ]);
    expect(stdout.linhas().join('\n')).not.toContain('SKU-1');
  });
});
