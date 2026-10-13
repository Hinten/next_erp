import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { __setRelogioDoCacheParaTestes } from '../../lib/lojaIntegrada/core/contaCache';
import type { ImportadorPedidoLi } from '../../lib/lojaIntegrada/notificacoes/notificacao';
import { FakeDb, asDb } from '../../lib/lojaIntegrada/testing/fakeDb';
import { AGORA_MS, espiarStdout, seedConta } from '../../lib/lojaIntegrada/testing/fixtures';

/**
 * The order poller's COMPOSITION ROOT: its declared schedule, and what it binds
 * into the tick — above all the importer seam, which only the roots read.
 *
 * The tick runs REAL (`lib/lojaIntegrada/pedidos/pollPedidos.ts`) against the
 * fake Firestore; only `importadorPedidoLi` is spied through, so a test can hand
 * the root a sentinel importer, and the producer root is replaced by a recording
 * double (nothing here enqueues). No network is reachable.
 *
 * `FUNCTIONS_REGION` is stubbed before the import, as the build would inline it.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'southamerica-east1';

const h = vi.hoisted(() => ({
  db: null as unknown,
  agendador: {
    enfileirar: (): Promise<void> => Promise.reject(new Error('teste: nada enfileira')),
  },
  criarAgendador: vi.fn(),
}));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));
vi.mock('./agendador', () => ({
  criarAgendadorLiDoAmbiente: () => {
    h.criarAgendador();
    return h.agendador;
  },
}));
vi.mock('../../lib/lojaIntegrada/notificacoes/notificacao', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../lib/lojaIntegrada/notificacoes/notificacao')>();
  return { ...real, importadorPedidoLi: vi.fn(real.importadorPedidoLi) };
});

const { depsDoPollLi, pollLojaIntegradaPedidos } = await import('./pollPedidos');
const notificacao = await import('../../lib/lojaIntegrada/notificacoes/notificacao');

afterAll(() => {
  if (originalFunctionsRegion === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = originalFunctionsRegion;
});

type Endpoint = Record<string, unknown>;

function endpointOf(fn: unknown): Endpoint {
  return (fn as { __endpoint: Endpoint }).__endpoint;
}

function rodar(): Promise<void> {
  return (pollLojaIntegradaPedidos as unknown as { run(evento: unknown): Promise<void> }).run({});
}

let info: ReturnType<typeof vi.spyOn>;
let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  stdout = espiarStdout();
  fake = new FakeDb();
  h.db = asDb(fake);
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubEnv('LOJA_INTEGRADA_CHAMADAS', undefined);
  vi.stubEnv('LOJA_INTEGRADA_POLL_LOOKBACK_H', undefined);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  info.mockRestore();
  stdout.restaurar();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** The `evento: 'poll'` lines the tick wrote to stdout. */
function linhasDoPoll(): Record<string, unknown>[] {
  return stdout
    .escritas()
    .map((linha) => JSON.parse(linha) as Record<string, unknown>)
    .filter((linha) => linha.evento === 'poll');
}

describe('pollLojaIntegradaPedidos — the options', () => {
  it('runs every 5 minutes, America/Sao_Paulo', () => {
    const gatilho = endpointOf(pollLojaIntegradaPedidos).scheduleTrigger as {
      schedule?: string;
      timeZone?: string;
    };
    expect(gatilho.schedule).toBe('*/5 * * * *');
    expect(gatilho.timeZone).toBe('America/Sao_Paulo');
  });

  it('has timeoutSeconds 300 — the 220 s tick plus one overshoot, never the 60 s default', () => {
    expect(endpointOf(pollLojaIntegradaPedidos).timeoutSeconds).toBe(300);
  });
});

describe('pollLojaIntegradaPedidos — the importer gate the root binds', () => {
  it('with the step-3 EMPTY seam the tick does ZERO reads — even with the read switch on', async () => {
    // The switch ON on purpose: a root that bound `importadorPresente: true`
    // would get past the gate here and list the contas.
    vi.stubEnv('LOJA_INTEGRADA_CHAMADAS', 'on');
    seedConta(fake, 'conta-li-1');

    await rodar();

    expect(notificacao.importadorPedidoLi).toHaveBeenCalledTimes(1);
    expect(notificacao.DESTINO_TIPO_LI.pedido).toBeNull();
    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    expect(fake.escritas).toEqual([]);
    expect(linhasDoPoll()).toEqual([
      expect.objectContaining({ conta: null, fluxo: 'poll', desfecho: 'importador-ausente' }),
    ]);
    expect(info).toHaveBeenCalledExactlyOnceWith('[loja-integrada] order poller tick', {
      portao: 'importador-ausente',
      contas: 0,
      desfechos: {},
      enfileiradas: 0,
      persistidas: 0,
    });
  });

  it('a filled seam opens the gate: the tick walks the contas (a conta with no token is RECORDED, nothing called)', async () => {
    const sentinela: ImportadorPedidoLi = () => Promise.resolve({ kind: 'importado' });
    vi.mocked(notificacao.importadorPedidoLi).mockReturnValueOnce(sentinela);
    vi.stubEnv('LOJA_INTEGRADA_CHAMADAS', 'on');
    seedConta(fake, 'conta-li-1');

    await rodar();

    expect(fake.consultas.map((c) => c.colecao)).toEqual(['integracao']);
    expect(fake.ler('pollPedidosLojaIntegrada/conta-li-1')).toMatchObject({
      falhasSeguidas: 1,
      ultimoErro: 'credencial-ausente',
      cursor: null,
    });
    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[loja-integrada] order poller tick',
      expect.objectContaining({ portao: null, contas: 1, desfechos: { recusa: 1 } }),
    );
  });

  it('a filled seam with the switch OFF stops at the switch: one chamada-bloqueada line, zero reads', async () => {
    vi.mocked(notificacao.importadorPedidoLi).mockReturnValueOnce(() =>
      Promise.resolve({ kind: 'importado' }),
    );
    seedConta(fake, 'conta-li-1');

    await rodar();

    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    const bloqueadas = stdout
      .escritas()
      .map((linha) => JSON.parse(linha) as Record<string, unknown>)
      .filter((linha) => linha.evento === 'chamada-bloqueada');
    expect(bloqueadas).toEqual([
      expect.objectContaining({ conta: null, fluxo: 'poll', operacao: 'pollPedidos' }),
    ]);
  });
});

describe('depsDoPollLi — what the root binds', () => {
  it('the environment whole and live, the producer from the environment, a tier-0 increment', () => {
    const deps = depsDoPollLi();

    expect(deps.ambiente).toBe(process.env);
    expect(h.criarAgendador).toHaveBeenCalledTimes(1);
    expect(deps.agendador).toBe(h.agendador);
    const incremento = deps.increment(2);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
    // NEAR-MISS: the step is passed through, not fixed at 1.
    expect((incremento as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
    expect(deps.logger).toBe(logger);
    expect(deps.importadorPresente).toBe(false);
  });

  it('a fresh lease owner per run, and the real clock', () => {
    const deps = depsDoPollLi();
    const antes = Date.now();
    const agora = deps.agoraMs();
    expect(agora).toBeGreaterThanOrEqual(antes);
    expect(agora).toBeLessThanOrEqual(Date.now());
    expect(deps.gerarExecucaoId()).not.toBe(deps.gerarExecucaoId());
  });

  it('the pacer sleeps for real, through a timer', async () => {
    vi.useFakeTimers();
    try {
      const deps = depsDoPollLi();
      let acordou = false;
      const espera = deps.esperar(2_000).then(() => {
        acordou = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(acordou).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await espera;
      expect(acordou).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['unset', undefined, 72],
    ['blank (the template line)', '', 72],
    ['72', '72', 72],
    ['2160', '2160', 2160],
    ['072 (a leading zero)', '072', null],
    ['0', '0', null],
    ['2161', '2161', null],
    [' 72 (a space)', ' 72', null],
  ])('LOJA_INTEGRADA_POLL_LOOKBACK_H %s → %s, never defaulted when invalid', (_n, valor, horas) => {
    vi.stubEnv('LOJA_INTEGRADA_POLL_LOOKBACK_H', valor);
    expect(depsDoPollLi().lookbackHoras).toBe(horas);
  });
});
