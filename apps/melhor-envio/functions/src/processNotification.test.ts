import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';

import { MELHOR_ENVIO_NOTIFICATION_QUEUE, TASK_MAX_ATTEMPTS } from '../../lib/freight/notificacao';

const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

const channel = vi.hoisted(() => ({
  handleNotificationTask: vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      outcome: 'done',
    }),
  ),
}));
vi.mock('../../lib/freight/notificacao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/freight/notificacao')>()),
  handleNotificationTask: channel.handleNotificationTask,
}));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { processMelhorEnvioNotification } = await import('./processNotification');

type RunnableTask = { data: unknown; retryCount?: number };

function run(req: RunnableTask): Promise<unknown> {
  return (
    processMelhorEnvioNotification as unknown as {
      run(request: RunnableTask): Promise<unknown>;
    }
  ).run(req);
}

function loggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => info.mockRestore());

describe('processMelhorEnvioNotification log line', () => {
  it('reports the channel result and raw pointer fields in one call', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'applied',
      detail: 'estado-atualizado',
      pedidoId: 'ped-1',
      estado: 'postado',
      providerStatusEfetivo: 'suspended',
    });
    await run({
      data: {
        labelId: 'lbl-1',
        event: 'order.posted',
        providerStatus: 'posted',
      },
      retryCount: 1,
    });

    expect(loggedPayload(info)).toEqual({
      queue: MELHOR_ENVIO_NOTIFICATION_QUEUE,
      outcome: 'done',
      kind: 'applied',
      detail: 'estado-atualizado',
      labelId: 'lbl-1',
      event: 'order.posted',
      providerStatus: 'posted',
      providerStatusEfetivo: 'suspended',
      pedidoId: 'ped-1',
      estado: 'postado',
      retryCount: 1,
      readCache: null,
    });
  });

  it('keeps raw ids on a schema-parse drop and emits null instead of missing keys', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({ outcome: 'dropped' });
    await run({ data: { labelId: 'lbl-1', event: 7, providerStatus: {} } });

    const payload = loggedPayload(info);
    expect(payload.labelId).toBe('lbl-1');
    for (const key of [
      'kind',
      'detail',
      'event',
      'providerStatus',
      'providerStatusEfetivo',
      'pedidoId',
      'estado',
    ]) {
      expect(payload).toHaveProperty(key, null);
    }
  });
});

describe('processMelhorEnvioNotification options', () => {
  const endpoint = (
    processMelhorEnvioNotification as unknown as { __endpoint: Record<string, unknown> }
  ).__endpoint;

  it('aligns the queue retry cap with the handler', () => {
    const trigger = endpoint.taskQueueTrigger as { retryConfig?: { maxAttempts?: number } };
    expect(trigger.retryConfig?.maxAttempts).toBe(TASK_MAX_ATTEMPTS);
  });

  it('declares both configured invokers', () => {
    const trigger = endpoint.taskQueueTrigger as { invoker?: string[] };
    expect(trigger.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });

  it('binds exactly the two OAuth application secrets', () => {
    const names = (endpoint.secretEnvironmentVariables as { key?: string }[] | undefined)?.map(
      (secret) => secret.key,
    );
    expect(names).toEqual(['MELHOR_ENVIO_CLIENT_ID', 'MELHOR_ENVIO_CLIENT_SECRET']);
  });

  it('keeps the function export and queue name aligned', () => {
    expect(processMelhorEnvioNotification).toBeDefined();
    expect(MELHOR_ENVIO_NOTIFICATION_QUEUE).toBe('processMelhorEnvioNotification');
  });
});
