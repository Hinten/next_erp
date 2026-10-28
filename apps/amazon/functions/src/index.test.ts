import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { ORIGEM_NOTIFICACAO_AMAZON, TIPO_TAREFA_AMAZON } from '@delfrance/schemas';

import type { ExpiracaoSweepAmazonResult } from '../../lib/amazon/conta/expiracaoSweep';
import { __setRelogioDoCacheParaTestes } from '../../lib/amazon/core/contaCache';
import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import type {
  ImportadorPedidoAmazon,
  PayloadNotificacaoAmazon,
} from '../../lib/amazon/notificacoes/notificacao';
import {
  JANELA_CANCELAMENTO_RECENTE_AMAZON_US,
  importarPedidoAmazon,
} from '../../lib/amazon/pedidos/importarPedido';
import {
  INTERVALO_POLL_AMAZON_MS,
  LEASE_POLL_MS,
  ORCAMENTO_TICK_MS,
  TEMPO_LIMITE_POLL_AMAZON_S,
} from '../../lib/amazon/pedidos/orcamentoPoll';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  espiarStdout,
  seedConta,
  seedCredencial,
  stubAmbiente,
} from '../../lib/amazon/testing/fixtures';

/**
 * The DECLARED options of every trigger in this codebase, and what the two
 * schedule bodies bind and log — which nothing else covers.
 *
 * `onSchedule` and `onTaskDispatched` record their options onto
 * `func.__endpoint` at import time and run nothing, so most of this file is a
 * pure config assertion. The cron, the zone and the timeout of a schedule are
 * never exercised by an emulator lane (the functions emulator does not drive
 * Cloud Scheduler), and the queue's rate and retry ladder are honoured by the
 * real Cloud Tasks only — an assertion here is the only place either can fail.
 *
 * ⚠️ Three maps — {@link AGENDAMENTOS}, {@link FILAS} and {@link GATILHOS} (the
 * Firestore triggers, with their paths in {@link CAMINHOS_DOS_GATILHOS}) — and
 * an exhaustiveness test for each: a trigger added later lands covered or reds
 * this file.
 *
 * `FUNCTIONS_REGION` is normally inlined at build time (esbuild `define` in
 * build.mjs); here it is stubbed BEFORE the import so `options.ts` does not
 * throw. `AMAZON_TASKS_REGION` is saved and restored because `options.ts`
 * WRITES it, and `TASKS_INVOKER_SA` because the queue reads it at module scope
 * — none of the three may leak into other files of this project.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'xx-regiao1';
const originalTasksRegion = process.env.AMAZON_TASKS_REGION;
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
// what the root bound. `importadorPedidoAmazon` (the seam, `destinos.ts` since
// PR 5-e) is spied so a test can hand the root a sentinel — or `null`, the
// empty seam — and see it come out the other side.
vi.mock('../../lib/amazon/notificacoes/notificacao', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/amazon/notificacoes/notificacao')>();
  return {
    ...real,
    reprocessarNotificacoesAmazon: vi.fn(real.reprocessarNotificacoesAmazon),
    reprocessarAdiadasAmazon: vi.fn(real.reprocessarAdiadasAmazon),
  };
});
vi.mock('../../lib/amazon/notificacoes/destinos', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/amazon/notificacoes/destinos')>();
  return { ...real, importadorPedidoAmazon: vi.fn(real.importadorPedidoAmazon) };
});

/** What the mocked expiry body returns: every counter distinct, so a swapped field shows. */
const sweep = vi.hoisted(() => ({
  resultado: {
    contas: 4,
    inativas: 1,
    semCredencial: 2,
    estacionadas: 3,
    reautorizacao: { avisados: 5, resolvidos: 6 },
    reconexao: { avisados: 7, resolvidos: 8 },
    orfaos: { lidos: 9, paginas: 1, truncado: false, resolvidos: 10 },
    segredo: { acao: 'resolvido', dias: 40, fechou: true },
    erros: [
      { etapa: 'conta', id: 'conta-amz-9', erro: 'CredencialAmazonInvalidaError' },
      { etapa: 'orfaos', id: 'consulta', erro: 'GrpcStatusError' },
      { etapa: 'conta', id: 'conta-amz-8', erro: 'CredencialAmazonInvalidaError' },
    ],
  } satisfies ExpiracaoSweepAmazonResult as ExpiracaoSweepAmazonResult,
}));
vi.mock('../../lib/amazon/conta/expiracaoSweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/amazon/conta/expiracaoSweep')>()),
  sweepAmazonExpiracoes: vi.fn(async () => Promise.resolve(sweep.resultado)),
}));

// ⚠️ Keep this import at the TOP LEVEL — not in a `beforeAll`: module evaluation
// carries no hook timeout, and `./index` is the heaviest module here.
const modulo = await import('./index');
const {
  filaLeituraAmazon,
  onIntegracaoAmazonChanged,
  pollAmazonOrders,
  reprocessAmazonNotifications,
  sweepAmazonExpirations,
} = modulo;
const notificacao = await import('../../lib/amazon/notificacoes/notificacao');
const destinos = await import('../../lib/amazon/notificacoes/destinos');
const expiracao = await import('../../lib/amazon/conta/expiracaoSweep');

afterAll(() => {
  if (originalFunctionsRegion === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalTasksRegion === undefined) delete process.env.AMAZON_TASKS_REGION;
  else process.env.AMAZON_TASKS_REGION = originalTasksRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

/** Every scheduled trigger this codebase exports. The exhaustiveness test makes adding one mandatory. */
const AGENDAMENTOS = {
  pollAmazonOrders,
  reprocessAmazonNotifications,
  sweepAmazonExpirations,
} as const;

/**
 * Every TASK-QUEUE trigger: exactly ONE. The channel has one reads queue that
 * dispatches on `tipo` (Firebase binds one function per queue), and no writes
 * queue before the write engine — a second `onTaskDispatched` here is a defect,
 * not a feature, until a step says otherwise.
 */
const FILAS = { filaLeituraAmazon } as const;

/**
 * Every FIRESTORE-TRIGGER export — the third sibling of {@link AGENDAMENTOS}
 * and {@link FILAS}, and it exists for the same reason. A gen2 Firestore
 * trigger carries `eventTrigger`, so the two exhaustiveness tests that filter
 * on `scheduleTrigger` / `taskQueueTrigger` enumerate it in NEITHER: without
 * this map its region, its `database`, its secrets and its `retry` would be read
 * by nothing.
 *
 * The failure it guards is the silent one: an `onDocument*` bound to the
 * `(default)` sentinel, or with no `database` at all, deploys fine and never
 * fires, with nothing anywhere to say so. Master plan step 20 added the first
 * (`onIntegracaoAmazonChanged`); the `every GATILHO…` tests below walk the MAP,
 * never a named trigger, so a second one lands covered.
 */
const GATILHOS = { onIntegracaoAmazonChanged } as const;

/**
 * The document path each trigger must listen on — derived from the HANDLE,
 * never a second literal, plus an ANCHOR literal so the comparison can never be
 * two `undefined`s agreeing. `satisfies` over the {@link GATILHOS} keys: a
 * trigger with no row here does not compile.
 */
const CAMINHOS_DOS_GATILHOS = {
  onIntegracaoAmazonChanged: {
    colecao: integracaoCollection.resolvePath({}),
    ancora: 'integracao',
    folha: '{integracaoId}',
  },
} as const satisfies Record<
  keyof typeof GATILHOS,
  { colecao: string; ancora: string; folha: string }
>;

/** The secret a READ run binds — and nothing else may (a missing one fails the deploy). */
const SEGREDO_LWA = 'AMAZON_LWA_CLIENT_SECRET';

type Endpoint = Record<string, unknown>;

function endpointOf(fn: unknown): Endpoint {
  return (fn as { __endpoint: Endpoint }).__endpoint;
}

function gatilhoDe(fn: unknown): {
  schedule?: string;
  timeZone?: string;
  retryConfig?: { retryCount?: number };
} {
  return endpointOf(fn).scheduleTrigger as {
    schedule?: string;
    timeZone?: string;
    retryConfig?: { retryCount?: number };
  };
}

/**
 * The minutes an `m1,m2,… * * * *` cron fires at, or `null` for any other shape
 * (an hourly field, a step, a day field): the poll's interval is READ off its
 * deployed cron, never restated.
 */
function minutosDoCron(cron: string | undefined): number[] | null {
  const m = /^(\d{1,2}(?:,\d{1,2})*) \* \* \* \*$/.exec(cron ?? '');
  if (m === null) return null;
  return (m[1] ?? '').split(',').map(Number);
}

/** The gaps between consecutive firings of an hourly minute list, wrapping the hour. */
function intervalosDoCronMs(minutos: readonly number[]): number[] {
  const ordenados = [...minutos].sort((a, b) => a - b);
  return ordenados.map((m, i) => {
    const proximo = ordenados[(i + 1) % ordenados.length] ?? m;
    const gap = i === ordenados.length - 1 ? proximo + 60 - m : proximo - m;
    return gap * 60_000;
  });
}

/** The secret NAMES an endpoint binds (`[]` when none). */
function segredosDe(fn: unknown): (string | undefined)[] {
  return ((endpointOf(fn).secretEnvironmentVariables as { key?: string }[] | undefined) ?? []).map(
    (s) => s.key,
  );
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

interface GatilhoDeEvento {
  eventFilters?: { database?: string };
  eventFilterPathPatterns?: { document?: string };
  retry?: boolean;
}

function gatilhoDeEvento(fn: unknown): GatilhoDeEvento {
  return endpointOf(fn).eventTrigger as GatilhoDeEvento;
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

let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  stdout = espiarStdout();
  fake = new FakeDb();
  h.db = asDb(fake);
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => Date.now());
  vi.stubEnv('AMAZON_CHAMADAS', undefined);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  stdout.restaurar();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** Every JSON line the app's logger wrote to stdout, parsed. */
function linhas(): Record<string, unknown>[] {
  return stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The `evento: 'varredura'` lines, in order. */
function linhasDaVarredura(): Record<string, unknown>[] {
  return linhas().filter((l) => l.evento === 'varredura');
}

const COLECAO = 'notificacoesAmazon';

function push(n: number): PayloadNotificacaoAmazon {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.push,
    sellerId: SPID_A,
    amazonOrderId: `000-0000000-000000${String(n)}`,
    notificationId: `00000000-0000-0000-0000-00000000000${String(n)}`,
    publishTimeMs: AGORA_MS - 1000,
  };
}

/** A failure document as the shared store leaves it, an old one (both lanes' windows cover it). */
function seedNotificacao(
  p: PayloadNotificacaoAmazon,
  status: 'failed' | 'deferred',
  tentativas: number,
): string {
  const caminho = `${COLECAO}/${notificacao.docIdNotificacaoAmazon(p)}`;
  fake.seed(caminho, {
    ...notificacao.camposDoDocumentoAmazon(p),
    status,
    tentativas,
    erro: status === 'deferred' ? 'adiado/chamadas-desligadas' : 'x',
    processedAt: 0,
  });
  return caminho;
}

/* -------------------------------------------------------------------------- */
/*                                The schedules                               */
/* -------------------------------------------------------------------------- */

describe('reprocessAmazonNotifications — the options', () => {
  it('runs at :10 and :40, America/Sao_Paulo — twice an hour, off the half-hour', () => {
    expect(gatilhoDe(reprocessAmazonNotifications).schedule).toBe('10,40 * * * *');
    expect(gatilhoDe(reprocessAmazonNotifications).timeZone).toBe('America/Sao_Paulo');
  });

  it('has timeoutSeconds 540 — twenty sequential rows do not fit the 60 s default', () => {
    expect(endpointOf(reprocessAmazonNotifications).timeoutSeconds).toBe(540);
  });

  it('binds EXACTLY the LWA client secret — a re-drive may refresh a token', () => {
    expect(segredosDe(reprocessAmazonNotifications)).toEqual([SEGREDO_LWA]);
  });
});

describe('reprocessAmazonNotifications — what the run binds', () => {
  it('drains the HOT lane, then the DEFERRED one, 10 rows each, with ONE set of read deps', async () => {
    await rodarAgendamento(reprocessAmazonNotifications);

    const quente = vi.mocked(notificacao.reprocessarNotificacoesAmazon);
    const adiada = vi.mocked(notificacao.reprocessarAdiadasAmazon);
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
    // The environment passed WHOLE and live — the context reads the switch.
    expect(depsQuente?.ambiente).toBe(process.env);
    // The app's ONE logger.
    expect(depsQuente?.logger).toBe(LOGGER_STDOUT_AMAZON);
    const incremento = depsQuente?.increment(2);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
  });

  it('binds the importer from the REAL seam table, read per run', async () => {
    // A sentinel the seam hands back: the root must pass exactly it. A root that
    // hard-coded `null` (or cached the table at load) would pass this test's
    // sibling and fail this one.
    const sentinela: ImportadorPedidoAmazon = () => Promise.resolve({ kind: 'importado' });
    vi.mocked(destinos.importadorPedidoAmazon).mockReturnValueOnce(sentinela);

    await rodarAgendamento(reprocessAmazonNotifications);

    expect(destinos.importadorPedidoAmazon).toHaveBeenCalledTimes(1);
    const deps = vi.mocked(notificacao.reprocessarNotificacoesAmazon).mock.calls[0]?.[2];
    expect(deps?.importador).toBe(sentinela);
  });

  it('★ and with the seam untouched it is the table itself — the step-5 order import (PR 5-e)', async () => {
    await rodarAgendamento(reprocessAmazonNotifications);

    const deps = vi.mocked(notificacao.reprocessarNotificacoesAmazon).mock.calls[0]?.[2];
    expect(deps?.importador).toBe(destinos.DESTINO_TIPO_AMAZON.pedido);
    expect(deps?.importador).toBe(importarPedidoAmazon);
  });

  it('binds the importer’s CEP lookup: ONE process-wide client, the same object on every run', async () => {
    await rodarAgendamento(reprocessAmazonNotifications);
    await rodarAgendamento(reprocessAmazonNotifications);

    const [primeira, segunda] = vi
      .mocked(notificacao.reprocessarNotificacoesAmazon)
      .mock.calls.map((c) => c[2]);
    expect(typeof primeira?.viaCep.buscarCep).toBe('function');
    expect(segunda?.viaCep).toBe(primeira?.viaCep);
  });

  it('runs the real pipeline: with the switch off a failed row MIGRATES to deferred, and a deferred one stays', async () => {
    const falhou = seedNotificacao(push(1), 'failed', 2);
    const adiada = seedNotificacao(push(2), 'deferred', 3);

    await rodarAgendamento(reprocessAmazonNotifications);

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
    // The switch refused before any conta read, once per row.
    expect(linhas().filter((l) => l.evento === 'chamada-bloqueada')).toHaveLength(2);
    expect(fake.leituras).toEqual([]);
  });

  it('logs the two lanes SEPARATELY — never summed — and a per-row failure by document id only', async () => {
    vi.mocked(notificacao.reprocessarNotificacoesAmazon).mockResolvedValueOnce({
      processed: 2,
      outcomes: { deferred: 1, failed: 1 },
      errors: [{ docId: 'push:00000000-0000-0000-0000-000000000009', message: 'msg-fora-do-log' }],
    });
    vi.mocked(notificacao.reprocessarAdiadasAmazon).mockResolvedValueOnce({
      processed: 3,
      outcomes: { deferred: 3 },
      errors: [],
    });

    await rodarAgendamento(reprocessAmazonNotifications);

    const [quente, falhas, adiada, ...resto] = linhasDaVarredura();
    expect(resto).toEqual([]);
    // EXACT lines: a summed `processed: 5`, a merged outcome map or a lane
    // label swapped fails here. No read cache moved (both lanes stubbed), so
    // the delta adds no field beyond the registered cache's zeroes.
    expect(quente).toMatchObject({
      evento: 'varredura',
      varredura: 'reprocesso',
      lane: 'hot',
      processed: 2,
      erros: 1,
      outcome_deferred: 1,
      outcome_failed: 1,
      fluxo: 'reprocesso',
      severity: 'INFO',
      message: '[amazon] varredura de reprocessamento (hot)',
    });
    expect(falhas).toEqual({
      varredura: 'reprocesso',
      lane: 'hot',
      erros: 1,
      docIds: 'push:00000000-0000-0000-0000-000000000009',
      docIds_omitidos: 0,
      evento: 'varredura',
      fluxo: 'reprocesso',
      severity: 'WARNING',
      message: '[amazon] varredura de reprocessamento (hot) com falhas por documento',
    });
    expect(adiada).toMatchObject({
      lane: 'deferred',
      processed: 3,
      erros: 0,
      outcome_deferred: 3,
      severity: 'INFO',
      message: '[amazon] varredura de reprocessamento (deferred)',
    });
    // NEAR-MISS: the deferred line carries ONLY its own outcomes.
    expect(adiada).not.toHaveProperty('outcome_failed');
    expect(linhasDaVarredura().some((l) => l.processed === 5)).toBe(false);
    // The shared core's message never reaches a line.
    expect(stdout.linhas().join('\n')).not.toContain('msg-fora-do-log');
  });

  /** The hot lane fails exactly these rows; the deferred lane is empty. */
  function falhamNaRaiaQuente(docIds: readonly string[]): void {
    vi.mocked(notificacao.reprocessarNotificacoesAmazon).mockResolvedValueOnce({
      processed: docIds.length,
      outcomes: { failed: docIds.length },
      errors: docIds.map((docId) => ({ docId, message: 'm' })),
    });
    vi.mocked(notificacao.reprocessarAdiadasAmazon).mockResolvedValueOnce({
      processed: 0,
      outcomes: {},
      errors: [],
    });
  }

  /** The hot lane's per-document WARNING line. */
  function linhaDasFalhas(): Record<string, unknown> | undefined {
    return linhasDaVarredura().find(
      (l) => l.message === '[amazon] varredura de reprocessamento (hot) com falhas por documento',
    );
  }

  /** A poll row's id (`docIdNotificacaoAmazon`'s shape): 5 + conta + 1 + 19 + 1 + 16 bytes. */
  const idDePoll = (conta: string, i: number) =>
    `poll:${conta}:000-0000000-000000${String(i)}:${String(1_800_000_000_000_000 + i)}`;

  it('names every short id — the bound is the sink’s 256 bytes, not a count', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `push:id-${String(i)}`);
    falhamNaRaiaQuente(ids);

    await rodarAgendamento(reprocessAmazonNotifications);

    expect(linhaDasFalhas()).toMatchObject({
      erros: 7,
      docIds: ids.join(','),
      docIds_omitidos: 0,
      severity: 'WARNING',
    });
  });

  it('never lets the sink cut a poll id mid-string: the ids that do not fit are COUNTED, not named', async () => {
    // 51 bytes each: four fit (207 bytes), a fifth would make 259.
    const ids = Array.from({ length: 7 }, (_, i) => idDePoll('conta-abc', i));
    expect(ids.every((id) => Buffer.byteLength(id) === 51)).toBe(true);
    falhamNaRaiaQuente(ids);

    await rodarAgendamento(reprocessAmazonNotifications);

    const linha = linhaDasFalhas();
    expect(linha).toMatchObject({ erros: 7, docIds_omitidos: 3 });
    const nomeados = String(linha?.docIds).split(',');
    // Every named id is a COMPLETE input id, in order — none cut.
    expect(nomeados).toEqual(ids.slice(0, 4));
    expect(Buffer.byteLength(String(linha?.docIds))).toBeLessThanOrEqual(256);
  });

  it('at the longest conta id the sink writes unmasked (119 characters), ONE poll id fits', async () => {
    // Below the sink's 120-character blob mask; 161 bytes each, two would be 323.
    const ids = Array.from({ length: 3 }, (_, i) => idDePoll('c'.repeat(119), i));
    falhamNaRaiaQuente(ids);

    await rodarAgendamento(reprocessAmazonNotifications);

    expect(linhaDasFalhas()).toMatchObject({ erros: 3, docIds: ids[0], docIds_omitidos: 2 });
  });

  it.each<[string, number, number]>([
    ['a line of exactly 256 bytes names both ids', 86, 0],
    ['one byte more (257) names only the first', 87, 1],
  ])('the bound is the sink’s own cap, to the byte: %s', async (_caso, contaB, omitidos) => {
    // 42 + 85 bytes, a comma, then 42 + 86 (or 87): 256 (or 257) bytes in all.
    const ids = [idDePoll('c'.repeat(85), 0), idDePoll('c'.repeat(contaB), 1)];
    expect(Buffer.byteLength(ids.join(','))).toBe(256 + omitidos);
    falhamNaRaiaQuente(ids);

    await rodarAgendamento(reprocessAmazonNotifications);

    expect(linhaDasFalhas()).toMatchObject({
      erros: 2,
      docIds: ids.slice(0, ids.length - omitidos).join(','),
      docIds_omitidos: omitidos,
    });
  });

  it('at the 128-character maximum the sink would MASK the id, so none is named — counted, never written masked', async () => {
    // `CONTA_ID_AMAZON_REGEX`'s maximum: the conta segment reads as a blob, and a
    // masked id names no document.
    const ids = Array.from({ length: 3 }, (_, i) => idDePoll('c'.repeat(128), i));
    falhamNaRaiaQuente(ids);

    await rodarAgendamento(reprocessAmazonNotifications);

    expect(linhaDasFalhas()).toMatchObject({ erros: 3, docIds: '', docIds_omitidos: 3 });
    expect(stdout.linhas().join('\n')).not.toContain('<redacted');
  });

  it('the counts line is a WARNING when the lane PARKED a row (no sweep re-drives it), INFO otherwise', async () => {
    vi.mocked(notificacao.reprocessarNotificacoesAmazon).mockResolvedValueOnce({
      processed: 2,
      outcomes: { parked: 1, failed: 1 },
      errors: [],
    });
    vi.mocked(notificacao.reprocessarAdiadasAmazon).mockResolvedValueOnce({
      processed: 2,
      outcomes: { deferred: 2 },
      errors: [],
    });

    await rodarAgendamento(reprocessAmazonNotifications);

    const [quente, adiada, ...resto] = linhasDaVarredura();
    expect(resto).toEqual([]);
    expect(quente).toMatchObject({ lane: 'hot', outcome_parked: 1, severity: 'WARNING' });
    // NEAR-MISS: rows that come back on a later tick are not a warning.
    expect(adiada).toMatchObject({ lane: 'deferred', outcome_deferred: 2, severity: 'INFO' });
  });

  // The stubbed lanes above touch no cache. Here the lanes run real: the hot
  // lane's one row loads the conta through the read cache, the deferred lane
  // has no row and reads nothing — so its delta must come out zero, not the
  // hot lane's reads counted a second time.
  it("measures each lane's read cache from ITS OWN mark — the deferred lane does not repeat the hot lane's reads", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA_MS);
    stubAmbiente(AMBIENTE_LIGADO);
    seedConta(fake, 'conta-1', { selling_partner_id: SPID_A });
    seedCredencial(fake, 'conta-1');
    const falhou = seedNotificacao(push(1), 'failed', 0);
    // The seam MOCKED empty (step 3's state, PR 5-e): the row stops at the seam
    // after its conta read, with no Amazon call — the filled seam would run the
    // real import, whose getOrder this file's refusing fetch would fail.
    vi.mocked(destinos.importadorPedidoAmazon).mockReturnValueOnce(null);

    await rodarAgendamento(reprocessAmazonNotifications);

    // Anti-vacuity: the hot lane really ran its row through the context, and the
    // empty seam deferred it.
    expect(fake.ler(falhou)).toMatchObject({
      status: 'deferred',
      erro: 'adiado/importador-ausente',
    });
    const [quente, adiada] = linhasDaVarredura();
    expect(quente).toMatchObject({
      lane: 'hot',
      processed: 1,
      readCache_amazon_integracao_hits: 0,
      readCache_amazon_integracao_misses: 1,
    });
    expect(adiada).toMatchObject({
      lane: 'deferred',
      processed: 0,
      readCache_amazon_integracao_hits: 0,
      readCache_amazon_integracao_misses: 0,
    });
  });
});

describe('pollAmazonOrders — the options and their arithmetic', () => {
  const minutos = minutosDoCron(gatilhoDe(pollAmazonOrders).schedule);
  const timeoutMs = (endpointOf(pollAmazonOrders).timeoutSeconds as number) * 1000;

  it('runs at :07, :22, :37 and :52, America/Sao_Paulo', () => {
    expect(gatilhoDe(pollAmazonOrders).schedule).toBe('7,22,37,52 * * * *');
    expect(gatilhoDe(pollAmazonOrders).timeZone).toBe('America/Sao_Paulo');
  });

  it('fires every 15 minutes EXACTLY — the interval the body budgets with (INTERVALO_POLL_AMAZON_MS)', () => {
    expect(minutos).not.toBeNull();
    // Every gap, the wrap across the hour included: an uneven cron (say
    // `7,22,37,50`) would starve one slot and crowd another.
    expect(intervalosDoCronMs(minutos ?? [])).toEqual([900_000, 900_000, 900_000, 900_000]);
    expect(new Set(intervalosDoCronMs(minutos ?? []))).toEqual(new Set([INTERVALO_POLL_AMAZON_MS]));
  });

  it('has timeoutSeconds 300 — the value the body budgets against (TEMPO_LIMITE_POLL_AMAZON_S)', () => {
    expect(endpointOf(pollAmazonOrders).timeoutSeconds).toBe(300);
    expect(endpointOf(pollAmazonOrders).timeoutSeconds).toBe(TEMPO_LIMITE_POLL_AMAZON_S);
  });

  it('★ the tick budget < the timeout < the lease < the interval, read off the deployed endpoint', () => {
    // The tick's budget fits the timeout (the last conta keeps room for its
    // final write).
    expect(ORCAMENTO_TICK_MS).toBeLessThan(timeoutMs);
    // A live run's lease never expires under it: no second run can take the
    // lease while this one still writes.
    expect(LEASE_POLL_MS).toBeGreaterThan(timeoutMs);
    // A crashed run's lease is free by the next tick.
    const intervalo = Math.min(...intervalosDoCronMs(minutos ?? []));
    expect(intervalo).toBeGreaterThan(LEASE_POLL_MS);
    // ÂNCORA: the numbers this arithmetic was written for.
    expect([ORCAMENTO_TICK_MS, timeoutMs, LEASE_POLL_MS, intervalo]).toEqual([
      240_000, 300_000, 360_000, 900_000,
    ]);
  });

  it('retries nothing: a failed tick waits for the next one (a retry would only race its lease)', () => {
    expect(gatilhoDe(pollAmazonOrders).retryConfig?.retryCount).toBe(0);
  });

  it('binds EXACTLY the LWA client secret — a conta’s run may refresh its access token', () => {
    expect(segredosDe(pollAmazonOrders)).toEqual([SEGREDO_LWA]);
  });
});

describe('sweepAmazonExpirations', () => {
  it('runs DAILY at 07:15 America/Sao_Paulo', () => {
    expect(gatilhoDe(sweepAmazonExpirations).schedule).toBe('15 7 * * *');
    expect(gatilhoDe(sweepAmazonExpirations).timeZone).toBe('America/Sao_Paulo');
  });

  it('has timeoutSeconds 120', () => {
    expect(endpointOf(sweepAmazonExpirations).timeoutSeconds).toBe(120);
  });

  it('binds NO secret — it makes no Amazon call, and a missing secret fails the whole deploy', () => {
    expect(segredosDe(sweepAmazonExpirations)).toEqual([]);
  });

  it('binds the database, a tier-0 increment, the clock in ms, the live environment and the app logger', async () => {
    const antes = Date.now();
    await rodarAgendamento(sweepAmazonExpirations);
    const depois = Date.now();

    const chamadas = vi.mocked(expiracao.sweepAmazonExpiracoes).mock.calls;
    expect(chamadas).toHaveLength(1);
    const [db, deps] = chamadas[0] ?? [];
    expect(db).toBe(h.db);
    expect(deps?.nowMs).toBeGreaterThanOrEqual(antes);
    expect(deps?.nowMs).toBeLessThanOrEqual(depois);
    expect(deps?.ambiente).toBe(process.env);
    expect(deps?.logger).toBe(LOGGER_STDOUT_AMAZON);
    const incremento = deps?.increment(2);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
    // NEAR-MISS: the step is passed through, not fixed at 1.
    expect((incremento as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
  });

  it('logs ONE line of flattened counters, the error CLASSES joined, never an id — a WARNING when anything failed', async () => {
    await rodarAgendamento(sweepAmazonExpirations);

    expect(linhasDaVarredura()).toEqual([
      {
        varredura: 'expiracao',
        contas: 4,
        inativas: 1,
        semCredencial: 2,
        estacionadas: 3,
        reautorizacao_avisados: 5,
        reautorizacao_resolvidos: 6,
        reconexao_avisados: 7,
        reconexao_resolvidos: 8,
        orfaos_lidos: 9,
        orfaos_paginas: 1,
        orfaos_truncado: false,
        orfaos_resolvidos: 10,
        segredo_acao: 'resolvido',
        segredo_dias: 40,
        erros: 3,
        erros_classes: 'CredencialAmazonInvalidaError,GrpcStatusError',
        evento: 'varredura',
        severity: 'WARNING',
        message: '[amazon] varredura de expiração',
      },
    ]);
    const texto = stdout.linhas().join('\n');
    expect(texto).not.toContain('conta-amz-9');
    expect(texto).not.toContain('conta-amz-8');
  });

  it('a clean run is INFO with no error classes; a skipped secret pass carries no `dias`', async () => {
    vi.mocked(expiracao.sweepAmazonExpiracoes).mockResolvedValueOnce({
      ...sweep.resultado,
      segredo: { acao: 'pulado' },
      erros: [],
    });

    await rodarAgendamento(sweepAmazonExpirations);

    expect(linhasDaVarredura()).toEqual([
      expect.objectContaining({
        segredo_acao: 'pulado',
        segredo_dias: null,
        erros: 0,
        erros_classes: null,
        severity: 'INFO',
      }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The queue                                 */
/* -------------------------------------------------------------------------- */

describe('filaLeituraAmazon — the declared options', () => {
  const fila = filaDe(filaLeituraAmazon);

  it("dispatches ONE task at a time, at most one every two seconds — getOrder's rate", () => {
    expect(fila.rateLimits.maxConcurrentDispatches).toBe(1);
    expect(fila.rateLimits.maxDispatchesPerSecond).toBeLessThanOrEqual(0.5);
    expect(fila.rateLimits).toEqual({ maxConcurrentDispatches: 1, maxDispatchesPerSecond: 0.5 });
  });

  it('gives up exactly when the pipeline starts to persist: maxAttempts IS TASK_MAX_ATTEMPTS', () => {
    // The handler persists instead of throwing on the attempt this constant calls
    // last. A queue that gave up earlier drops the notification with no failure
    // document; one that gave up later re-delivers a payload already recorded.
    expect(fila.retryConfig.maxAttempts).toBe(TASK_MAX_ATTEMPTS);
    // ÂNCORA: the ladder arithmetic below is written for three.
    expect(TASK_MAX_ATTEMPTS).toBe(3);
  });

  it('backs off 10 s → 300 s with up to three doublings', () => {
    expect(fila.retryConfig.minBackoffSeconds).toBe(10);
    expect(fila.retryConfig.maxBackoffSeconds).toBe(300);
    expect(fila.retryConfig.maxDoublings).toBe(3);
  });

  it('has timeoutSeconds 120 — neither the 60 s default nor the 540 of a sweep', () => {
    expect(endpointOf(filaLeituraAmazon).timeoutSeconds).toBe(120);
  });

  it("closes its whole retry ladder inside HALF the hot sweep's one-hour window", () => {
    // N runs and the N-1 backoffs BETWEEN them (each at most maxBackoff) must fit
    // in at most half of the hour after which the hot sweep re-drives a
    // `failed` row: 3 × 120 + 2 × 300.
    const tentativas = fila.retryConfig.maxAttempts ?? 0;
    const execucao = endpointOf(filaLeituraAmazon).timeoutSeconds as number;
    const backoff = fila.retryConfig.maxBackoffSeconds ?? 0;
    const escadaSegundos = tentativas * execucao + Math.max(tentativas - 1, 0) * backoff;
    expect(escadaSegundos).toBe(960);
    expect(escadaSegundos).toBeLessThanOrEqual(1800);
  });

  it('declares the invoker, the leg whose absence fails invisibly (#1133)', () => {
    expect(fila.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });

  it('binds EXACTLY the LWA client secret', () => {
    expect(segredosDe(filaLeituraAmazon)).toEqual([SEGREDO_LWA]);
  });
});

/* -------------------------------------------------------------------------- */
/*               The step-5 recent-cancel window vs the deployed options      */
/* -------------------------------------------------------------------------- */

describe('the recent-cancel window of the order import (plan §3 decisions 12 and 44)', () => {
  // A first-seen CANCELLED (or otherwise reversed) order is skipped with ZERO
  // writes, a decision no precondition can guard: the import waits until no
  // other importer can still hold an older read of the order — one that would
  // create a reserving pedido after the skip, with nothing ever cancelling it.
  // The longest any importer can hold a read before its commit is its
  // function's timeout: the reprocess sweep runs the import INLINE (540 s),
  // the queue's dispatch for 120 s. Both read off the deployed endpoints, never
  // restated, each with a minute of margin.
  const janelaS = JANELA_CANCELAMENTO_RECENTE_AMAZON_US / 1_000_000;
  const MARGEM_S = 60;

  it.each([
    ['the reprocess sweep (inline re-drives)', () => reprocessAmazonNotifications],
    ['the reads queue', () => filaLeituraAmazon],
  ] as const)('★ the window exceeds %s timeout plus a minute', (_nome, funcao) => {
    const timeoutS = endpointOf(funcao()).timeoutSeconds as number;
    expect(Number.isInteger(timeoutS) && timeoutS > 0).toBe(true);
    expect(janelaS).toBeGreaterThan(timeoutS + MARGEM_S);
  });

  it('ÂNCORA: the numbers this arithmetic was written for — 15 min against 540 s and 120 s', () => {
    expect([
      janelaS,
      endpointOf(reprocessAmazonNotifications).timeoutSeconds,
      endpointOf(filaLeituraAmazon).timeoutSeconds,
    ]).toEqual([900, 540, 120]);
  });
});

/* -------------------------------------------------------------------------- */
/*                            The Firestore triggers                          */
/* -------------------------------------------------------------------------- */

describe('the Firestore triggers (GATILHOS)', () => {
  it("every GATILHO binds the NAMED 'default' database — never '(default)', never an absent one", () => {
    // THE load-bearing assertion of this block, and it MUST be an exact equality
    // on the parsed field — never a `JSON.stringify(...).toContain('default')`:
    // the serialized endpoint always carries `"namespace":"(default)"`, and an
    // OMITTED `database` defaults to `"(default)"` too, so a substring check
    // passes in every case and guards nothing. Firestore Enterprise names this
    // project's database literally `default`; a trigger bound to `(default)`
    // deploys fine and never fires. This offline pin, not the emulator lane,
    // guards the binding: the emulator serves any database it is asked for, so
    // a wrong one is not proven to fail there.
    for (const [nome, fn] of Object.entries(GATILHOS)) {
      const banco = gatilhoDeEvento(fn).eventFilters?.database;
      expect(banco, nome).toBe('default');
      // NEAR-MISS: the sentinel spelling and the absent value, both refused.
      expect(banco, nome).toBeDefined();
      expect(banco, nome).not.toBe('(default)');
    }
  });

  it('every GATILHO declares retry: true', () => {
    // At-least-once redelivery for transient Firestore failures; without it the
    // event is dropped on the first one. Safe because the reconcile is
    // state-driven: a redelivery replays the ORIGINAL before/after, and the
    // reconcile reads neither — it re-reads the conta itself.
    for (const [nome, fn] of Object.entries(GATILHOS)) {
      expect(gatilhoDeEvento(fn).retry, nome).toBe(true);
    }
  });

  it('every GATILHO listens on the path of its CAMINHOS_DOS_GATILHOS row — and no two on the same one', () => {
    // A guessed collection name deploys fine and never fires, exactly like a
    // wrong `database`. Distinctness catches a whole trigger copy-pasted with the
    // first one's `document:` kept.
    const caminhos: string[] = [];
    for (const [nome, fn] of Object.entries(GATILHOS)) {
      const esperado = CAMINHOS_DOS_GATILHOS[nome as keyof typeof GATILHOS];
      const caminho = gatilhoDeEvento(fn).eventFilterPathPatterns?.document;
      expect(caminho, nome).toBe(`${esperado.colecao}/${esperado.folha}`);
      // ÂNCORA: the handle really resolved the collection.
      expect(esperado.colecao, nome).toBe(esperado.ancora);
      caminhos.push(caminho ?? '');
    }
    expect(new Set(caminhos).size).toBe(caminhos.length);
    expect(Object.keys(CAMINHOS_DOS_GATILHOS).sort()).toEqual(Object.keys(GATILHOS).sort());
  });

  it('⚠️ build.mjs DEFINES the database id the triggers bind', () => {
    // A SOURCE assertion, because no runtime assertion can see it: unbundled,
    // `process.env.FIREBASE_DATABASE_ID ?? 'default'` answers `'default'` with
    // or without a define, so the exact-equality test above stays green over a
    // build that dropped it. What the define adds is narrower — `||` turns a
    // BLANK export into `default` (under `??` a blank reaches firebase-functions
    // as `''`, which it binds as `(default)`), the preflight table prints what
    // the build baked (`tools/deploy-env/preflight.test.js` fails a define that
    // table omits), and in the bundle it replaces `admin.ts`'s read too, so the
    // binding and `getDb()` share the build-time value. Remove the define and
    // THIS test is what goes red.
    const build = readFileSync(fileURLToPath(new URL('../build.mjs', import.meta.url)), 'utf8');

    expect(build).toContain("'process.env.FIREBASE_DATABASE_ID': JSON.stringify(databaseId)");
    expect(build).toContain("process.env.FIREBASE_DATABASE_ID || 'default'");
    // ÂNCORA: the file really was read and really is this codebase's build.
    expect(build).toContain("'process.env.FUNCTIONS_REGION': JSON.stringify(region)");
  });
});

/* -------------------------------------------------------------------------- */
/*                         Across every exported trigger                      */
/* -------------------------------------------------------------------------- */

describe('every trigger of the codebase', () => {
  const TODOS = { ...AGENDAMENTOS, ...FILAS, ...GATILHOS };

  it('every onSchedule export is in AGENDAMENTOS — and there are exactly three', () => {
    expect(exportadosCom('scheduleTrigger')).toEqual(Object.keys(AGENDAMENTOS).sort());
    expect(exportadosCom('scheduleTrigger')).toEqual([
      'pollAmazonOrders',
      'reprocessAmazonNotifications',
      'sweepAmazonExpirations',
    ]);
  });

  it('the task exports are EXACTLY {filaLeituraAmazon}', () => {
    expect(exportadosCom('taskQueueTrigger')).toEqual(['filaLeituraAmazon']);
  });

  it('every event-trigger export is in GATILHOS — exactly {onIntegracaoAmazonChanged}', () => {
    // The third exhaustiveness twin: the two above filter on `scheduleTrigger`
    // and `taskQueueTrigger`, so an `onDocument*` export would otherwise have its
    // `database`, region, secrets and `retry` read by nothing.
    expect(exportadosCom('eventTrigger')).toEqual(Object.keys(GATILHOS).sort());
    expect(exportadosCom('eventTrigger')).toEqual(['onIntegracaoAmazonChanged']);
  });

  it('there is no HTTPS or callable trigger', () => {
    expect(exportadosCom('httpsTrigger')).toEqual([]);
    expect(exportadosCom('callableTrigger')).toEqual([]);
  });

  it('the THREE families are DISJOINT — nothing is a schedule, a queue and a trigger at once', () => {
    // An export in two maps would satisfy both exhaustiveness tests and have its
    // options read by the wrong set. All THREE pairs: with three families there
    // are three ways to duplicate, and two of them would pass a check written
    // for two.
    const familias = { AGENDAMENTOS, FILAS, GATILHOS };
    const pares = [
      ['AGENDAMENTOS', 'FILAS'],
      ['AGENDAMENTOS', 'GATILHOS'],
      ['FILAS', 'GATILHOS'],
    ] as const;

    for (const [a, b] of pares) {
      const naPrimeira = new Set(Object.keys(familias[a]));
      for (const nome of Object.keys(familias[b])) {
        expect(naPrimeira.has(nome), `${nome} is in ${a} AND in ${b}`).toBe(false);
      }
    }
  });

  it('every runtime export IS a trigger — a helper exported here would read as a function name', () => {
    expect(Object.keys(modulo).sort()).toEqual(Object.keys(TODOS).sort());
  });

  it('the queue export key is exactly FILA_LEITURA_AMAZON — the enqueue target', () => {
    // `index.ts` asserts the pair at module load (a half-rename fails Firebase's
    // codebase analysis); this pins it offline, where the failure names itself.
    expect(notificacao.FILA_LEITURA_AMAZON in modulo).toBe(true);
    expect(notificacao.FILA_LEITURA_AMAZON).toBe('filaLeituraAmazon');
  });

  // Re-importing the whole index after `vi.resetModules()` takes ~0.2 s here but
  // measured 5.1 s on a loaded CI runner (#2018), past the 5-s default.
  it(
    'and the module-load assertion really fires on a half-rename',
    { timeout: 30_000 },
    async () => {
      // The handler module renamed its export while the constant stayed: loading
      // `index.ts` must THROW (Firebase's codebase analysis then fails the deploy
      // loudly) — the pin above alone would not notice the assertion deleted.
      vi.resetModules();
      vi.doMock('./filaLeitura', () => ({ filaRenomeada: {} }));
      try {
        await expect(import('./index')).rejects.toThrow(
          "function-name drift: functions/src/filaLeitura.ts must export a handler named 'filaLeituraAmazon'",
        );
      } finally {
        vi.doUnmock('./filaLeitura');
        vi.resetModules();
      }
    },
  );

  it('binds the LWA secret on the queue, the reprocess and the poll, and NOTHING else anywhere', () => {
    // The expiry sweep and the conta trigger make no Amazon call (D11): a
    // declared secret missing from Secret Manager would fail the whole deploy
    // for a function that never reads it.
    for (const [nome, fn] of Object.entries(TODOS)) {
      const esperado =
        nome === 'sweepAmazonExpirations' || nome === 'onIntegracaoAmazonChanged'
          ? []
          : [SEGREDO_LWA];
      expect(segredosDe(fn), nome).toEqual(esperado);
    }
    // ÂNCORA: the walk covers all three families.
    expect(Object.keys(TODOS)).toHaveLength(5);
  });

  it('runs in the inlined region (the bare options import, #1108) and caps instances at 10', () => {
    for (const [nome, fn] of Object.entries(TODOS)) {
      expect(endpointOf(fn).region, nome).toEqual(['xx-regiao1']);
      expect(endpointOf(fn).maxInstances, nome).toBe(10);
    }
  });

  it("the schedules are DISTINCT, and none is the half-hour cron other channels' sweeps use", () => {
    const crons = Object.values(AGENDAMENTOS).map((fn) => gatilhoDe(fn).schedule);
    expect(crons).toHaveLength(3);
    expect(new Set(crons).size).toBe(crons.length);
    expect(crons).not.toContain('*/30 * * * *');
  });

  it("no two schedules share a minute: the poll's four slots miss the reprocess's :10/:40 and the expiry's :15", () => {
    const poll = minutosDoCron(gatilhoDe(pollAmazonOrders).schedule) ?? [];
    const reprocesso = minutosDoCron(gatilhoDe(reprocessAmazonNotifications).schedule) ?? [];
    // The expiry runs daily (`15 7 * * *`): its minute field is its first.
    const expiracao = Number((gatilhoDe(sweepAmazonExpirations).schedule ?? '').split(' ')[0]);
    expect(poll).toHaveLength(4);
    expect(reprocesso).toEqual([10, 40]);
    expect(expiracao).toBe(15);
    expect(poll.filter((m) => reprocesso.includes(m) || m === expiracao)).toEqual([]);
  });

  it("imports './options' FIRST and ALONE — the global options precede every trigger", () => {
    const fonte = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const importacoes = [...fonte.matchAll(/^import\b[^;]*;/gm)].map((m) => m[0]);
    expect(importacoes[0]).toBe("import './options';");
    // Exactly ONE import statement names it: a second `from './options'` further
    // down would be merged into, and so moved behind, the trigger modules.
    expect(importacoes.filter((i) => /['"]\.\/options['"]/.test(i))).toEqual([
      "import './options';",
    ]);
    // ÂNCORA: the scan really reads this file's imports.
    expect(importacoes.length).toBeGreaterThan(5);
  });
});
