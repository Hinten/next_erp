import { logger } from 'firebase-functions/v2';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

import { ShopeeConfigError } from '@delfrance/integrations-shopee';

import type {
  ResultadoContaSweepDevolucoes,
  ResultadoSweepDevolucoes,
  ShopeeDevolucoesSweepDeps,
} from '../../lib/shopee/devolucoes/devolucoesSweep';

/**
 * The BODY of `sweepShopeeReturns` (step 17, #1525), driven through
 * `onSchedule`'s own `.run` — what `index.test.ts` (declared options only)
 * cannot reach. The tick itself is pinned one layer down in
 * `lib/shopee/devolucoes/devolucoesSweep.test.ts` against the real FakeDb, so
 * `runShopeeDevolucoesSweep` is MOCKED here and nothing else in that module is:
 * the `motivo` constants and the valve's name are the real ones.
 *
 * ⚠️ Every fixture is a FULL literal of the result types, never a `Partial`: a
 * counter the sweep grows stops compiling here until it is placed, and the
 * summary test then fails until `index.ts` carries it.
 *
 * Env handling is `sweepShopeeAutoArrange.test.ts`'s, verbatim in behaviour.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalShopeeTasksRegion = process.env.SHOPEE_TASKS_REGION;
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalShopeeTasksRegion === undefined) delete process.env.SHOPEE_TASKS_REGION;
  else process.env.SHOPEE_TASKS_REGION = originalShopeeTasksRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

const h = vi.hoisted(() => ({
  run: vi.fn<(db: unknown, deps: ShopeeDevolucoesSweepDeps) => Promise<ResultadoSweepDevolucoes>>(),
  agendador: { enqueue: vi.fn(async () => {}) },
  db: { __fake: 'db' },
}));

vi.mock('../../lib/shopee/devolucoes/devolucoesSweep', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/shopee/devolucoes/devolucoesSweep')>()),
  runShopeeDevolucoesSweep: h.run,
}));
vi.mock('./lib/admin', () => ({ getDb: () => h.db }));
vi.mock('../../lib/shopee/shopeeTasks', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/shopee/shopeeTasks')>()),
  createShopeeTaskScheduler: () => h.agendador,
}));

// Top-level, never inside a hook (index.test.ts says why).
const { sweepShopeeReturns } = await import('./index');
const { MOTIVO_SWEEP_DEVOLUCOES } = await import('../../lib/shopee/devolucoes/devolucoesSweep');

const AGORA_MS = 1_767_000_000_000;
const RESUMO = '[shopee] returns sweep';
const FALHAS = '[shopee] returns sweep com falhas por conta';
const INATIVO = '[shopee] returns sweep inativo — nada lido';

function contaZerada(integracaoId: string): ResultadoContaSweepDevolucoes {
  return {
    integracaoId,
    paginas: 0,
    listadas: 0,
    linhasIlegiveis: 0,
    repetidas: 0,
    jaAtualizadas: 0,
    enfileiradas: { ausente: 0, relogio: 0, divergente: 0, invariante: 0 },
    comFalhaHoje: 0,
    alemDoLimite: 0,
    truncada: false,
    paginacaoAmbigua: false,
    erroEnvelope: null,
    error: null,
  };
}

/** The conta's NUMERIC counters — read off the object, so none is forgotten. */
function contadoresDe(c: ResultadoContaSweepDevolucoes): (keyof ResultadoContaSweepDevolucoes)[] {
  return (Object.keys(c) as (keyof ResultadoContaSweepDevolucoes)[]).filter(
    (k) => typeof c[k] === 'number',
  );
}

/** Every counter (and every reason) at `(k + 1) × escala` — distinct sums per key. */
function contaComTudo(
  integracaoId: string,
  escala: number,
  over: Partial<ResultadoContaSweepDevolucoes> = {},
): ResultadoContaSweepDevolucoes {
  const base = contaZerada(integracaoId);
  const conta = { ...base } as Record<keyof ResultadoContaSweepDevolucoes, unknown>;
  for (const [k, chave] of contadoresDe(base).entries()) conta[chave] = (k + 1) * escala;
  return {
    ...(conta as ResultadoContaSweepDevolucoes),
    enfileiradas: {
      ausente: escala,
      relogio: 2 * escala,
      divergente: 3 * escala,
      invariante: 4 * escala,
    },
    ...over,
  };
}

function tickQueRodou(
  contas: readonly ResultadoContaSweepDevolucoes[],
  over: Partial<ResultadoSweepDevolucoes> = {},
): ResultadoSweepDevolucoes {
  return { motivo: null, contas, semShopId: 0, interrompidoPorLimite: null, ...over };
}

async function rodar(): Promise<void> {
  await sweepShopeeReturns.run({
    scheduleTime: '2026-10-01T09:35:00Z',
    jobName: 'sweepShopeeReturns',
  });
}

function chamada(indice = 0): [unknown, ShopeeDevolucoesSweepDeps] {
  const c = h.run.mock.calls[indice];
  expect(c).toBeDefined();
  return c as [unknown, ShopeeDevolucoesSweepDeps];
}

function resumo(): Record<string, unknown> {
  const linhas = info.mock.calls.filter(([msg]) => msg === RESUMO);
  expect(linhas).toHaveLength(1);
  return (linhas[0] as [string, Record<string, unknown>])[1];
}

let info: MockInstance<typeof logger.info>;
let warn: MockInstance<typeof logger.warn>;

beforeEach(() => {
  vi.useFakeTimers({ now: AGORA_MS, toFake: ['Date'] });
  h.run.mockReset();
  h.run.mockResolvedValue(tickQueRodou([]));
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('sweepShopeeReturns — o CORPO do agendamento', () => {
  it('UM relógio por tique vira `deps.nowMs`; o db, o scheduler e o logger do lane chegam ao sweep, e NENHUMA costura de teste', async () => {
    await rodar();
    const [db, deps] = chamada();
    expect(db).toBe(h.db);
    expect(deps.nowMs).toBe(AGORA_MS);
    expect(deps.scheduler).toBe(h.agendador);
    expect(deps.logger).toBe(logger);
    // No `clientFor`, no `env`: production reads the real conta and process.env.
    expect(Object.keys(deps).sort()).toEqual(['logger', 'nowMs', 'scheduler']);
  });

  it('QUASE-IGUAL: o tique seguinte leva o SEU instante', async () => {
    await rodar();
    vi.setSystemTime(AGORA_MS + 6 * 3_600_000);
    await rodar();
    expect(chamada(0)[1].nowMs).toBe(AGORA_MS);
    expect(chamada(1)[1].nowMs).toBe(AGORA_MS + 6 * 3_600_000);
  });

  it.each([
    [MOTIVO_SWEEP_DEVOLUCOES.desligado, 'SHOPEE_DEVOLUCAO_SWEEP_DISABLED'],
    [MOTIVO_SWEEP_DEVOLUCOES.handlerAusente, null],
    [MOTIVO_SWEEP_DEVOLUCOES.tasksDesabilitado, 'SHOPEE_TASKS_DISABLED'],
  ] as const)(
    'inativo por `%s` ⇒ UMA linha info nomeando %j — nenhum resumo, nenhum warn',
    async (motivo, variavel) => {
      // LITERALS on purpose: the string an operator greps the env for.
      h.run.mockResolvedValue(tickQueRodou([], { motivo }));
      await rodar();
      expect(info.mock.calls).toEqual([[INATIVO, { motivo, variavel }]]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('o resumo SOMA cada contador de cada conta, cada motivo de reimportação, e repassa o que é do tique', async () => {
    const a = contaComTudo('int-1', 1, { truncada: true, erroEnvelope: '-' });
    const b = contaComTudo('int-2', 100, {
      paginacaoAmbigua: true,
      erroEnvelope: ' ',
      error: 'ShopeeApiError: error_param',
    });
    const c = contaComTudo('int-3', 10_000, { erroEnvelope: '-' });
    h.run.mockResolvedValue(
      tickQueRodou([a, b, c], { semShopId: 7, interrompidoPorLimite: 'daily' }),
    );

    await rodar();

    const r = resumo();
    const contadores = contadoresDe(a);
    expect(contadores.length).toBeGreaterThanOrEqual(7); // ÂNCORA
    for (const chave of contadores) {
      expect(r[chave], chave).toBe(
        (a[chave] as number) + (b[chave] as number) + (c[chave] as number),
      );
    }
    expect(r.enfileiradas).toEqual({
      ausente: 10_101,
      relogio: 20_202,
      divergente: 30_303,
      invariante: 40_404,
    });
    expect(r).toMatchObject({
      contas: 3,
      semShopId: 7,
      processadas: 2,
      contasTruncadas: 1,
      contasComPaginacaoAmbigua: 1,
      interrompidoPorLimite: 'daily',
      errorCount: 1,
    });
    // DISTINCT envelope values, never one per conta.
    expect([...(r.errosDeEnvelope as string[])].sort()).toEqual([' ', '-']);
    expect(Object.keys(r).sort()).toEqual(
      [
        ...contadores,
        'enfileiradas',
        'contas',
        'semShopId',
        'processadas',
        'contasTruncadas',
        'contasComPaginacaoAmbigua',
        'errosDeEnvelope',
        'interrompidoPorLimite',
        'errorCount',
        'readCache',
      ].sort(),
    );
  });

  it('o warn lista SÓ as contas com erro, na ordem, até 10 — e o errorCount conta todas', async () => {
    const contas = [
      contaZerada('int-ok'),
      ...Array.from({ length: 12 }, (_, i) => ({
        ...contaZerada(`int-${String(i + 1)}`),
        error: `ShopeeNetworkError: falha ${String(i + 1)}`,
      })),
    ];
    h.run.mockResolvedValue(tickQueRodou(contas));
    await rodar();
    expect(resumo()).toMatchObject({ contas: 13, processadas: 1, errorCount: 12 });
    expect(warn.mock.calls).toEqual([
      [
        FALHAS,
        {
          erros: contas.slice(1, 11).map((x) => ({ integracaoId: x.integracaoId, erro: x.error })),
        },
      ],
    ]);
  });

  it('QUASE-IGUAL: nenhuma conta falhou ⇒ NENHUM warn, e um tique vazio loga os quatro motivos zerados', async () => {
    await rodar();
    expect(resumo()).toMatchObject({
      contas: 0,
      processadas: 0,
      errorCount: 0,
      enfileiradas: { ausente: 0, relogio: 0, divergente: 0, invariante: 0 },
      errosDeEnvelope: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('⛔ o wrapper NÃO engole o que o sweep relança: `ShopeeConfigError` falha o tique, sem resumo', async () => {
    const erro = new ShopeeConfigError('configuração de teste ausente');
    h.run.mockRejectedValue(erro);
    await expect(rodar()).rejects.toBe(erro);
    expect(info.mock.calls.filter(([msg]) => msg === RESUMO)).toEqual([]);
  });
});
