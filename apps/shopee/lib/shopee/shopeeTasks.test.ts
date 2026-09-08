import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';

/**
 * Mocked: the transport seams (the Functions SDK's queue/enqueue and the admin
 * app binding) and the adapter module, which is imported here only for the
 * queue-name constant. The scheduler's own env-driven wiring runs real.
 */
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

// Only the constant is needed, and loading the real adapter would drag the
// whole pipeline (and Firestore) into a test about a queue name.
vi.mock('./notificacoes/notificacao', () => ({
  SHOPEE_NOTIFICATION_QUEUE: 'processShopeeNotification',
}));

const { ShopeeTasksDisabledError, createShopeeTaskScheduler, shopeeTasksRegion } =
  await import('./shopeeTasks');

const payload = {
  code: 1,
  shopId: 987654,
  timestamp: 1_660_616_278_000,
  data: { authorize_type: 'shop authorization by user', shop_id: 987654 },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createShopeeTaskScheduler', () => {
  it('enfileira na fila processShopeeNotification qualificada pela região', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    const scheduler = createShopeeTaskScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east1/functions/processShopeeNotification',
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload);
  });

  it('cai para FUNCTIONS_REGION quando SHOPEE_TASKS_REGION não está definida', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'southamerica-east1');
    await createShopeeTaskScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/processShopeeNotification',
    );
  });

  // NEAR-MISS do fallback: uma variável DECLARADA e vazia não é "definida".
  // `SHOPEE_TASKS_REGION=` em branco produziria `locations//functions/...`, e o
  // enqueue seria descartado em silêncio (#887 / #1108).
  it('trata SHOPEE_TASKS_REGION em branco como não definida', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', '   ');
    vi.stubEnv('FUNCTIONS_REGION', 'us-east1');
    await createShopeeTaskScheduler().enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east1/functions/processShopeeNotification',
    );
  });

  it('SHOPEE_TASKS_REGION tem precedência sobre FUNCTIONS_REGION', () => {
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    vi.stubEnv('FUNCTIONS_REGION', 'southamerica-east1');
    expect(shopeeTasksRegion()).toBe('us-east1');
  });

  it('RECUSA enfileirar quando nenhuma região está configurada', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createShopeeTaskScheduler();

    // Não existe default de propósito: um enqueue contra a região errada NÃO
    // falha — o Admin SDK resolve us-central1, a fila não existe, e a tarefa é
    // descartada enquanto o receiver ainda responde 204 (#1108).
    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('lança ShopeeTasksDisabledError com SHOPEE_TASKS_DISABLED=1, sem tocar no transporte', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    const scheduler = createShopeeTaskScheduler();
    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(ShopeeTasksDisabledError);
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  // NEAR-MISS da válvula: ela é opt-in EXATAMENTE em '1'.
  it.each(['0', 'true', 'yes', '', ' 1'])(
    'SHOPEE_TASKS_DISABLED=%j NÃO desabilita a fila',
    async (raw) => {
      vi.stubEnv('SHOPEE_TASKS_DISABLED', raw);
      vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
      await createShopeeTaskScheduler().enqueue(payload);
      expect(h.enqueue).toHaveBeenCalledWith(payload);
    },
  );

  it('a mensagem do erro de desabilitado nomeia a variável e diz o que acontece', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    try {
      await createShopeeTaskScheduler().enqueue(payload);
      expect.unreachable('enqueue deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ShopeeTasksDisabledError)) throw err;
      expect(err.message).toContain('SHOPEE_TASKS_DISABLED');
      expect(err.message).toContain('sweep');
    }
  });
});
