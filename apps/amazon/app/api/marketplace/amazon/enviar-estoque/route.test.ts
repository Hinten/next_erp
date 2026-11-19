/**
 * `POST /api/marketplace/amazon/enviar-estoque` — the thin route over
 * `enviarEstoqueManualAmazon` (whose ladder `envioManualEstoque.test.ts` covers
 * rung by rung). Here: the permission, the bindings END TO END through the REAL
 * App Hosting root (`lib/firebase/filaLeitura.ts` — region, valve, path), the
 * request's own reference, both headers on every answer, and that nothing
 * reaches Amazon or Firestore's write side.
 *
 * Mocked: the Admin singleton (the fake db, a token verifier) and the Admin
 * SDK's `getFunctions` (a recording queue). D11: nothing reaches Amazon or
 * Cloud Tasks.
 */
import { inspect } from 'node:util';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ESTOQUE_AMAZON,
  ID_LOTE_FEED_AMAZON_REGEX,
  INTEGRACAO_TIPO,
  envioEstoqueManualAmazonSchema,
  erroEnvioEstoqueManualAmazonSchema,
} from '@delfrance/schemas';

import { AmazonTarefasTransitoriasError } from '@/lib/amazon/core/filaTarefas';
import {
  AmazonEstoqueEnfileiramentoFalhouError,
  MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON,
} from '@/lib/amazon/estoque/envioManualEstoque';
import { type TarefaEstoqueAmazon, nomeDaTarefaEstoque } from '@/lib/amazon/estoque/tarefaEstoque';
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
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/enviar-estoque';

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
    depositoOuterRef: 'documents/depositos/dep-1',
  });
  db.seed('produtos/p1', { nome: 'Produto 1' });
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
    // What WOULD stop a write — the route must not care (the task reads it).
    AMAZON_MODO_ESTOQUE: 'off',
    AMAZON_CANARIO_ESTOQUE: '',
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

describe('POST /api/marketplace/amazon/enviar-estoque', () => {
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
    ['★ a caller with PERM.pedido.write alone (the NF-e re-drive’s bit)', EXPEDICAO],
  ])('PERM.integracao.write is required: %s ⇒ 403, nothing read', async (_nome, quem) => {
    semear();
    h.verifyIdToken.mockResolvedValue(quem);
    const res = await post(CORPO);
    expect(res.status).toBe(403);
    cabecalhosOk(res);
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('★ 200 end to end: ONE NAMED task onto the REGION-QUALIFIED stock queue, the payload identities only, the referência a fresh request id', async () => {
    semear();
    const res = await post(CORPO);
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
          mensagem: MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON.enfileirado,
        },
      ],
      produtosSemEnvio: [],
      pausadoAte: null,
    });
    expect(envioEstoqueManualAmazonSchema.safeParse(corpo).success).toBe(true);
    expect(h.caminhos).toEqual(['locations/xx-tarefas-1/functions/processAmazonStockPatch']);
    expect(h.chamadas).toHaveLength(1);
    const [payload, extras] = h.chamadas[0] as [TarefaEstoqueAmazon, { id: string }];
    expect(payload).toEqual({
      v: 1,
      contaId: CONTA,
      sku: 'SKU-1',
      origem: 'manual',
      referencia: expect.stringMatching(ID_LOTE_FEED_AMAZON_REGEX) as unknown,
      depositoId: null,
    });
    // NAMED by its own fields, and nothing else rides along (no delay, no uri).
    expect(extras).toEqual({ id: nomeDaTarefaEstoque(payload) });
    expect(h.getFunctions).toHaveBeenCalledWith({ name: 'app-de-teste' });
  });

  it.each([
    ['reads that take the whole budget', 40_000, 'nao-tentado'],
    ['NEAR-MISS: reads one ms short of it', 39_999, 'enviado'],
  ] as const)(
    '★ the 40-s budget runs on the WALL clock from the request’s start: %s',
    async (_nome, gastoMs, esperado) => {
      semear();
      let agora = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => agora);
      const real = h.db as Firestore;
      // The produto read is what moves the clock: never how often it is asked.
      h.db = new Proxy(real, {
        get(alvo, chave) {
          const v = Reflect.get(alvo, chave) as unknown;
          if (typeof v !== 'function') return v;
          const metodo = v as (...a: unknown[]) => unknown;
          if (chave !== 'getAll') return (...args: unknown[]) => metodo.apply(alvo, args);
          return async (...args: unknown[]) => {
            const saida = await (metodo.apply(alvo, args) as Promise<unknown>);
            if ((args[0] as { readonly path?: unknown }).path === 'produtos/p1') agora += gastoMs;
            return saida;
          };
        },
      });
      const res = await post(CORPO);
      expect(res.status).toBe(200);
      const corpo = envioEstoqueManualAmazonSchema.parse(await res.json());
      expect(corpo.listings.map((l) => l.resultado)).toEqual([esperado]);
      expect(h.chamadas).toHaveLength(esperado === 'enviado' ? 1 : 0);
    },
  );

  it('★ every request mints its OWN referência: the same selection twice is two names', async () => {
    semear();
    await post(CORPO);
    await post(CORPO);
    const refs = h.chamadas.map(([t]) => (t as TarefaEstoqueAmazon).referencia);
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

  it('★ AMAZON_TASKS_DISABLED=1 ⇒ 200 with the rows `nao-tentado`, the SDK untouched', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    const res = await post(CORPO);
    expect(res.status).toBe(200);
    cabecalhosOk(res);
    const corpo = envioEstoqueManualAmazonSchema.parse(await res.json());
    expect(corpo.listings.map((l) => [l.resultado, l.mensagem])).toEqual([
      ['nao-tentado', MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON['fila-desligada']],
    ]);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('the valve CLOSED with no region set ⇒ still 200 `nao-tentado`: the root’s valve is what the body reads, so the region is never resolved', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    vi.stubEnv('AMAZON_TASKS_REGION', '');
    const res = await post(CORPO);
    expect(res.status).toBe(200);
    const corpo = envioEstoqueManualAmazonSchema.parse(await res.json());
    expect(corpo.listings.map((l) => l.resultado)).toEqual(['nao-tentado']);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('a stray key ⇒ 400 AMAZON_ESTOQUE_CORPO_INVALIDO, with both headers, nothing read', async () => {
    semear();
    const res = await post({ ...CORPO, reenviarComErro: true });
    expect(res.status).toBe(400);
    cabecalhosOk(res);
    expect(erroEnvioEstoqueManualAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_ESTOQUE_AMAZON.CORPO_INVALIDO,
      issues: ['reenviarComErro'],
    });
    expect(db.operacoes).toBe(0);
  });

  it('a limit refusal carries its `detalhes` through the envelope', async () => {
    semear();
    const res = await post({
      integracaoId: CONTA,
      produtoIds: Array.from({ length: 51 }, (_, i) => `p${String(i)}`),
    });
    expect(res.status).toBe(400);
    cabecalhosOk(res);
    expect(erroEnvioEstoqueManualAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_ESTOQUE_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { limite: 50, unidade: 'produtos', encontrados: 51 },
    });
  });

  it('★ a Cloud Tasks transient PROPAGATES (the platform’s 500: part of the batch may have landed)', async () => {
    semear();
    h.getFunctions.mockImplementation(() => ({
      taskQueue: () => ({ enqueue: () => Promise.reject(falhaDoFunctions('unavailable', 503)) }),
    }));
    await expect(post(CORPO)).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('★ an unset region PROPAGATES before ANY Firestore read, after ONE ERROR line', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_REGION', '');
    await expect(post(CORPO)).rejects.toThrow(/AMAZON_TASKS_REGION/);
    expect(h.chamadas).toEqual([]);
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
    const linhas = stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        evento: 'estoque',
        rota: 'enviar-estoque',
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
    expect(err).toBeInstanceOf(AmazonEstoqueEnfileiramentoFalhouError);
    expect(inspect(err, { depth: 5 })).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(stdout.linhas().join('\n')).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  it('the answer line goes to stdout as ONE JSON line, never carrying a SKU', async () => {
    semear();
    await post(CORPO);
    const linhas = stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas).toEqual([
      expect.objectContaining({
        severity: 'INFO',
        evento: 'estoque',
        rota: 'enviar-estoque',
        resultado: 'enfileirado',
        enfileirados: 1,
      }),
    ]);
    expect(stdout.linhas().join('\n')).not.toContain('SKU-1');
  });
});
