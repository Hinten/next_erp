import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';

import {
  ENVIO_PRECO_MAX_TENTATIVAS,
  PARQUE_JITTER_MAX_S,
  SHOPEE_PRICE_SYNC_QUEUE,
} from '../../lib/shopee/precos/constantesPreco';
import {
  concurrentDispatches,
  dispatchesPerSecond,
} from '../../lib/shopee/estoque/constantesEstoque';

/**
 * What lives ONLY in this file is the SHAPE of the fourth queue — its declared
 * options and its one log line — plus what the wiring can silently get wrong:
 * dropping a malformed payload instead of retrying it for ever, reading the
 * clock more than once, and injecting a seam the job should have defaulted.
 *
 * The job's own behaviour (plan, drain, checkpoint, pause, park, fail) is
 * asserted one layer down, in `lib/shopee/precos/atualizarPrecos.test.ts`
 * against the FakeDb — so `processarEnvioPrecoShopee` is MOCKED here. The split
 * is `processMassImport.test.ts`'s: per-option assertions live with the
 * function, the cross-cutting set (exact secrets, the ≤ 1800 s ladder,
 * exhaustiveness) lives in `index.test.ts`.
 *
 * `tasksInvoker.ts` reads `TASKS_INVOKER_SA` at module scope, so stub it before
 * the dynamic import and restore it afterwards so it cannot leak into other
 * files sharing this vitest project. `FUNCTIONS_REGION` is stubbed for the same
 * reason `processMassImport.test.ts` gives.
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
// all `envioPrecoShopeeTaskSchema` (the drop below must be the schema's own
// verdict, not a fixture's).
const job = vi.hoisted(() => ({
  // ⚠️ The signature is declared (not `vi.fn(async () => …)`) because it types
  // `mock.calls[0]`: a parameterless mock records calls as `[]`, and then the
  // assertion on the ARGUMENTS — which is the test — does not compile.
  processarEnvioPrecoShopee: vi.fn(
    async (
      _deps: Record<string, unknown>,
      _payload: Record<string, unknown>,
      _retryCount: number,
    ): Promise<string> => 'done',
  ),
}));
vi.mock('../../lib/shopee/precos/atualizarPrecos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/shopee/precos/atualizarPrecos')>()),
  processarEnvioPrecoShopee: job.processarEnvioPrecoShopee,
}));

const tasks = vi.hoisted(() => {
  const agendador = { enqueue: vi.fn(async () => {}) };
  return { agendador, createShopeePriceSyncScheduler: vi.fn(() => agendador) };
});
vi.mock('../../lib/shopee/precos/shopeePriceSyncTasks', () => ({
  createShopeePriceSyncScheduler: tasks.createShopeePriceSyncScheduler,
}));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { processShopeePriceSync } = await import('./processPriceSync');

const FONTE = readFileSync(
  fileURLToPath(new URL('./processPriceSync.ts', import.meta.url)),
  'utf8',
);

type RunnableTask = { data: unknown; retryCount?: number };

function run(req: RunnableTask): Promise<unknown> {
  return (processShopeePriceSync as unknown as { run(r: RunnableTask): Promise<unknown> }).run(req);
}

type ChamadaDoJob = [Record<string, unknown>, Record<string, unknown>, number];

/** The arguments of the single `processarEnvioPrecoShopee` call. */
function chamadaDoJob(): ChamadaDoJob {
  expect(job.processarEnvioPrecoShopee).toHaveBeenCalledTimes(1);
  const chamada = job.processarEnvioPrecoShopee.mock.calls[0];
  expect(chamada).toBeDefined();
  return chamada as ChamadaDoJob;
}

/** The single `logger.*` payload the handler emitted. */
function loggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

const endpoint = (processShopeePriceSync as unknown as { __endpoint: Record<string, unknown> })
  .__endpoint;

type Gatilho = {
  retryConfig?: {
    maxAttempts?: number;
    minBackoffSeconds?: number;
    maxBackoffSeconds?: number;
    maxDoublings?: number;
  };
  rateLimits?: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
  invoker?: string[];
};
const gatilho = endpoint.taskQueueTrigger as Gatilho;

let info: ReturnType<typeof vi.spyOn>;
let erro: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  job.processarEnvioPrecoShopee.mockResolvedValue('done');
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  erro = vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  erro.mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('as opções declaradas do processShopeePriceSync (M47)', () => {
  it('timeoutSeconds 300 e a escada {3, 30, 300, 2} fecha em 1500 s', () => {
    // ⚠️ 300, e NÃO os 540 da fila de preço do Mercado Livre — e a asserção
    // precisa ser uma que DISTINGA os dois. A invariante que `index.test.ts`
    // fixa para toda fila desta codebase é `tentativas × timeout +
    // (tentativas − 1) × backoff ≤ 1800`: com 300 dá 3×300 + 2×300 = 1500 ✅;
    // com os 540 do ML dá 3×540 + 2×300 = 2220 ✗. E um `onTaskDispatched` sem
    // `timeoutSeconds` roda com o padrão gen2 de 60 s, que um lote de dez
    // anúncios a ~20 s cada estoura.
    expect(endpoint.timeoutSeconds).toBe(300);
    expect(endpoint.timeoutSeconds).not.toBe(540);
    expect(endpoint.timeoutSeconds).not.toBe(60);
    expect(gatilho.retryConfig?.maxAttempts).toBe(3);
    expect(gatilho.retryConfig?.minBackoffSeconds).toBe(30);
    expect(gatilho.retryConfig?.maxBackoffSeconds).toBe(300);
    expect(gatilho.retryConfig?.maxDoublings).toBe(2);

    const tentativas = gatilho.retryConfig?.maxAttempts ?? 0;
    const escadaSegundos =
      tentativas * (endpoint.timeoutSeconds as number) +
      Math.max(tentativas - 1, 0) * (gatilho.retryConfig?.maxBackoffSeconds ?? 0);
    expect(escadaSegundos).toBe(1500);
    expect(escadaSegundos).toBeLessThanOrEqual(1800);
  });

  it('PAR: retryConfig.maxAttempts É ENVIO_PRECO_MAX_TENTATIVAS — a mesma constante que o job lê', () => {
    // O job decide que uma tentativa é a ÚLTIMA comparando `retryCount` com
    // `ENVIO_PRECO_MAX_TENTATIVAS - 1` e, nela, carimba `failed` em vez de
    // relançar. Se a fila tentasse MAIS vezes, a penúltima tentativa real já
    // carimbaria e a última nunca rodaria; se tentasse MENOS, a última tentativa
    // real relançaria e a fila descartaria a task com o job `running` para
    // sempre (nada re-conduz esta fila). Os dois números só concordam enquanto
    // forem UM.
    expect(gatilho.retryConfig?.maxAttempts).toBe(ENVIO_PRECO_MAX_TENTATIVAS);
    expect(ENVIO_PRECO_MAX_TENTATIVAS).toBe(3);
    // A fonte NOMEIA a constante, não repete o literal — um `maxAttempts: 3`
    // passaria no par acima hoje e divergiria no dia em que a constante mudasse.
    expect(FONTE).toContain('maxAttempts: ENVIO_PRECO_MAX_TENTATIVAS,');
    expect(FONTE).not.toMatch(/maxAttempts:\s*\d/);
  });

  it('maxConcurrentDispatches 1 e maxDispatchesPerSecond 1 — o doc do job é o checkpoint', () => {
    // O documento do job É o checkpoint: `fila`, o cursor, os contadores e o
    // índice do shard do relatório são lidos, avançados e regravados pelo
    // despacho. Dois despachos do MESMO job em voo correriam esse documento e
    // re-enviariam um anúncio já drenado.
    expect(gatilho.rateLimits?.maxConcurrentDispatches).toBe(1);
    expect(gatilho.rateLimits?.maxDispatchesPerSecond).toBe(1);
  });

  it('⛔ QUASE-IGUAL: a vazão é LITERAL — não os leitores de ambiente da fila de estoque', () => {
    // A fila de estoque lê a sua vazão do shell do deploy (padrão 2/2), e é essa
    // linha que uma cópia de `sendStock.ts` traria junto. Aqui ela quebraria a
    // propriedade acima E deixaria `preflight.mjs` sem nada a imprimir nem a
    // conferir para esta fila. Os padrões do estoque SÃO diferentes de 1/1 — é
    // isso que torna esta asserção capaz de ver a troca (lidos com o ambiente
    // VAZIO, para que um shell com o botão posto não a torne vacuamente falsa).
    vi.stubEnv('SHOPEE_STOCK_CONCURRENT_DISPATCHES', '');
    vi.stubEnv('SHOPEE_STOCK_DISPATCHES_PER_SECOND', '');
    expect(concurrentDispatches()).not.toBe(1);
    expect(dispatchesPerSecond()).not.toBe(1);
    expect(FONTE).toContain(
      'rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },',
    );
    expect(FONTE).not.toContain('concurrentDispatches(');
    expect(FONTE).not.toContain('dispatchesPerSecond(');
  });

  it('nenhum segredo além dos dois de parceiro', () => {
    // `secrets:` é uma whitelist que o operador concede um a um. Um nome que
    // entra por cópia sobe no deploy e derruba a FUNÇÃO no startup com 403 do
    // Secret Manager — e aí nenhum despacho roda, o job fica `running` até a
    // recuperação de órfão. O conjunto exato vê um nome a mais; um `toContain`
    // não.
    const nomes = (endpoint.secretEnvironmentVariables as { key?: string }[] | undefined)?.map(
      (s) => s.key,
    );
    expect(nomes).toEqual(['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY']);
  });

  it('declara o invoker — as DUAS identidades, a perna cuja ausência falha invisivelmente (#1133)', () => {
    // A SA de runtime do App Hosting (o primeiro enqueue da rota) e a SA de
    // runtime das functions (toda continuação, a pausa e o parque). A lista é
    // AUTORITATIVA: o deploy SUBSTITUI os membros, então deixar uma de fora tira
    // a role dela — e o enqueue já retornou sucesso.
    expect(gatilho.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });

  it('não declara `region:` — a região vem do options.ts global', () => {
    // Uma chave local deixaria a região da função e a do enfileirador (que lê a
    // mesma variável inlinada) derivarem uma da outra, e uma fila na região
    // errada descarta toda task com o enqueue respondendo sucesso (#1108).
    expect(FONTE).not.toMatch(/^\s*region\s*:/m);
    expect(FONTE).toContain('...tasksInvokerOptions(),');
  });
});

describe('o handler do processShopeePriceSync', () => {
  it('um payload inválido é DESCARTADO com um logger.error e nada é processado', async () => {
    // Um bug de código ou de enfileiramento: esta fila só recebe o NOSSO
    // `{ jobId, integracaoId }`. Não há o que re-tentar e não há o que carimbar
    // (sem `jobId` não existe documento para marcar `failed`).
    await run({ data: { jobId: '', integracaoId: 'int-1' }, retryCount: 0 });

    expect(job.processarEnvioPrecoShopee).not.toHaveBeenCalled();
    expect(tasks.createShopeePriceSyncScheduler).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(loggedPayload(erro)).toEqual({
      queue: SHOPEE_PRICE_SYNC_QUEUE,
      campos: 'jobId',
    });
  });

  it('⛔ QUASE-IGUAL: uma chave A MAIS também é descartada (o schema é `.strict()`), sem nomeá-la', async () => {
    // O par de quase-falha da importação em massa, invertido: lá o schema é
    // passthrough e uma chave extra passa; aqui a fila tem um único formato de
    // produtor, e um corpo com algo a mais é um produtor que o job não conhece.
    // O issue carrega o NOME da chave — conteúdo do corpo que ninguém validou —
    // então a linha diz só `(raiz)`.
    await run({
      data: { jobId: 'job-1', integracaoId: 'int-1', chaveEstranha: 'SEGREDO-NAO-LOGAR' },
      retryCount: 0,
    });

    expect(job.processarEnvioPrecoShopee).not.toHaveBeenCalled();
    const serializado = JSON.stringify(loggedPayload(erro));
    expect(serializado).toContain('(raiz)');
    expect(serializado).not.toContain('chaveEstranha');
    expect(serializado).not.toContain('SEGREDO-NAO-LOGAR');
  });

  it('⛔ o descarte registra CAMINHOS de campo, nunca um valor do corpo', async () => {
    await run({ data: { jobId: 7, integracaoId: 'SEGREDO-NAO-LOGAR-2' }, retryCount: 0 });

    const serializado = JSON.stringify(loggedPayload(erro));
    expect(serializado).toContain('jobId');
    expect(serializado).not.toContain('SEGREDO-NAO-LOGAR-2');
  });

  it('um payload válido chama processarEnvioPrecoShopee com o retryCount da task e UMA leitura de relógio', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    job.processarEnvioPrecoShopee.mockResolvedValueOnce('continued');

    await run({ data: { jobId: 'job-1', integracaoId: 'int-1' }, retryCount: 2 });

    const [deps, payload, tentativa] = chamadaDoJob();
    expect(deps.db).toBe(admin.db);
    expect(deps.scheduler).toBe(tasks.agendador);
    expect(tasks.createShopeePriceSyncScheduler).toHaveBeenCalledTimes(1);
    // O instante do despacho: o job não lê relógio nenhum, então este número é
    // o que carimba TODO campo que o despacho escreve.
    expect(deps.nowMs).toBe(1_760_000_000_000);
    expect(payload).toEqual({ jobId: 'job-1', integracaoId: 'int-1' });
    // ⚠️ O `retryCount` da TASK, não um zero fixo: é ele que faz o job carimbar
    // `failed` na tentativa final em vez de estourar de novo.
    expect(tentativa).toBe(2);

    // A linha de log: UMA chamada, exatamente estes campos, e o `outcome`
    // atravessa intacto (#1087).
    expect(loggedPayload(info)).toEqual({
      queue: SHOPEE_PRICE_SYNC_QUEUE,
      outcome: 'continued',
      jobId: 'job-1',
      integracaoId: 'int-1',
      retryCount: 2,
      readCache: expect.anything(),
    });
  });

  it('PAR / QUASE-IGUAL: um retryCount AUSENTE é 0 — e 0 é um valor, não uma ausência', async () => {
    // `?? 0`, nunca `|| 0`: as duas grafias concordam no ausente e no zero, e é
    // por isso que o par não basta sozinho — o 2 do teste acima é a quase-falha
    // que as separa de um zero fixo.
    await run({ data: { jobId: 'job-1', integracaoId: 'int-1' } });
    expect(chamadaDoJob()[2]).toBe(0);
    expect(loggedPayload(info).retryCount).toBe(0);
  });

  it('o `pausado` (o parque da cota diária) atravessa o log como ele mesmo, não como `continued`', async () => {
    job.processarEnvioPrecoShopee.mockResolvedValueOnce('pausado');

    await run({ data: { jobId: 'job-1', integracaoId: 'int-1' }, retryCount: 0 });

    expect(loggedPayload(info).outcome).toBe('pausado');
  });

  it('⚠️ as sementes injetadas são EXATAMENTE quatro — toda outra fica no padrão do job', async () => {
    // O contexto, o veredito da conta, o leitor de página, a leitura de preços
    // na drenagem, o leitor de base em lote e o REMETENTE têm padrões de
    // produção dentro do job. Uma injeção aqui seria um segundo lugar decidindo
    // por qual remetente um marketplace vivo é escrito — e compilaria, subiria e
    // rodaria.
    await run({ data: { jobId: 'job-1', integracaoId: 'int-1' }, retryCount: 0 });

    const [deps] = chamadaDoJob();
    expect(Object.keys(deps).sort()).toEqual(['db', 'jitterSec', 'nowMs', 'scheduler']);
  });

  it('PAR / QUASE-IGUAL: o jitter é um INTEIRO em [0, maxS] — o máximo alcançável, nunca maxS + 1', async () => {
    await run({ data: { jobId: 'job-1', integracaoId: 'int-1' }, retryCount: 0 });
    const jitter = chamadaDoJob()[0].jitterSec as (maxS: number) => number;

    const aleatorio = vi.spyOn(Math, 'random');
    // O piso: o sorteio mínimo dá zero segundos.
    aleatorio.mockReturnValueOnce(0);
    expect(jitter(PARQUE_JITTER_MAX_S)).toBe(0);
    // O teto é ALCANÇÁVEL: o maior sorteio possível dá exatamente maxS…
    aleatorio.mockReturnValueOnce(0.999_999_9);
    expect(jitter(PARQUE_JITTER_MAX_S)).toBe(PARQUE_JITTER_MAX_S);
    // …e nunca maxS + 1, a quase-falha de um `Math.ceil` ou de um `+ 1` fora do
    // `floor`.
    aleatorio.mockReturnValueOnce(0.999_999_9);
    expect(jitter(PARQUE_JITTER_MAX_S)).not.toBe(PARQUE_JITTER_MAX_S + 1);
    // E um valor do meio é inteiro — `scheduleDelaySeconds` não aceita fração.
    aleatorio.mockReturnValueOnce(0.5);
    expect(Number.isInteger(jitter(PARQUE_JITTER_MAX_S))).toBe(true);
    aleatorio.mockRestore();
  });

  it('uma falha do job PROPAGA — a escada de três tentativas da fila É o retry', async () => {
    // O handler não traduz um erro em sucesso nem o engole: quem decide entre
    // relançar e carimbar `failed` é o job, pela tentativa. Um `try/catch` aqui
    // faria a fila ver sucesso e descartar a task com o job `running`.
    const falha = new Error('transiente');
    job.processarEnvioPrecoShopee.mockRejectedValueOnce(falha);

    await expect(
      run({ data: { jobId: 'job-1', integracaoId: 'int-1' }, retryCount: 0 }),
    ).rejects.toBe(falha);
    expect(info).not.toHaveBeenCalled();
  });

  it('a fonte lê o relógio UMA vez — e o valor vai como `nowMs`, nunca como função', () => {
    // Uma segunda leitura (ou um `now: () => Date.now()` repassado ao job)
    // daria a dois carimbos do MESMO despacho instantes diferentes; o job foi
    // escrito para receber UM número e reusá-lo.
    expect(FONTE.match(/Date\.now\(\)/g) ?? []).toHaveLength(1);
    expect(FONTE).toContain('nowMs: Date.now(),');
  });
});
