import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';

import { __setRelogioDoCacheParaTestes } from '../../lib/lojaIntegrada/core/contaCache';
import type { ImportadorPedidoLi } from '../../lib/lojaIntegrada/notificacoes/notificacao';
import { FakeDb, asDb } from '../../lib/lojaIntegrada/testing/fakeDb';
import { espiarStdout, seedConta, seedCredencial } from '../../lib/lojaIntegrada/testing/fixtures';
import { seedNotificacaoLi } from '../../lib/lojaIntegrada/testing/notificacoes';

/**
 * The DECLARED options of every trigger in this codebase, and what the two
 * schedule bodies bind — which nothing else covers.
 *
 * `onSchedule` and `onTaskDispatched` record their options onto
 * `func.__endpoint` at import time and run nothing, so most of this file is a
 * pure config assertion. The cron, the zone and the timeout of a schedule are
 * never exercised by an emulator lane (the functions emulator does not drive
 * Cloud Scheduler), and the queue's rate and retry ladder are honoured by the
 * real Cloud Tasks only — an assertion here is the only place either can fail.
 *
 * ⚠️ Three maps — {@link AGENDAMENTOS}, {@link FILAS} and the empty set of
 * event triggers — and an exhaustiveness test for each, so a trigger added later
 * lands covered or reds this file. Shopee's codebase learned that one family at
 * a time.
 *
 * `FUNCTIONS_REGION` is normally inlined at build time (esbuild `define` in
 * build.mjs); here it is stubbed BEFORE the import so `options.ts` does not
 * throw. `LOJA_INTEGRADA_TASKS_REGION` is saved and restored because
 * `options.ts` WRITES it, and `TASKS_INVOKER_SA` because the queue reads it at
 * module scope — none of the three may leak into other files of this project.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'southamerica-east1';
const originalTasksRegion = process.env.LOJA_INTEGRADA_TASKS_REGION;
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));

// The channel's functions run REAL (spied through), so a schedule's run below
// drives the real pipeline against the fake Firestore; the spies only record
// what the root bound. `importadorPedidoLi` is spied so a test can hand the root
// a sentinel and see it come out the other side.
vi.mock('../../lib/lojaIntegrada/notificacoes/notificacao', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../lib/lojaIntegrada/notificacoes/notificacao')>();
  return {
    ...real,
    importadorPedidoLi: vi.fn(real.importadorPedidoLi),
    reprocessarNotificacoesLi: vi.fn(real.reprocessarNotificacoesLi),
    reprocessarAdiadasLi: vi.fn(real.reprocessarAdiadasLi),
  };
});

const sweep = vi.hoisted(() => ({
  resultado: {
    contas: 4,
    semCredencial: 1,
    estacionadas: 1,
    expiracao: { criado: 1 },
    reconexao: { resolvido: 1 },
    orfaos: 0,
    erros: [{ etapa: 'conta', id: 'conta-li-9', erro: 'x' }],
  },
}));
vi.mock('../../lib/lojaIntegrada/conta/expiracaoSweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lojaIntegrada/conta/expiracaoSweep')>()),
  sweepLojaIntegradaTokenExpiry: vi.fn(async () => sweep.resultado),
}));

// ⚠️ Keep this import at the TOP LEVEL — not in a `beforeAll`: module evaluation
// carries no hook timeout, and `./index` is the heaviest module here.
const modulo = await import('./index');
const {
  filaLeituraLojaIntegrada,
  reprocessLojaIntegradaNotifications,
  sweepLojaIntegradaTokenExpiry,
} = modulo;
const notificacao = await import('../../lib/lojaIntegrada/notificacoes/notificacao');
const expiracao = await import('../../lib/lojaIntegrada/conta/expiracaoSweep');

afterAll(() => {
  if (originalFunctionsRegion === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalTasksRegion === undefined) delete process.env.LOJA_INTEGRADA_TASKS_REGION;
  else process.env.LOJA_INTEGRADA_TASKS_REGION = originalTasksRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

/** Every scheduled trigger this codebase exports. The exhaustiveness test makes adding one mandatory. */
const AGENDAMENTOS = {
  reprocessLojaIntegradaNotifications,
  sweepLojaIntegradaTokenExpiry,
} as const;

/**
 * Every TASK-QUEUE trigger: exactly ONE. The channel has one reads queue that
 * dispatches on `tipo` (Firebase binds one function per queue), and no writes
 * queue before step 7 — a second `onTaskDispatched` here is a defect, not a
 * feature, until that step says otherwise.
 */
const FILAS = { filaLeituraLojaIntegrada } as const;

type Endpoint = Record<string, unknown>;

function endpointOf(fn: unknown): Endpoint {
  return (fn as { __endpoint: Endpoint }).__endpoint;
}

function gatilhoDe(fn: unknown): { schedule?: string; timeZone?: string } {
  return endpointOf(fn).scheduleTrigger as { schedule?: string; timeZone?: string };
}

interface GatilhoDeFila {
  retryConfig: {
    maxAttempts?: number;
    minBackoffSeconds?: number;
    maxBackoffSeconds?: number;
    maxDoublings?: number;
  };
  rateLimits: { maxConcurrentDispatches?: number; maxDispatchesPerSecond?: number };
  invoker?: string[];
}

function filaDe(fn: unknown): GatilhoDeFila {
  return endpointOf(fn).taskQueueTrigger as GatilhoDeFila;
}

/** The module's exports that carry an endpoint with `chave`. */
function exportadosCom(chave: string): string[] {
  return Object.entries(modulo as unknown as Record<string, unknown>)
    .filter(([, valor]) => {
      const endpoint = (valor as { __endpoint?: Endpoint } | null)?.__endpoint;
      return endpoint !== undefined && endpoint[chave] !== undefined;
    })
    .map(([nome]) => nome)
    .sort();
}

function rodarAgendamento(fn: unknown): Promise<void> {
  return (fn as { run(evento: unknown): Promise<void> }).run({});
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let fake: FakeDb;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  fake = new FakeDb();
  h.db = asDb(fake);
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => Date.now());
  vi.stubEnv('LOJA_INTEGRADA_CHAMADAS', undefined);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/* -------------------------------------------------------------------------- */
/*                                The schedules                               */
/* -------------------------------------------------------------------------- */

describe('reprocessLojaIntegradaNotifications — the options', () => {
  it('runs every 30 minutes on the half hour, America/Sao_Paulo', () => {
    // The hot lane re-drives `failed` rows older than 1 h, the deferred lane
    // rides the same tick on a 24 h per-row window. Both are backstops, so the
    // cadence bounds how late a lost notification is recovered.
    expect(gatilhoDe(reprocessLojaIntegradaNotifications).schedule).toBe('*/30 * * * *');
    expect(gatilhoDe(reprocessLojaIntegradaNotifications).timeZone).toBe('America/Sao_Paulo');
  });

  it('has timeoutSeconds 540 — twenty paced rows do not fit the 60 s default', () => {
    expect(endpointOf(reprocessLojaIntegradaNotifications).timeoutSeconds).toBe(540);
  });
});

describe('reprocessLojaIntegradaNotifications — what the run binds', () => {
  it('drains the HOT lane, then the DEFERRED one, 10 rows each, with ONE set of read deps', async () => {
    await rodarAgendamento(reprocessLojaIntegradaNotifications);

    const quente = vi.mocked(notificacao.reprocessarNotificacoesLi);
    const adiada = vi.mocked(notificacao.reprocessarAdiadasLi);
    expect(quente).toHaveBeenCalledTimes(1);
    expect(adiada).toHaveBeenCalledTimes(1);
    expect(quente.mock.invocationCallOrder[0]).toBeLessThan(
      adiada.mock.invocationCallOrder[0] ?? 0,
    );

    const [dbQuente, optsQuente, depsQuente] = quente.mock.calls[0] ?? [];
    const [dbAdiada, optsAdiada, depsAdiada] = adiada.mock.calls[0] ?? [];
    expect(dbQuente).toBe(h.db);
    expect(dbAdiada).toBe(h.db);
    // The limit EXACTLY, and nothing else: an `olderThanMs` here would move the
    // shared core's window, a `now` would freeze its clock.
    expect(optsQuente).toEqual({ limit: 10 });
    expect(optsAdiada).toEqual({ limit: 10 });
    expect(depsAdiada).toBe(depsQuente);

    // The sweep is not a task: same flow, no attempt, no task id.
    expect(depsQuente?.registro).toEqual({ fluxo: 'intake', tentativa: null, idTarefa: null });
    // The environment passed WHOLE and live — the context reads the switch.
    expect(depsQuente?.ambiente).toBe(process.env);
  });

  it('binds the importer from the REAL seam table, read per run', async () => {
    // A sentinel the seam hands back: the root must pass exactly it. A root that
    // hard-coded `null` (or cached the table at load) would pass this test's
    // sibling and fail this one.
    const sentinela: ImportadorPedidoLi = () => Promise.resolve({ kind: 'importado' });
    vi.mocked(notificacao.importadorPedidoLi).mockReturnValueOnce(sentinela);

    await rodarAgendamento(reprocessLojaIntegradaNotifications);

    expect(notificacao.importadorPedidoLi).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(notificacao.reprocessarNotificacoesLi).mock.calls[0]?.[2];
    expect(deps?.importador).toBe(sentinela);
  });

  it('and with the seam untouched it is the table itself — empty in step 3', async () => {
    await rodarAgendamento(reprocessLojaIntegradaNotifications);

    const deps = vi.mocked(notificacao.reprocessarNotificacoesLi).mock.calls[0]?.[2];
    expect(deps?.importador).toBe(notificacao.DESTINO_TIPO_LI.pedido);
    expect(deps?.importador).toBeNull();
  });

  it('runs the real pipeline: with the switch off a failed row MIGRATES to deferred, and a deferred one stays', async () => {
    const stdout = espiarStdout();
    try {
      const falhou = seedNotificacaoLi(fake, 'conta-li-1', '1001', 'failed');
      const adiada = seedNotificacaoLi(fake, 'conta-li-1', '1002', 'deferred');

      await rodarAgendamento(reprocessLojaIntegradaNotifications);

      expect(fake.ler(falhou)).toMatchObject({
        status: 'deferred',
        tentativas: 0,
        erro: 'adiado/chamadas-desligadas',
      });
      // Seeded with 3 deferred passes: this one is the 4th, still below the cap.
      expect(fake.ler(adiada)).toMatchObject({
        status: 'deferred',
        tentativas: 4,
        erro: 'adiado/chamadas-desligadas',
      });

      // The switch refused before any conta read, and its line carries the
      // sweep's registro — the binding the queue's own line would carry.
      const bloqueadas = stdout
        .escritas()
        .map((linha) => JSON.parse(linha) as Record<string, unknown>)
        .filter((linha) => linha.evento === 'chamada-bloqueada');
      expect(bloqueadas).toHaveLength(2);
      for (const linha of bloqueadas) {
        expect(linha).toMatchObject({
          conta: 'conta-li-1',
          fluxo: 'intake',
          tentativa: null,
          idTarefa: null,
        });
      }
    } finally {
      stdout.restaurar();
    }
  });

  it('logs the two lanes SEPARATELY, and a per-row failure by document id only', async () => {
    vi.mocked(notificacao.reprocessarNotificacoesLi).mockResolvedValueOnce({
      processed: 2,
      outcomes: { deferred: 1, failed: 1 },
      errors: [{ docId: 'conta-li-1:1001:poll:-', message: 'mensagem-que-nao-vai-ao-log' }],
    });
    vi.mocked(notificacao.reprocessarAdiadasLi).mockResolvedValueOnce({
      processed: 3,
      outcomes: { deferred: 3 },
      errors: [],
    });

    await rodarAgendamento(reprocessLojaIntegradaNotifications);

    // `readCache` is THIS lane's delta, `null` when the lane touched no cache —
    // as here, where both lanes are stubbed.
    expect(info).toHaveBeenNthCalledWith(1, '[loja-integrada] reprocess sweep (quente)', {
      processed: 2,
      outcomes: { deferred: 1, failed: 1 },
      errorCount: 1,
      readCache: null,
    });
    expect(info).toHaveBeenNthCalledWith(2, '[loja-integrada] reprocess sweep (adiada)', {
      processed: 3,
      outcomes: { deferred: 3 },
      errorCount: 0,
      readCache: null,
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[loja-integrada] reprocess sweep (quente) had per-doc failures',
      { docIds: ['conta-li-1:1001:poll:-'] },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('mensagem-que-nao-vai-ao-log');
  });

  // The stubbed lanes above touch no cache, so both deltas are `null` there and
  // a deferred lane measured from the HOT lane's mark would read the same. Here
  // the lanes run real: the hot lane's one row loads the conta through the read
  // cache, the deferred lane has no row and reads nothing — so its delta must
  // come out zero, not the hot lane's reads counted a second time.
  it("measures each lane's readCache from ITS OWN mark — the deferred lane does not repeat the hot lane's reads", async () => {
    vi.stubEnv('LOJA_INTEGRADA_CHAMADAS', 'on');
    seedConta(fake, 'conta-li-1');
    seedCredencial(fake, 'conta-li-1');
    const falhou = seedNotificacaoLi(fake, 'conta-li-1', '1001', 'failed');

    await rodarAgendamento(reprocessLojaIntegradaNotifications);

    // Anti-vacuity: the hot lane really ran its row through the context.
    expect(fake.ler(falhou)).toMatchObject({ status: 'parked', erro: 'importador-ausente' });
    expect(info).toHaveBeenNthCalledWith(
      1,
      '[loja-integrada] reprocess sweep (quente)',
      expect.objectContaining({
        processed: 1,
        readCache: { 'li:integracao': { hits: 0, misses: 1 } },
      }),
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      '[loja-integrada] reprocess sweep (adiada)',
      expect.objectContaining({
        processed: 0,
        readCache: { 'li:integracao': { hits: 0, misses: 0 } },
      }),
    );
  });
});

describe('sweepLojaIntegradaTokenExpiry', () => {
  it('runs DAILY at 06:30 America/Sao_Paulo', () => {
    // The first warning is 30 days out and the date is typed by an operator: a
    // daily walk is what keeps the horizon from passing between two ticks.
    expect(gatilhoDe(sweepLojaIntegradaTokenExpiry).schedule).toBe('30 6 * * *');
    expect(gatilhoDe(sweepLojaIntegradaTokenExpiry).timeZone).toBe('America/Sao_Paulo');
  });

  it('is NOT weekly — `30 6 * * 1` reads the same at a glance', () => {
    expect(gatilhoDe(sweepLojaIntegradaTokenExpiry).schedule).not.toBe('30 6 * * 1');
  });

  it('has timeoutSeconds 120', () => {
    expect(endpointOf(sweepLojaIntegradaTokenExpiry).timeoutSeconds).toBe(120);
  });

  it('binds the database, a tier-0 increment, the clock in ms and the functions logger', async () => {
    const antes = Date.now();
    await rodarAgendamento(sweepLojaIntegradaTokenExpiry);
    const depois = Date.now();

    const chamadas = vi.mocked(expiracao.sweepLojaIntegradaTokenExpiry).mock.calls;
    expect(chamadas).toHaveLength(1);
    const [db, deps] = chamadas[0] ?? [];
    expect(db).toBe(h.db);
    expect(deps?.nowMs).toBeGreaterThanOrEqual(antes);
    expect(deps?.nowMs).toBeLessThanOrEqual(depois);
    expect(deps?.logger).toBe(logger);
    const incremento = deps?.increment(2);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
    // NEAR-MISS: the step is passed through, not fixed at 1.
    expect((incremento as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
  });

  it('logs one line of counters', async () => {
    await rodarAgendamento(sweepLojaIntegradaTokenExpiry);

    expect(info).toHaveBeenCalledExactlyOnceWith('[loja-integrada] token expiry sweep', {
      contas: 4,
      semCredencial: 1,
      estacionadas: 1,
      expiracao: { criado: 1 },
      reconexao: { resolvido: 1 },
      orfaos: 0,
      errorCount: 1,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The queue                                 */
/* -------------------------------------------------------------------------- */

describe('filaLeituraLojaIntegrada — the declared options', () => {
  const fila = filaDe(filaLeituraLojaIntegrada);

  it('dispatches ONE task at a time, one per second — a correctness property, not a knob', () => {
    // The pacer sleeps 2 000 ms before every Loja Integrada call; only under
    // concurrency 1 does that bound the queue to 30 calls a minute across task
    // boundaries. Exact equality: a 2 here halves the guarantee and still
    // "has a rate limit".
    expect(fila.rateLimits).toEqual({ maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 });
  });

  it('gives up exactly when the pipeline starts to persist: maxAttempts IS TASK_MAX_ATTEMPTS', () => {
    // The handler persists instead of throwing on the attempt this constant calls
    // last. A queue that gave up earlier drops the notification with no failure
    // document; one that gave up later re-delivers a payload already recorded.
    expect(fila.retryConfig.maxAttempts).toBe(TASK_MAX_ATTEMPTS);
    // ÂNCORA: the ladder arithmetic below is written for three.
    expect(TASK_MAX_ATTEMPTS).toBe(3);
  });

  it('backs off 60 s → 300 s with ONE doubling, so each retry lands in a fresh minute', () => {
    expect(fila.retryConfig.minBackoffSeconds).toBe(60);
    expect(fila.retryConfig.maxBackoffSeconds).toBe(300);
    expect(fila.retryConfig.maxDoublings).toBe(1);
  });

  it('has timeoutSeconds 300 — neither the 60 s default nor the 540 of a sweep', () => {
    const timeout = endpointOf(filaLeituraLojaIntegrada).timeoutSeconds;
    expect(timeout).toBe(300);
    expect(timeout).not.toBe(60);
    expect(timeout).not.toBe(540);
  });

  it('closes its whole retry ladder inside HALF the hot sweep window', () => {
    // N runs and the N-1 backoffs BETWEEN them must fit in at most half of the
    // hour after which the hot sweep re-drives a `failed` row: 3 × 300 + 2 × 300.
    const tentativas = fila.retryConfig.maxAttempts ?? 0;
    const execucao = endpointOf(filaLeituraLojaIntegrada).timeoutSeconds as number;
    const backoff = fila.retryConfig.maxBackoffSeconds ?? 0;
    const escadaSegundos = tentativas * execucao + Math.max(tentativas - 1, 0) * backoff;
    expect(escadaSegundos).toBe(1500);
    expect(escadaSegundos).toBeLessThanOrEqual(1800);
  });

  it('declares the invoker, the leg whose absence fails invisibly (#1133)', () => {
    expect(fila.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                         Across every exported trigger                      */
/* -------------------------------------------------------------------------- */

describe('every trigger of the codebase', () => {
  const TODOS = { ...AGENDAMENTOS, ...FILAS };

  it('every onSchedule export is in AGENDAMENTOS — and there are exactly two', () => {
    expect(exportadosCom('scheduleTrigger')).toEqual(Object.keys(AGENDAMENTOS).sort());
    expect(Object.keys(AGENDAMENTOS)).toHaveLength(2);
  });

  it('the task exports are EXACTLY {filaLeituraLojaIntegrada}', () => {
    expect(exportadosCom('taskQueueTrigger')).toEqual(['filaLeituraLojaIntegrada']);
  });

  it('there is no event, HTTPS or callable trigger', () => {
    expect(exportadosCom('eventTrigger')).toEqual([]);
    expect(exportadosCom('httpsTrigger')).toEqual([]);
    expect(exportadosCom('callableTrigger')).toEqual([]);
  });

  it('every runtime export IS a trigger — a constant exported here would read as a function name', () => {
    expect(Object.keys(modulo).sort()).toEqual(Object.keys(TODOS).sort());
  });

  it('the queue export key is exactly FILA_LEITURA_LI — the enqueue target', () => {
    // `index.ts` asserts the pair at module load (a half-rename fails Firebase's
    // codebase analysis); this pins it offline, where the failure names itself.
    expect(notificacao.FILA_LEITURA_LI in modulo).toBe(true);
    expect(notificacao.FILA_LEITURA_LI).toBe('filaLeituraLojaIntegrada');
  });

  it('and the module-load assertion really fires on a half-rename', async () => {
    // The handler module renamed its export while the constant stayed: loading
    // `index.ts` must THROW (Firebase's codebase analysis then fails the deploy
    // loudly) — the pin above alone would not notice the assertion deleted.
    vi.resetModules();
    vi.doMock('./filaLeitura', () => ({ filaRenomeada: {} }));
    try {
      await expect(import('./index')).rejects.toThrow(
        "function-name drift: functions/src/filaLeitura.ts must export a handler named 'filaLeituraLojaIntegrada'",
      );
    } finally {
      vi.doUnmock('./filaLeitura');
      vi.resetModules();
    }
  });

  it('declares NO secret anywhere — the token lives per conta in Firestore', () => {
    // A declared secret missing from Secret Manager fails the whole deploy.
    for (const [nome, fn] of Object.entries(TODOS)) {
      expect(endpointOf(fn).secretEnvironmentVariables ?? [], nome).toEqual([]);
    }
  });

  it('runs in the inlined region (the bare options import, #1108)', () => {
    for (const [nome, fn] of Object.entries(TODOS)) {
      expect(endpointOf(fn).region, nome).toEqual(['southamerica-east1']);
    }
  });

  it('caps instances at 10', () => {
    for (const [nome, fn] of Object.entries(TODOS)) {
      expect(endpointOf(fn).maxInstances, nome).toBe(10);
    }
  });

  it('the schedules are DISTINCT', () => {
    const crons = Object.values(AGENDAMENTOS).map((fn) => gatilhoDe(fn).schedule);
    expect(new Set(crons).size).toBe(crons.length);
  });
});
