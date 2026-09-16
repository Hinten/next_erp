import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';

import {
  MAX_TENTATIVAS,
  SHOPEE_MASS_IMPORT_QUEUE,
} from '../../lib/shopee/produtos/importacaoMassa';

/**
 * What lives ONLY in this file is the SHAPE of the second queue — its declared
 * options and its one log line — plus the two things the wiring can silently get
 * wrong: dropping a malformed payload instead of retrying it for ever, and
 * injecting an importer that is not the real one.
 *
 * The job's own behaviour (the scan, the drain, the 22-row disposition table)
 * is asserted one layer down, in `lib/shopee/produtos/importacaoMassa.test.ts`
 * against the real FakeDb — so `processarImportacaoShopee` is MOCKED here. The
 * split is `processNotification.test.ts`'s: per-option assertions live with the
 * function, the cross-cutting set (exact secrets, the ≤ 1800 s ladder,
 * exhaustiveness) lives in `index.test.ts`.
 *
 * `tasksInvoker.ts` reads `TASKS_INVOKER_SA` at module scope, so stub it before
 * the dynamic import and restore it afterwards so it cannot leak into other
 * files sharing this vitest project. `FUNCTIONS_REGION` is not read by this
 * module today (it declares no `region:` — `options.ts` sets it globally), but
 * it is stubbed anyway so the file keeps working if one ever lands.
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

// The job engine is mocked; everything else the module imports is REAL — above
// all `importacaoShopeeTaskSchema` (the drop below must be the schema's own
// verdict, not a fixture's) and `importarAnuncioShopee` (the identity test).
const job = vi.hoisted(() => ({
  // ⚠️ A assinatura é declarada aqui (e não `vi.fn(async () => …)`) porque é ela
  // que tipa `mock.calls[0]`: um mock sem parâmetros registra as chamadas como
  // `[]`, e aí a asserção sobre os ARGUMENTOS — que é o teste — não compila.
  processarImportacaoShopee: vi.fn(
    async (
      _deps: Record<string, unknown>,
      _payload: Record<string, unknown>,
      _retryCount: number,
    ): Promise<string> => 'done',
  ),
}));
vi.mock('../../lib/shopee/produtos/importacaoMassa', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/shopee/produtos/importacaoMassa')>()),
  processarImportacaoShopee: job.processarImportacaoShopee,
}));

const tasks = vi.hoisted(() => {
  const agendador = { enqueue: vi.fn(async () => {}) };
  return { agendador, createShopeeMassImportScheduler: vi.fn(() => agendador) };
});
vi.mock('../../lib/shopee/produtos/shopeeMassImportTasks', () => ({
  createShopeeMassImportScheduler: tasks.createShopeeMassImportScheduler,
}));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { processShopeeMassImport } = await import('./processMassImport');
const { importarAnuncioShopee } = await import('../../lib/shopee/produtos/importarAnuncio');

type RunnableTask = { data: unknown; retryCount?: number };

function run(req: RunnableTask): Promise<unknown> {
  return (processShopeeMassImport as unknown as { run(r: RunnableTask): Promise<unknown> }).run(
    req,
  );
}

type ChamadaDoJob = [Record<string, unknown>, Record<string, unknown>, number];

/** The arguments of the single `processarImportacaoShopee` call. */
function chamadaDoJob(): ChamadaDoJob {
  expect(job.processarImportacaoShopee).toHaveBeenCalledTimes(1);
  const chamada = job.processarImportacaoShopee.mock.calls[0];
  expect(chamada).toBeDefined();
  return chamada as ChamadaDoJob;
}

/** The single `logger.*` payload the handler emitted. */
function loggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

const endpoint = (processShopeeMassImport as unknown as { __endpoint: Record<string, unknown> })
  .__endpoint;

let info: ReturnType<typeof vi.spyOn>;
let erro: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  job.processarImportacaoShopee.mockResolvedValue('done');
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  erro = vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  erro.mockRestore();
});

describe('as opções declaradas do processShopeeMassImport', () => {
  it('timeoutSeconds 300 e a escada fecha em 1500 s', () => {
    // ⚠️ 300, e NÃO os 540 do irmão do Mercado Livre — e a asserção precisa ser
    // uma que DISTINGA os dois. A invariante que `index.test.ts` fixa para toda
    // fila desta codebase é `tentativas × timeout + (tentativas − 1) × backoff
    // ≤ 1800`: com 300 dá 3×300 + 2×300 = 1500 ✅; com os 540 do ML dá
    // 3×540 + 2×300 = 2220 ✗. Ou seja, copiar o número do ML derrubaria a
    // asserção compartilhada — mas só se este número existir, e um
    // `onTaskDispatched` sem `timeoutSeconds` roda com o padrão gen2 de 60 s.
    const trigger = endpoint.taskQueueTrigger as {
      retryConfig?: {
        maxAttempts?: number;
        minBackoffSeconds?: number;
        maxBackoffSeconds?: number;
        maxDoublings?: number;
      };
    };
    expect(endpoint.timeoutSeconds).toBe(300);
    expect(endpoint.timeoutSeconds).not.toBe(540);
    expect(endpoint.timeoutSeconds).not.toBe(60);
    expect(trigger.retryConfig?.maxAttempts).toBe(MAX_TENTATIVAS);
    expect(trigger.retryConfig?.minBackoffSeconds).toBe(30);
    expect(trigger.retryConfig?.maxBackoffSeconds).toBe(300);
    expect(trigger.retryConfig?.maxDoublings).toBe(2);

    const tentativas = trigger.retryConfig?.maxAttempts ?? 0;
    const escadaSegundos =
      tentativas * (endpoint.timeoutSeconds as number) +
      Math.max(tentativas - 1, 0) * (trigger.retryConfig?.maxBackoffSeconds ?? 0);
    expect(escadaSegundos).toBe(1500);
    expect(escadaSegundos).toBeLessThanOrEqual(1800);
  });

  it('maxConcurrentDispatches 1 — o doc do job é o checkpoint', () => {
    // O documento do job É o checkpoint: `fila`, `nextOffset` e os contadores
    // são lidos, avançados e regravados pelo despacho. Dois despachos do MESMO
    // job em voo correriam esse documento e re-drenariam uma página já drenada.
    //
    // ⚠️ QUASE-FALHA: os valores da fila de notificação (3 e 5) são os que uma
    // cópia traria junto, passam em qualquer asserção de "existe um limite" e
    // quebram exatamente esta propriedade.
    const trigger = endpoint.taskQueueTrigger as {
      rateLimits?: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
    };
    expect(trigger.rateLimits?.maxConcurrentDispatches).toBe(1);
    expect(trigger.rateLimits?.maxDispatchesPerSecond).toBe(1);
    expect(trigger.rateLimits?.maxConcurrentDispatches).not.toBe(3);
    expect(trigger.rateLimits?.maxDispatchesPerSecond).not.toBe(5);
  });

  it('nenhum segredo além dos dois de parceiro', () => {
    // `secrets:` é uma whitelist que o operador concede um a um. Um nome que
    // entra por cópia sobe no deploy e derruba a FUNÇÃO no startup com 403 do
    // Secret Manager — e aí nenhum despacho roda, o job fica `running` e não há
    // sweep nenhum atrás deste caminho para re-conduzi-lo.
    //
    // ⚠️ Um `toContain` casaria um SUPERSTRING e não veria um nome a mais; o
    // conjunto exato vê. A mesma asserção que `index.test.ts` faz para as duas
    // famílias, feita aqui também porque este é o arquivo que declara a lista.
    const nomes = (endpoint.secretEnvironmentVariables as { key?: string }[] | undefined)?.map(
      (s) => s.key,
    );
    expect(nomes).toEqual(['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY']);
  });

  it('declara o invoker, a perna cuja ausência falha invisivelmente (#1133)', () => {
    // ⚠️ DUAS identidades despacham esta fila — a SA de runtime do App Hosting
    // (o primeiro enqueue da rota) e a SA de runtime das functions (toda
    // continuação e a pausa por rate limit) — e a lista é AUTORITATIVA: o
    // deploy SUBSTITUI os membros dos dois bindings, então deixar uma de fora
    // tira a role dela. A ausência falha invisivelmente: o enqueue já retornou
    // sucesso e o nosso código nunca vê o 403 da perna de dispatch.
    const trigger = endpoint.taskQueueTrigger as { invoker?: string[] };
    expect(trigger.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });
});

describe('o handler do processShopeeMassImport', () => {
  it('um payload inválido é DESCARTADO com um logger.error e nada é reprocessado', async () => {
    // Um bug de código ou de enfileiramento: esta fila só recebe o NOSSO
    // `{ jobId, integracaoId }`. Não há o que re-tentar (mais três tentativas
    // leriam os mesmos bytes do mesmo jeito) e não há o que carimbar (sem
    // `jobId` não existe documento para marcar `failed`), então a task é
    // descartada — numa linha, alto.
    await run({ data: { jobId: '', integracaoId: 'int-1' }, retryCount: 0 });

    expect(job.processarImportacaoShopee).not.toHaveBeenCalled();
    expect(tasks.createShopeeMassImportScheduler).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(loggedPayload(erro)).toEqual({
      queue: SHOPEE_MASS_IMPORT_QUEUE,
      campos: 'jobId',
    });
  });

  it('⛔ o descarte registra CAMINHOS de campo, nunca um valor do corpo', async () => {
    // Par de quase-falha do teste acima: aquele mostra que o descarte acontece,
    // este mostra ONDE ele para. O corpo que não passou no schema é justamente
    // o que ninguém validou, e a linha é lida por operadores (#1015) — então o
    // que sai é `issues[].path`, nunca o valor.
    await run({
      data: { jobId: 7, integracaoId: 'int-1', extra: 'SEGREDO-NAO-LOGAR' },
      retryCount: 0,
    });

    const serializado = JSON.stringify(loggedPayload(erro));
    expect(serializado).toContain('jobId');
    expect(serializado).not.toContain('SEGREDO-NAO-LOGAR');
    // ⚠️ E o `.passthrough()` do schema é o motivo de `extra` NÃO aparecer como
    // campo inválido: uma chave futura não pode derrubar uma task.
    expect(serializado).not.toContain('extra');
  });

  it('um payload válido chama processarImportacaoShopee com o retryCount da task', async () => {
    job.processarImportacaoShopee.mockResolvedValueOnce('continued');

    await run({ data: { jobId: 'job-1', integracaoId: 'int-1' }, retryCount: 2 });

    const [deps, payload, tentativa] = chamadaDoJob();
    expect(deps.db).toBe(admin.db);
    expect(deps.scheduler).toBe(tasks.agendador);
    expect(payload).toMatchObject({ jobId: 'job-1', integracaoId: 'int-1' });
    // ⚠️ O `retryCount` da TASK, não um zero fixo: é ele que faz o job
    // carimbar `failed` na tentativa final em vez de estourar de novo, e
    // `?? 0` (nunca `|| 0`) porque a primeira tentativa é um VALOR.
    expect(tentativa).toBe(2);

    // A linha de log: UMA chamada, exatamente estes campos, e o `outcome`
    // atravessa intacto — `continued` (uma pausa ou uma continuação) e `done`
    // (o job acabou) não podem ser lidos como a mesma coisa (#1087).
    expect(loggedPayload(info)).toEqual({
      queue: SHOPEE_MASS_IMPORT_QUEUE,
      outcome: 'continued',
      jobId: 'job-1',
      integracaoId: 'int-1',
      retryCount: 2,
      readCache: expect.anything(),
    });
  });

  it('o importarAnuncio injetado É o importarAnuncioShopee real, nunca um substituto', async () => {
    // ⚠️ A única coisa que liga a fila ao importador de verdade é ESTA linha do
    // wiring. Um refactor que trocasse o import por um stub, um placeholder ou
    // um segundo módulo de mesmo nome compilaria, subiria e rodaria — o job
    // relataria `done` para cada item e nenhum produto seria escrito. Identidade
    // de referência é o que uma asserção de forma não pega.
    await run({ data: { jobId: 'job-1', integracaoId: 'int-1' }, retryCount: 0 });

    const [deps] = chamadaDoJob();
    expect(deps.importarAnuncio).toBe(importarAnuncioShopee);
    // ⚠️ E `importarKit` continua AUSENTE nesta onda (o importador de kit é da
    // onda seguinte): um `undefined` explícito passaria por "não injetado" e
    // esconderia a linha que falta.
    expect('importarKit' in deps).toBe(false);
  });
});
