import { format, inspect } from 'node:util';

import { FieldValue } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  AmazonHttpError,
  type ContextoRequisicaoAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import { MOTIVO_IMPORTACAO_PARADA_AMAZON } from '@delfrance/schemas';

import { chaveImportacaoParada } from '../../lib/amazon/avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../../lib/amazon/core/contaCache';
import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import {
  FalhaTarefaAmazonError,
  type ImportadorPedidoAmazon,
} from '../../lib/amazon/notificacoes/notificacao';
import type { ResultadoTickPollAmazon } from '../../lib/amazon/pedidos/pollPedidos';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  caminhoAviso,
  espiarStdout,
  seedConta,
  stubAmbiente,
} from '../../lib/amazon/testing/fixtures';

/**
 * The backstop poll's COMPOSITION ROOT (`pollAmazonOrders`): what it binds into
 * the tick — above all the importer seam, which only the roots read — its ONE
 * summary line, and the sanitizing boundary an escaping error crosses. The
 * declared options and their arithmetic are pinned with every other trigger's
 * in `index.test.ts`.
 *
 * The tick runs REAL (`lib/amazon/pedidos/pollPedidos.ts`) against the fake
 * Firestore; `executarPollPedidosAmazon` and `importadorPedidoAmazon` are spied
 * THROUGH, so a test can hand the root a sentinel importer or a failing tick,
 * and the producer root is a recording double (nothing here enqueues). No
 * network is reachable: the global `fetch` refuses and records.
 */
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
  criarAgendadorAmazonDoAmbiente: () => {
    h.criarAgendador();
    return h.agendador;
  },
}));
vi.mock('../../lib/amazon/notificacoes/notificacao', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/amazon/notificacoes/notificacao')>();
  return { ...real, importadorPedidoAmazon: vi.fn(real.importadorPedidoAmazon) };
});
vi.mock('../../lib/amazon/pedidos/pollPedidos', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/amazon/pedidos/pollPedidos')>();
  return { ...real, executarPollPedidosAmazon: vi.fn(real.executarPollPedidosAmazon) };
});

const { depsDoPollAmazon, pollAmazonOrders } = await import('./pollPedidos');
const notificacao = await import('../../lib/amazon/notificacoes/notificacao');
const poll = await import('../../lib/amazon/pedidos/pollPedidos');

function rodar(): Promise<void> {
  return (pollAmazonOrders as unknown as { run(evento: unknown): Promise<void> }).run({});
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
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubEnv('AMAZON_CHAMADAS', undefined);
  vi.stubEnv('AMAZON_POLL_LOOKBACK_H', undefined);
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

/** The root's own summary line(s): `[amazon] poll de pedidos`. */
function resumos(): Record<string, unknown>[] {
  return linhas().filter((l) => l.message === '[amazon] poll de pedidos');
}

/** A filled importer seam, as step 5 will leave it. */
function semearImportador(): void {
  const sentinela: ImportadorPedidoAmazon = () => Promise.resolve({ kind: 'importado' });
  vi.mocked(notificacao.importadorPedidoAmazon).mockReturnValueOnce(sentinela);
}

describe('pollAmazonOrders — the importer gate the root binds', () => {
  it('with the EMPTY seam the tick does ZERO Firestore operations — even with the read switch on', async () => {
    // The switch ON on purpose: a root that bound `importadorPresente: true`
    // would get past the gate here and list the contas.
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    seedConta(fake, 'conta-1', { selling_partner_id: SPID_A });

    await rodar();

    expect(notificacao.importadorPedidoAmazon).toHaveBeenCalledTimes(1);
    expect(notificacao.DESTINO_TIPO_AMAZON.pedido).toBeNull();
    expect(fake.operacoes).toBe(0);
    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    expect(fake.escritas).toEqual([]);
    expect(linhas().filter((l) => l.evento === 'poll')).toEqual([
      expect.objectContaining({ desfecho: 'importador-ausente', conta: null, fluxo: 'poll' }),
      expect.objectContaining({
        message: '[amazon] poll de pedidos',
        portao: 'importador-ausente',
        contas: 0,
        severity: 'INFO',
      }),
    ]);
  });

  it('a filled seam with the switch OFF stops at the switch: one chamada-bloqueada line, zero reads', async () => {
    semearImportador();
    seedConta(fake, 'conta-1', { selling_partner_id: SPID_A });

    await rodar();

    expect(fake.operacoes).toBe(0);
    expect(linhas().filter((l) => l.evento === 'chamada-bloqueada')).toEqual([
      expect.objectContaining({ rota: 'pollPedidos', chave: 'AMAZON_CHAMADAS' }),
    ]);
    expect(resumos()).toEqual([
      expect.objectContaining({ portao: 'chamadas-desligadas', contas: 0, severity: 'INFO' }),
    ]);
  });

  it('a filled seam with the switch on walks the contas: a conta with no credential is RECORDED, nothing called', async () => {
    semearImportador();
    // The switch on and the synthetic LWA pair, through the process environment
    // the root binds whole.
    stubAmbiente(AMBIENTE_LIGADO);
    seedConta(fake, 'conta-1', { nome: 'Conta Um', selling_partner_id: SPID_A });

    await rodar();

    expect(fake.consultas.map((c) => c.colecao)).toEqual(['integracao']);
    expect(fake.ler('pollPedidosAmazon/conta-1')).toMatchObject({
      cursorMs: null,
      falhasSeguidas: 1,
      ultimoErro: MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialAusente,
    });
    // The refusal's threshold is 1: the aviso is up, through the real writer.
    expect(fake.ler(caminhoAviso(chaveImportacaoParada('conta-1')))).toMatchObject({
      resolvidoEm: null,
      params: { loja: 'Conta Um', motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialAusente },
    });
    // ONE summary line, the counters FLAT: one key per conta outcome.
    expect(resumos()).toEqual([
      {
        portao: null,
        abortado: null,
        contas: 1,
        enfileiradas: 0,
        persistidas: 0,
        desfecho_recusa: 1,
        evento: 'poll',
        fluxo: 'poll',
        severity: 'INFO',
        message: '[amazon] poll de pedidos',
      },
    ]);
  });

  it('the summary line is a WARNING when an app-wide refusal ABORTED the tick', async () => {
    const abortado: ResultadoTickPollAmazon = {
      portao: null,
      contas: [],
      abortado: 'segredo-recusado',
    };
    vi.mocked(poll.executarPollPedidosAmazon).mockResolvedValueOnce(abortado);

    await rodar();

    expect(resumos()).toEqual([
      expect.objectContaining({ abortado: 'segredo-recusado', severity: 'WARNING' }),
    ]);
  });
});

describe('pollAmazonOrders — the sanitizing boundary (step-3/4 plan §3 decision 31)', () => {
  const SENTINELAS = {
    ref: 'ref-SENTINELA-0f0f0f',
    caminho: 'SENTINELA-CAMINHO-7777',
    causa: 'SENTINELA-CAUSA-9999',
  } as const;
  const CTX_SUJO: ContextoRequisicaoAmazon = {
    destino: 'sp-api',
    operacao: 'searchOrders',
    metodo: 'GET',
    caminho: `/orders/2026-01-01/orders/${SENTINELAS.caminho}`,
    correlationId: 'corr-1',
    requestIdAmazon: null,
    refCredencial: SENTINELAS.ref,
  };

  const vazamentos = (texto: string) => Object.values(SENTINELAS).filter((s) => texto.includes(s));

  it('★ a package error escaping the tick leaves as a FalhaTarefaAmazonError with no ref, path or cause — and no summary line', async () => {
    const original = new AmazonHttpError({ ...CTX_SUJO, status: 400 });
    Object.defineProperty(original, 'cause', {
      value: new Error(SENTINELAS.causa),
      configurable: true,
      enumerable: true,
      writable: true,
    });
    // Anti-vacuity: the original DOES show the sentinels to a logger.
    expect(vazamentos(inspect(original, { showHidden: true, depth: 5 })).length).toBeGreaterThan(0);
    vi.mocked(poll.executarPollPedidosAmazon).mockRejectedValueOnce(original);

    const err = await rodar().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FalhaTarefaAmazonError);
    expect(err).toMatchObject({ classe: 'AmazonHttpError', detalhe: 400 });
    const e = err as FalhaTarefaAmazonError;
    expect(e.cause).toBeUndefined();
    for (const texto of [
      format(e),
      format('%o', e),
      inspect(e, { showHidden: true, depth: 5 }),
      e.message,
      JSON.stringify(e),
    ]) {
      expect(vazamentos(texto), texto).toEqual([]);
    }
    expect(resumos()).toEqual([]);
  });

  it('near-miss: anything else (a bug) is rethrown as the SAME object (rule 6)', async () => {
    const bug = new RangeError('bug');
    vi.mocked(poll.executarPollPedidosAmazon).mockRejectedValueOnce(bug);

    await expect(rodar()).rejects.toBe(bug);
    expect(resumos()).toEqual([]);
  });
});

describe('depsDoPollAmazon — what the root binds', () => {
  it('the environment whole and live, the producer from the environment, a tier-0 increment, the app logger', () => {
    const deps = depsDoPollAmazon();

    expect(deps.ambiente).toBe(process.env);
    expect(h.criarAgendador).toHaveBeenCalledTimes(1);
    expect(deps.agendador).toBe(h.agendador);
    const incremento = deps.increment(2);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
    // NEAR-MISS: the step is passed through, not fixed at 1.
    expect((incremento as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
    expect(deps.logger).toBe(LOGGER_STDOUT_AMAZON);
    // No transport seam in production: the package's client uses the runtime's
    // own fetch, behind the read switch.
    expect(deps.fetch).toBeUndefined();
    expect(deps.agendarPrazo).toBeUndefined();
  });

  it('the importer seam is read from the REAL table, per call — never cached at load', () => {
    expect(depsDoPollAmazon().importadorPresente).toBe(false);
    semearImportador();
    expect(depsDoPollAmazon().importadorPresente).toBe(true);
    // And back: the sentinel was handed out once.
    expect(depsDoPollAmazon().importadorPresente).toBe(false);
    expect(notificacao.importadorPedidoAmazon).toHaveBeenCalledTimes(3);
  });

  it('a fresh lease owner per run, and the real clock', () => {
    const deps = depsDoPollAmazon();
    const antes = Date.now();
    const agora = deps.agora();
    expect(agora).toBeGreaterThanOrEqual(antes);
    expect(agora).toBeLessThanOrEqual(Date.now());
    expect(deps.gerarExecucaoId()).not.toBe(deps.gerarExecucaoId());
  });

  it('esperar sleeps for real, through a timer (bound only so a test can prove the poll never calls it)', async () => {
    vi.useFakeTimers();
    const deps = depsDoPollAmazon();
    let acordou = false;
    const espera = deps.esperar(2_000).then(() => {
      acordou = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(acordou).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await espera;
    expect(acordou).toBe(true);
  });
});
