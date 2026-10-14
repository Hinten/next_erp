import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';
import { ORIGEM_NOTIFICACAO_LI, TIPO_TAREFA_LI } from '@delfrance/schemas';

/**
 * The reads-queue producer's COMPOSITION ROOT: what it reads from the
 * environment (the valve, the region) and what it hands the Admin SDK (the
 * region-qualified queue path, the payload alone).
 *
 * Mocked: only the transport seams — `getFunctions` and the admin app. The SDK's
 * error CLASSES stay real, because the producer narrows on them and a mocked
 * class would make every `instanceof` a test of the mock. No network is
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

const { criarAgendadorLiDoAmbiente, regiaoDaFilaLi, tarefasLiDesligadas } =
  await import('./agendador');
const { LiTarefasDesligadasError, LiTarefasTransitoriasError } =
  await import('../../lib/lojaIntegrada/notificacoes/agendador');
const { CORPO_DA_RESPOSTA_DO_TASKS, falhaDeConfiguracaoDoFunctions, falhaDoFunctions } =
  await import('../../lib/lojaIntegrada/testing/falhaDeEnfileiramento');

const PAYLOAD = {
  tipo: TIPO_TAREFA_LI.pedido,
  contaId: 'conta-li-1',
  numero: '1234',
  origem: ORIGEM_NOTIFICACAO_LI.poll,
  dataModificacaoLi: '2026-10-13T08:15:58.123456',
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
  vi.stubEnv('LOJA_INTEGRADA_TASKS_REGION', o.tasksRegion);
  vi.stubEnv('FUNCTIONS_REGION', o.functionsRegion);
  vi.stubEnv('LOJA_INTEGRADA_TASKS_DISABLED', o.desligado);
}

describe('the queue path', () => {
  it('enqueues onto locations/<region>/functions/filaLeituraLojaIntegrada, on the admin app', async () => {
    ambiente({ tasksRegion: 'southamerica-east1', functionsRegion: 'southamerica-east1' });

    await criarAgendadorLiDoAmbiente().enfileirar(PAYLOAD);

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(
      'locations/southamerica-east1/functions/filaLeituraLojaIntegrada',
    );
  });

  it('sends the payload ALONE — no task id, no uri, no options of any kind', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });

    await criarAgendadorLiDoAmbiente().enfileirar(PAYLOAD);

    // The WHOLE argument list: a second argument (`{ id }`, `{ uri }`) is the defect.
    expect(h.enqueue.mock.calls).toEqual([[PAYLOAD]]);
  });

  it('LOJA_INTEGRADA_TASKS_REGION wins over FUNCTIONS_REGION', () => {
    ambiente({ tasksRegion: 'us-east4', functionsRegion: 'southamerica-east1' });
    expect(regiaoDaFilaLi()).toBe('us-east4');
  });

  it('falls back to FUNCTIONS_REGION when LOJA_INTEGRADA_TASKS_REGION is unset', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });

    await criarAgendadorLiDoAmbiente().enfileirar(PAYLOAD);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/filaLeituraLojaIntegrada',
    );
  });

  // NEAR-MISS of the fallback: a DECLARED but blank variable is not "set". A
  // blank region would build `locations//functions/…` and the enqueue would be
  // dropped while reporting success (#887, #1108).
  it('treats a blank LOJA_INTEGRADA_TASKS_REGION as unset', async () => {
    ambiente({ tasksRegion: '   ', functionsRegion: 'southamerica-east1' });

    await criarAgendadorLiDoAmbiente().enfileirar(PAYLOAD);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/filaLeituraLojaIntegrada',
    );
  });

  it('REFUSES the enqueue with no region at all, before touching the transport', async () => {
    ambiente({});
    const agendador = criarAgendadorLiDoAmbiente();

    // No default on purpose: a wrong region does not fail, it drops the task.
    await expect(agendador.enfileirar(PAYLOAD)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('writes requireRegion as an object literal of STATIC process.env reads — the shape `define` can inline', () => {
    // `tools/deploy-env/bundle-inlining.test.js` proves this on the BUILT bundle,
    // but only for code the bundle contains, and nothing imports this root until
    // the order poller does. Until then this pins the shape at the source: a
    // computed argument (`requireRegion(candidatos)`, an env indexed by name)
    // leaves FUNCTIONS_REGION a live read, `undefined` after a deploy.
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendador.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const chamadas = fonte.match(/requireRegion\(/g) ?? [];
    expect(chamadas).toHaveLength(1);
    expect(fonte).toContain(
      [
        'requireRegion({',
        '    LOJA_INTEGRADA_TASKS_REGION: process.env.LOJA_INTEGRADA_TASKS_REGION,',
        '    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,',
        '  })',
      ].join('\n'),
    );
  });
});

describe('the sweep-only valve', () => {
  it("exactly '1' closes it: the enqueue rejects named, and the SDK is never touched", async () => {
    ambiente({ functionsRegion: 'southamerica-east1', desligado: '1' });

    expect(tarefasLiDesligadas()).toBe(true);
    await expect(criarAgendadorLiDoAmbiente().enfileirar(PAYLOAD)).rejects.toBeInstanceOf(
      LiTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("closed, it needs no region either — sweep-only mode works before the queue's IAM exists", async () => {
    ambiente({ desligado: '1' });

    await expect(criarAgendadorLiDoAmbiente().enfileirar(PAYLOAD)).rejects.toBeInstanceOf(
      LiTarefasDesligadasError,
    );
  });

  // NEAR-MISS: the valve is opt-in at EXACTLY '1' — never trimmed, never parsed.
  it.each([['1 '], [' 1'], ['true'], ['TRUE'], ['0'], [''], [undefined]])(
    'LOJA_INTEGRADA_TASKS_DISABLED=%j leaves enqueuing ON',
    async (valor) => {
      ambiente({ functionsRegion: 'southamerica-east1', desligado: valor });

      expect(tarefasLiDesligadas()).toBe(false);
      await criarAgendadorLiDoAmbiente().enfileirar(PAYLOAD);
      expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(PAYLOAD);
    },
  );
});

describe('the real transport failures, through the root', () => {
  it('a Cloud Tasks 503 comes out as LiTarefasTransitoriasError, without the body', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    h.enqueue.mockImplementationOnce(() => Promise.reject(falhaDoFunctions('unknown-error')));

    const err = await criarAgendadorLiDoAmbiente()
      .enfileirar(PAYLOAD)
      .then(
        () => expect.unreachable('o transporte rejeitou'),
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(LiTarefasTransitoriasError);
    expect(err).toMatchObject({ codigo: 'functions/unknown-error', httpStatus: 503 });
    expect((err as Error).message).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  // NEAR-MISS: a broken deploy must fail the poller's tick, never be persisted.
  it.each<[string, () => Error]>([
    ['functions/not-found', () => falhaDoFunctions('not-found', 404)],
    ['functions/unknown-error with NO response', () => falhaDeConfiguracaoDoFunctions('projeto')],
  ])('%s is rethrown exactly as the SDK threw it', async (_nome, falha) => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    const sdk = falha();
    h.enqueue.mockImplementationOnce(() => Promise.reject(sdk));

    await expect(criarAgendadorLiDoAmbiente().enfileirar(PAYLOAD)).rejects.toBe(sdk);
  });
});
