/**
 * `POST /api/marketplace/amazon/enviar-nfe` — the thin route over
 * `reenviarNfeAmazon` (whose ladder `reenvioNfe.test.ts` covers rung by rung).
 * Here: the permission, the bindings END TO END through the REAL App Hosting
 * root (`lib/firebase/filaLeitura.ts` — region, valve, path), both headers on
 * every answer, and that nothing reaches Amazon or Firestore's write side.
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
  CODIGO_ERRO_NFE_AMAZON,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  erroEnvioNfeAmazonSchema,
  respostaEnvioNfeAmazonSchema,
} from '@delfrance/schemas';

import { AmazonTarefasTransitoriasError } from '@/lib/amazon/core/filaTarefas';
import { AmazonNfeEnfileiramentoFalhouError } from '@/lib/amazon/nfe/reenvioNfe';
import { tarefaInicialNfeAmazon } from '@/lib/amazon/nfe/tarefaNfe';
import { makePedidoIdAmazon } from '@/lib/amazon/pedidos/orderIds';
import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDoFunctions,
} from '@/lib/amazon/testing/falhaDeEnfileiramento';
import { ESCRITOR, espiaoDeFetch, espiarStdout, stubAmbiente } from '@/lib/amazon/testing/fixtures';

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
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/enviar-nfe';

/** A caller who handles orders: `PERM.pedido.write` and nothing else. */
const EXPEDICAO = { uid: 'u-expedicao', permissions: PERM.pedido.write.toString() };

const PROC =
  '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide>' +
  '</infNFe></NFe></nfeProc>';

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

function semear() {
  db.seed(`pedidos/${PEDIDO_ID}`, {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: ESTADO_PEDIDO.pago,
  });
  db.seed(`pedidos/${PEDIDO_ID}/nfev4/s1`, { estado: ESTADO_NFE.aprovada, xml_nfe_proc: PROC });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db = new FakeDb();
  h.db = asDb(db);
  h.caminhos.length = 0;
  h.chamadas.length = 0;
  h.verifyIdToken.mockResolvedValue(EXPEDICAO);
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
    // What WOULD stop a submit — the route must not care (the task reads it).
    AMAZON_MODO_NFE: 'off',
    AMAZON_CANARIO_NFE: '',
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

describe('POST /api/marketplace/amazon/enviar-nfe', () => {
  it('exports POST only, on the node runtime, never cached', async () => {
    const rota = await import('./route');
    expect(Object.keys(rota).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(rota.dynamic).toBe('force-dynamic');
    expect(rota.runtime).toBe('nodejs');
  });

  it('no Bearer token ⇒ 401, with both headers, nothing read or enqueued', async () => {
    semear();
    const res = await post({ pedidoId: PEDIDO_ID }, { semAuth: true });
    expect(res.status).toBe(401);
    cabecalhosOk(res);
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('★ PERM.pedido.write is required: the conta routes’ integracao writer ⇒ 403, nothing read', async () => {
    semear();
    h.verifyIdToken.mockResolvedValue(ESCRITOR);
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(403);
    cabecalhosOk(res);
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('★ 202 end to end: ONE unnamed enqueue onto the REGION-QUALIFIED NF-e queue, the payload ALONE', async () => {
    semear();
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(202);
    cabecalhosOk(res);
    // ★ The RAW body, EXACTLY these keys (the schema strips unknown ones), then the contract.
    const corpo: unknown = await res.json();
    expect(corpo).toEqual({ enfileirado: true, pedidoId: PEDIDO_ID, nfeId: 's1' });
    expect(respostaEnvioNfeAmazonSchema.safeParse(corpo).success).toBe(true);
    expect(h.caminhos).toEqual(['locations/xx-tarefas-1/functions/processAmazonNfeUpload']);
    // No second argument: no task id, no delay.
    expect(h.chamadas).toEqual([[tarefaInicialNfeAmazon(PEDIDO_ID, 's1')]]);
    expect(h.getFunctions).toHaveBeenCalledWith({ name: 'app-de-teste' });
  });

  it('the read switch off ⇒ 503 AMAZON_CHAMADAS_DESLIGADAS, ZERO Firestore operations', async () => {
    semear();
    vi.stubEnv('AMAZON_CHAMADAS', '');
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(503);
    cabecalhosOk(res);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('★ AMAZON_TASKS_DISABLED=1 ⇒ 503 AMAZON_TAREFAS_DESLIGADAS, ZERO Firestore operations, the SDK untouched', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(503);
    cabecalhosOk(res);
    expect(erroEnvioNfeAmazonSchema.parse(await res.json()).code).toBe(
      CODIGO_ERRO_NFE_AMAZON.TAREFAS_DESLIGADAS,
    );
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
  });

  it('a `fase` in the body ⇒ 400 AMAZON_CORPO_INVALIDO, with both headers', async () => {
    semear();
    const res = await post({ pedidoId: PEDIDO_ID, fase: 'verificacao' });
    expect(res.status).toBe(400);
    cabecalhosOk(res);
    expect(await res.json()).toMatchObject({
      code: CODIGO_ERRO_NFE_AMAZON.CORPO_INVALIDO,
      issues: ['fase'],
    });
    expect(db.operacoes).toBe(0);
  });

  it('a 409 carries its motivo through the envelope', async () => {
    db.seed(`pedidos/${PEDIDO_ID}`, { numero: ORDER, integracaoPedidoOuterRef: null });
    const res = await post({ pedidoId: PEDIDO_ID });
    expect(res.status).toBe(409);
    cabecalhosOk(res);
    expect(erroEnvioNfeAmazonSchema.parse(await res.json())).toMatchObject({
      code: CODIGO_ERRO_NFE_AMAZON.NFE_NAO_ELEGIVEL,
      motivo: 'nao-amazon',
    });
  });

  it('★ a Cloud Tasks transient PROPAGATES (the platform’s 500: the outcome is unknown, no code is invented)', async () => {
    semear();
    h.getFunctions.mockImplementation(() => ({
      taskQueue: () => ({ enqueue: () => Promise.reject(falhaDoFunctions('unavailable', 503)) }),
    }));
    await expect(post({ pedidoId: PEDIDO_ID })).rejects.toBeInstanceOf(
      AmazonTarefasTransitoriasError,
    );
  });

  it('★ an unset region PROPAGATES before ANY Firestore read (a broken deploy, never a silent drop), after ONE ERROR line', async () => {
    semear();
    vi.stubEnv('AMAZON_TASKS_REGION', '');
    await expect(post({ pedidoId: PEDIDO_ID })).rejects.toThrow(/AMAZON_TASKS_REGION/);
    expect(h.chamadas).toEqual([]);
    expect(db.operacoes).toBe(0);
    expect(h.getFunctions).not.toHaveBeenCalled();
    const linhas = stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        evento: 'nfe',
        rota: 'enviar-nfe',
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
    const err: unknown = await post({ pedidoId: PEDIDO_ID }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AmazonNfeEnfileiramentoFalhouError);
    // What a platform logger prints of a thrown error: its inspection, own properties included.
    expect(inspect(err, { depth: 5 })).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(stdout.linhas().join('\n')).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });
});
