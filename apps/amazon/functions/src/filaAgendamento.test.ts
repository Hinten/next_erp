import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { AmazonHttpError } from '@delfrance/integrations-amazon-sp-api';
import { ESTADO_FRETE, ESTADO_PEDIDO } from '@delfrance/schemas';

import {
  ORIGEM_AGENDAMENTO_AMAZON,
  tarefaInicialAgendamentoAmazon,
} from '../../lib/amazon/agendamento/tarefaAgendamento';
import { __setRelogioDoCacheParaTestes } from '../../lib/amazon/core/contaCache';
import { FalhaTarefaAmazonError } from '../../lib/amazon/notificacoes/notificacao';
import { makePedidoIdAmazon } from '../../lib/amazon/pedidos/orderIds';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import { AGORA_MS, espiarStdout } from '../../lib/amazon/testing/fixtures';

/**
 * The Easy Ship scheduling queue's BODY (step 15, PR 15-c): what the function
 * binds (the live environment, the app's ONE logger, the functions scheduling
 * root's producer), the ONE `evento: 'agendamento'` dispatch line per run that
 * returns, and the sanitizing boundary of a throw. The declared options live in
 * `index.test.ts`; the A0–A9 ladder in
 * `lib/amazon/agendamento/processarAgendamento.test.ts`. No network is
 * reachable (D11): every `fetch` is refused and counted.
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

const { processAmazonEasyShipSchedule, depsDoAgendamentoAmazon } =
  await import('./filaAgendamento');
const { criarAgendadorAgendamentoAmazonDoAmbiente } = await import('./agendadorAgendamento');
const { criarAgendadorNfeAmazonDoAmbiente } = await import('./agendadorNfe');

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
  return (processAmazonEasyShipSchedule as unknown as { run(r: Requisicao): Promise<void> }).run(
    req,
  );
}

const CONTA = 'conta-amz-fila-agendamento';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const TAREFA = tarefaInicialAgendamentoAmazon(
  PEDIDO_ID,
  CONTA,
  ORDER,
  ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe,
);

let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  fake = new FakeDb();
  h.db = asDb(fake);
  stdout = espiarStdout();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubEnv('AMAZON_CHAMADAS', undefined);
  vi.stubEnv('AMAZON_MODO_AGENDAMENTO', undefined);
  vi.stubEnv('AMAZON_CANARIO_AGENDAMENTO', undefined);
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

/** The pedido as the importer wrote it: proved, paid, DBA, freight `amz` waiting to be scheduled. */
function seedPedido(): void {
  fake.seed(`pedidos/${PEDIDO_ID}`, {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: ESTADO_PEDIDO.pago,
    marketplace: { tipo: 'amazon', fulfilledBy: 'MERCHANT', programs: ['DELIVERY_BY_AMAZON'] },
    freteInicial: {
      externalOptionIntegracao: 'amz',
      estado: ESTADO_FRETE.aguardandoAgendamento,
    },
  });
}

describe('processAmazonEasyShipSchedule — the body', () => {
  it('binds the LIVE environment, the app logger and the functions SCHEDULING root’s producer (never the NF-e one)', () => {
    const deps = depsDoAgendamentoAmazon({ tentativa: 2, idTarefa: 't' });
    expect(deps.ambiente).toBe(process.env);
    expect(deps.agendamento).toBe(criarAgendadorAgendamentoAmazonDoAmbiente);
    expect(deps.agendamento).not.toBe(criarAgendadorNfeAmazonDoAmbiente);
    expect(deps.registro).toEqual({ tentativa: 2, idTarefa: 't' });
    expect(deps.fetch).toBeUndefined();
    expect(deps.agora()).toBeGreaterThan(0);
  });

  it('ONE dispatch line per run: an invalid payload is a WARNING naming the queue, the attempt and the task id', async () => {
    await rodar({ data: { qualquer: 1 }, retryCount: 1, id: 'tarefa-agendamento-1' });
    const doDespacho = linhas().filter((l) => l.fila === 'processAmazonEasyShipSchedule');
    expect(doDespacho).toEqual([
      expect.objectContaining({
        evento: 'agendamento',
        severity: 'WARNING',
        acao: 'payload-invalido',
        fluxo: 'agendamento',
        tentativa: 1,
        idTarefa: 'tarefa-agendamento-1',
      }),
    ]);
    expect(linhas()).toHaveLength(1);
    expect(fake.operacoes).toBe(0);
  });

  it('★ a valid payload under the scheduling valve OFF (every environment until the window): the valve line, then ONE dispatch line — ZERO Firestore operations', async () => {
    await rodar({ data: TAREFA, retryCount: 0, id: 't-1' });
    expect(linhas().map((l) => l.evento)).toEqual(['valvula', 'agendamento']);
    expect(linhas().at(-1)).toMatchObject({
      severity: 'INFO',
      acao: 'descartado',
      motivo: 'agendamento-desligado',
      conta: CONTA,
      pedido: ORDER,
      origem: 'aceite-nfe',
    });
    expect(fake.operacoes).toBe(0);
  });

  it('with the valve on but the READ SWITCH off: the pedido is read, the context refuses — ONE WARNING dispatch line, no Amazon call, no write', async () => {
    vi.stubEnv('AMAZON_MODO_AGENDAMENTO', 'on');
    vi.stubEnv('AMAZON_CANARIO_AGENDAMENTO', '*');
    seedPedido();
    await rodar({ data: TAREFA, retryCount: 0, id: 't-2' });
    const despacho = linhas().filter((l) => l.fila === 'processAmazonEasyShipSchedule');
    expect(despacho).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        acao: 'descartado',
        motivo: 'chamadas-desligadas',
      }),
    ]);
    expect(fake.escritas).toEqual([]);
  });

  it('★ a package error that reaches the function leaves SANITIZED through the app’s boundary, and writes no dispatch line (NEAR-MISS: a Firestore error stays itself)', async () => {
    vi.stubEnv('AMAZON_MODO_AGENDAMENTO', 'dry-run');
    // A3 rethrows anything that is not a gRPC error raw: only the function can sanitize this one.
    fake.falharLeitura(
      `pedidos/${PEDIDO_ID}`,
      new AmazonHttpError({
        destino: 'sp-api',
        operacao: 'getOrder',
        metodo: 'GET',
        caminho: '/orders/2026-01-01/orders/x',
        correlationId: 'corr-teste',
        requestIdAmazon: null,
        refCredencial: 'ref-teste',
        status: 400,
      }),
    );
    await expect(rodar({ data: TAREFA, retryCount: 0 })).rejects.toBeInstanceOf(
      FalhaTarefaAmazonError,
    );
    expect(linhas().filter((l) => l.evento === 'agendamento')).toEqual([]);

    fake.falharLeitura(`pedidos/${PEDIDO_ID}`, Object.assign(new Error('x'), { code: 14 }));
    await expect(rodar({ data: TAREFA, retryCount: 0 })).rejects.toMatchObject({ code: 14 });
    expect(linhas().filter((l) => l.evento === 'agendamento')).toEqual([]);
  });
});
