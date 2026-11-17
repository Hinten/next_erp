import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ESTADO_NFE } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../lib/amazon/core/contaCache';
import { tarefaInicialNfeAmazon } from '../../lib/amazon/nfe/tarefaNfe';
import { makePedidoIdAmazon } from '../../lib/amazon/pedidos/orderIds';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import { AGORA_MS, espiarStdout } from '../../lib/amazon/testing/fixtures';

/**
 * The NF-e queue's BODY (step 14, PR 14-c): what the function binds (the live
 * environment, the app's ONE logger, the functions root's producer), the ONE
 * `evento: 'nfe'` dispatch line per run that returns, and the sanitizing
 * boundary of a throw. The declared options live in `index.test.ts`; the P0–P12
 * ladder in `lib/amazon/nfe/processarNfe.test.ts`. No network is reachable
 * (D11): every `fetch` is refused and counted.
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

const { processAmazonNfeUpload, depsDoEnvioNfeAmazon } = await import('./filaNfe');
const { criarAgendadorNfeAmazonDoAmbiente } = await import('./agendadorNfe');
const { criarAgendadorAgendamentoAmazonDoAmbiente } = await import('./agendadorAgendamento');

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
  return (processAmazonNfeUpload as unknown as { run(r: Requisicao): Promise<void> }).run(req);
}

const CONTA = 'conta-amz-fila-nfe';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const XML =
  '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide>' +
  '</infNFe></NFe></nfeProc>';

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
  vi.stubEnv('AMAZON_MODO_NFE', undefined);
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

describe('processAmazonNfeUpload — the body', () => {
  it('binds the LIVE environment, the app logger and the functions roots’ producers (the NF-e queue; the scheduling queue for E1)', () => {
    const deps = depsDoEnvioNfeAmazon({ tentativa: 2, idTarefa: 't' });
    expect(deps.ambiente).toBe(process.env);
    expect(deps.agendador).toBe(criarAgendadorNfeAmazonDoAmbiente);
    // Step 15 (PR 15-c): the seam's producer is the scheduling ROOT, never the NF-e one.
    expect(deps.agendamento).toBe(criarAgendadorAgendamentoAmazonDoAmbiente);
    expect(deps.agendamento).not.toBe(criarAgendadorNfeAmazonDoAmbiente);
    expect(deps.registro).toEqual({ tentativa: 2, idTarefa: 't' });
    expect(deps.fetch).toBeUndefined();
  });

  it('ONE dispatch line per run: an invalid payload is a WARNING naming the queue, the attempt and the task id', async () => {
    await rodar({ data: { qualquer: 1 }, retryCount: 1, id: 'tarefa-nfe-1' });
    const doDespacho = linhas().filter((l) => l.fila === 'processAmazonNfeUpload');
    expect(doDespacho).toEqual([
      expect.objectContaining({
        evento: 'nfe',
        severity: 'WARNING',
        acao: 'payload-invalido',
        fluxo: 'nfe',
        tentativa: 1,
        idTarefa: 'tarefa-nfe-1',
      }),
    ]);
    expect(fake.operacoes).toBe(0);
  });

  it('★ a valid payload under the valve off stops at P6 with the aviso — the valve line, then ONE dispatch line', async () => {
    fake.seed(`pedidos/${PEDIDO_ID}`, {
      numero: ORDER,
      integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
      estado: 'pago',
    });
    fake.seed(`pedidos/${PEDIDO_ID}/nfev4/s1`, { estado: ESTADO_NFE.aprovada, xml_nfe_proc: XML });
    await rodar({ data: tarefaInicialNfeAmazon(PEDIDO_ID, 's1'), retryCount: 0, id: 't-1' });
    const eventos = linhas().map((l) => l.evento);
    expect(eventos).toEqual(['valvula', 'nfe']);
    expect(linhas().at(-1)).toMatchObject({
      acao: 'avisado',
      motivo: 'envio-nao-ligado',
      conta: CONTA,
      pedido: ORDER,
    });
  });

  it('a throw leaves SANITIZED through the app’s boundary (a Firestore error stays itself)', async () => {
    fake.falharLeitura(
      `pedidos/${PEDIDO_ID}/nfev4/s1`,
      Object.assign(new Error('x'), { code: 14 }),
    );
    await expect(
      rodar({ data: tarefaInicialNfeAmazon(PEDIDO_ID, 's1'), retryCount: 0 }),
    ).rejects.toMatchObject({ code: 14 });
    expect(linhas().filter((l) => l.evento === 'nfe')).toEqual([]);
  });
});
