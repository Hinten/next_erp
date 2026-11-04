import { logger } from 'firebase-functions/v2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FilaEscritaLi,
  type TarefaFilaEscritaLi,
  criarAgendadorEscritaLi,
} from '../../lib/lojaIntegrada/rastreio/agendadorEscrita';
import {
  falhaDoApp,
  falhaDoFunctions,
} from '../../lib/lojaIntegrada/testing/falhaDeEnfileiramento';

/**
 * The writes queue's SCHEDULER (master plan step 7, PR 7-e): every tick it
 * enqueues exactly ONE `varredura` task onto the writes queue, named after the
 * tick — and does nothing else. The sweep itself runs INSIDE the queue's single
 * dispatch slot (`filaEscrita.ts`), never inline here, so a retry can never
 * race a fresh write: that is the whole reason this scheduler exists apart from
 * the reads sweep.
 *
 * The producer is the REAL pure one over a recording transport, through the
 * mocked root, so already-exists, the valve and the transient naming are the
 * shipped classification. D17: no network is reachable, and nothing here reads
 * the write valve (the task does).
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'southamerica-east1';

const h = vi.hoisted(() => ({ agendador: null as unknown, criados: 0 }));
vi.mock('./agendadorEscrita', () => ({
  criarAgendadorEscritaLiDoAmbiente: () => {
    h.criados += 1;
    return h.agendador;
  },
}));
vi.mock('./lib/admin', () => ({
  getDb: () => {
    throw new Error('teste: o agendador da varredura não lê o Firestore');
  },
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));

const { enfileirarVarreduraEscritaLi, varrerEscritasLojaIntegrada } =
  await import('./varrerEscritas');

afterAll(() => {
  if (originalFunctionsRegion === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = originalFunctionsRegion;
});

const TICK = '2026-10-26T15:15:00.000Z';

interface Fila {
  readonly f: FilaEscritaLi;
  readonly chamadas: { payload: TarefaFilaEscritaLi; opcoes: { id: string } }[];
}

function fila(falha: Error | null = null): Fila {
  const chamadas: Fila['chamadas'] = [];
  return {
    chamadas,
    f: {
      enqueue: (payload, opcoes) => {
        chamadas.push({ payload, opcoes });
        return falha === null ? Promise.resolve() : Promise.reject(falha);
      },
    },
  };
}

function agendador(t: Fila, desligado = false) {
  return criarAgendadorEscritaLi({ fila: () => t.f, desligado });
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let escritasNoStdout: ReturnType<typeof vi.spyOn>;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  h.criados = 0;
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  escritasNoStdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  escritasNoStdout.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

function rodarTick(evento: Record<string, unknown>): Promise<void> {
  return (varrerEscritasLojaIntegrada as unknown as { run(e: unknown): Promise<void> }).run(evento);
}

describe('varrerEscritasLojaIntegrada — the declared options', () => {
  const gatilho = endpointOf(varrerEscritasLojaIntegrada).scheduleTrigger as {
    schedule?: string;
    timeZone?: string;
  };

  it('ticks at :15 and :45, America/Sao_Paulo — offset from the reads sweep’s */30', () => {
    expect(gatilho.schedule).toBe('15,45 * * * *');
    expect(gatilho.timeZone).toBe('America/Sao_Paulo');
    // NEAR-MISS: the reads sweep's own cron.
    expect(gatilho.schedule).not.toBe('*/30 * * * *');
  });

  it('has timeoutSeconds 60: it only enqueues, the sweep runs in the queue', () => {
    expect(endpointOf(varrerEscritasLojaIntegrada).timeoutSeconds).toBe(60);
  });
});

describe('one tick', () => {
  it('enqueues EXACTLY ONE `{ tipo: varredura }` task, named after the schedule time, and logs one line', async () => {
    const t = fila();
    h.agendador = agendador(t);

    await rodarTick({ scheduleTime: TICK, jobName: 'j' });

    expect(t.chamadas).toEqual([
      { payload: { tipo: 'varredura' }, opcoes: { id: 'varredura-20261026151500000' } },
    ]);
    expect(h.criados).toBe(1);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[loja-integrada] varredura de escritas enfileirada',
      { id: 'varredura-20261026151500000' },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('EQUAL pair: a redelivered tick names the SAME task; the next tick another', async () => {
    const t = fila();
    h.agendador = agendador(t);

    await rodarTick({ scheduleTime: TICK });
    await rodarTick({ scheduleTime: TICK });
    await rodarTick({ scheduleTime: '2026-10-26T15:45:00.000Z' });

    const ids = t.chamadas.map((c) => c.opcoes.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('does NOT read the write valve: at `off` it still enqueues (the task reads it, and returns)', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_RASTREIO', 'off');
    const t = fila();
    h.agendador = agendador(t);

    await rodarTick({ scheduleTime: TICK });

    expect(t.chamadas).toHaveLength(1);
    // No valve line from here.
    expect(escritasNoStdout).not.toHaveBeenCalled();
  });

  it('an answered `task-already-exists` is SUCCESS: no warning, nothing thrown', async () => {
    const t = fila(falhaDoFunctions('task-already-exists', 409));
    h.agendador = agendador(t);

    await expect(rodarTick({ scheduleTime: TICK })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<[string, () => Fila, boolean]>([
    ['the sweep-only valve closed', () => fila(), true],
    ['a Cloud Tasks 503', () => fila(falhaDoFunctions('unknown-error', 503)), false],
    ['a socket failure', () => fila(falhaDoApp('network-error')), false],
  ])('%s ⇒ ONE WARNING, nothing thrown: the next tick tries again', async (_c, t, desligado) => {
    h.agendador = agendador(t(), desligado);

    await expect(rodarTick({ scheduleTime: TICK })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ id: 'varredura-20261026151500000' });
    expect(info).not.toHaveBeenCalled();
  });

  it.each<[string, () => Error]>([
    ['permission denied (a broken deploy)', () => falhaDoFunctions('permission-denied', 403)],
    ['no queue in that region', () => falhaDoFunctions('not-found', 404)],
    ['a coding bug', () => new TypeError('bug')],
  ])('%s ⇒ RETHROWN, loud', async (_c, falha) => {
    const err = falha();
    h.agendador = agendador(fila(err));

    await expect(rodarTick({ scheduleTime: TICK })).rejects.toBe(err);
  });
});

describe('enfileirarVarreduraEscritaLi — the id', () => {
  it('a schedule time with no digit falls back to the clock’s own instant — never a bare `varredura-`', async () => {
    const t = fila();

    await enfileirarVarreduraEscritaLi(
      agendador(t),
      undefined,
      () => Date.UTC(2026, 9, 26, 15, 45),
      logger,
    );
    await enfileirarVarreduraEscritaLi(
      agendador(t),
      '',
      () => Date.UTC(2026, 9, 26, 16, 15),
      logger,
    );

    expect(t.chamadas.map((c) => c.opcoes.id)).toEqual([
      'varredura-20261026154500000',
      'varredura-20261026161500000',
    ]);
  });

  it('a schedule time WITH digits wins over the clock', async () => {
    const t = fila();

    await enfileirarVarreduraEscritaLi(agendador(t), TICK, () => 1, logger);

    expect(t.chamadas.map((c) => c.opcoes.id)).toEqual(['varredura-20261026151500000']);
  });
});
