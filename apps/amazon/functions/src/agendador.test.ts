import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';
import { ORIGEM_NOTIFICACAO_AMAZON, TIPO_TAREFA_AMAZON } from '@delfrance/schemas';

import type { PayloadNotificacaoAmazon } from '../../lib/amazon/notificacoes/notificacao';

/**
 * The functions codebase's COMPOSITION ROOT of the reads-queue producer (the
 * step-4 poll's, from PR 4-b): what it reads from the environment (the valve,
 * the region) and what it hands the Admin SDK (the region-qualified queue path,
 * the payload alone).
 *
 * Mocked: only the transport seams — `getFunctions` and the admin app. The SDK's
 * error CLASSES stay real (the pure producer narrows on them). No network is
 * reachable: the queue is a recording fake.
 *
 * ⚠️ Nothing imports this root before 4-b, so esbuild leaves it out of the
 * bundle and `tools/deploy-env/bundle-inlining.test.js` cannot check its
 * inlining: the SOURCE-SHAPE pin below stands in until then.
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

const { criarAgendadorAmazonDoAmbiente, regiaoDaFilaAmazon, tarefasAmazonDesligadas } =
  await import('./agendador');
const { AmazonTarefasDesligadasError } = await import('../../lib/amazon/notificacoes/agendador');

const PAYLOAD: PayloadNotificacaoAmazon = {
  tipo: TIPO_TAREFA_AMAZON.pedido,
  origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
  sellerId: 'AXXXXXXXXXXXXX',
  amazonOrderId: '000-0000000-0000001',
  contaId: 'conta-1',
  lastUpdatedUs: 1_800_000_000_000_123,
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
  it('enqueues onto locations/<region>/functions/filaLeituraAmazon, on the admin app', async () => {
    ambiente({ tasksRegion: 'xx-regiao1', functionsRegion: 'xx-regiao1' });

    await criarAgendadorAmazonDoAmbiente().enfileirar(PAYLOAD);

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(
      'locations/xx-regiao1/functions/filaLeituraAmazon',
    );
  });

  it('sends the payload ALONE — no task id, no uri, no options of any kind', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });

    await criarAgendadorAmazonDoAmbiente().enfileirar(PAYLOAD);

    // The WHOLE argument list: a second argument (`{ id }`, `{ uri }`) is the defect.
    expect(h.enqueue.mock.calls).toEqual([[PAYLOAD]]);
  });

  it('AMAZON_TASKS_REGION wins over FUNCTIONS_REGION', () => {
    ambiente({ tasksRegion: 'xx-regiao2', functionsRegion: 'xx-regiao1' });
    expect(regiaoDaFilaAmazon()).toBe('xx-regiao2');
  });

  // NEAR-MISS of the fallback: a DECLARED but blank variable is not "set". A
  // blank region would build `locations//functions/…` and the enqueue would be
  // dropped while reporting success (#887, #1108).
  it('falls back to FUNCTIONS_REGION when AMAZON_TASKS_REGION is unset or blank', async () => {
    for (const tasksRegion of [undefined, '   ']) {
      ambiente({ tasksRegion, functionsRegion: 'xx-regiao1' });
      await criarAgendadorAmazonDoAmbiente().enfileirar(PAYLOAD);
    }
    expect(h.taskQueue.mock.calls).toEqual([
      ['locations/xx-regiao1/functions/filaLeituraAmazon'],
      ['locations/xx-regiao1/functions/filaLeituraAmazon'],
    ]);
  });

  it('REFUSES the enqueue with no region at all, before touching the transport', async () => {
    ambiente({});
    const agendador = criarAgendadorAmazonDoAmbiente();

    // No default on purpose: a wrong region does not fail, it drops the task.
    await expect(agendador.enfileirar(PAYLOAD)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('writes requireRegion as an object literal of STATIC process.env reads — the shape `define` can inline', () => {
    // esbuild's `define` substitutes a static member expression and nothing
    // else: a computed argument (`requireRegion(candidatos)`, an env indexed by
    // name) leaves FUNCTIONS_REGION a live read, `undefined` after a deploy.
    // `bundle-inlining.test.js` proves this on the BUILT bundle only once the
    // poll (4-b) makes this root reachable; until then this pin is the guard.
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendador.ts', import.meta.url)),
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
});

describe('the sweep-only valve', () => {
  it("exactly '1' closes it: the enqueue rejects named, and the SDK is never touched", async () => {
    ambiente({ functionsRegion: 'xx-regiao1', desligado: '1' });

    expect(tarefasAmazonDesligadas()).toBe(true);
    await expect(criarAgendadorAmazonDoAmbiente().enfileirar(PAYLOAD)).rejects.toBeInstanceOf(
      AmazonTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("closed, it needs no region either — sweep-only mode works before the queue's IAM exists", async () => {
    ambiente({ desligado: '1' });

    await expect(criarAgendadorAmazonDoAmbiente().enfileirar(PAYLOAD)).rejects.toBeInstanceOf(
      AmazonTarefasDesligadasError,
    );
  });

  // NEAR-MISS: the valve is opt-in at EXACTLY '1' — never trimmed, never parsed.
  it.each([['1 '], [' 1'], ['true'], ['TRUE'], ['0'], [''], [undefined]])(
    'AMAZON_TASKS_DISABLED=%j leaves enqueuing ON',
    async (valor) => {
      ambiente({ functionsRegion: 'xx-regiao1', desligado: valor });

      expect(tarefasAmazonDesligadas()).toBe(false);
      await criarAgendadorAmazonDoAmbiente().enfileirar(PAYLOAD);
      expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(PAYLOAD);
    },
  );
});
