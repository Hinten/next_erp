import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { AmazonHttpError } from '@delfrance/integrations-amazon-sp-api';

import { __setRelogioDoCacheParaTestes } from '../../lib/amazon/core/contaCache';
import { loadAmazonContext } from '../../lib/amazon/core/contexto';
import { FalhaTarefaAmazonError } from '../../lib/amazon/notificacoes/notificacao';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import { espiarStdout } from '../../lib/amazon/testing/fixtures';

/**
 * The stock queue's BODY (step 12, PR 12-e1): what the function binds (the
 * codebase's Firestore handle, the live environment, the app's ONE logger, the
 * context loader, the stock root's producer), the ONE `evento: 'estoque'`
 * dispatch line per run — written by the body, never by this root — and the
 * sanitizing boundary of a throw. The declared options live in
 * `index.test.ts`; the P0–P10 ladder in
 * `lib/amazon/estoque/processarEstoque.test.ts`. No network is reachable (D11):
 * every `fetch` is refused and counted.
 */
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA = '1-compute@developer.gserviceaccount.com';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));

// The body runs REAL (spied through): the spy only records what the root bound,
// and lets one case hand the root a throw only a package error could make.
vi.mock('../../lib/amazon/estoque/processarEstoque', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/amazon/estoque/processarEstoque')>();
  return { ...real, processarEstoqueAmazon: vi.fn(real.processarEstoqueAmazon) };
});

const { processAmazonStockPatch, depsDoEstoqueAmazon, SEGREDOS_DO_ESTOQUE_AMAZON } =
  await import('./filaEstoque');
const { criarAgendadorLotesAmazonDoAmbiente, criarProdutorEstoqueAmazonDoAmbiente } =
  await import('./agendadorEstoque');
const corpo = await import('../../lib/amazon/estoque/processarEstoque');

afterAll(() => {
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

interface Requisicao {
  data: unknown;
  retryCount?: number;
  id?: string;
}

function rodar(req: Requisicao): Promise<void> {
  return (processAmazonStockPatch as unknown as { run(r: Requisicao): Promise<void> }).run(req);
}

const CONTA = 'conta-amz-fila-estoque';
const TAREFA = {
  v: 1,
  contaId: CONTA,
  sku: 'SKU-TESTE-1',
  origem: 'delta',
  referencia: '1700000000.000000001',
  depositoId: null,
} as const;

let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  fake = new FakeDb();
  h.db = asDb(fake);
  stdout = espiarStdout();
  __resetAllReadCaches();
  vi.mocked(corpo.processarEstoqueAmazon).mockClear();
  vi.stubEnv('AMAZON_CHAMADAS', undefined);
  vi.stubEnv('AMAZON_MODO_ESTOQUE', undefined);
  vi.stubEnv('AMAZON_CANARIO_ESTOQUE', undefined);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  stdout.restaurar();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

function linhas(): Record<string, unknown>[] {
  return stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
}

const doDespacho = () => linhas().filter((l) => l.fila === 'processAmazonStockPatch');

describe('processAmazonStockPatch — the body', () => {
  it('binds the Firestore handle, the LIVE environment, the context loader and the STOCK root’s producer (never the jobs one)', () => {
    const deps = depsDoEstoqueAmazon({ tentativa: 2, idTarefa: 't' });
    expect(deps.db).toBe(h.db);
    expect(deps.ambiente).toBe(process.env);
    expect(deps.carregarContexto).toBe(loadAmazonContext);
    expect(deps.produtor).toBe(criarProdutorEstoqueAmazonDoAmbiente);
    expect(deps.produtor).not.toBe(criarAgendadorLotesAmazonDoAmbiente);
    expect(deps.registro).toEqual({ tentativa: 2, idTarefa: 't' });
    // No test seam in production: the context and the engine keep their own transport.
    expect(deps.fetch).toBeUndefined();
    // The clock's UNIT is fixed here, for every stored `emMs` and the budget:
    // milliseconds, the wall clock's own (never µs, never s).
    const antes = Date.now();
    const agora = deps.agora();
    const depois = Date.now();
    expect(agora).toBeGreaterThanOrEqual(antes);
    expect(agora).toBeLessThanOrEqual(depois);
    expect(SEGREDOS_DO_ESTOQUE_AMAZON).toEqual(['AMAZON_LWA_CLIENT_SECRET']);
  });

  it('hands the body the request’s attempt and task id, and the payload untouched', async () => {
    await rodar({ data: TAREFA, retryCount: 3, id: 'tarefa-estoque-9' });
    const [dados, deps] = vi.mocked(corpo.processarEstoqueAmazon).mock.calls[0] ?? [];
    expect(dados).toBe(TAREFA);
    expect(deps?.registro).toEqual({ tentativa: 3, idTarefa: 'tarefa-estoque-9' });
    expect(deps?.db).toBe(h.db);
  });

  it('ONE dispatch line per run: an invalid payload is a WARNING naming the queue, the attempt and the task id — nothing read', async () => {
    await rodar({ data: { ...TAREFA, quantidade: 3 }, retryCount: 1, id: 'tarefa-estoque-1' });
    expect(doDespacho()).toEqual([
      expect.objectContaining({
        evento: 'estoque',
        severity: 'WARNING',
        acao: 'payload-invalido',
        fluxo: 'estoque',
        tentativa: 1,
        idTarefa: 'tarefa-estoque-1',
      }),
    ]);
    expect(linhas()).toHaveLength(1);
    expect(fake.operacoes).toBe(0);
  });

  it('★ a valid payload under the stock valve OFF (every environment until the window): the valve line, then ONE dispatch line — ZERO Firestore operations', async () => {
    await rodar({ data: TAREFA, retryCount: 0, id: 't-1' });
    expect(linhas().map((l) => l.evento)).toEqual(['valvula', 'estoque']);
    expect(doDespacho()).toEqual([
      expect.objectContaining({
        severity: 'INFO',
        acao: 'encerrado',
        motivo: 'desligado',
        conta: CONTA,
        sku: 'SKU-TESTE-1',
        origem: 'delta',
      }),
    ]);
    expect(fake.operacoes).toBe(0);
  });

  it('with the valve on but the READ SWITCH off: the context refuses — ONE WARNING dispatch line, no Amazon call, no write', async () => {
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'on');
    vi.stubEnv('AMAZON_CANARIO_ESTOQUE', '*');
    await rodar({ data: TAREFA, retryCount: 0, id: 't-2' });
    expect(doDespacho()).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        acao: 'encerrado',
        motivo: 'desligado',
        falha: 'chamadas-desligadas',
      }),
    ]);
    expect(fake.escritas).toEqual([]);
  });

  it('★ a package error that reaches the function leaves SANITIZED through the app’s boundary, and the root writes no line of its own (NEAR-MISS: a Firestore error stays itself)', async () => {
    const erro = new AmazonHttpError({
      destino: 'sp-api',
      operacao: 'patchListingsItem',
      metodo: 'PATCH',
      caminho: '/listings/2021-08-01/items/x/y',
      correlationId: 'corr-teste',
      requestIdAmazon: null,
      refCredencial: 'ref-teste',
      status: 400,
    });
    vi.mocked(corpo.processarEstoqueAmazon).mockRejectedValueOnce(erro);
    const sanitizado = await rodar({ data: TAREFA }).catch((e: unknown) => e);
    expect(sanitizado).toBeInstanceOf(FalhaTarefaAmazonError);
    expect(sanitizado).not.toBe(erro);
    expect(linhas()).toEqual([]);

    const grpc = Object.assign(new Error('x'), { code: 14 });
    vi.mocked(corpo.processarEstoqueAmazon).mockRejectedValueOnce(grpc);
    await expect(rodar({ data: TAREFA })).rejects.toBe(grpc);
    expect(linhas()).toEqual([]);
  });
});
