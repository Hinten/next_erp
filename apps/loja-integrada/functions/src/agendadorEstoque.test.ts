import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';
import { ORIGEM_TAREFA_ESTOQUE_LI, TIPO_TAREFA_ESTOQUE_LI } from '@delfrance/schemas';

/**
 * The stock-queue producer's COMPOSITION ROOT (master plan step 12, PR 12-e): what it reads from
 * the environment (the sweep-only valve, the region — both through the reads root's own readers)
 * and what it hands the Admin SDK (the region-qualified path of `filaEstoqueLojaIntegrada`, the
 * payload, its task id, and its schedule as a `scheduleTime` Date).
 *
 * Mocked: only the transport seams — `getFunctions` and the admin app. The SDK's error CLASSES
 * stay real, because the producer narrows on them. No network is reachable: the queue is a
 * recording fake.
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

const { criarAgendadorEstoqueLiDoAmbiente } = await import('./agendadorEstoque');
const { LiTarefasDesligadasError, LiTarefasTransitoriasError } =
  await import('../../lib/lojaIntegrada/notificacoes/agendador');
const { agendamentoEstoqueLi, enfileirarTarefaEstoqueLi, idDaTarefaEstoqueLi } =
  await import('../../lib/lojaIntegrada/estoque/agendadorEstoque');
const { CORPO_DA_RESPOSTA_DO_TASKS, falhaDeConfiguracaoDoFunctions, falhaDoFunctions } =
  await import('../../lib/lojaIntegrada/testing/falhaDeEnfileiramento');

const JANELA = 29_000_000;
const PAYLOAD = {
  tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
  contaId: 'conta-li-est',
  produtoId: 'prod-1',
  origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva,
  janela: JANELA,
  estoqueId: null,
  apagado: false,
  estoqueIds: null,
  geracao: 1 as const,
};
const OPCOES = {
  id: idDaTarefaEstoqueLi(PAYLOAD),
  agendarParaMs: agendamentoEstoqueLi(JANELA, 'prod-1'),
};
const CAMINHO = 'locations/southamerica-east1/functions/filaEstoqueLojaIntegrada';

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
  it('enqueues onto locations/<region>/functions/filaEstoqueLojaIntegrada, on the admin app', async () => {
    ambiente({ tasksRegion: 'southamerica-east1', functionsRegion: 'southamerica-east1' });

    await criarAgendadorEstoqueLiDoAmbiente().enfileirar(PAYLOAD, OPCOES);

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(CAMINHO);
  });

  it('sends the payload, its task id AND its schedule as a Date — the whole argument list', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });

    await criarAgendadorEstoqueLiDoAmbiente().enfileirar(PAYLOAD, OPCOES);

    // NEAR-MISS of the writes root, which sends no schedule: here the schedule is what keeps a
    // name from meeting a task that already dispatched (the pure module's header).
    expect(h.enqueue.mock.calls).toEqual([
      [PAYLOAD, { id: OPCOES.id, scheduleTime: new Date(OPCOES.agendarParaMs) }],
    ]);
    expect(OPCOES.id).toMatch(/^estoque-[0-9a-f]{64}$/);
  });

  it('through the producer helper: the clock at the enqueue names and schedules the task', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    const { tipo: _tipo, janela: _janela, ...semJanela } = PAYLOAD;

    await enfileirarTarefaEstoqueLi(
      criarAgendadorEstoqueLiDoAmbiente(),
      () => JANELA * 60_000 + 59_999,
      semJanela,
    );

    expect(h.enqueue.mock.calls).toEqual([
      [PAYLOAD, { id: OPCOES.id, scheduleTime: new Date(OPCOES.agendarParaMs) }],
    ]);
  });

  it('the queue is resolved PER enqueue, never at construction', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    const agendador = criarAgendadorEstoqueLiDoAmbiente();
    expect(h.taskQueue).not.toHaveBeenCalled();

    await agendador.enfileirar(PAYLOAD, OPCOES);
    await agendador.enfileirar(PAYLOAD, OPCOES);

    expect(h.taskQueue).toHaveBeenCalledTimes(2);
  });

  it('LOJA_INTEGRADA_TASKS_REGION wins over FUNCTIONS_REGION — the reads queue’s rule', async () => {
    ambiente({ tasksRegion: 'us-east4', functionsRegion: 'southamerica-east1' });

    await criarAgendadorEstoqueLiDoAmbiente().enfileirar(PAYLOAD, OPCOES);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east4/functions/filaEstoqueLojaIntegrada',
    );
  });

  it('REFUSES the enqueue with no region at all, before touching the transport — and the module still loads', async () => {
    ambiente({});
    const agendador = criarAgendadorEstoqueLiDoAmbiente();

    await expect(agendador.enfileirar(PAYLOAD, OPCOES)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('reads the region and the valve through the READS root — one reader of each, so the bundle-inlining proof covers all three queues', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendadorEstoque.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte).toMatch(
      /import \{[^}]*\bregiaoDaFilaLi\b[^}]*\btarefasLiDesligadas\b[^}]*\} from '\.\/agendador';/,
    );
    // A second reader here would be a second shape `define` must inline.
    expect(fonte).not.toContain('requireRegion(');
    expect(fonte).not.toContain('process.env');
    // The queue name comes from the ONE constant the export is asserted against.
    expect(fonte).toMatch(/\/functions\/\$\{FILA_ESTOQUE_LI\}`/);
    expect(fonte).not.toContain("'filaEstoqueLojaIntegrada'");
  });
});

describe('the sweep-only valve', () => {
  it("exactly '1' closes it: the enqueue rejects named, and the SDK is never touched", async () => {
    ambiente({ functionsRegion: 'southamerica-east1', desligado: '1' });

    await expect(
      criarAgendadorEstoqueLiDoAmbiente().enfileirar(PAYLOAD, OPCOES),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('is read ONCE, when the producer is built', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    const agendador = criarAgendadorEstoqueLiDoAmbiente();
    vi.stubEnv('LOJA_INTEGRADA_TASKS_DISABLED', '1');

    await agendador.enfileirar(PAYLOAD, OPCOES);

    expect(h.enqueue).toHaveBeenCalledOnce();
  });

  it.each([['1 '], ['true'], [''], [undefined]])(
    'LOJA_INTEGRADA_TASKS_DISABLED=%j leaves enqueuing ON',
    async (valor) => {
      ambiente({ functionsRegion: 'southamerica-east1', desligado: valor });

      await criarAgendadorEstoqueLiDoAmbiente().enfileirar(PAYLOAD, OPCOES);
      expect(h.enqueue).toHaveBeenCalledOnce();
    },
  );
});

describe('the real transport failures, through the root', () => {
  it('an ANSWERED `task-already-exists` (409) is success: the same task is already queued for this window', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    h.enqueue.mockImplementationOnce(() =>
      Promise.reject(falhaDoFunctions('task-already-exists', 409)),
    );

    await expect(
      criarAgendadorEstoqueLiDoAmbiente().enfileirar(PAYLOAD, OPCOES),
    ).resolves.toBeUndefined();
  });

  it('a Cloud Tasks 503 comes out as LiTarefasTransitoriasError, without the body', async () => {
    ambiente({ functionsRegion: 'southamerica-east1' });
    h.enqueue.mockImplementationOnce(() => Promise.reject(falhaDoFunctions('unknown-error')));

    const err = await criarAgendadorEstoqueLiDoAmbiente()
      .enfileirar(PAYLOAD, OPCOES)
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

    await expect(criarAgendadorEstoqueLiDoAmbiente().enfileirar(PAYLOAD, OPCOES)).rejects.toBe(sdk);
  });
});
