import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';

import { ShopeeTasksDisabledError } from '../shopeeTasks';
import { SHOPEE_STOCK_SEND_QUEUE } from './constantesEstoque';
import { ShopeeStockTasksDisabledError } from './errosEstoque';
import type { TarefaDeEstoqueShopee } from './planoEstoque';

/**
 * Mocked: the transport seams (the Functions SDK's queue/enqueue and the admin
 * app binding) only.
 *
 * ⚠️ `../shopeeTasks` is mocked PARTIALLY, on purpose: `shopeeTasksRegion` stays
 * the real one (the region wiring is what two of these tests are about) and only
 * the valve can be forced, so the "one reader" claim is testable without
 * neutralising anything else. And `./constantesEstoque` is NOT mocked — the
 * queue name is the half of the rename trap that lives on this side, so a test
 * that pinned a mocked name would pin nothing.
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

vi.mock('../shopeeTasks', async () => {
  const real = await vi.importActual<typeof import('../shopeeTasks')>('../shopeeTasks');
  return {
    ...real,
    shopeeTasksDesabilitado: (): boolean => h.valvula() ?? real.shopeeTasksDesabilitado(),
  };
});

const { createShopeeStockTaskScheduler } = await import('./shopeeStockTasks');

const FONTE = readFileSync(
  fileURLToPath(new URL('./shopeeStockTasks.ts', import.meta.url)),
  'utf8',
);

/**
 * A no-model listing (`modelId: 0`) — the shape that dies first if anything
 * between the planner and the wire tests an id for truthiness.
 */
const payload: TarefaDeEstoqueShopee = {
  integracaoId: 'int-1',
  produtoId: 'prod-abc',
  linkDocId: 'link-1',
  itemId: 2500139861,
  categoryId: null,
  sweepId: 'sweep-1',
  sweepComputadoEmMs: 1_760_000_000_000,
  reenfileiramentos: 0,
  parte: 1,
  totalDePartes: 1,
  modelos: [{ modelId: 0, produtoId: 'prod-abc', varLinkDocId: null, quantidade: 0 }],
};

/** The options object the LAST enqueue actually received. */
function ultimasOpcoes(): unknown {
  const chamada = h.enqueue.mock.calls.at(-1);
  expect(chamada).toBeDefined();
  return chamada?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.valvula.mockReturnValue(null);
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createShopeeStockTaskScheduler', () => {
  it('1 — usa o nome da fila qualificado pela região', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await createShopeeStockTaskScheduler().enqueue(payload);

    // A string INTEIRA, literal: o nome da fila é metade de uma armadilha de
    // rename cuja outra metade é o nome EXPORTADO da função implantada. Pinar o
    // caminho por aqui é o que obriga quem renomear um lado a encarar o outro —
    // e o que quebra num rename pela metade não é o começo da varredura, é o
    // re-enfileiramento DELA MESMA (a pausa e a rajada).
    expect(h.taskQueue).toHaveBeenCalledWith('locations/us-east1/functions/sendShopeeStock');
    expect(SHOPEE_STOCK_SEND_QUEUE).toBe('sendShopeeStock');
  });

  it('2 — cai para FUNCTIONS_REGION quando SHOPEE_TASKS_REGION não está posta', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'southamerica-east1');

    await createShopeeStockTaskScheduler().enqueue(payload);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/sendShopeeStock',
    );
  });

  it('3 — região ausente LANÇA no primeiro enqueue, não antes, e NUNCA assume um padrão', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);

    // Construir o scheduler não lê região nenhuma…
    const agendador = createShopeeStockTaskScheduler();
    expect(h.taskQueue).not.toHaveBeenCalled();

    // …e a recusa acontece ANTES de qualquer chamada de transporte: sem default
    // deliberadamente, porque o Admin SDK resolveria `us-central1`, a tarefa
    // seria descartada em silêncio e quem enfileirou veria sucesso (#1108).
    await expect(agendador.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('4 — PAR: com scheduleDelaySeconds a opção vai com o valor', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await createShopeeStockTaskScheduler().enqueue(payload, { scheduleDelaySeconds: 30 });

    expect(h.enqueue).toHaveBeenLastCalledWith(payload, { scheduleDelaySeconds: 30 });
    expect(ultimasOpcoes()).toEqual({ scheduleDelaySeconds: 30 });
  });

  it('5 — QUASE-IGUAL: sem atraso a CHAVE é OMITIDA, não enviada como undefined', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    const agendador = createShopeeStockTaskScheduler();

    // ⛔ O objeto de opções vai para o Cloud Tasks: "sem atraso" e "atraso
    // indefinido" não são o mesmo pedido. `toHaveBeenCalledWith` compara como
    // `toEqual` e IGNORA chaves com undefined, então `{scheduleDelaySeconds:
    // undefined}` passaria por `{}` — a asserção que mata o mutante é sobre o
    // ARGUMENTO em si, que precisa ser undefined inteiro.
    await agendador.enqueue(payload);
    expect(ultimasOpcoes()).toBeUndefined();

    // E um objeto de opções VAZIO é o mesmo pedido que nenhum objeto.
    await agendador.enqueue(payload, {});
    expect(ultimasOpcoes()).toBeUndefined();

    // Um atraso explícito de zero, por outro lado, É um valor e sobrevive: zero
    // segundos de espera não é "sem opção", e um `if (atraso)` aqui o perderia.
    await agendador.enqueue(payload, { scheduleDelaySeconds: 0 });
    expect(ultimasOpcoes()).toEqual({ scheduleDelaySeconds: 0 });
  });

  it('6 — o payload atravessa VERBATIM: modelId 0 e quantidade 0 não somem', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await createShopeeStockTaskScheduler().enqueue(payload);

    // Mesma referência: este adaptador não reconstrói, não filtra e não
    // normaliza nada. `modelId: 0` é o anúncio SEM variação e `quantidade: 0` é
    // uma quantidade real — qualquer teste de veracidade no caminho vira um
    // erro de ESTRUTURA lá na Shopee, não um número errado.
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]?.[0]).toBe(payload);
  });

  it('7 — SHOPEE_TASKS_DISABLED=1 devolve um scheduler que LANÇA, sem tocar no transporte', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    const agendador = createShopeeStockTaskScheduler();

    await expect(agendador.enqueue(payload)).rejects.toBeInstanceOf(ShopeeStockTasksDisabledError);
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('8 — a válvula fechada LANÇA mesmo com um atraso pedido', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await expect(
      createShopeeStockTaskScheduler().enqueue(payload, { scheduleDelaySeconds: 30 }),
    ).rejects.toBeInstanceOf(ShopeeStockTasksDisabledError);
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('9 — a classe é a DO ESTOQUE, e as duas não se confundem nos dois sentidos', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');

    const capturado: unknown = await createShopeeStockTaskScheduler()
      .enqueue(payload)
      .then(
        () => null,
        (e: unknown) => e,
      );

    // A compartilhada está DENTRO de `erroContidoPorConta`: se fosse ela, uma
    // válvula fechada viraria um `lastError` por conta e a varredura reportaria
    // um tique verde sobre uma pane de implantação inteira. As duas estendem
    // Error e nenhuma estende a outra — por isso o `instanceof` precisa falhar
    // NOS DOIS SENTIDOS, e não só no que a gente esperava.
    expect(capturado).toBeInstanceOf(ShopeeStockTasksDisabledError);
    expect(capturado).not.toBeInstanceOf(ShopeeTasksDisabledError);
    expect(new ShopeeTasksDisabledError()).not.toBeInstanceOf(ShopeeStockTasksDisabledError);
    expect((capturado as Error).name).toBe('ShopeeStockTasksDisabledError');
    expect((capturado as Error).message).toContain('SHOPEE_TASKS_DISABLED');
  });

  it('10 — lê a válvula por shopeeTasksDesabilitado, não pela variável', async () => {
    // A variável está VAZIA e mesmo assim o scheduler recusa: o que decide é a
    // função, que é a ÚNICA leitora de SHOPEE_TASKS_DISABLED neste app.
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    h.valvula.mockReturnValue(true);

    await expect(createShopeeStockTaskScheduler().enqueue(payload)).rejects.toBeInstanceOf(
      ShopeeStockTasksDisabledError,
    );
    expect(h.valvula).toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('11 — a decisão é tomada na CONSTRUÇÃO, não a cada enqueue', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    const agendador = createShopeeStockTaskScheduler();

    // Fechar a válvula DEPOIS de construir não muda este scheduler: quem quer a
    // decisão nova constrói outro. É o mesmo contrato do adaptador da importação
    // em massa, e é o que deixa a válvula testável sem re-import do módulo.
    h.valvula.mockReturnValue(true);
    await agendador.enqueue(payload);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('12 — a FONTE não lê a variável de ambiente: ela chama a única leitora', () => {
    // A leitura precisa continuar indireta. Um `process.env` aqui não falharia
    // nenhum gate — só tornaria FALSA a frase que o docblock da leitora afirma,
    // e a próxima pessoa a mudar o significado de '1' mudaria um lugar só.
    const nome = ['SHOPEE', 'TASKS', 'DISABLED'].join('_');
    expect(FONTE).not.toContain(`process.env.${nome}`);
    expect(FONTE).not.toContain(`process.env[`);
    expect(FONTE).toContain(
      "import { shopeeTasksDesabilitado, shopeeTasksRegion } from '../shopeeTasks'",
    );
    expect(FONTE).toContain('shopeeTasksDesabilitado()');
  });
});
