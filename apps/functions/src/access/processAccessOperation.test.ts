import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_PHASE as P } from '@delfrance/schemas';
const m = vi.hoisted(() => ({
  enqueue: vi.fn(),
  process: vi.fn(),
  active: vi.fn(),
  get: vi.fn(),
  tasks: vi.fn(),
  created: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({}),
  FirebaseAuthError: class extends Error {},
}));
vi.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({ taskQueue: () => ({ enqueue: m.enqueue }) }),
}));
vi.mock('firebase-functions/v2/tasks', () => ({
  onTaskDispatched: m.tasks.mockImplementation((opts, fn) => ({ opts, fn })),
}));
vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentCreated: m.created.mockImplementation((opts, fn) => ({ opts, fn })),
}));
vi.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: m.schedule.mockImplementation((schedule, fn) => ({ schedule, fn })),
}));
vi.mock('../lib/admin', () => ({ getAdminApp: () => ({}), getDb: () => ({}) }));
vi.mock('@delfrance/data/admin/cargo-claims', async (original) => ({
  ...(await original<typeof import('@delfrance/data/admin/cargo-claims')>()),
  processAccessOperation: m.process,
  getActiveOperationId: m.active,
  getAccessOperation: m.get,
}));
await import('./processAccessOperation');
const worker = m.tasks.mock.calls[0]![1] as (req: { data: { id: string } }) => Promise<void>;
const watchdog = m.schedule.mock.calls[0]![1] as () => Promise<void>;
const created = m.created.mock.calls[0]![1] as (event: {
  data: object;
  params: { id: string };
}) => Promise<void>;
beforeEach(() => {
  vi.stubEnv('FUNCTIONS_REGION', 'us-east1');
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '');
  m.enqueue.mockReset();
  m.process.mockReset();
  m.active.mockReset();
  m.get.mockReset();
  m.get.mockResolvedValue({ phase: P.applying, leaseUntil: 0, progressAt: 0 });
});
describe('access task dispatch and recovery', () => {
  it('enqueues the durable outbox event and limits the worker to one dispatch', async () => {
    await created({ data: {}, params: { id: 'op' } });
    expect(m.enqueue).toHaveBeenCalledWith(
      { id: 'op' },
      expect.objectContaining({ dispatchDeadlineSeconds: 180 }),
    );
    expect(m.tasks.mock.calls[0]![0].rateLimits.maxConcurrentDispatches).toBe(1);
    expect(m.tasks.mock.calls[0]![0].timeoutSeconds).toBe(120);
  });
  it('continues a released page and does not enqueue when another delivery owns its lease', async () => {
    await worker({ data: { id: 'op' } });
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    m.get.mockResolvedValue({ phase: P.applying, leaseUntil: Date.now() + 10000 });
    await worker({ data: { id: 'op' } });
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });
  it('watchdog recovers a lost enqueue using only the global pointer and current operation', async () => {
    m.active.mockResolvedValue('op');
    m.enqueue.mockRejectedValueOnce(new TypeError('transport down'));
    await expect(created({ data: {}, params: { id: 'op' } })).rejects.toThrow('transport down');
    await watchdog();
    expect(m.enqueue).toHaveBeenCalledTimes(2);
    expect(m.get).toHaveBeenCalledWith({}, 'op');
  });
  it('keeps completed and parked failures quiet', async () => {
    m.active.mockResolvedValue(null);
    await watchdog();
    expect(m.get).not.toHaveBeenCalled();
    m.get.mockResolvedValue({ phase: P.completed, leaseUntil: 0 });
    await worker({ data: { id: 'op' } });
    m.active.mockResolvedValue('op');
    m.get.mockResolvedValue({ phase: P.failed, leaseUntil: 0, progressAt: 0 });
    await watchdog();
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});
