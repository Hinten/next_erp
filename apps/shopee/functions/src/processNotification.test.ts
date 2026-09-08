import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';

import {
  SHOPEE_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
} from '../../lib/shopee/notificacoes/notificacao';

/**
 * What lives ONLY in this file is the shape of the log line and the declared
 * queue options — delete a field from either and nothing else in the repo goes
 * red, while an operator loses the only view of what a delivery did.
 *
 * The `kind`/`detail` contract itself is asserted one layer down, in
 * `lib/shopee/notificacoes/notificacao.test.ts`. The hazard being guarded here
 * is the one Mercado Livre hit on its first live run (#1087): the handler
 * reported a bare success for every delivery while nothing was being written,
 * because one disposition covered both "did the work" and "found nothing to do".
 *
 * `tasksInvoker.ts` reads `TASKS_INVOKER_SA` at module scope, so stub it before
 * the dynamic import and restore it afterwards so it cannot leak into other
 * files sharing this vitest project. `FUNCTIONS_REGION` is not read by this
 * module today (it declares no `region:` — `options.ts` sets it globally), but
 * it is stubbed anyway so the file keeps working if one ever lands. Mirrors
 * `apps/mercado-pago/functions/src/processNotification.test.ts`.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

// Isolate the log wiring from the disposition + the admin singleton (both have
// their own coverage). Mirrors how the pipeline's pure cores are tested apart
// from their thin `functions/src` wrappers.
type TaskResultish = Record<string, unknown>;
const channel = vi.hoisted(() => ({
  handleNotificationTask: vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      outcome: 'done',
    }),
  ),
}));
vi.mock('../../lib/shopee/notificacoes/notificacao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/shopee/notificacoes/notificacao')>()),
  handleNotificationTask: channel.handleNotificationTask,
}));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { processShopeeNotification } = await import('./processNotification');

type RunnableTask = { data: unknown; retryCount?: number };

function run(req: RunnableTask): Promise<unknown> {
  return (processShopeeNotification as unknown as { run(r: RunnableTask): Promise<unknown> }).run(
    req,
  );
}

/** The single `logger.info` payload the handler emitted. */
function loggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
});

describe('a linha de log do processShopeeNotification', () => {
  it('diz o que a entrega realmente fez, em UMA chamada', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'aviso',
      lojas: 2,
    } satisfies TaskResultish);

    await run({ data: { code: 12, shopId: null }, retryCount: 1 });

    // UMA chamada de propósito — os campos caem em `jsonPayload` e são
    // filtráveis, então mais campos vale mais que mais linhas.
    expect(loggedPayload(info)).toEqual({
      queue: SHOPEE_NOTIFICATION_QUEUE,
      outcome: 'done',
      kind: 'aviso',
      detail: null,
      code: 12,
      shopId: null,
      lojas: 2,
      retryCount: 1,
      readCache: expect.anything(),
    });
  });

  it('um ack que a Shopee mandou por engano é distinguível de um aviso de verdade', async () => {
    // Os dois terminam sem escrever nada; só `kind`/`detail` separam
    // "reconhecemos e ignoramos" de "levantamos um aviso".
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'dropped',
      kind: 'ack',
      detail: 'nenhuma-loja-mapeada',
    } satisfies TaskResultish);

    await run({ data: { code: 1, shopId: 987654 }, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.outcome).toBe('dropped');
    expect(payload.kind).toBe('ack');
    expect(payload.detail).toBe('nenhuma-loja-mapeada');
  });

  it('campo ausente do TaskResult vira null, nunca uma chave que sumiu', async () => {
    // O Cloud Logging DESCARTA chaves `undefined`, então uma chave filtrável
    // como ausente vale mais que uma que some do `jsonPayload`.
    channel.handleNotificationTask.mockResolvedValueOnce({ outcome: 'dropped' });

    await run({ data: { code: 3, shopId: 987654 }, retryCount: 0 });

    const payload = loggedPayload(info);
    for (const key of ['kind', 'detail', 'lojas']) {
      expect(payload).toHaveProperty(key, null);
    }
  });

  it('mas um campo PRESENTE atravessa intacto — o `?? null` não pode achatar tudo', async () => {
    // Par do teste acima: aquele mostra que o fallback se aplica, este mostra
    // onde ele PARA. Sem ele, trocar o valor por `null` fixo passaria nos dois.
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'parked',
      kind: 'parado',
      detail: 'pedido-passo-5',
      lojas: 4,
    } satisfies TaskResultish);

    await run({ data: { code: 3, shopId: 987654 }, retryCount: 2 });

    const payload = loggedPayload(info);
    expect(payload.kind).toBe('parado');
    expect(payload.detail).toBe('pedido-passo-5');
    expect(payload.lojas).toBe(4);
  });

  it('zero é um valor, não uma ausência — `??`, nunca `||`', async () => {
    // O quase-erro clássico: `result.lojas || null` transformaria "nenhuma loja
    // casou" em "não sei quantas", e `req.retryCount || 0` esconderia a
    // diferença entre a primeira tentativa e uma contagem ausente.
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'aviso',
      lojas: 0,
    } satisfies TaskResultish);

    await run({ data: { code: 12, shopId: 0 }, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.lojas).toBe(0);
    expect(payload.shopId).toBe(0);
    expect(payload.retryCount).toBe(0);
  });

  it('code e shopId saem do payload CRU, então sobrevivem a um descarte do schema', async () => {
    // O descarte de parse do pipeline compartilhado não devolve payload
    // validado nem resultado de canal — exatamente a entrega cujos ids você
    // mais precisa nomeados.
    channel.handleNotificationTask.mockResolvedValueOnce({ outcome: 'dropped' });

    await run({ data: { code: 28, shopId: 987654 }, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.code).toBe(28);
    expect(payload.shopId).toBe(987654);
    expect(payload.kind).toBeNull();
  });

  it('code/shopId de tipo errado viram null, nunca um cast', async () => {
    await run({ data: { code: '28', shopId: '987654' }, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.code).toBeNull();
    expect(payload.shopId).toBeNull();
  });

  it('nunca registra o corpo do push nem os dados da Shopee', async () => {
    // Um push da Shopee carrega ids de recurso do comprador em `data`, e a
    // linha é lida por operadores. `data` (e o payload inteiro) fica de fora.
    await run({
      data: { code: 3, shopId: 987654, data: { ordersn: 'SEGREDO-DO-COMPRADOR' } },
      retryCount: 0,
    });

    const serializado = JSON.stringify(loggedPayload(info));
    expect(serializado).not.toContain('SEGREDO-DO-COMPRADOR');
    expect(serializado).not.toContain('ordersn');
  });
});

describe('as opções declaradas do processShopeeNotification', () => {
  /**
   * `retryConfig.maxAttempts` must equal `TASK_MAX_ATTEMPTS`. The handler
   * persists-instead-of-throws on `retryCount === TASK_MAX_ATTEMPTS - 1`, so a
   * queue configured to give up EARLIER never delivers the last attempt and the
   * push is dropped with no failure doc; configured LATER, the queue keeps
   * re-delivering a payload the handler has already recorded.
   */
  const endpoint = (processShopeeNotification as unknown as { __endpoint: Record<string, unknown> })
    .__endpoint;

  it('desiste exatamente quando o handler começa a persistir', () => {
    const trigger = endpoint.taskQueueTrigger as { retryConfig?: { maxAttempts?: number } };
    expect(trigger.retryConfig?.maxAttempts).toBe(TASK_MAX_ATTEMPTS);
  });

  it('declara o backoff e os limites de vazão, não só o número de tentativas', () => {
    // O par do teste acima: aquele fixa QUANDO desistimos, este fixa a que
    // ritmo tentamos. Uma vazão maior que a que a Shopee tolera vira 429 no
    // nosso lado do fio, e um backoff mínimo menor apaga a janela em que uma
    // instabilidade passageira se resolve sozinha.
    const trigger = endpoint.taskQueueTrigger as {
      retryConfig?: {
        minBackoffSeconds?: number;
        maxBackoffSeconds?: number;
        maxDoublings?: number;
      };
      rateLimits?: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
    };
    expect(trigger.retryConfig?.minBackoffSeconds).toBe(30);
    expect(trigger.retryConfig?.maxBackoffSeconds).toBe(300);
    expect(trigger.retryConfig?.maxDoublings).toBe(2);
    expect(trigger.rateLimits?.maxConcurrentDispatches).toBe(3);
    expect(trigger.rateLimits?.maxDispatchesPerSecond).toBe(5);
  });

  it('declara o invoker, a perna cuja ausência falha invisivelmente (#1133)', () => {
    const trigger = endpoint.taskQueueTrigger as { invoker?: string[] };
    expect(trigger.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });

  it('vincula as duas credenciais de parceiro que os braços de conta assinam', () => {
    // Sem elas cada entrega de code 1/2/12 estoura `ShopeeConfigError`, que o
    // pipeline trata como transitório e estaciona depois das tentativas — os
    // braços de ack e de park continuam funcionando, então a falha parece
    // parcial em vez de uma credencial que ninguém vinculou.
    //
    // Asserção sobre o JSON do `__endpoint` e não sobre a sua forma interna
    // (`secretEnvironmentVariables`/`{ key }` é interno do firebase-functions e
    // pode mudar de formato entre versões) — mesmo padrão de
    // apps/mercado-livre/functions/src/index.test.ts.
    const serializado = JSON.stringify(endpoint);
    expect(serializado).toContain('SHOPEE_PARTNER_ID');
    expect(serializado).toContain('SHOPEE_PARTNER_KEY');
  });

  it('o nome do export É o nome da fila — um rename pela metade não sobe', () => {
    // `__endpoint.id` é preenchido pela análise de codebase do Firebase a
    // partir do nome do EXPORT, que não está rodando aqui — então fixamos a
    // constante contra o literal, como o irmão do Mercado Pago faz. O risco é
    // silencioso: o Admin SDK enfileira alegremente num caminho de fila que não
    // existe e a task simplesmente nunca chega.
    expect(processShopeeNotification).toBeDefined();
    expect(SHOPEE_NOTIFICATION_QUEUE).toBe('processShopeeNotification');
  });
});
