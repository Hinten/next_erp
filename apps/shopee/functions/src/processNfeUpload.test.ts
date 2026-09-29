import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeNetworkError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import {
  NFE_SHOPEE_MAX_TENTATIVAS,
  SHOPEE_NFE_UPLOAD_QUEUE,
} from '../../lib/shopee/nfe/constantesNfe';

/**
 * What lives ONLY in this file is the SHAPE of the fifth queue — its declared
 * options — plus what the dispatcher can silently get wrong: re-parsing the
 * payload, logging a second completion line, reading the clock twice, stubbing
 * a seam, and letting Shopee's own sentence reach the runtime log inside a
 * rethrown error (review 1, F-3).
 *
 * The handler's behaviour is asserted one layer down, in
 * `lib/shopee/nfe/processarNfe.test.ts` over the FakeDb, so
 * `processarNfeShopee` is MOCKED here. The split is `processPriceSync.test.ts`'s:
 * per-option assertions live with the function, the cross-cutting set (exact
 * secrets, the ≤ 1800 s ladder, exhaustiveness) in `index.test.ts`.
 *
 * `tasksInvoker.ts` reads `TASKS_INVOKER_SA` at module scope, so it is stubbed
 * before the dynamic import and restored afterwards; `FUNCTIONS_REGION` for the
 * same reason `processMassImport.test.ts` gives.
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

const handler = vi.hoisted(() => ({
  // ⚠️ The signature is declared so `mock.calls[0]` types its ARGUMENTS.
  processarNfeShopee: vi.fn(
    async (
      _deps: Record<string, unknown>,
      _payload: unknown,
      _retryCount: number,
    ): Promise<Record<string, unknown>> => ({ desfecho: 'enviado' }),
  ),
}));
vi.mock('../../lib/shopee/nfe/processarNfe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/shopee/nfe/processarNfe')>()),
  processarNfeShopee: handler.processarNfeShopee,
}));

const tasks = vi.hoisted(() => {
  const agendador = { enqueue: vi.fn(async () => {}) };
  return { agendador, createShopeeNfeUploadScheduler: vi.fn(() => agendador) };
});
vi.mock('../../lib/shopee/nfe/shopeeNfeUploadTasks', () => ({
  createShopeeNfeUploadScheduler: tasks.createShopeeNfeUploadScheduler,
}));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { processShopeeNfeUpload } = await import('./processNfeUpload');

const FONTE = readFileSync(
  fileURLToPath(new URL('./processNfeUpload.ts', import.meta.url)),
  'utf8',
);

type RunnableTask = { data: unknown; retryCount?: number };

function run(req: RunnableTask): Promise<unknown> {
  return (processShopeeNfeUpload as unknown as { run(r: RunnableTask): Promise<unknown> }).run(req);
}

type Chamada = [Record<string, unknown>, unknown, number];

/** The arguments of the single `processarNfeShopee` call. */
function chamada(): Chamada {
  expect(handler.processarNfeShopee).toHaveBeenCalledTimes(1);
  return handler.processarNfeShopee.mock.calls[0] as Chamada;
}

const endpoint = (processShopeeNfeUpload as unknown as { __endpoint: Record<string, unknown> })
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

const TAREFA = { pedidoId: 'ped-1', nfeId: 's1', fase: 'envio' };

/**
 * A planted provider sentence: what Shopee's `message` could carry on this
 * path — a synthetic, visibly fake key (cUF 99, a CNPJ of repeated digits), a
 * CNPJ-shaped run and a marker. None of it may reach a log or a rethrown error.
 */
const CHAVE_PLANTADA = `99${'2609'}${'1'.repeat(14)}55${'000'}${'000000001'}1${'00000000'}0`;
const TEXTO_PLANTADO = `invalid access key ${CHAVE_PLANTADA} for cnpj ${'1'.repeat(14)} MARCADOR-DO-PROVEDOR`;

function erroDaShopee(code = 'order.upload_invoice_error'): ShopeeApiError {
  return new ShopeeApiError(
    `Shopee /api/v2/order/upload_invoice_doc respondeu ${code} (HTTP 200) — ${TEXTO_PLANTADO}`,
    {
      code,
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: '/api/v2/order/upload_invoice_doc',
      providerMessage: TEXTO_PLANTADO,
    },
  );
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let erro: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  handler.processarNfeShopee.mockResolvedValue({ desfecho: 'enviado' });
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  erro = vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  erro.mockRestore();
  vi.useRealTimers();
});

/** Everything this dispatcher sent to the functions logger, serialized. */
function tudoQueFoiLogado(): string {
  return JSON.stringify([info.mock.calls, warn.mock.calls, erro.mock.calls]);
}

describe('as opções declaradas do processShopeeNfeUpload', () => {
  it('timeoutSeconds 120 e a escada {4, 60, 300, 2} fecha em 1380 s', () => {
    // A invariante de `index.test.ts` para toda fila desta codebase:
    // `tentativas × timeout + (tentativas − 1) × maxBackoff ≤ 1800`. 4 × 120 +
    // 3 × 300 = 1380 ✅; os 300 s da fila de preço dariam 4 × 300 + 3 × 300 =
    // 2100 ✗ — a quase-falha que uma cópia de `processPriceSync.ts` traria.
    expect(endpoint.timeoutSeconds).toBe(120);
    expect(endpoint.timeoutSeconds).not.toBe(300);
    expect(gatilho.retryConfig?.maxAttempts).toBe(4);
    expect(gatilho.retryConfig?.minBackoffSeconds).toBe(60);
    expect(gatilho.retryConfig?.maxBackoffSeconds).toBe(300);
    expect(gatilho.retryConfig?.maxDoublings).toBe(2);

    const tentativas = gatilho.retryConfig?.maxAttempts ?? 0;
    const escada =
      tentativas * (endpoint.timeoutSeconds as number) +
      Math.max(tentativas - 1, 0) * (gatilho.retryConfig?.maxBackoffSeconds ?? 0);
    expect(escada).toBe(1380);
    expect(escada).toBeLessThanOrEqual(1800);
  });

  it('PAR: maxAttempts É NFE_SHOPEE_MAX_TENTATIVAS — a constante que o handler lê', () => {
    // O handler finaliza um transitório quando `retryCount >= MAX - 1`; a fila
    // e ele só concordam enquanto forem UM número. A fonte NOMEIA a constante:
    // um `maxAttempts: 4` passaria no par hoje e divergiria no dia da mudança.
    expect(gatilho.retryConfig?.maxAttempts).toBe(NFE_SHOPEE_MAX_TENTATIVAS);
    expect(FONTE).toContain('maxAttempts: NFE_SHOPEE_MAX_TENTATIVAS,');
    expect(FONTE).not.toMatch(/maxAttempts:\s*\d/);
  });

  it('rateLimits LITERAL {1, 1} — nenhum envio da mesma NF-e corre ao lado de outro', () => {
    // Um despacho do gatilho, um reenfileiramento SERPRO e um reenvio pela rota
    // da MESMA NF-e nunca sobem juntos: a pré-leitura do segundo roda depois do
    // envio do primeiro. Literal: sem botão de shell, nada para o preflight.
    expect(gatilho.rateLimits?.maxConcurrentDispatches).toBe(1);
    expect(gatilho.rateLimits?.maxDispatchesPerSecond).toBe(1);
    expect(FONTE).toContain(
      'rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },',
    );
    expect(FONTE).not.toContain('concurrentDispatches(');
  });

  it('exatamente os dois segredos de parceiro — nenhum terceiro', () => {
    const nomes = (endpoint.secretEnvironmentVariables as { key?: string }[] | undefined)?.map(
      (s) => s.key,
    );
    expect(nomes).toEqual(['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY']);
  });

  it('declara o invoker — as DUAS identidades (o gatilho/autorreenfileiramento e a rota)', () => {
    expect(gatilho.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });

  it('não declara `region:` — a região vem do options.ts global', () => {
    expect(FONTE).not.toMatch(/^\s*region\s*:/m);
    expect(FONTE).toContain('...tasksInvokerOptions(),');
  });
});

describe('o despachante do processShopeeNfeUpload', () => {
  it('entrega o req.data VERBATIM (sem re-parse) com o retryCount da task e UMA leitura de relógio', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_789_000_000_000);
    const dados = { ...TAREFA };

    await run({ data: dados, retryCount: 2 });

    const [deps, payload, tentativa] = chamada();
    // A MESMA referência: um parse aqui seria um segundo lugar decidindo o que é
    // uma task válida (e devolveria um objeto novo, com os padrões aplicados).
    expect(payload).toBe(dados);
    expect(tentativa).toBe(2);
    expect(deps.db).toBe(admin.db);
    expect(deps.scheduler).toBe(tasks.agendador);
    expect(tasks.createShopeeNfeUploadScheduler).toHaveBeenCalledTimes(1);
    expect(deps.nowMs).toBe(1_789_000_000_000);
  });

  it('PAR / QUASE-IGUAL: um retryCount AUSENTE é 0 — e o 2 acima é o que o separa de um zero fixo', async () => {
    await run({ data: TAREFA });
    expect(chamada()[2]).toBe(0);
  });

  it('um payload inválido também vai VERBATIM — quem descarta é o handler, com a linha dele', async () => {
    const lixo = { pedidoId: '', extra: 'SEGREDO-NAO-LOGAR' };
    await run({ data: lixo, retryCount: 0 });
    expect(chamada()[1]).toBe(lixo);
    expect(tudoQueFoiLogado()).not.toContain('SEGREDO-NAO-LOGAR');
  });

  it('⚠️ NENHUMA segunda linha de conclusão — o handler escreve a dele', async () => {
    // O handler loga `[shopee] processShopeeNfeUpload` com o desfecho, o motivo e
    // os contadores. Uma segunda linha aqui dobraria todo filtro de log.
    await run({ data: TAREFA, retryCount: 0 });
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(erro).not.toHaveBeenCalled();
  });

  it('as sementes injetadas são EXATAMENTE cinco — `resolveClient` fica no padrão do handler', async () => {
    await run({ data: TAREFA, retryCount: 0 });
    const [deps] = chamada();
    expect(Object.keys(deps).sort()).toEqual([
      'db',
      'increment',
      'jitterSec',
      'nowMs',
      'scheduler',
    ]);
  });

  it('`increment` é o FieldValue REAL — PAR com o mesmo n, QUASE-IGUAL com outro', async () => {
    await run({ data: TAREFA, retryCount: 0 });
    const increment = chamada()[0].increment as (by: number) => unknown;
    const sentinela = increment(2) as ReturnType<typeof FieldValue.increment>;
    expect(FieldValue.increment(2).isEqual(sentinela)).toBe(true);
    expect(FieldValue.increment(3).isEqual(sentinela)).toBe(false);
  });

  it('PAR / QUASE-IGUAL: o jitter é um INTEIRO em [0, maxS] — o teto alcançável, nunca maxS + 1', async () => {
    await run({ data: TAREFA, retryCount: 0 });
    const jitter = chamada()[0].jitterSec as (maxS: number) => number;
    const aleatorio = vi.spyOn(Math, 'random');
    aleatorio.mockReturnValueOnce(0);
    expect(jitter(30)).toBe(0);
    aleatorio.mockReturnValueOnce(0.999_999_9);
    expect(jitter(30)).toBe(30);
    aleatorio.mockReturnValueOnce(0.999_999_9);
    expect(jitter(30)).not.toBe(31);
    aleatorio.mockReturnValueOnce(0.5);
    expect(Number.isInteger(jitter(30))).toBe(true);
    aleatorio.mockRestore();
  });

  it('a fonte lê o relógio UMA vez — e o valor vai como `nowMs`, nunca como função', () => {
    expect(FONTE.match(/Date\.now\(\)/g) ?? []).toHaveLength(1);
    expect(FONTE).toContain('nowMs: Date.now(),');
  });
});

describe('F-3: uma recusa da Shopee relançada nunca leva o texto do provedor', () => {
  it('um ShopeeApiError vira um erro NOVO — classe e código, sem o texto plantado', async () => {
    const original = erroDaShopee();
    handler.processarNfeShopee.mockRejectedValueOnce(original);

    const falha = await run({ data: TAREFA, retryCount: 1 }).then(
      () => null,
      (e: unknown) => e,
    );

    // Still a FAILURE — Cloud Tasks must retry it.
    expect(falha).toBeInstanceOf(Error);
    expect(falha).not.toBe(original);
    expect(falha).not.toBeInstanceOf(ShopeeApiError);
    const mensagem = (falha as Error).message;
    expect(mensagem).toContain('ShopeeApiError');
    expect(mensagem).toContain('order.upload_invoice_error');
    expect(mensagem).toContain(SHOPEE_NFE_UPLOAD_QUEUE);
    // ⚠️ The planted sentence, the key and the CNPJ-shaped run: nowhere.
    expect(mensagem).not.toContain('MARCADOR-DO-PROVEDOR');
    expect(mensagem).not.toContain(CHAVE_PLANTADA);
    expect(mensagem).not.toMatch(/\d{14}/);
    // No `cause`: the runtime would print the original, sentence and all.
    expect((falha as Error).cause).toBeUndefined();
    expect(Object.values(falha as object).join(' ')).not.toContain('MARCADOR-DO-PROVEDOR');
  });

  it('UMA linha de log: a classe e o código-token, nunca o texto', async () => {
    handler.processarNfeShopee.mockRejectedValueOnce(erroDaShopee());

    await expect(run({ data: TAREFA, retryCount: 3 })).rejects.toThrow();

    expect(erro).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect((erro.mock.calls[0] as unknown[])[1]).toEqual({
      queue: SHOPEE_NFE_UPLOAD_QUEUE,
      retryCount: 3,
      // Review 2, S3-5: the two safe ids of `req.data` (TAREFA's), nothing else.
      pedidoId: 'ped-1',
      nfeId: 's1',
      classe: 'ShopeeApiError',
      codigo: 'order.upload_invoice_error',
      kind: SHOPEE_ERROR_KIND.other,
    });
    const logado = tudoQueFoiLogado();
    expect(logado).not.toContain('MARCADOR-DO-PROVEDOR');
    expect(logado).not.toContain(CHAVE_PLANTADA);
  });

  it('uma SUBCLASSE (o reauth) é redigida igual — e nomeia a própria classe', async () => {
    handler.processarNfeShopee.mockRejectedValueOnce(
      new ShopeeReauthRequiredError(`Shopee x respondeu shop_access_expired — ${TEXTO_PLANTADO}`, {
        code: 'shop_access_expired',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 200,
        path: '/api/v2/order/get_order_detail',
        providerMessage: TEXTO_PLANTADO,
      }),
    );

    const falha = (await run({ data: TAREFA, retryCount: 0 }).catch((e: unknown) => e)) as Error;
    expect(falha.message).toContain('ShopeeReauthRequiredError shop_access_expired');
    expect(falha.message).not.toContain('MARCADOR-DO-PROVEDOR');
  });

  it('PAR / QUASE-IGUAL: um código que NÃO é token não é repetido — nem no log, nem no erro', async () => {
    // Shopee's `error` is provider text too; only a `[a-z][a-z0-9_.]*` token is
    // echoed. A code carrying a space and a key is replaced, never printed.
    handler.processarNfeShopee.mockRejectedValueOnce(erroDaShopee(`bad code ${CHAVE_PLANTADA}`));

    const falha = (await run({ data: TAREFA, retryCount: 0 }).catch((e: unknown) => e)) as Error;
    expect(falha.message).toContain('(código ilegível)');
    expect(falha.message).not.toContain(CHAVE_PLANTADA);
    expect(((erro.mock.calls[0] as unknown[])[1] as Record<string, unknown>).codigo).toBeNull();
    expect(tudoQueFoiLogado()).not.toContain(CHAVE_PLANTADA);
  });

  it('⛔ QUASE-FALHA: um erro que NÃO é da API da Shopee relança INTOCADO (a mesma referência)', async () => {
    // Network, HTTP and schema messages are OUR text (path, status, field
    // paths); a Firestore failure or a bug is not Shopee's at all. Each keeps
    // its class, its message and its identity — and no line is logged here.
    for (const original of [
      new ShopeeNetworkError(
        'Falha de rede ao contatar a Shopee em /api/v2/order/get_order_detail.',
      ),
      new ShopeeSchemaError('Shopee x respondeu num formato inesperado. Campos inválidos: a.', {
        httpStatus: 200,
        path: '/api/v2/order/get_order_detail',
      }),
      new Error('transiente do Firestore'),
    ]) {
      handler.processarNfeShopee.mockRejectedValueOnce(original);
      await expect(run({ data: TAREFA, retryCount: 0 })).rejects.toBe(original);
    }
    expect(erro).not.toHaveBeenCalled();
  });

  it('PAR / QUASE-IGUAL: o código passa pelo `codigoSeguro` ÚNICO — `e` + os 44 dígitos de uma chave e um token de 70 caracteres NÃO são código', async () => {
    // Review 2, S3-6: the private uncapped copy echoed both as "tokens". PAIR:
    // the real code (with stray whitespace) is echoed trimmed; NEAR-MISS: a
    // token-SHAPED run carrying a key, and one over 64 characters, are not.
    handler.processarNfeShopee.mockRejectedValueOnce(erroDaShopee(' order.upload_invoice_error\t'));
    const par = (await run({ data: TAREFA, retryCount: 0 }).catch((e: unknown) => e)) as Error;
    expect(par.message).toContain('ShopeeApiError order.upload_invoice_error —');
    expect(((erro.mock.calls[0] as unknown[])[1] as Record<string, unknown>).codigo).toBe(
      'order.upload_invoice_error',
    );

    for (const code of [`e${CHAVE_PLANTADA}`, `e${'x'.repeat(69)}`]) {
      erro.mockClear();
      handler.processarNfeShopee.mockRejectedValueOnce(erroDaShopee(code));
      const falha = (await run({ data: TAREFA, retryCount: 0 }).catch((e: unknown) => e)) as Error;
      expect(falha.message).toContain('(código ilegível)');
      expect(falha.message).not.toContain(code);
      expect(((erro.mock.calls[0] as unknown[])[1] as Record<string, unknown>).codigo).toBeNull();
    }
    expect(tudoQueFoiLogado()).not.toContain(CHAVE_PLANTADA);
  });

  it('a fonte IMPORTA o `codigoSeguro` de `nfe/redacaoNfe.ts` — nenhuma cópia privada', () => {
    expect(FONTE).toContain("import { codigoSeguro } from '../../lib/shopee/nfe/redacaoNfe';");
    expect(FONTE).not.toContain('CODIGO_TOKEN');
    expect(FONTE).not.toMatch(/function codigoSeguro\b/);
  });

  it('a fonte narra por CLASSE (regra 6): ShopeeApiError e nada mais largo', () => {
    // `ShopeeError` would also catch `ShopeeConfigError` (our own message) and
    // the transport classes; `Error` would catch everything.
    expect(FONTE).toContain('if (err instanceof ShopeeApiError) {');
    expect(FONTE).not.toMatch(/instanceof ShopeeError\b/);
    expect(FONTE).not.toMatch(/instanceof Error\b/);
    expect(FONTE).not.toContain('cause:');
  });
});

describe('S3-5: a linha do F-3 diz QUAL NF-e falhou — só os dois ids seguros', () => {
  function linhaDoErro(): Record<string, unknown> {
    expect(erro).toHaveBeenCalledTimes(1);
    return (erro.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
  }

  it('PAR: `pedidoId` e `nfeId` de `req.data` entram — até 128 caracteres', async () => {
    // A non-final attempt's transient rethrows with NO handler line, so this is
    // the attempt's only trace; without the ids it ties to no pedido.
    const pedidoId = 'a'.repeat(128);
    handler.processarNfeShopee.mockRejectedValueOnce(erroDaShopee());

    await expect(run({ data: { ...TAREFA, pedidoId }, retryCount: 0 })).rejects.toThrow();

    expect(linhaDoErro()).toMatchObject({ pedidoId, nfeId: 's1' });
  });

  it('QUASE-IGUAL: um id com `/`, com 129 caracteres, vazio ou não-string fica FORA — e nada mais do payload entra', async () => {
    const casos: unknown[] = [
      { pedidoId: 'pedidos/ped-1', nfeId: 'a'.repeat(129), fase: 'envio' },
      { pedidoId: '', nfeId: 7, extra: 'SEGREDO-NAO-LOGAR' },
      null,
      'ped-1',
    ];
    for (const dados of casos) {
      erro.mockClear();
      handler.processarNfeShopee.mockRejectedValueOnce(erroDaShopee());

      await expect(run({ data: dados, retryCount: 0 })).rejects.toThrow();

      expect(Object.keys(linhaDoErro()).sort()).toEqual([
        'classe',
        'codigo',
        'kind',
        'queue',
        'retryCount',
      ]);
    }
    expect(tudoQueFoiLogado()).not.toContain('SEGREDO-NAO-LOGAR');
    expect(tudoQueFoiLogado()).not.toContain('pedidos/ped-1');
  });

  it('o erro RELANÇADO continua sem id nenhum — só a linha os carrega', async () => {
    handler.processarNfeShopee.mockRejectedValueOnce(erroDaShopee());

    const falha = (await run({ data: TAREFA, retryCount: 0 }).catch((e: unknown) => e)) as Error;

    expect(falha.message).not.toContain('ped-1');
  });
});
