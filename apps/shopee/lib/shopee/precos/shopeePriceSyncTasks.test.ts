import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';

import { ShopeeMassImportTasksDisabledError } from '../produtos/errosImportacao';
import { ShopeeTasksDisabledError } from '../shopeeTasks';
import type { EnvioPrecoShopeeTaskPayload } from './atualizarPrecos';
import { SHOPEE_PRICE_SYNC_QUEUE } from './constantesPreco';
import { ShopeePriceSyncTasksDisabledError } from './errosPreco';

/**
 * Mocked: the transport seams (the Functions SDK's queue/enqueue and the admin
 * app binding) only — `../estoque/shopeeStockTasks.test.ts`'s shape.
 *
 * ⚠️ `../shopeeTasks` is mocked PARTIALLY, on purpose: `shopeeTasksRegion` stays
 * the real one (the region wiring is what three of these tests are about) and
 * only the valve can be forced, so the "one reader" claim is testable without
 * neutralising anything else. And `./constantesPreco` is NOT mocked — the queue
 * name is the half of the rename trap that lives on this side, so a test that
 * pinned a mocked name would pin nothing.
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

const { createShopeePriceSyncScheduler } = await import('./shopeePriceSyncTasks');

const FONTE = readFileSync(
  fileURLToPath(new URL('./shopeePriceSyncTasks.ts', import.meta.url)),
  'utf8',
);

/** The job's routing body — fixture ids only. */
const payload: EnvioPrecoShopeeTaskPayload = { jobId: 'job-1', integracaoId: 'int-1' };

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

describe('createShopeePriceSyncScheduler', () => {
  it('1 — usa o nome da fila qualificado pela região, e o nome é o da QUARTA fila', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await createShopeePriceSyncScheduler().enqueue(payload);

    // A string INTEIRA, literal: o nome da fila é metade de uma armadilha de
    // rename cuja outra metade é o nome EXPORTADO da função implantada. O que um
    // rename pela metade quebra aqui não é o primeiro despacho — é a
    // CONTINUAÇÃO do job, que fica `running` até a recuperação de órfão.
    expect(h.taskQueue).toHaveBeenCalledWith('locations/us-east1/functions/processShopeePriceSync');
    expect(SHOPEE_PRICE_SYNC_QUEUE).toBe('processShopeePriceSync');
    expect(h.getFunctions).toHaveBeenCalledWith({ __app: true });
  });

  it('2 — cai para FUNCTIONS_REGION quando SHOPEE_TASKS_REGION não está posta', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'southamerica-east1');

    await createShopeePriceSyncScheduler().enqueue(payload);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/processShopeePriceSync',
    );
  });

  it('3 — região ausente LANÇA no primeiro enqueue, não antes, e NUNCA assume um padrão', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);

    // Construir o scheduler não lê região nenhuma — um despacho que termina sem
    // reenfileirar (um `noop`, o `completed`) não falha num botão que não usou…
    const agendador = createShopeePriceSyncScheduler();
    expect(h.taskQueue).not.toHaveBeenCalled();

    // …e a recusa acontece ANTES de qualquer chamada de transporte: sem default
    // deliberadamente, porque o Admin SDK resolveria `us-central1`, a tarefa
    // seria descartada em silêncio e quem enfileirou veria sucesso (#1108).
    await expect(agendador.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('4 — PAR: com scheduleDelaySeconds a opção vai com o valor (a pausa e o parque)', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    const agendador = createShopeePriceSyncScheduler();

    // O `Retry-After` de uma rajada…
    await agendador.enqueue(payload, { scheduleDelaySeconds: 42 });
    expect(ultimasOpcoes()).toEqual({ scheduleDelaySeconds: 42 });

    // …e o parque da cota diária (até a próxima 00:00 UTC+8, mais jitter).
    await agendador.enqueue(payload, { scheduleDelaySeconds: 10814 });
    expect(ultimasOpcoes()).toEqual({ scheduleDelaySeconds: 10814 });
  });

  it('5 — QUASE-IGUAL (M49): sem atraso a CHAVE é OMITIDA, não enviada como undefined', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    const agendador = createShopeePriceSyncScheduler();

    // ⛔ O objeto de opções vai para o Cloud Tasks: "sem atraso" e "atraso
    // indefinido" não são o mesmo pedido. `toHaveBeenCalledWith` compara como
    // `toEqual` e IGNORA chaves com undefined, então `{scheduleDelaySeconds:
    // undefined}` passaria por `{}` — a asserção que mata o mutante é sobre o
    // ARGUMENTO em si, que precisa ser undefined inteiro. É o caminho de TODA
    // continuação comum do job (planejar a próxima página, drenar o próximo lote).
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

  it('6 — o payload atravessa VERBATIM, a mesma referência', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await createShopeePriceSyncScheduler().enqueue(payload);

    // Este adaptador não reconstrói nem acrescenta nada: o schema da task é
    // `.strict()`, então uma chave a mais posta AQUI faria o despacho descartar
    // a própria continuação do job.
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]?.[0]).toBe(payload);
  });

  it('7 — SHOPEE_TASKS_DISABLED=1 devolve um scheduler que LANÇA, sem tocar no transporte', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    const agendador = createShopeePriceSyncScheduler();

    await expect(agendador.enqueue(payload)).rejects.toBeInstanceOf(
      ShopeePriceSyncTasksDisabledError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('8 — a válvula fechada LANÇA mesmo com um atraso pedido (o parque não escapa)', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');

    await expect(
      createShopeePriceSyncScheduler().enqueue(payload, { scheduleDelaySeconds: 10814 }),
    ).rejects.toBeInstanceOf(ShopeePriceSyncTasksDisabledError);
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('9 — a classe é a DO PREÇO, e ela não se confunde com as duas irmãs em sentido nenhum', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');

    const capturado: unknown = await createShopeePriceSyncScheduler()
      .enqueue(payload)
      .then(
        () => null,
        (e: unknown) => e,
      );

    // A compartilhada está DENTRO de `erroContidoPorConta`: se fosse ela, uma
    // válvula fechada viraria o `lastError` de uma conta em vez de carimbar o
    // job `failed`. E a da importação em massa é a gêmea mais provável de uma
    // cópia — o job só narra a DELE (`ehFalhaDePrimeiraTentativa`), então uma
    // classe trocada cairia na escada de três tentativas em vez de parar.
    expect(capturado).toBeInstanceOf(ShopeePriceSyncTasksDisabledError);
    expect(capturado).not.toBeInstanceOf(ShopeeTasksDisabledError);
    expect(capturado).not.toBeInstanceOf(ShopeeMassImportTasksDisabledError);
    expect(new ShopeeTasksDisabledError()).not.toBeInstanceOf(ShopeePriceSyncTasksDisabledError);
    expect(new ShopeeMassImportTasksDisabledError()).not.toBeInstanceOf(
      ShopeePriceSyncTasksDisabledError,
    );
    expect((capturado as Error).name).toBe('ShopeePriceSyncTasksDisabledError');
    expect((capturado as Error).message).toContain('SHOPEE_TASKS_DISABLED');
    // O 503 que a rota de início responde vem da própria classe.
    expect((capturado as ShopeePriceSyncTasksDisabledError).status).toBe(503);
  });

  it('10 — lê a válvula por shopeeTasksDesabilitado, não pela variável', async () => {
    // A variável está VAZIA e mesmo assim o scheduler recusa: o que decide é a
    // função, que é a ÚNICA leitora de SHOPEE_TASKS_DISABLED neste app.
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    h.valvula.mockReturnValue(true);

    await expect(createShopeePriceSyncScheduler().enqueue(payload)).rejects.toBeInstanceOf(
      ShopeePriceSyncTasksDisabledError,
    );
    expect(h.valvula).toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('11 — a decisão é tomada na CONSTRUÇÃO, não a cada enqueue', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
    vi.stubEnv('SHOPEE_TASKS_REGION', 'us-east1');
    const agendador = createShopeePriceSyncScheduler();

    // Fechar a válvula DEPOIS de construir não muda este scheduler: quem quer a
    // decisão nova constrói outro — e a entrada das functions constrói um por
    // despacho. O mesmo contrato dos dois adaptadores irmãos.
    h.valvula.mockReturnValue(true);
    await agendador.enqueue(payload);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('12 — a FONTE não lê o ambiente: ela chama a única leitora', () => {
    // A leitura precisa continuar indireta. Montada em tempo de execução,
    // porque este arquivo está sob `precos/` e a grafia crua é o que o grep de
    // disciplina da pasta procura.
    const lerAmbiente = ['process', 'env'].join('.');
    expect(FONTE.includes(lerAmbiente)).toBe(false);
    expect(FONTE).toContain(
      "import { shopeeTasksDesabilitado, shopeeTasksRegion } from '../shopeeTasks'",
    );
    expect(FONTE).toContain('shopeeTasksDesabilitado()');
  });

  it('13 — ⛔ o adaptador importa o job SÓ como TIPOS — nunca o grafo do job em tempo de execução', () => {
    // O job declara a interface (`AgendadorPrecoShopee`) e nunca importa este
    // adaptador; o adaptador, por sua vez, só enxerga os TIPOS do job. Um
    // `import { … } from './atualizarPrecos'` sem `type` carregaria o grafo
    // inteiro do job (Firestore, schemas, remetente) em quem só quer enfileirar
    // — e fecharia um ciclo o dia em que o job importasse o adaptador.
    const importsDoJob = FONTE.match(/^import[^;]*from '\.\/atualizarPrecos';/gms) ?? [];
    expect(importsDoJob).toHaveLength(1);
    expect(importsDoJob[0]?.startsWith('import type {')).toBe(true);
    // ÂNCORA: a interface realmente vem de lá (sem ela o laço acima passaria
    // sobre um arquivo que declarasse a sua própria cópia).
    expect(importsDoJob[0]).toContain('AgendadorPrecoShopee');
    expect(FONTE).not.toMatch(/interface AgendadorPrecoShopee/);
  });
});
