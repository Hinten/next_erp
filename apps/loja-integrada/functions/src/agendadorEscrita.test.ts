import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';
import { ESTADO_RASTREIO_LI, TIPO_TAREFA_ESCRITA_LI } from '@delfrance/schemas';

/**
 * The writes-queue producer's COMPOSITION ROOT (master plan step 7, PR 7-e):
 * what it reads from the environment (the sweep-only valve, the region — both
 * through the reads root's own readers) and what it hands the Admin SDK (the
 * region-qualified path of `filaEscritaLojaIntegrada`, the payload AND its task
 * id).
 *
 * Mocked: only the transport seams — `getFunctions` and the admin app. The SDK's
 * error CLASSES stay real, because the producer narrows on them. No network is
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

const { criarAgendadorEscritaLiDoAmbiente } = await import('./agendadorEscrita');
const { LiTarefasDesligadasError, LiTarefasTransitoriasError } =
  await import('../../lib/lojaIntegrada/notificacoes/agendador');
const { TIPO_TAREFA_VARREDURA_ESCRITA_LI, eventoDoHistoricoLi, idDaTarefaEscritaLi } =
  await import('../../lib/lojaIntegrada/rastreio/agendadorEscrita');
const { CORPO_DA_RESPOSTA_DO_TASKS, falhaDeConfiguracaoDoFunctions, falhaDoFunctions } =
  await import('../../lib/lojaIntegrada/testing/falhaDeEnfileiramento');

const PEDIDO_ID = '0123456789abcdef'.repeat(4);
const PAYLOAD = {
  tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
  contaId: 'conta-li-1',
  numero: '165',
  pedidoId: PEDIDO_ID,
  evento: eventoDoHistoricoLi(PEDIDO_ID, 'hist-1'),
  estado: ESTADO_RASTREIO_LI.postado,
  eventoEmMs: 1_789_000_000_123,
};
const ID = idDaTarefaEscritaLi(PAYLOAD);
const CAMINHO = 'locations/southamerica-east1/functions/filaEscritaLojaIntegrada';

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
  it('enqueues onto locations/<region>/functions/filaEscritaLojaIntegrada, on the admin app', async () => {
    ambiente({ tasksRegion: 'southamerica-east1', functionsRegion: 'southamerica-east1' });

    await criarAgendadorEscritaLiDoAmbiente().enfileirar(PAYLOAD, { id: ID });

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(CAMINHO);
  });

  it('sends the payload AND its task id — the whole argument list', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });

    await criarAgendadorEscritaLiDoAmbiente().enfileirar(PAYLOAD, { id: ID });

    // NEAR-MISS of the reads root, which sends the payload alone: here the id is
    // what makes a redelivered history row collide instead of queueing twice.
    expect(h.enqueue.mock.calls).toEqual([[PAYLOAD, { id: `rastreio-${PAYLOAD.evento}` }]]);
  });

  it('carries the varredura task too, onto the SAME queue', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });

    await criarAgendadorEscritaLiDoAmbiente().enfileirar(
      { tipo: TIPO_TAREFA_VARREDURA_ESCRITA_LI },
      { id: 'varredura-1' },
    );

    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(CAMINHO);
    expect(h.enqueue.mock.calls).toEqual([[{ tipo: 'varredura' }, { id: 'varredura-1' }]]);
  });

  it('LOJA_INTEGRADA_TASKS_REGION wins over FUNCTIONS_REGION — the reads queue’s rule', async () => {
    ambiente({ tasksRegion: 'us-east4', functionsRegion: 'southamerica-east1' });

    await criarAgendadorEscritaLiDoAmbiente().enfileirar(PAYLOAD, { id: ID });

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east4/functions/filaEscritaLojaIntegrada',
    );
  });

  it('treats a blank LOJA_INTEGRADA_TASKS_REGION as unset (#887, #1108)', async () => {
    ambiente({ tasksRegion: '   ', functionsRegion: 'southamerica-east1' });

    await criarAgendadorEscritaLiDoAmbiente().enfileirar(PAYLOAD, { id: ID });

    expect(h.taskQueue).toHaveBeenCalledWith(CAMINHO);
  });

  it('REFUSES the enqueue with no region at all, before touching the transport', async () => {
    ambiente({});
    const agendador = criarAgendadorEscritaLiDoAmbiente();

    await expect(agendador.enfileirar(PAYLOAD, { id: ID })).rejects.toBeInstanceOf(
      MissingRegionError,
    );
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('reads the region and the valve through the READS root — one reader of each, so the bundle-inlining proof covers both queues', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendadorEscrita.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte).toMatch(
      /import \{[^}]*\bregiaoDaFilaLi\b[^}]*\btarefasLiDesligadas\b[^}]*\} from '\.\/agendador';/,
    );
    // A second reader here would be a second shape `define` must inline.
    expect(fonte).not.toContain('requireRegion(');
    expect(fonte).not.toContain('process.env');
  });
});

describe('the sweep-only valve', () => {
  it("exactly '1' closes it: the enqueue rejects named, and the SDK is never touched", async () => {
    ambiente({ functionsRegion: 'southamerica-east1', desligado: '1' });

    await expect(
      criarAgendadorEscritaLiDoAmbiente().enfileirar(PAYLOAD, { id: ID }),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([['1 '], ['true'], [''], [undefined]])(
    'LOJA_INTEGRADA_TASKS_DISABLED=%j leaves enqueuing ON',
    async (valor) => {
      ambiente({ functionsRegion: 'southamerica-east1', desligado: valor });

      await criarAgendadorEscritaLiDoAmbiente().enfileirar(PAYLOAD, { id: ID });
      expect(h.enqueue).toHaveBeenCalledOnce();
    },
  );
});

describe('the real transport failures, through the root', () => {
  it('an ANSWERED `task-already-exists` (409) is success: the same event is already queued', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    h.enqueue.mockImplementationOnce(() =>
      Promise.reject(falhaDoFunctions('task-already-exists', 409)),
    );

    await expect(
      criarAgendadorEscritaLiDoAmbiente().enfileirar(PAYLOAD, { id: ID }),
    ).resolves.toBeUndefined();
  });

  it('a Cloud Tasks 503 comes out as LiTarefasTransitoriasError, without the body', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    h.enqueue.mockImplementationOnce(() => Promise.reject(falhaDoFunctions('unknown-error')));

    const err = await criarAgendadorEscritaLiDoAmbiente()
      .enfileirar(PAYLOAD, { id: ID })
      .then(
        () => expect.unreachable('o transporte rejeitou'),
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(LiTarefasTransitoriasError);
    expect((err as Error).message).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  it.each<[string, () => Error]>([
    ['functions/not-found', () => falhaDoFunctions('not-found', 404)],
    ['functions/unknown-error with NO response', () => falhaDeConfiguracaoDoFunctions('projeto')],
  ])('%s is rethrown exactly as the SDK threw it', async (_nome, falha) => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    const sdk = falha();
    h.enqueue.mockImplementationOnce(() => Promise.reject(sdk));

    await expect(criarAgendadorEscritaLiDoAmbiente().enfileirar(PAYLOAD, { id: ID })).rejects.toBe(
      sdk,
    );
  });
});
