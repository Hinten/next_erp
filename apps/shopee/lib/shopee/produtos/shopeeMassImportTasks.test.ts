import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';

import { ShopeeMassImportTasksDisabledError } from './errosImportacao';

/**
 * Mocked: the transport seams (the Functions SDK's queue/enqueue and the admin
 * app binding), the adapter module the real `shopeeTasks.ts` only needs a
 * constant from, and `./importacaoMassa`, which is imported here for the queue
 * NAME alone — loading it for real would drag Firestore, the schemas and the
 * whole importer graph into a test about a queue path.
 *
 * ⚠️ `../shopeeTasks` is mocked PARTIALLY, on purpose: `shopeeTasksRegion` stays
 * the real one (the region wiring is what two of these tests are about) and only
 * the valve can be forced, so the "one reader" claim is testable without
 * neutralising anything else.
 */
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown, _opts?: unknown) => {}),
  taskQueue: vi.fn(),
  getFunctions: vi.fn(),
  /** `null` ⇒ defer to the REAL env-driven reader. */
  valvula: vi.fn((): boolean | null => null),
}));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: (...args: unknown[]) => {
    h.getFunctions(...args);
    return { taskQueue: h.taskQueue };
  },
}));

vi.mock('../../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

vi.mock('../notificacoes/notificacao', () => ({
  SHOPEE_NOTIFICATION_QUEUE: 'processShopeeNotification',
}));

vi.mock('./importacaoMassa', () => ({
  SHOPEE_MASS_IMPORT_QUEUE: 'processShopeeMassImport',
}));

vi.mock('../shopeeTasks', async () => {
  const real = await vi.importActual<typeof import('../shopeeTasks')>('../shopeeTasks');
  return {
    ...real,
    shopeeTasksDesabilitado: (): boolean => h.valvula() ?? real.shopeeTasksDesabilitado(),
  };
});

const { createShopeeMassImportScheduler } = await import('./shopeeMassImportTasks');

const payload = { jobId: 'job-1', integracaoId: 'int-1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.valvula.mockReturnValue(null);
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createShopeeMassImportScheduler', () => {
  it('usa o nome da fila qualificado pela região', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await createShopeeMassImportScheduler().enqueue(payload);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east1/functions/processShopeeMassImport',
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload, undefined);
  });

  it('um SHOPEE_TASKS_DISABLED=1 devolve um scheduler que LANÇA, sem tocar no transporte', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    const agendador = createShopeeMassImportScheduler();

    await expect(agendador.enqueue(payload)).rejects.toBeInstanceOf(
      ShopeeMassImportTasksDisabledError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('lê a válvula por shopeeTasksDesabilitado, não por process.env', async () => {
    // A variável está VAZIA e mesmo assim o scheduler recusa: o que decide é a
    // função, que é a ÚNICA leitora de SHOPEE_TASKS_DISABLED neste app.
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    h.valvula.mockReturnValue(true);

    await expect(createShopeeMassImportScheduler().enqueue(payload)).rejects.toBeInstanceOf(
      ShopeeMassImportTasksDisabledError,
    );
    expect(h.valvula).toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('repassa scheduleDelaySeconds quando há um, e OMITE a opção quando não há', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    const agendador = createShopeeMassImportScheduler();

    await agendador.enqueue(payload, { scheduleDelaySeconds: 42 });
    expect(h.enqueue).toHaveBeenLastCalledWith(payload, { scheduleDelaySeconds: 42 });

    // ⛔ NEAR-MISS: sem atraso a opção é OMITIDA, nunca enviada como
    // `{ scheduleDelaySeconds: undefined }` — o objeto vai para o Cloud Tasks e
    // "sem atraso" não é o mesmo pedido que "atraso indefinido".
    await agendador.enqueue(payload);
    expect(h.enqueue).toHaveBeenLastCalledWith(payload, undefined);

    await agendador.enqueue(payload, {});
    expect(h.enqueue).toHaveBeenLastCalledWith(payload, undefined);
  });

  it('região ausente LANÇA no primeiro enqueue, não antes', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);

    // Construir o scheduler não lê região nenhuma…
    const agendador = createShopeeMassImportScheduler();
    expect(h.taskQueue).not.toHaveBeenCalled();

    // …e a recusa acontece ANTES de qualquer chamada de transporte: sem default
    // deliberadamente, porque o Admin SDK resolveria `us-central1` e a tarefa
    // seria descartada em silêncio enquanto o chamador vê sucesso (#1108).
    await expect(agendador.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('a mensagem do erro de desabilitado nomeia a variável e diz que não há sweep', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    try {
      await createShopeeMassImportScheduler().enqueue(payload);
      expect.unreachable('o enqueue deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ShopeeMassImportTasksDisabledError)) throw err;
      expect(err.message).toContain('SHOPEE_TASKS_DISABLED');
      expect(err.message).toContain('sweep');
      expect(err.name).toBe('ShopeeMassImportTasksDisabledError');
    }
  });
});
