import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the transport seams: the Functions SDK (queue/enqueue) and the admin app
// binding. The scheduler's own env-driven wiring runs real. Mirrors
// apps/mercado-livre/lib/marketplace/estoque/mlStockTasks.test.ts's pattern.
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown) => {}),
  taskQueue: vi.fn(),
  getFunctions: vi.fn(),
}));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: (...args: unknown[]) => {
    h.getFunctions(...args);
    return { taskQueue: h.taskQueue };
  },
}));

vi.mock('../lib/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

const { BALANCO_QUEUE, BalancoTasksDisabledError, createBalancoScheduler } =
  await import('./balancoTasks');

// The worker treats the payload opaquely — only the queue path is under test here.
const payload = { balancoId: 'bal-1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createBalancoScheduler', () => {
  it('enqueues onto the region-qualified processarBalanco queue', async () => {
    vi.stubEnv('BALANCO_TASKS_DISABLED', '');
    vi.stubEnv('BALANCO_TASKS_REGION', 'southamerica-east1');
    await createBalancoScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      `locations/southamerica-east1/functions/${BALANCO_QUEUE}`,
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload);
  });

  it('falls back to FUNCTIONS_REGION when BALANCO_TASKS_REGION is unset', async () => {
    vi.stubEnv('BALANCO_TASKS_DISABLED', '');
    vi.stubEnv('BALANCO_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'us-west1');
    await createBalancoScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(`locations/us-west1/functions/${BALANCO_QUEUE}`);
  });

  it('defaults the region to us-east1 when nothing is configured', async () => {
    vi.stubEnv('BALANCO_TASKS_DISABLED', '');
    // Truly unset (not blank) — the plain fall-through.
    vi.stubEnv('BALANCO_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    await createBalancoScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(`locations/us-east1/functions/${BALANCO_QUEUE}`);
  });

  // #887: `??` does NOT fall through on '', so a declared-but-blank var used to
  // resolve to `locations//functions/processarBalanco` — a malformed path the
  // Admin SDK sends to us-central1, where the queue does not exist. The enqueue
  // then drops silently, and this queue has NO sweep backstop.
  it('treats a blank BALANCO_TASKS_REGION as unset and falls through to the default', async () => {
    vi.stubEnv('BALANCO_TASKS_DISABLED', '');
    vi.stubEnv('BALANCO_TASKS_REGION', '');
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    await createBalancoScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(`locations/us-east1/functions/${BALANCO_QUEUE}`);
  });

  it('treats a whitespace-only BALANCO_TASKS_REGION as unset too', async () => {
    vi.stubEnv('BALANCO_TASKS_DISABLED', '');
    vi.stubEnv('BALANCO_TASKS_REGION', '  ');
    vi.stubEnv('FUNCTIONS_REGION', 'us-west1');
    await createBalancoScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(`locations/us-west1/functions/${BALANCO_QUEUE}`);
  });

  it('the disabled valve throws BalancoTasksDisabledError instead of enqueuing', async () => {
    vi.stubEnv('BALANCO_TASKS_DISABLED', '1');
    await expect(createBalancoScheduler().enqueue(payload)).rejects.toBeInstanceOf(
      BalancoTasksDisabledError,
    );
    expect(h.taskQueue).not.toHaveBeenCalled();
  });
});
