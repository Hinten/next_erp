import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';

import { makePedidoIdAmazon } from '../../lib/amazon/pedidos/orderIds';
import { falhaDeTarefaJaExistente } from '../../lib/amazon/testing/falhaDeEnfileiramento';

/**
 * The functions codebase's COMPOSITION ROOT of the Easy Ship scheduling queue's
 * producer (step 15, PR 15-c): what it reads from the environment (the valve,
 * the region) and what it hands the Admin SDK (the region-qualified queue path,
 * the payload, an entry's task name).
 *
 * Mocked: only the transport seams — `getFunctions` and the admin app. The SDK's
 * error CLASSES stay real (the pure producer narrows on them). No network is
 * reachable: the queue is a recording fake.
 */
const h = vi.hoisted(() => ({
  enqueue: vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve()),
  taskQueue: vi.fn(),
  getFunctions: vi.fn(),
}));

vi.mock('firebase-admin/functions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase-admin/functions')>()),
  getFunctions: (...args: unknown[]) => {
    h.getFunctions(...args);
    return { taskQueue: h.taskQueue };
  },
}));

const APP = vi.hoisted(() => ({ __app: 'admin' }));
vi.mock('./lib/admin', () => ({ getAdminApp: () => APP }));

const {
  criarAgendadorAgendamentoAmazonDoAmbiente,
  regiaoDaFilaAgendamentoAmazon,
  tarefasAgendamentoAmazonDesligadas,
} = await import('./agendadorAgendamento');
const { AmazonAgendamentoTarefasDesligadasError } =
  await import('../../lib/amazon/agendamento/agendadorAgendamento');
const { ORIGEM_AGENDAMENTO_AMAZON, idDaTarefaDeAgendamentoAmazon, tarefaInicialAgendamentoAmazon } =
  await import('../../lib/amazon/agendamento/tarefaAgendamento');

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const TAREFA = tarefaInicialAgendamentoAmazon(
  PEDIDO_ID,
  CONTA,
  ORDER,
  ORIGEM_AGENDAMENTO_AMAZON.importacao,
);
const OBSERVACAO = {
  origem: ORIGEM_AGENDAMENTO_AMAZON.importacao,
  pedidoId: PEDIDO_ID,
  watermarkUs: 1_790_000_000_000_000,
};

const chamadasDeRede: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  h.enqueue.mockImplementation(() => Promise.resolve());
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** A clean environment for one case: only what the case sets. */
function ambiente(o: { tasksRegion?: string; functionsRegion?: string; desligado?: string }): void {
  vi.stubEnv('AMAZON_TASKS_REGION', o.tasksRegion);
  vi.stubEnv('FUNCTIONS_REGION', o.functionsRegion);
  vi.stubEnv('AMAZON_TASKS_DISABLED', o.desligado);
}

describe('the queue path', () => {
  it('enqueues onto locations/<region>/functions/processAmazonEasyShipSchedule, on the admin app', async () => {
    ambiente({ tasksRegion: 'xx-regiao1', functionsRegion: 'xx-regiao1' });

    await criarAgendadorAgendamentoAmazonDoAmbiente().enfileirar(TAREFA);

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(
      'locations/xx-regiao1/functions/processAmazonEasyShipSchedule',
    );
    // NEVER another queue: a separate root binds a separate queue.
    expect(h.taskQueue).not.toHaveBeenCalledWith(expect.stringContaining('processAmazonNfeUpload'));
    expect(h.taskQueue).not.toHaveBeenCalledWith(expect.stringContaining('filaLeituraAmazon'));
  });

  it('an entry’s enqueue carries the observation’s name; a re-enqueue carries none', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });
    const agendador = criarAgendadorAgendamentoAmazonDoAmbiente();

    expect(await agendador.enfileirarEntrada(TAREFA, OBSERVACAO)).toBe('enfileirada');
    await agendador.enfileirar(TAREFA);

    expect(h.enqueue.mock.calls).toEqual([
      [TAREFA, { id: idDaTarefaDeAgendamentoAmazon(OBSERVACAO) }],
      [TAREFA],
    ]);
  });

  it('the SDK’s own 409 for a held name reads ja-enfileirada through the root', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });
    h.enqueue.mockImplementationOnce(() => Promise.reject(falhaDeTarefaJaExistente('x')));

    expect(
      await criarAgendadorAgendamentoAmazonDoAmbiente().enfileirarEntrada(TAREFA, OBSERVACAO),
    ).toBe('ja-enfileirada');
  });

  it('AMAZON_TASKS_REGION wins over FUNCTIONS_REGION', () => {
    ambiente({ tasksRegion: 'xx-regiao2', functionsRegion: 'xx-regiao1' });
    expect(regiaoDaFilaAgendamentoAmazon()).toBe('xx-regiao2');
  });

  // NEAR-MISS of the fallback: a DECLARED but blank variable is not "set".
  it('falls back to FUNCTIONS_REGION when AMAZON_TASKS_REGION is unset or blank', async () => {
    for (const tasksRegion of [undefined, '   ']) {
      ambiente({ tasksRegion, functionsRegion: 'xx-regiao1' });
      await criarAgendadorAgendamentoAmazonDoAmbiente().enfileirar(TAREFA);
    }
    expect(h.taskQueue.mock.calls).toEqual([
      ['locations/xx-regiao1/functions/processAmazonEasyShipSchedule'],
      ['locations/xx-regiao1/functions/processAmazonEasyShipSchedule'],
    ]);
  });

  it('REFUSES the enqueue with no region at all, before touching the transport', async () => {
    ambiente({});
    await expect(
      criarAgendadorAgendamentoAmazonDoAmbiente().enfileirar(TAREFA),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('writes requireRegion as an object literal of STATIC process.env reads — the shape `define` can inline', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendadorAgendamento.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(fonte.match(/requireRegion\(/g) ?? []).toHaveLength(1);
    expect(fonte).toContain(
      [
        'requireRegion({',
        '    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,',
        '    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,',
        '  })',
      ].join('\n'),
    );
    expect(fonte).not.toMatch(/process\.env\[/);
  });

  it('★ (mutation 13) the NF-e root names no scheduling producer — the NF-e trigger’s closure does not grow', () => {
    const nfe = readFileSync(fileURLToPath(new URL('./agendadorNfe.ts', import.meta.url)), 'utf8');
    expect(nfe).not.toMatch(/agendamento\//);
    expect(nfe).not.toMatch(/Agendamento/);
  });
});

describe('the queue valve', () => {
  it("exactly '1' closes it: both entry points reject with the scheduling class, and the SDK is never touched", async () => {
    ambiente({ functionsRegion: 'xx-regiao1', desligado: '1' });

    expect(tarefasAgendamentoAmazonDesligadas()).toBe(true);
    const agendador = criarAgendadorAgendamentoAmazonDoAmbiente();
    await expect(agendador.enfileirarEntrada(TAREFA, OBSERVACAO)).rejects.toBeInstanceOf(
      AmazonAgendamentoTarefasDesligadasError,
    );
    await expect(agendador.enfileirar(TAREFA)).rejects.toBeInstanceOf(
      AmazonAgendamentoTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('closed, it needs no region either', async () => {
    ambiente({ desligado: '1' });
    await expect(
      criarAgendadorAgendamentoAmazonDoAmbiente().enfileirar(TAREFA),
    ).rejects.toBeInstanceOf(AmazonAgendamentoTarefasDesligadasError);
  });

  // NEAR-MISS: the valve is opt-in at EXACTLY '1' — never trimmed, never parsed.
  it.each([['1 '], [' 1'], ['true'], ['TRUE'], ['0'], [''], [undefined]])(
    'AMAZON_TASKS_DISABLED=%j leaves enqueuing ON',
    async (valor) => {
      ambiente({ functionsRegion: 'xx-regiao1', desligado: valor });

      expect(tarefasAgendamentoAmazonDesligadas()).toBe(false);
      await criarAgendadorAgendamentoAmazonDoAmbiente().enfileirar(TAREFA);
      expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(TAREFA);
    },
  );
});
