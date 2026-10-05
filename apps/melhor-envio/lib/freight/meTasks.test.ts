import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';

const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown) => {}),
  taskQueue: vi.fn(),
  getFunctions: vi.fn(),
}));

vi.mock('firebase-admin/functions', () => ({
  FirebaseFunctionsError: class FirebaseFunctionsError extends Error {},
  getFunctions: (...args: unknown[]) => {
    h.getFunctions(...args);
    return { taskQueue: h.taskQueue };
  },
}));

vi.mock('../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

const { createMelhorEnvioTaskScheduler, MelhorEnvioTasksDisabledError } = await import('./meTasks');

const payload = {
  labelId: 'lbl-1',
  event: 'order.posted',
  providerStatus: 'posted',
  tracking: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => vi.unstubAllEnvs());

describe('createMelhorEnvioTaskScheduler', () => {
  it('enqueues onto the region-qualified function queue', async () => {
    vi.stubEnv('MELHOR_ENVIO_TASKS_REGION', 'southamerica-east1');
    await createMelhorEnvioTaskScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/processMelhorEnvioNotification',
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload);
  });

  it('falls back to FUNCTIONS_REGION', async () => {
    vi.stubEnv('MELHOR_ENVIO_TASKS_REGION', '');
    vi.stubEnv('FUNCTIONS_REGION', 'us-central1');
    await createMelhorEnvioTaskScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-central1/functions/processMelhorEnvioNotification',
    );
  });

  it('refuses to guess a region', async () => {
    vi.stubEnv('MELHOR_ENVIO_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    await expect(createMelhorEnvioTaskScheduler().enqueue(payload)).rejects.toBeInstanceOf(
      MissingRegionError,
    );
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('uses the disabled valve as a persist-for-sweep failure', async () => {
    vi.stubEnv('MELHOR_ENVIO_TASKS_DISABLED', '1');
    await expect(createMelhorEnvioTaskScheduler().enqueue(payload)).rejects.toBeInstanceOf(
      MelhorEnvioTasksDisabledError,
    );
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
