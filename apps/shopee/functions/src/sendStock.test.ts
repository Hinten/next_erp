import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_STOCK_SEND_QUEUE,
  STOCK_SEND_MAX_ATTEMPTS,
} from '../../lib/shopee/estoque/constantesEstoque';

/**
 * What lives ONLY in this file is the SHAPE of the third queue — its declared
 * options, the deps it threads and its one log line — plus the two things the
 * wiring can silently get wrong: setting `ignoreSyncFlag` (which would keep a
 * closed valve writing to a live marketplace), and handing the ladder a stub
 * where the real `FieldValue.increment` belongs.
 *
 * The ladder's own behaviour — the twelve error arms, the reserved floor, the
 * write-backs — is asserted one layer down, in
 * `lib/shopee/estoque/enviarEstoque.test.ts` against the real FakeDb, so
 * `processShopeeStockSendTask` is MOCKED here. The split is
 * `processMassImport.test.ts`'s: per-option assertions live with the function,
 * the cross-cutting set (exact secrets, the ≤ 1800 s ladder, exhaustiveness)
 * lives in `index.test.ts`.
 *
 * `tasksInvoker.ts` reads `TASKS_INVOKER_SA` at module scope, so stub it before
 * the dynamic import and restore it afterwards so it cannot leak into other
 * files sharing this vitest project. `FUNCTIONS_REGION` is stubbed for the same
 * reason the sibling file stubs it — this module declares no `region:`
 * (`options.ts` sets it globally), but the stub keeps the file working if one
 * ever lands.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';
const originalConcurrent = process.env.SHOPEE_STOCK_CONCURRENT_DISPATCHES;
const originalPerSecond = process.env.SHOPEE_STOCK_DISPATCHES_PER_SECOND;

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
  if (originalConcurrent === undefined) delete process.env.SHOPEE_STOCK_CONCURRENT_DISPATCHES;
  else process.env.SHOPEE_STOCK_CONCURRENT_DISPATCHES = originalConcurrent;
  if (originalPerSecond === undefined) delete process.env.SHOPEE_STOCK_DISPATCHES_PER_SECOND;
  else process.env.SHOPEE_STOCK_DISPATCHES_PER_SECOND = originalPerSecond;
});

// The ladder is mocked; everything else the module imports is REAL — above all
// `constantesEstoque` (the queue name and the attempt cap must be the shipped
// ones, not a fixture's) and `tasksInvoker`.
const envio = vi.hoisted(() => ({
  processShopeeStockSendTask: vi.fn(
    async (
      _db: unknown,
      _rawPayload: unknown,
      _deps: Record<string, unknown>,
    ): Promise<{
      outcome: string;
      motivo: string | null;
      codigo: string | null;
      modelos: readonly unknown[];
      quantidadeEnviada: number;
      chamadasShopee: number;
      pausadoAte: number | null;
    }> => ({
      outcome: 'enviado',
      motivo: null,
      codigo: null,
      modelos: [],
      quantidadeEnviada: 0,
      chamadasShopee: 1,
      pausadoAte: null,
    }),
  ),
}));
vi.mock('../../lib/shopee/estoque/enviarEstoque', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/shopee/estoque/enviarEstoque')>()),
  processShopeeStockSendTask: envio.processShopeeStockSendTask,
}));

const tasks = vi.hoisted(() => {
  const agendador = { enqueue: vi.fn(async () => {}) };
  return { agendador, createShopeeStockTaskScheduler: vi.fn(() => agendador) };
});
vi.mock('../../lib/shopee/estoque/shopeeStockTasks', () => ({
  createShopeeStockTaskScheduler: tasks.createShopeeStockTaskScheduler,
}));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { sendShopeeStock } = await import('./sendStock');

type RunnableTask = { data: unknown; retryCount?: number };

function run(req: RunnableTask): Promise<unknown> {
  return (sendShopeeStock as unknown as { run(r: RunnableTask): Promise<unknown> }).run(req);
}

type ChamadaDoEnvio = [unknown, unknown, Record<string, unknown>];

/** The arguments of the single `processShopeeStockSendTask` call. */
function chamadaDoEnvio(): ChamadaDoEnvio {
  expect(envio.processShopeeStockSendTask).toHaveBeenCalledTimes(1);
  const chamada = envio.processShopeeStockSendTask.mock.calls[0];
  expect(chamada).toBeDefined();
  return chamada as ChamadaDoEnvio;
}

/** The deps object the handler built. */
function depsDoEnvio(): Record<string, unknown> {
  return chamadaDoEnvio()[2];
}

/** The single `logger.info` payload the handler emitted. */
function loggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

const endpoint = (sendShopeeStock as unknown as { __endpoint: Record<string, unknown> }).__endpoint;

/** The PAYLOAD the queue carries — a fixture listing, never a real id. */
const TAREFA = {
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
  modelos: [{ modelId: 2000458802, produtoId: 'prod-abc', varLinkDocId: 'var-1', quantidade: 7 }],
};

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  envio.processShopeeStockSendTask.mockResolvedValue({
    outcome: 'enviado',
    motivo: null,
    codigo: null,
    modelos: [],
    quantidadeEnviada: 7,
    chamadasShopee: 1,
    pausadoAte: null,
  });
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
});

describe('as opções declaradas do sendShopeeStock', () => {
  it('timeoutSeconds 120 e a escada fecha em 960 s', () => {
    // ⚠️ 120 — nem os 540 dos agendamentos desta codebase nem os 300 da
    // importação em massa, e a asserção precisa DISTINGUIR os três. O teto real
    // do trabalho são três idas: um `update_stock`, no máximo um
    // `get_item_promotion` e no máximo um retry com o piso aplicado. Um
    // orçamento muito acima disso não faz um despacho lento terminar, faz um
    // TRAVADO ficar invisível por mais tempo.
    //
    // E a invariante compartilhada é o outro lado: `tentativas × timeout +
    // (tentativas − 1) × maxBackoff ≤ 1800`. Com 120 dá 3×120 + 2×300 = 960 ✅;
    // com os 540 dos agendamentos daria 2220 ✗ — ou seja, copiar o número do
    // vizinho derrubaria `index.test.ts`, mas só se este número EXISTIR: um
    // `onTaskDispatched` sem `timeoutSeconds` roda com o padrão gen2 de 60 s.
    const trigger = endpoint.taskQueueTrigger as {
      retryConfig?: {
        maxAttempts?: number;
        minBackoffSeconds?: number;
        maxBackoffSeconds?: number;
        maxDoublings?: number;
      };
    };
    expect(endpoint.timeoutSeconds).toBe(120);
    expect(endpoint.timeoutSeconds).not.toBe(540);
    expect(endpoint.timeoutSeconds).not.toBe(300);
    expect(endpoint.timeoutSeconds).not.toBe(60);
    expect(trigger.retryConfig?.maxAttempts).toBe(STOCK_SEND_MAX_ATTEMPTS);
    expect(trigger.retryConfig?.minBackoffSeconds).toBe(30);
    expect(trigger.retryConfig?.maxBackoffSeconds).toBe(300);
    expect(trigger.retryConfig?.maxDoublings).toBe(2);

    const tentativas = trigger.retryConfig?.maxAttempts ?? 0;
    const escadaSegundos =
      tentativas * (endpoint.timeoutSeconds as number) +
      Math.max(tentativas - 1, 0) * (trigger.retryConfig?.maxBackoffSeconds ?? 0);
    expect(escadaSegundos).toBe(960);
    expect(escadaSegundos).toBeLessThanOrEqual(1800);
  });

  it('rateLimits 2/2 por padrão — e NÃO o 1/1 da importação em massa', () => {
    // O par de quase-falha: 1/1 é o número do irmão desta codebase e é o que
    // uma cópia traria junto. Ele passaria em qualquer asserção de "existe um
    // limite" e mudaria a vazão do único fluxo de ESCRITA do canal. A diferença
    // é argumentada em `constantesEstoque.ts`: o limite da Shopee é por
    // APLICAÇÃO, mas aqui uma rajada é sobrevivível e auto-regulada (429 ⇒
    // pausa da conta + reenfileiramento atrasado que não gasta tentativa).
    const trigger = endpoint.taskQueueTrigger as {
      rateLimits?: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
    };
    expect(trigger.rateLimits?.maxConcurrentDispatches).toBe(2);
    expect(trigger.rateLimits?.maxDispatchesPerSecond).toBe(2);
    expect(trigger.rateLimits?.maxConcurrentDispatches).not.toBe(1);
    expect(trigger.rateLimits?.maxDispatchesPerSecond).not.toBe(1);
  });

  it('rateLimits vem do ambiente do DEPLOY, não de um literal', async () => {
    // O par do teste acima: aquele mostra o valor, este mostra de ONDE ele vem.
    // O Firebase assa `rateLimits` na configuração da fila durante a análise de
    // codebase, então estes dois são leituras de env do SHELL DO DEPLOY — mudar
    // a vazão é um redeploy, nunca uma edição de código. Um literal `2` passaria
    // no teste acima e tornaria as duas variáveis (e a linha que o
    // `preflight.mjs` imprime em todo deploy) mentira.
    process.env.SHOPEE_STOCK_CONCURRENT_DISPATCHES = '5';
    process.env.SHOPEE_STOCK_DISPATCHES_PER_SECOND = '4';
    vi.resetModules();
    const mod = await import('./sendStock');
    const outro = (mod.sendShopeeStock as unknown as { __endpoint: Record<string, unknown> })
      .__endpoint;
    const trigger = outro.taskQueueTrigger as {
      rateLimits?: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
    };
    expect(trigger.rateLimits?.maxConcurrentDispatches).toBe(5);
    expect(trigger.rateLimits?.maxDispatchesPerSecond).toBe(4);
    delete process.env.SHOPEE_STOCK_CONCURRENT_DISPATCHES;
    delete process.env.SHOPEE_STOCK_DISPATCHES_PER_SECOND;
    vi.resetModules();
  });

  it('nenhum segredo além dos dois de parceiro', () => {
    // `secrets:` é uma whitelist que o operador concede um a um. Um nome que
    // entra por cópia sobe no deploy e derruba a FUNÇÃO no startup com 403 do
    // Secret Manager — e aí nenhum despacho roda, a varredura segue
    // enfileirando e nada nunca é enviado.
    //
    // ⚠️ Um `toContain` casaria um SUPERSTRING e não veria um nome a mais; o
    // conjunto exato vê.
    const nomes = (endpoint.secretEnvironmentVariables as { key?: string }[] | undefined)?.map(
      (s) => s.key,
    );
    expect(nomes).toEqual(['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY']);
  });

  it('declara o invoker, a perna cuja ausência falha invisivelmente (#1133)', () => {
    // ⚠️ DUAS identidades despacham esta fila — as três varreduras `onSchedule`
    // (SA de runtime das functions) e ela MESMA, nos dois braços que
    // reenfileiram (conta pausada, 429). A lista é AUTORITATIVA: o deploy
    // SUBSTITUI os membros dos dois bindings, então deixar uma de fora tira a
    // role dela, e a ausência falha invisivelmente — o enqueue já retornou
    // sucesso e o nosso código nunca vê o 403 da perna de dispatch.
    const trigger = endpoint.taskQueueTrigger as { invoker?: string[] };
    expect(trigger.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });

  it('NÃO declara `region:` — a região é global desta codebase', () => {
    // `options.ts` define a região globalmente a partir do `FUNCTIONS_REGION`
    // embutido no build, e o enfileirador usa a mesma por padrão. Um override
    // local deixaria as duas divergirem, e um caminho de fila apontando para a
    // região errada DESCARTA toda task enquanto o enqueue retorna sucesso
    // (#1108). O texto da fonte é a asserção porque a ausência de uma chave não
    // aparece no endpoint.
    const fonte = readFileSync(fileURLToPath(new URL('./sendStock.ts', import.meta.url)), 'utf8');
    const semComentarios = fonte.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(semComentarios).not.toContain('region:');
  });
});

describe('o handler do sendShopeeStock', () => {
  it('passa o payload VERBATIM e o db do singleton', async () => {
    await run({ data: TAREFA, retryCount: 0 });

    const [db, payload] = chamadaDoEnvio();
    expect(db).toBe(admin.db);
    // A MESMA referência: um payload reconstruído aqui poderia perder um
    // `modelId: 0` ou um `quantidade: 0`, que são valores reais ponta a ponta.
    expect(payload).toBe(TAREFA);
  });

  it('⛔ NUNCA passa `ignoreSyncFlag` — a válvula mestra é obedecida pela fila', async () => {
    // ⚠️ O teste mais importante deste arquivo. `ignoreSyncFlag` contorna
    // `SHOPEE_STOCK_SYNC_ENABLED` e é da PUSH MANUAL, onde um humano está
    // olhando. Uma fila que o setasse continuaria escrevendo num marketplace
    // vivo depois de a válvula ser fechada — exatamente a única coisa para a
    // qual fechar a válvula serve.
    //
    // Duas asserções porque a propriedade tem duas metades: a chave não está no
    // objeto CONSTRUÍDO (o que a ladder lê), e o nome não aparece no TEXTO da
    // fonte (o que um `deps.ignoreSyncFlag = algo` condicional burlaria). A
    // comparação da ladder é `!== true`, então ausente e `false` obedecem
    // igual — mas ausente é o que não pode ser "consertado" por engano.
    await run({ data: TAREFA, retryCount: 0 });

    const deps = depsDoEnvio();
    expect('ignoreSyncFlag' in deps).toBe(false);

    const fonte = readFileSync(fileURLToPath(new URL('./sendStock.ts', import.meta.url)), 'utf8');
    const executavel = fonte.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(executavel).not.toContain('ignoreSyncFlag');
  });

  it('`increment` é o FieldValue REAL, não um número', async () => {
    // ⚠️ O par de quase-falha da injeção: um stub `(by) => by` satisfaz o tipo
    // (`unknown`), compila, e transforma o contador `ocorrencias` do aviso de
    // clamp num read-modify-write — que PERDE uma soma sempre que dois
    // produtores caem juntos. `isEqual` compara os sentinelas do próprio SDK,
    // que é a única forma de dizer "este é o incremento de verdade".
    await run({ data: TAREFA, retryCount: 0 });

    const increment = depsDoEnvio().increment as (by: number) => unknown;
    const sentinela = increment(2) as ReturnType<typeof FieldValue.increment>;
    expect(FieldValue.increment(2).isEqual(sentinela)).toBe(true);
    // NEAR-MISS: o sentinela de OUTRO passo não é igual — se fosse, a asserção
    // acima passaria para qualquer `FieldValue.increment(...)` e não diria nada
    // sobre o argumento ter sido threaded.
    expect(FieldValue.increment(3).isEqual(sentinela)).toBe(false);
    expect(typeof sentinela).not.toBe('number');
  });

  it('`jitterSec` é aleatório e fica DENTRO de [0, max] — a dispersão mora aqui', async () => {
    // O default da ladder é um `0` determinístico, para o atraso ser testável;
    // a dispersão de verdade é do despachador implantado, porque o braço de
    // pausa reenfileira TODAS as tasks de uma conta pausada e elas não podem
    // voltar todas no mesmo segundo.
    await run({ data: TAREFA, retryCount: 0 });

    const jitterSec = depsDoEnvio().jitterSec as (maxS: number) => number;
    const aleatorio = vi.spyOn(Math, 'random');
    try {
      // PAR: os dois extremos do intervalo são alcançáveis — um `Math.floor`
      // sobre `max` (sem o `+ 1`) nunca devolveria o próprio `max`.
      aleatorio.mockReturnValue(0);
      expect(jitterSec(30)).toBe(0);
      aleatorio.mockReturnValue(0.999999);
      expect(jitterSec(30)).toBe(30);
      // NEAR-MISS: e nada sai do intervalo — 31 seria um atraso que o chamador
      // não pediu, e 0 em todo caso seria a ausência de dispersão.
      aleatorio.mockReturnValue(0.5);
      const meio = jitterSec(30);
      expect(meio).toBeGreaterThanOrEqual(0);
      expect(meio).toBeLessThanOrEqual(30);
    } finally {
      aleatorio.mockRestore();
    }
  });

  it('thread o retryCount, e um ausente vira 0', async () => {
    // Nada ramifica nele — o payload vai verbatim em toda tentativa — mas é o
    // que permite uma linha dizer "este anúncio já falhou duas vezes" sem uma
    // segunda fonte de dados. `req.retryCount` pode não vir, e `undefined` no
    // lugar de 0 apagaria o campo do log em vez de dizer "primeira tentativa".
    await run({ data: TAREFA, retryCount: 2 });
    expect(depsDoEnvio().retryCount).toBe(2);
    expect(loggedPayload(info).retryCount).toBe(2);

    vi.clearAllMocks();
    info.mockClear();
    await run({ data: TAREFA });
    expect(depsDoEnvio().retryCount).toBe(0);
    expect(loggedPayload(info).retryCount).toBe(0);
  });

  it('constrói o agendador REAL — a fila reenfileira contra si mesma', async () => {
    // Os dois braços que reenfileiram (conta pausada, 429) passam por aqui. Se
    // o agendador não chegasse, a ladder perderia o único caminho que ela tem
    // para adiar uma task sem gastar tentativa.
    await run({ data: TAREFA, retryCount: 0 });
    expect(tasks.createShopeeStockTaskScheduler).toHaveBeenCalledTimes(1);
    expect(depsDoEnvio().scheduler).toBe(tasks.agendador);
  });

  it('a linha de log carrega fila, outcome, motivo, retryCount, chamadas e readCache', async () => {
    // UMA linha de propósito — os campos caem em `jsonPayload` e são
    // filtráveis (`jsonPayload.outcome="pausado-reenfileirado"`), então mais
    // campos valem mais que mais linhas.
    //
    // ⚠️ `outcome` e `motivo` não são intercambiáveis e nenhum é redundante: um
    // envio LIMPO que precisou subir a quantidade até o piso reservado de uma
    // promoção é `enviado` COM `motivo: 'clampado-na-reserva'` — uma anotação,
    // não uma falha. Ler `motivo !== null` como "deu errado" reportaria todo
    // envio clampado como quebrado.
    envio.processShopeeStockSendTask.mockResolvedValue({
      outcome: 'enviado',
      motivo: 'clampado-na-reserva',
      codigo: null,
      modelos: [],
      quantidadeEnviada: 9,
      chamadasShopee: 3,
      pausadoAte: null,
    });

    await run({ data: TAREFA, retryCount: 1 });

    const payload = loggedPayload(info);
    expect(payload.queue).toBe(SHOPEE_STOCK_SEND_QUEUE);
    expect(payload.outcome).toBe('enviado');
    expect(payload.motivo).toBe('clampado-na-reserva');
    expect(payload.retryCount).toBe(1);
    // 3 = o caminho do PISO rodou (update + leitura da promoção + retry
    // clampado). É o único lugar onde esse custo aparece.
    expect(payload.chamadasShopee).toBe(3);
    expect(payload.readCache).toBeDefined();
  });

  it('⛔ a linha de log não carrega o corpo da tarefa — nem produto, nem quantidade', async () => {
    // Par de quase-falha do teste acima: aquele mostra que a linha existe, este
    // mostra ONDE ela para. O que o envio aprendeu já está no documento de
    // link, que é a visão do operador; esta linha só diz qual despacho o
    // produziu. Um `...result` ou um `payload` no objeto passaria no teste
    // acima e vazaria a tarefa inteira para o log.
    envio.processShopeeStockSendTask.mockResolvedValue({
      outcome: 'enviado',
      motivo: null,
      codigo: null,
      modelos: [{ modelId: 2000458802, quantidadeSolicitada: 7 }],
      quantidadeEnviada: 7,
      chamadasShopee: 1,
      pausadoAte: null,
    });

    await run({ data: TAREFA, retryCount: 0 });

    const serializado = JSON.stringify(loggedPayload(info));
    expect(serializado).not.toContain('prod-abc');
    expect(serializado).not.toContain('2500139861');
    expect(serializado).not.toContain('2000458802');
    expect(serializado).not.toContain('sweep-1');
  });

  it('RESOLVER É SUCESSO PARA A FILA — um `descartado` não vira falha', async () => {
    // ⚠️ Todo outcome resolve, `descartado` e `erro-registrado` incluídos: a
    // ladder já escreveu no anúncio o que aprendeu, e re-conduzir repetiria uma
    // recusa que o provedor já deu. Só um THROW pede nova tentativa.
    envio.processShopeeStockSendTask.mockResolvedValue({
      outcome: 'descartado',
      motivo: 'tasks-desabilitadas',
      codigo: 'erp:tasks-desabilitadas',
      modelos: [],
      quantidadeEnviada: 0,
      chamadasShopee: 0,
      pausadoAte: 1_760_000_000_000,
    });

    await expect(run({ data: TAREFA, retryCount: 2 })).resolves.toBeUndefined();
    expect(loggedPayload(info).outcome).toBe('descartado');
  });

  it('um THROW da ladder SOBE — a escada de três tentativas é o retry', async () => {
    // O par do teste acima, e a outra metade da mesma regra: o handler não
    // traduz um outcome em falha E não engole um throw. Um `try/catch` que
    // logasse e retornasse faria um transitório (um 500 da Shopee) parecer um
    // envio bem-sucedido, e a task nunca voltaria.
    envio.processShopeeStockSendTask.mockRejectedValue(new Error('transitório'));

    await expect(run({ data: TAREFA, retryCount: 0 })).rejects.toThrow('transitório');
    expect(info).not.toHaveBeenCalled();
  });
});
