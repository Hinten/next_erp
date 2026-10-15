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

import type { FasePacote } from '../../lib/shopee/etiqueta/faseEtiqueta';
import type {
  ArranjoAutomaticoContaResult,
  ArranjoAutomaticoSweepDeps,
  ArranjoAutomaticoSweepResult,
} from '../../lib/shopee/pedidos/arranjoAutomaticoSweep';

/**
 * The BODY of `sweepShopeeAutoArrange` (step 15b, #1744), driven through
 * `onSchedule`'s own `.run` — the one thing `index.test.ts` cannot reach,
 * because it asserts declared options only and never calls a handler.
 *
 * What lives ONLY here is the wrapper's own work: the ONE clock read it hands
 * the tick as `nowMs`, the db and the lane's scheduler it builds, the info line
 * that names the variable to flip on a disabled tick, the summary that SUMS the
 * per-conta counters, and the warn that lists the contas that failed. The
 * tick's behaviour is asserted one layer down, in
 * `lib/shopee/pedidos/arranjoAutomaticoSweep.test.ts` against the real FakeDb,
 * so `runShopeeArranjoAutomaticoSweep` is MOCKED here — and nothing else in that
 * module is, so the `motivo` constants and the valve's name are the real ones.
 * The split is `sweepStock.test.ts`'s.
 *
 * ⚠️ Every fixture below is a FULL literal of the sweep's result types, never a
 * `Partial`: a counter the sweep grows stops compiling here until it is placed,
 * and the summary test then fails until `index.ts` carries it — which is how
 * "the summary sums every counter" stays true without anyone re-reading it.
 *
 * Review 3b (S4) found the clock (S07), the motivo → variable rows (S08), the
 * phase totals (S09) and the errors warn (S10) all mutable with every suite
 * green; each is pinned below.
 *
 * `FUNCTIONS_REGION` is stubbed BEFORE the import so `options.ts` cannot throw,
 * `SHOPEE_TASKS_REGION` is saved and restored because `options.ts` WRITES it,
 * and `TASKS_INVOKER_SA` because `processNotification.ts` reads it at module
 * scope — none of the three may leak into other files sharing this project.
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
  run: vi.fn<
    (db: unknown, deps: ArranjoAutomaticoSweepDeps) => Promise<ArranjoAutomaticoSweepResult>
  >(),
  agendador: { enqueue: vi.fn(async () => {}) },
  db: { __fake: 'db' },
}));

vi.mock('../../lib/shopee/pedidos/arranjoAutomaticoSweep', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/shopee/pedidos/arranjoAutomaticoSweep')>()),
  runShopeeArranjoAutomaticoSweep: h.run,
}));
vi.mock('./lib/admin', () => ({ getDb: () => h.db }));
vi.mock('../../lib/shopee/shopeeTasks', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/shopee/shopeeTasks')>()),
  createShopeeTaskScheduler: () => h.agendador,
}));

// Top-level, never inside a hook: `./index` is the heaviest module in this
// codebase and a hook carries a 10 s budget (`index.test.ts` says why).
const { sweepShopeeAutoArrange } = await import('./index');
const {
  MOTIVO_ARRANJO_DESLIGADO,
  MOTIVO_SWEEP_DESLIGADO,
  MOTIVO_TASKS_DESABILITADO,
  TRUNCAGEM_ARRANJO,
} = await import('../../lib/shopee/pedidos/arranjoAutomaticoSweep');

/** A real epoch in ms — never 0, so a wrapper that hands the tick `0` is visible. */
const AGORA_MS = 1_767_000_000_000;

const RESUMO = '[shopee] auto-arrange sweep';
const FALHAS = '[shopee] auto-arrange sweep com falhas por conta';
const INATIVO = '[shopee] auto-arrange sweep inativo — nada lido';

/** Every phase, zero — `satisfies` keeps the set total against `FasePacote`. */
const FASES_ZERADAS = {
  'nfe-pendente': 0,
  'nao-pronto': 0,
  retido: 0,
  programar: 0,
  arranjado: 0,
  'janela-fechada': 0,
  inelegivel: 0,
  desconhecido: 0,
} satisfies Record<FasePacote, number>;

/** A conta that walked and found nothing — EVERY field of the type, by name. */
function contaZerada(integracaoId: string): ArranjoAutomaticoContaResult {
  return {
    integracaoId,
    paginasLidas: 0,
    totalInformado: 0,
    linhas: 0,
    ilegiveisNaBusca: 0,
    duplicadas: 0,
    jaArranjadosNaBusca: 0,
    foraDoCanal: 0,
    consultadosNoDetalhe: 0,
    ausentesNoDetalhe: 0,
    ilegiveisNoDetalhe: 0,
    foraDoCanalNoDetalhe: 0,
    canalDesconhecidoNoDetalhe: 0,
    naoConsultadosPeloLimite: 0,
    fases: { ...FASES_ZERADAS },
    nfePendenteNaBusca: 0,
    enfileiradosPacote: 0,
    enfileiradosPedido: 0,
    pedidosComFalhaHoje: 0,
    pacotesComFalhaHoje: 0,
    truncada: false,
    truncadaPor: null,
    error: null,
  };
}

/** The conta's NUMERIC counters — read off the object, so none is forgotten here. */
function contadoresDe(conta: ArranjoAutomaticoContaResult): (keyof ArranjoAutomaticoContaResult)[] {
  return (Object.keys(conta) as (keyof ArranjoAutomaticoContaResult)[]).filter(
    (chave) => typeof conta[chave] === 'number',
  );
}

/**
 * `contaZerada` with the k-th numeric counter, and the k-th phase, set to
 * `(k + 1) × escala`: two contas on different scales give every counter a
 * DISTINCT sum, so an overwrite, a max, a one-conta read or two swapped keys
 * all come out as a different number.
 */
function contaComTudo(
  integracaoId: string,
  escala: number,
  over: Partial<ArranjoAutomaticoContaResult> = {},
): ArranjoAutomaticoContaResult {
  const base = contaZerada(integracaoId);
  const conta = { ...base } as Record<keyof ArranjoAutomaticoContaResult, unknown>;
  for (const [k, chave] of contadoresDe(base).entries()) conta[chave] = (k + 1) * escala;
  const fases = { ...FASES_ZERADAS };
  for (const [k, fase] of (Object.keys(fases) as FasePacote[]).entries()) {
    fases[fase] = (k + 1) * escala;
  }
  return { ...(conta as ArranjoAutomaticoContaResult), fases, ...over };
}

/** A tick that ran — EVERY result-level field, by name. */
function tickQueRodou(
  contas: readonly ArranjoAutomaticoContaResult[],
  over: Partial<ArranjoAutomaticoSweepResult> = {},
): ArranjoAutomaticoSweepResult {
  return {
    enabled: true,
    motivo: null,
    semShopId: 0,
    reconexaoPendente: 0,
    interrompidoPorLimite: null,
    interrompidoPorPrazo: false,
    contas,
    ...over,
  };
}

/** Drive the schedule's body, the way the platform does. */
async function rodar(): Promise<void> {
  await sweepShopeeAutoArrange.run({
    scheduleTime: '2026-10-01T12:02:00Z',
    jobName: 'sweepShopeeAutoArrange',
  });
}

/** The deps the wrapper handed the tick — exactly one call, or the read means nothing. */
function chamada(indice = 0): [unknown, ArranjoAutomaticoSweepDeps] {
  const c = h.run.mock.calls[indice];
  expect(c).toBeDefined();
  return c as [unknown, ArranjoAutomaticoSweepDeps];
}

/** The summary line's payload — asserting it was logged exactly once. */
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

describe('sweepShopeeAutoArrange — o CORPO do agendamento (gap S07–S10 do review 3b)', () => {
  it('UM relógio: o `Date.now()` do tique vira `deps.nowMs` — e o db e o scheduler do lane chegam ao sweep', async () => {
    // `nowMs` stamps every synthetic notification this tick enqueues, and the
    // stamp is inside the doc id: a constant there (S07's `0`) makes the first
    // failure row swallow every later tick's failure (create-only) and reads
    // 1970 on the re-drive clock.
    await rodar();

    expect(h.run).toHaveBeenCalledTimes(1);
    const [db, deps] = chamada();
    expect(db).toBe(h.db);
    expect(deps.nowMs).toBe(AGORA_MS);
    expect(deps.scheduler).toBe(h.agendador);
    expect(deps.logger).toBe(logger);
    // Production passes the three it must and NO test seam: a `clientFor` here
    // would replace the real conta context with whatever was supplied.
    expect(Object.keys(deps).sort()).toEqual(['logger', 'nowMs', 'scheduler']);
  });

  it('QUASE-IGUAL: o relógio é lido POR TIQUE — o tique seguinte leva o SEU instante, nunca o do primeiro', async () => {
    await rodar();
    vi.setSystemTime(AGORA_MS + 300_000);
    await rodar();

    expect(h.run).toHaveBeenCalledTimes(2);
    expect(chamada(0)[1].nowMs).toBe(AGORA_MS);
    expect(chamada(1)[1].nowMs).toBe(AGORA_MS + 300_000);
  });

  it.each([
    [MOTIVO_SWEEP_DESLIGADO, 'SHOPEE_ARRANJO_SWEEP_DISABLED'],
    [MOTIVO_ARRANJO_DESLIGADO, 'SHOPEE_ARRANJO_AUTOMATICO_DISABLED'],
    [MOTIVO_TASKS_DESABILITADO, 'SHOPEE_TASKS_DISABLED'],
  ] as const)(
    'desligado por `%s` ⇒ UMA linha info nomeando `%s` — e nenhum resumo, nenhum warn',
    async (motivo, variavel) => {
      // The variable is written as a LITERAL here, never through the exported
      // constants: it is the string an operator greps the env for, and a swapped
      // row (S08) would send them to flip the wrong valve.
      h.run.mockResolvedValue({ ...tickQueRodou([]), enabled: false, motivo });

      await rodar();

      expect(info.mock.calls).toEqual([[INATIVO, { motivo, variavel }]]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('o resumo SOMA cada contador de cada conta — todas as chaves, fases incluídas — e repassa o que é do tique', async () => {
    const a = contaComTudo('int-1', 1, { truncada: true, truncadaPor: TRUNCAGEM_ARRANJO.paginas });
    const b = contaComTudo('int-2', 100, { error: 'ShopeeApiError: error_server' });
    const tique = tickQueRodou([a, b], {
      semShopId: 7,
      reconexaoPendente: 3,
      interrompidoPorLimite: 'daily',
      interrompidoPorPrazo: true,
    });
    h.run.mockResolvedValue(tique);

    await rodar();

    const r = resumo();
    const contadores = contadoresDe(a);
    // ÂNCORA: the fixture really carries counters, and on distinct scales.
    expect(contadores.length).toBeGreaterThan(10);
    for (const chave of contadores) {
      expect(r[chave], chave).toBe((a[chave] as number) + (b[chave] as number));
    }
    // Every phase present and summed (S09: `=` instead of `+=` keeps the LAST
    // conta's value, here 100 × (k + 1) instead of 101 × (k + 1)).
    expect(r.fases).toEqual(
      Object.fromEntries(
        (Object.keys(FASES_ZERADAS) as FasePacote[]).map((fase) => [
          fase,
          a.fases[fase] + b.fases[fase],
        ]),
      ),
    );
    // What belongs to the TICK rather than to a conta is carried verbatim.
    const { enabled: _enabled, motivo: _motivo, contas: _contas, ...doTique } = tique;
    for (const [chave, valor] of Object.entries(doTique)) expect(r[chave], chave).toEqual(valor);
    expect(r).toMatchObject({ contas: 2, processadas: 1, contasTruncadas: 1, errorCount: 1 });
    // And NOTHING else: a counter added to the tick or to a conta without a
    // line in the summary reds here, not in a log nobody reads.
    expect(Object.keys(r).sort()).toEqual(
      [
        ...contadores,
        'fases',
        ...Object.keys(doTique),
        'contas',
        'processadas',
        'contasTruncadas',
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
          erros: contas.slice(1, 11).map((c) => ({ integracaoId: c.integracaoId, erro: c.error })),
        },
      ],
    ]);
  });

  it('QUASE-IGUAL: nenhuma conta falhou ⇒ NENHUM warn (o resumo ainda sai)', async () => {
    h.run.mockResolvedValue(tickQueRodou([contaZerada('int-1'), contaComTudo('int-2', 3)]));

    await rodar();

    expect(resumo()).toMatchObject({ contas: 2, processadas: 2, errorCount: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('um tique que não varreu conta nenhuma ainda loga TODAS as fases, zeradas', async () => {
    // An absent key is indistinguishable from an arm that never existed.
    await rodar();

    const r = resumo();
    expect(r.fases).toEqual(FASES_ZERADAS);
    expect(r).toMatchObject({ contas: 0, processadas: 0, errorCount: 0, linhas: 0 });
  });

  it('⛔ o wrapper NÃO engole o que o sweep relança: `ShopeeConfigError` falha o tique, sem resumo', async () => {
    // Our own misconfiguration must fail the tick LOUDLY — the sweep rethrows
    // it on purpose, and a try/catch here would turn it into a green tick.
    const erro = new ShopeeConfigError('configuração de teste ausente');
    h.run.mockRejectedValue(erro);

    await expect(rodar()).rejects.toBe(erro);
    expect(info.mock.calls.filter(([msg]) => msg === RESUMO)).toEqual([]);
  });
});
