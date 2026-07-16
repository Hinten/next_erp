import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the transport seams: the Functions SDK (queue/enqueue) and the admin app
// binding. The scheduler's own env-driven wiring runs real.
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

vi.mock('../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

const { createWhatsappTaskScheduler, WhatsappTasksDisabledError } = await import('./waTasks');

const payload = {
  field: 'messages',
  phoneNumberId: 'PNID1',
  messageId: 'wamid.A',
  value: { messaging_product: 'whatsapp' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createWhatsappTaskScheduler', () => {
  it('enqueues onto the region-qualified processWhatsappNotification queue', async () => {
    vi.stubEnv('WHATSAPP_TASKS_DISABLED', '');
    vi.stubEnv('WHATSAPP_TASKS_REGION', 'southamerica-east1');
    const scheduler = createWhatsappTaskScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/processWhatsappNotification',
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload);
  });

  it('defaults the region to us-east5 when nothing is configured', async () => {
    vi.stubEnv('WHATSAPP_TASKS_DISABLED', '');
    vi.stubEnv('WHATSAPP_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createWhatsappTaskScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east5/functions/processWhatsappNotification',
    );
  });

  it('the disabled valve throws WhatsappTasksDisabledError instead of enqueuing', async () => {
    vi.stubEnv('WHATSAPP_TASKS_DISABLED', '1');
    const scheduler = createWhatsappTaskScheduler();
    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(WhatsappTasksDisabledError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
