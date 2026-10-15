import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { logger } from 'firebase-functions/v2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODO_VARREDURA_ESTOQUE } from '@delfrance/schemas';

/**
 * What lives ONLY in this file is the SHAPE of the three stock schedules — the
 * crons, the zone, the timeout, the deps they build — plus the one thing a cron
 * cannot express and the wrapper therefore owns: the incremental tier skipping
 * exactly two slots of its own schedule.
 *
 * The tick's own behaviour (the window, the gates, the page loop, the
 * continuation) is asserted one layer down, in
 * `lib/shopee/estoque/varreduraEstoque.test.ts` against the real FakeDb, so
 * `runShopeeStockSweep` and the two slot predicates are MOCKED here. The split
 * is `processMassImport.test.ts`'s; the cross-cutting set (the exact secrets,
 * cron distinctness, exhaustiveness) lives in `index.test.ts`.
 *
 * `FUNCTIONS_REGION` is stubbed BEFORE the import so `options.ts` —
 * transitively reached by `./lib/admin` — cannot throw, and restored afterwards
 * so it cannot leak into other files sharing this vitest project.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalShopeeTasksRegion = process.env.SHOPEE_TASKS_REGION;

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalShopeeTasksRegion === undefined) delete process.env.SHOPEE_TASKS_REGION;
  else process.env.SHOPEE_TASKS_REGION = originalShopeeTasksRegion;
});

const varredura = vi.hoisted(() => ({
  runShopeeStockSweep: vi.fn(
    async (
      _db: unknown,
      _modo: string,
      _deps: Record<string, unknown>,
    ): Promise<{
      enabled: boolean;
      contas: readonly LinhaDeConta[];
    }> => ({ enabled: true, contas: [] }),
  ),
  ehSlotDoDiario: vi.fn((_nowMs: number) => false),
  ehSlotDaReconciliacao: vi.fn((_nowMs: number) => false),
}));
vi.mock('../../lib/shopee/estoque/varreduraEstoque', () => ({
  runShopeeStockSweep: varredura.runShopeeStockSweep,
  ehSlotDoDiario: varredura.ehSlotDoDiario,
  ehSlotDaReconciliacao: varredura.ehSlotDaReconciliacao,
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

const { sweepShopeeStock, sweepShopeeStockDaily, sweepShopeeStockReconciliacao } =
  await import('./sweepStock');

/** One row of the tick's result — the shape `ResultadoDaContaShopee` has. */
interface LinhaDeConta {
  integracaoId: string;
  enqueued: number;
  skipped: number;
  inalterados: number;
  pages: number;
  truncated: boolean;
  paused: boolean;
  motivoConta: string | null;
  error: string | null;
}

/** A fixture conta row. Fixture ids only — never a real integração. */
function conta(over: Partial<LinhaDeConta> = {}): LinhaDeConta {
  return {
    integracaoId: 'int-1',
    enqueued: 0,
    skipped: 0,
    inalterados: 0,
    pages: 0,
    truncated: false,
    paused: false,
    motivoConta: null,
    error: null,
    ...over,
  };
}

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

function gatilhoDe(fn: unknown): { schedule?: string; timeZone?: string } {
  return endpointOf(fn).scheduleTrigger as { schedule?: string; timeZone?: string };
}

/** Drive one schedule's body, the way the platform does. */
function rodar(fn: unknown): Promise<unknown> {
  return (fn as { run(evento: unknown): Promise<unknown> }).run({});
}

/** The deps object the wrapper handed the tick. */
function depsDaVarredura(): Record<string, unknown> {
  expect(varredura.runShopeeStockSweep).toHaveBeenCalledTimes(1);
  const chamada = varredura.runShopeeStockSweep.mock.calls[0];
  expect(chamada).toBeDefined();
  return (chamada as [unknown, string, Record<string, unknown>])[2];
}

/** The `modo` the wrapper chose. */
function modoDaVarredura(): string {
  expect(varredura.runShopeeStockSweep).toHaveBeenCalledTimes(1);
  return (varredura.runShopeeStockSweep.mock.calls[0] as [unknown, string, unknown])[1];
}

const AGORA_MS = 1_760_000_000_000;

let info: ReturnType<typeof vi.spyOn>;
let aviso: ReturnType<typeof vi.spyOn>;
let relogio: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  varredura.runShopeeStockSweep.mockResolvedValue({ enabled: true, contas: [] });
  varredura.ehSlotDoDiario.mockReturnValue(false);
  varredura.ehSlotDaReconciliacao.mockReturnValue(false);
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  aviso = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  relogio = vi.spyOn(Date, 'now').mockReturnValue(AGORA_MS);
});

afterEach(() => {
  info.mockRestore();
  aviso.mockRestore();
  relogio.mockRestore();
});

describe('as opções declaradas dos três agendamentos', () => {
  it('os três crons são LITERAIS e os três declaram America/Sao_Paulo', () => {
    // Os minutos são escolhidos, não herdados: os sete agendamentos que esta
    // codebase já roda ocupam :00, :15, :20, :30 e :45, e todos sacam de UM
    // orçamento de rate limit de parceiro que a Shopee não publica.
    //
    // ⚠️ `timeZone` explícito nos três. Sem ele o Cloud Scheduler roda em UTC e
    // "02:10" vira 23:10 do dia anterior em Brasília — o que não falha, apenas
    // move a passagem diária para o meio do expediente, e move junto os pulos
    // em código do incremental, que perguntam a hora de `America/Sao_Paulo`.
    expect(gatilhoDe(sweepShopeeStock).schedule).toBe('10,25,40,55 * * * *');
    expect(gatilhoDe(sweepShopeeStockDaily).schedule).toBe('10 2 * * *');
    expect(gatilhoDe(sweepShopeeStockReconciliacao).schedule).toBe('10 3 1 * *');
    for (const fn of [sweepShopeeStock, sweepShopeeStockDaily, sweepShopeeStockReconciliacao]) {
      expect(gatilhoDe(fn).timeZone).toBe('America/Sao_Paulo');
    }
  });

  it('os três têm timeoutSeconds 540 e exatamente os dois segredos de parceiro', () => {
    for (const fn of [sweepShopeeStock, sweepShopeeStockDaily, sweepShopeeStockReconciliacao]) {
      expect(endpointOf(fn).timeoutSeconds).toBe(540);
      const nomes = (
        endpointOf(fn).secretEnvironmentVariables as { key?: string }[] | undefined
      )?.map((s) => s.key);
      expect(nomes).toEqual(['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY']);
    }
  });

  it('nenhum dos três declara `region:` — a região é global desta codebase', () => {
    // `options.ts` define a região globalmente a partir do `FUNCTIONS_REGION`
    // embutido no build, e o enfileirador usa a mesma por padrão. Um override
    // local deixaria as duas divergirem, e um caminho de fila apontando para a
    // região errada DESCARTA toda task enquanto o enqueue retorna sucesso
    // (#1108). A ausência de uma chave não aparece no endpoint, então a
    // asserção é sobre o texto da fonte.
    expect(fonteExecutavel()).not.toContain('region:');
  });
});

describe('o wrapper incremental e os dois slots que ele pula', () => {
  it('roda a varredura incremental num tick comum', async () => {
    await rodar(sweepShopeeStock);
    expect(modoDaVarredura()).toBe(MODO_VARREDURA_ESTOQUE.incremental);
  });

  it('pula o tick quando o slot é do DIÁRIO — e não lê nada', async () => {
    // Um cron não consegue dizer "a cada quarto de hora EXCETO 02:10", então o
    // wrapper diz. O tick pulado não chama a varredura de forma alguma: não é
    // uma varredura que não encontra nada, é uma varredura que não acontece.
    varredura.ehSlotDoDiario.mockReturnValue(true);

    await rodar(sweepShopeeStock);

    expect(varredura.runShopeeStockSweep).not.toHaveBeenCalled();
    expect(tasks.createShopeeStockTaskScheduler).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('pula o tick quando o slot é da RECONCILIAÇÃO — e não lê nada', async () => {
    // A segunda metade da mesma regra, e ela é um teste separado porque os dois
    // predicados são independentes: um `||` que só consultasse o primeiro
    // passaria no teste acima e deixaria o incremental disputar o dia 1 às
    // 03:10 com a reconciliação — os limites da conta, o documento de estado e
    // a continuação, todos ao mesmo tempo.
    varredura.ehSlotDaReconciliacao.mockReturnValue(true);

    await rodar(sweepShopeeStock);

    expect(varredura.runShopeeStockSweep).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('⚠️ os predicados recebem o MESMO instante que a varredura — uma leitura de relógio', async () => {
    // O par de quase-falha dos dois testes acima. Duas leituras de `Date.now()`
    // — uma para decidir o slot, outra para a janela — deixariam um tick
    // decidir "não sou o slot do diário" e depois rodar a janela a partir de um
    // instante que JÁ é. `nowMs` é a janela, a expiração dos caches dos portões,
    // o conjunto de pulos por anúncio, todo carimbo e metade do `sweepId`.
    // O relogio ANDA entre leituras: a primeira responde AGORA_MS e toda
    // leitura seguinte responde um minuto depois. Um wrapper que lesse duas
    // vezes entregaria o minuto seguinte a alguem, e a assercao diz qual.
    relogio.mockReset();
    relogio.mockReturnValueOnce(AGORA_MS).mockReturnValue(AGORA_MS + 60_000);

    await rodar(sweepShopeeStock);

    expect(varredura.ehSlotDoDiario).toHaveBeenCalledWith(AGORA_MS);
    expect(varredura.ehSlotDaReconciliacao).toHaveBeenCalledWith(AGORA_MS);
    expect(depsDaVarredura().nowMs).toBe(AGORA_MS);
  });
});

describe('os outros dois wrappers', () => {
  it('o diário passa o modo `diario` e NÃO consulta os predicados de slot', async () => {
    // O slot é DELE: o incremental é quem pula. Um diário que também
    // perguntasse "é o meu slot?" pularia a si mesmo.
    await rodar(sweepShopeeStockDaily);

    expect(modoDaVarredura()).toBe(MODO_VARREDURA_ESTOQUE.diario);
    expect(varredura.ehSlotDoDiario).not.toHaveBeenCalled();
    expect(varredura.ehSlotDaReconciliacao).not.toHaveBeenCalled();
  });

  it('a reconciliação passa o modo `reconciliacao`', async () => {
    await rodar(sweepShopeeStockReconciliacao);
    expect(modoDaVarredura()).toBe(MODO_VARREDURA_ESTOQUE.reconciliacao);
  });

  it('⛔ a reconciliação NÃO lê uma flag própria — a válvula é uma só', async () => {
    // ⚠️ A diferença deliberada em relação ao gêmeo do Mercado Livre, que
    // carrega um segundo `*_RECONCILIACAO_ENABLED`. A reconciliação é o ÚNICO
    // nível que enxerga um anúncio cujo estoque no ERP nunca se moveu — é onde
    // a deriva do lado da Shopee mora — então uma segunda flag seria um jeito
    // de o corretor estar desligado enquanto o operador acredita que a
    // sincronia de estoque está ligada.
    //
    // A asserção é sobre o TEXTO executável do módulo inteiro: a válvula mestra
    // é lida dentro de `runShopeeStockSweep`, e nenhum dos três wrappers lê
    // ambiente nenhum. Um `if (process.env[...] !== '1') return;` passaria no
    // teste acima (o modo continua correto quando a flag está ligada) e faria a
    // passagem mensal nunca rodar.
    expect(fonteExecutavel()).not.toContain('process.env');

    await rodar(sweepShopeeStockReconciliacao);
    expect(varredura.runShopeeStockSweep).toHaveBeenCalledTimes(1);
  });

  it('os três passam APENAS `scheduler` e `nowMs`', async () => {
    // Todo outro membro de `DepsDaVarreduraShopee` é uma costura de TESTE com
    // um default real — a consulta de descoberta, o agregado do livro-razão, os
    // portões da conta, o cliente Shopee. Passar um aqui é como um leitor de
    // pipeline vira um stub que ninguém percebe.
    for (const fn of [sweepShopeeStock, sweepShopeeStockDaily, sweepShopeeStockReconciliacao]) {
      vi.clearAllMocks();
      varredura.runShopeeStockSweep.mockResolvedValue({ enabled: true, contas: [] });
      varredura.ehSlotDoDiario.mockReturnValue(false);
      varredura.ehSlotDaReconciliacao.mockReturnValue(false);

      await rodar(fn);

      const deps = depsDaVarredura();
      expect(Object.keys(deps).sort()).toEqual(['nowMs', 'scheduler']);
      expect(deps.scheduler).toBe(tasks.agendador);
    }
  });
});

describe('a linha de resumo', () => {
  it('soma os contadores por conta e reporta o readCache do tick', async () => {
    varredura.runShopeeStockSweep.mockResolvedValue({
      enabled: true,
      contas: [
        conta({ integracaoId: 'int-1', enqueued: 3, skipped: 5, inalterados: 4, pages: 2 }),
        conta({ integracaoId: 'int-2', enqueued: 1, skipped: 2, inalterados: 2, truncated: true }),
      ],
    });

    await rodar(sweepShopeeStockDaily);

    const payload = (info.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.enabled).toBe(true);
    expect(payload.contas).toBe(2);
    expect(payload.enqueued).toBe(4);
    // ⚠️ `skipped` é um SUPERCONJUNTO de `inalterados` — ele carrega também os
    // descartes por anúncio do planejador — então somar os dois contaria duas
    // vezes a mesma família.
    expect(payload.skipped).toBe(7);
    expect(payload.inalterados).toBe(6);
    expect(payload.pages).toBe(2);
    expect(payload.truncated).toBe(1);
    expect(payload.paused).toBe(0);
    expect(payload.errorCount).toBe(0);
    expect(payload.readCache).toBeDefined();
  });

  it('uma válvula fechada aparece como `enabled: false`, e a linha continua sendo UMA', async () => {
    // O tick já emitiu a linha que NOMEIA a variável, então este campo é a
    // metade legível por máquina do mesmo fato — não uma segunda mensagem.
    varredura.runShopeeStockSweep.mockResolvedValue({ enabled: false, contas: [] });

    await rodar(sweepShopeeStockReconciliacao);

    expect(info).toHaveBeenCalledTimes(1);
    const payload = (info.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.enabled).toBe(false);
    expect(payload.contas).toBe(0);
    expect(aviso).not.toHaveBeenCalled();
  });

  it('as falhas CONTIDAS por conta saem numa linha própria, limitadas a dez', async () => {
    // Uma falha contida não custou nada às outras contas, então ela é uma linha
    // separada do resumo: uma diz "o tick correu", a outra diz "estas contas
    // não correram". Limitada porque a lista é por conta e o número de contas
    // não é limitado.
    varredura.runShopeeStockSweep.mockResolvedValue({
      enabled: true,
      contas: Array.from({ length: 12 }, (_, i) =>
        conta({ integracaoId: `int-${i}`, error: 'indisponível' }),
      ),
    });

    await rodar(sweepShopeeStock);

    const resumo = (info.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(resumo.errorCount).toBe(12);
    expect(aviso).toHaveBeenCalledTimes(1);
    const erros = ((aviso.mock.calls[0] as unknown[])[1] as { erros: unknown[] }).erros;
    expect(erros).toHaveLength(10);
  });

  it('⛔ a linha não carrega corpo nenhum — só contadores e ids de integração', async () => {
    // Par de quase-falha das três acima: aquelas mostram que a linha existe,
    // esta mostra ONDE ela para. Um `...result` ou um `contas: result.contas`
    // passaria em todas elas e derramaria cada linha por conta no log.
    varredura.runShopeeStockSweep.mockResolvedValue({
      enabled: true,
      contas: [conta({ integracaoId: 'int-1', motivoConta: 'loja-fbs' })],
    });

    await rodar(sweepShopeeStock);

    const serializado = JSON.stringify((info.mock.calls[0] as unknown[])[1]);
    expect(serializado).not.toContain('int-1');
    expect(serializado).not.toContain('loja-fbs');
  });
});

/** This module's source with every comment removed — the EXECUTABLE text. */
function fonteExecutavel(): string {
  const fonte = readFileSync(fileURLToPath(new URL('./sweepStock.ts', import.meta.url)), 'utf8');
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
