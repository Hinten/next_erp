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
      orderSn: null,
      itensSemProduto: null,
      retryCount: 1,
      readCache: expect.anything(),
    });
  });

  it('uma importação de pedido registra o order_sn e as linhas sem produto', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'pedido',
      detail: 'criado',
      orderSn: '220810QSK8S7BX',
      itensSemProduto: 2,
    } satisfies TaskResultish);

    await run({ data: { code: 3, shopId: 987654 }, retryCount: 0 });

    const payload = loggedPayload(info);
    // ⚠️ `order_sn` NÃO é dado do comprador: é o `numero` do pedido, a única
    // alça de busca de um operador, e já está em claro num segmento do id do
    // documento de `notificacoesShopee`.
    expect(payload.orderSn).toBe('220810QSK8S7BX');
    // ⚠️ E este é o campo que separa "importado" de "importado e ninguém
    // percebeu que 2 linhas ficaram sem produto" — um `done` que ainda exige
    // ação humana.
    expect(payload.itensSemProduto).toBe(2);
  });

  it('zero linhas sem produto é um VALOR — o `?? null` não pode achatá-lo', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'pedido',
      orderSn: '220810QSK8S7BX',
      itensSemProduto: 0,
    } satisfies TaskResultish);

    await run({ data: { code: 3, shopId: 987654 }, retryCount: 0 });

    expect(loggedPayload(info).itensSemProduto).toBe(0);
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
    for (const key of ['kind', 'detail', 'lojas', 'orderSn', 'itensSemProduto']) {
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
    //
    // ⚠️ O limite exato mudou no passo 5 e vale dizê-lo: o `order_sn` do
    // RESULTADO é registrado (é o `numero` do pedido), mas o corpo do push
    // continua não sendo lido — nem quando carrega o mesmo campo. O que prova
    // isso é o valor: o `data.ordersn` abaixo não aparece em lugar nenhum,
    // porque a linha lê o `TaskResult`, nunca `req.data.data`.
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'pedido',
      orderSn: '220810QSK8S7BX',
    } satisfies TaskResultish);

    await run({
      data: { code: 3, shopId: 987654, data: { ordersn: 'SEGREDO-DO-COMPRADOR' } },
      retryCount: 0,
    });

    const serializado = JSON.stringify(loggedPayload(info));
    expect(serializado).not.toContain('SEGREDO-DO-COMPRADOR');
    expect(serializado).toContain('220810QSK8S7BX');
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

  it('tem timeoutSeconds 300 — o padrão de 60 s não absorve a importação do pedido', () => {
    // Duas chamadas Shopee, até duas consultas de collectionGroup e até quatro
    // sondagens de SKU POR LINHA, uma transação e um incidente por linha sem
    // vínculo. O padrão gen2 de 60 s estoura num pedido de 20 linhas, e um
    // timeout no meio da importação é a única falha que entrega um pedido
    // meio-escrito a uma re-tentativa.
    expect(endpoint.timeoutSeconds).toBe(300);
  });

  it('⚠️ e NÃO é 540 — a escada inteira cabe em MEIA janela da varredura horária', () => {
    // O par de quase-falha do teste acima, e a asserção precisa ser uma que
    // DISTINGA os dois números. ⚠️ "cabe dentro de uma hora" não distingue:
    // com `TASK_MAX_ATTEMPTS = 3`, 540 s de execução mais 2 backoffs de 300 s
    // dão ~37 min e passariam igual — uma versão anterior deste comentário
    // afirmava o contrário e estava aritmeticamente errada. O que separa os
    // dois é a MARGEM: a escada com 300 s fecha em ~25 min, menos de metade da
    // janela horária em que a varredura quente re-conduz um `failed`; com 540
    // sobra metade disso, e um orçamento tão acima do teto real do trabalho não
    // faz uma importação lenta terminar — faz uma TRAVADA ficar invisível por
    // mais tempo (o argumento que o `monitorShopeePushConfig` já registra).
    const trigger = endpoint.taskQueueTrigger as { retryConfig?: { maxBackoffSeconds?: number } };
    const backoff = trigger.retryConfig?.maxBackoffSeconds ?? 0;
    const execucao = endpoint.timeoutSeconds as number;
    // Tentativas rodam N vezes; os backoffs ficam ENTRE elas, logo N-1.
    const escadaSegundos = TASK_MAX_ATTEMPTS * execucao + (TASK_MAX_ATTEMPTS - 1) * backoff;
    expect(execucao).not.toBe(540);
    expect(execucao).not.toBe(60); // nem o padrão gen2, que é o que havia antes
    expect(escadaSegundos).toBeLessThanOrEqual(1800);
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

  // QUASE-FALHA: um `toContain` também casa um SUPERSTRING e não vê um nome a
  // mais. `secrets:` é uma whitelist que o operador concede um a um; um nome que
  // entra por cópia sobe no deploy e derruba a FUNÇÃO no startup com 403 do
  // Secret Manager — e aí toda entrega volta 5xx sem o corpo do handler rodar,
  // então nada é persistido em `notificacoesShopee`. Mesma asserção exata que
  // `index.test.ts` faz nos dois agendamentos.
  it('não vincula um TERCEIRO segredo, nem um nome parecido', () => {
    const nomes = (endpoint.secretEnvironmentVariables as { key?: string }[] | undefined)?.map(
      (s) => s.key,
    );
    expect(nomes).toEqual(['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY']);
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
