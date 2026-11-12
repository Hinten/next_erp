import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';

import { falhaDeTarefaJaExistente } from '../../lib/amazon/testing/falhaDeEnfileiramento';

/**
 * The functions codebase's COMPOSITION ROOT of the jobs queue's producer (step
 * 12a, PR 12-c): what it reads from the environment (the valve, the region)
 * and what it hands the Admin SDK (the region-qualified queue path, the
 * payload, a task's name and delay).
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
  criarAgendadorLotesAmazonDoAmbiente,
  regiaoDaFilaLotesAmazon,
  tarefasLotesAmazonDesligadas,
} = await import('./agendadorEstoque');
const { AmazonLotesTarefasDesligadasError } = await import('../../lib/amazon/feeds/agendadorLotes');
const { nomeConsultaFeed, tarefaLoteAmazonSchema } =
  await import('../../lib/amazon/feeds/tarefaLote');

const CONTA = 'conta-teste';
const FEED = '50001234567';
const RODADA = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-resultado',
  contaId: CONTA,
  feedId: FEED,
  rodada: 1,
  origem: 'consulta',
});
const NOME = nomeConsultaFeed(CONTA, FEED, 1);
const ESPERA = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-incerto',
  fluxo: 'estoque',
  contaId: CONTA,
  execucaoId: 'exec-teste-0001',
});

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
  it('★ enqueues onto locations/<region>/functions/processAmazonListingsJob, on the admin app', async () => {
    ambiente({ tasksRegion: 'xx-regiao1', functionsRegion: 'xx-regiao1' });

    await criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(RODADA, { nome: NOME });

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(
      'locations/xx-regiao1/functions/processAmazonListingsJob',
    );
    // NEVER another queue: a separate root binds a separate queue.
    for (const outra of [
      'filaLeituraAmazon',
      'processAmazonNfeUpload',
      'processAmazonEasyShipSchedule',
    ]) {
      expect(h.taskQueue).not.toHaveBeenCalledWith(expect.stringContaining(outra));
    }
  });

  it('a named enqueue carries its name; an unnamed wait carries only its delay', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });
    const agendador = criarAgendadorLotesAmazonDoAmbiente();

    expect(await agendador.enfileirarLote(RODADA, { nome: NOME, atrasoS: 120 })).toBe(
      'enfileirada',
    );
    await agendador.enfileirarLote(ESPERA, { atrasoS: 30 });

    expect(h.enqueue.mock.calls).toEqual([
      [RODADA, { id: NOME, scheduleDelaySeconds: 120 }],
      [ESPERA, { scheduleDelaySeconds: 30 }],
    ]);
  });

  it('the SDK’s own 409 for a held name reads ja-enfileirada through the root', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });
    h.enqueue.mockImplementationOnce(() => Promise.reject(falhaDeTarefaJaExistente(NOME)));

    expect(await criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(RODADA, { nome: NOME })).toBe(
      'ja-enfileirada',
    );
  });

  it('AMAZON_TASKS_REGION wins over FUNCTIONS_REGION', () => {
    ambiente({ tasksRegion: 'xx-regiao2', functionsRegion: 'xx-regiao1' });
    expect(regiaoDaFilaLotesAmazon()).toBe('xx-regiao2');
  });

  // NEAR-MISS of the fallback: a DECLARED but blank variable is not "set".
  it('falls back to FUNCTIONS_REGION when AMAZON_TASKS_REGION is unset or blank', async () => {
    for (const tasksRegion of [undefined, '   ']) {
      ambiente({ tasksRegion, functionsRegion: 'xx-regiao1' });
      await criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(ESPERA);
    }
    expect(h.taskQueue.mock.calls).toEqual([
      ['locations/xx-regiao1/functions/processAmazonListingsJob'],
      ['locations/xx-regiao1/functions/processAmazonListingsJob'],
    ]);
  });

  it('★ REFUSES the enqueue with no region at all, before touching the transport (no default)', async () => {
    ambiente({});
    await expect(
      criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(ESPERA),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('★ writes requireRegion as an object literal of STATIC process.env reads — the shape `define` can inline', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendadorEstoque.ts', import.meta.url)),
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

  it('★ the file has ONE `getFunctions(` call', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendadorEstoque.ts', import.meta.url)),
      'utf8',
    );
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codigo.match(/\bgetFunctions\s*\(/g)).toHaveLength(1);
  });

  it('the NF-e root names nothing of the feed core — the NF-e trigger’s closure does not grow', () => {
    const nfe = readFileSync(fileURLToPath(new URL('./agendadorNfe.ts', import.meta.url)), 'utf8');
    expect(nfe).not.toMatch(/feeds\//);
    expect(nfe).not.toMatch(/Lotes/);
  });
});

describe('the queue valve', () => {
  it("★ exactly '1' closes it: the enqueue rejects with the jobs queue’s class, and the SDK is never touched", async () => {
    ambiente({ functionsRegion: 'xx-regiao1', desligado: '1' });

    expect(tarefasLotesAmazonDesligadas()).toBe(true);
    const agendador = criarAgendadorLotesAmazonDoAmbiente();
    await expect(agendador.enfileirarLote(RODADA, { nome: NOME })).rejects.toBeInstanceOf(
      AmazonLotesTarefasDesligadasError,
    );
    await expect(agendador.enfileirarLote(ESPERA)).rejects.toBeInstanceOf(
      AmazonLotesTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('closed, it needs no region either', async () => {
    ambiente({ desligado: '1' });
    await expect(
      criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(ESPERA),
    ).rejects.toBeInstanceOf(AmazonLotesTarefasDesligadasError);
  });

  // NEAR-MISS: the valve is opt-in at EXACTLY '1' — never trimmed, never parsed.
  it.each([['1 '], [' 1'], ['true'], ['TRUE'], ['0'], [''], [undefined]])(
    'AMAZON_TASKS_DISABLED=%j leaves enqueuing ON',
    async (valor) => {
      ambiente({ functionsRegion: 'xx-regiao1', desligado: valor });

      expect(tarefasLotesAmazonDesligadas()).toBe(false);
      await criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(ESPERA);
      expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(ESPERA);
    },
  );
});
