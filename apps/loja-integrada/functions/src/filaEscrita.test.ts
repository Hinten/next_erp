import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  ESTADO_FRETE,
  ESTADO_RASTREIO_LI,
  NOTIFICACAO_RESILIENCIA_STATUS,
  TIPO_TAREFA_ESCRITA_LI,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../lib/lojaIntegrada/core/contaCache';
import { idPedidoLi } from '../../lib/lojaIntegrada/pedidos/orderIdsLi';
import {
  TIPO_TAREFA_VARREDURA_ESCRITA_LI,
  eventoDoHistoricoLi,
} from '../../lib/lojaIntegrada/rastreio/agendadorEscrita';
import type { PayloadTarefaEscritaLi } from '../../lib/lojaIntegrada/rastreio/notificacaoEscrita';
import { FakeDb, asDb } from '../../lib/lojaIntegrada/testing/fakeDb';
import { AGORA_MS, espiarStdout, seedConta } from '../../lib/lojaIntegrada/testing/fixtures';
import { NUMERO_LI } from '../../lib/lojaIntegrada/testing/pedidosLi';
import { seedPedidoLi } from '../../lib/lojaIntegrada/testing/plataformaEscritaLi';

/**
 * The WRITES queue's body (master plan step 7, PR 7-e): the `tipo` dispatch —
 * `rastreio` through the shared pipeline, `varredura` through the in-queue
 * sweep, anything else dropped — the dispatch-start stamp, the ONE log line, and
 * what the root binds (`depsEscrita.ts`).
 *
 * The channel's pipeline runs REAL (the valve, the pedido read, the write
 * context's read switch, the shared core) against the fake Firestore;
 * `tratarTarefaEscritaLi` and `varrerEscritasLi` are only spied through, so a
 * test can read what the root passed. The declared options live in
 * `index.test.ts`. D17: no network is reachable, and the read switch stays off.
 *
 * `FUNCTIONS_REGION` and `TASKS_INVOKER_SA` are stubbed before the import, as
 * the build would inline them, and restored after.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'southamerica-east1';
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA = '1-compute@developer.gserviceaccount.com';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));

vi.mock('../../lib/lojaIntegrada/rastreio/notificacaoEscrita', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../lib/lojaIntegrada/rastreio/notificacaoEscrita')>();
  return {
    ...real,
    tratarTarefaEscritaLi: vi.fn(real.tratarTarefaEscritaLi),
    varrerEscritasLi: vi.fn(real.varrerEscritasLi),
  };
});

const {
  DETALHE_TIPO_DESCONHECIDO_ESCRITA_LI,
  VARREDURA_ESCRITA_ORCAMENTO_MS,
  filaEscritaLojaIntegrada,
} = await import('./filaEscrita');
const escrita = await import('../../lib/lojaIntegrada/rastreio/notificacaoEscrita');

afterAll(() => {
  if (originalFunctionsRegion === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

const CONTA = 'conta-li-1';
const PEDIDO_ID = idPedidoLi(CONTA, NUMERO_LI);
const COLECAO = 'notificacoesEscritaLojaIntegrada';
const LINHA = '[loja-integrada] tarefa da fila de escritas';

function payload(over: Partial<PayloadTarefaEscritaLi> = {}): PayloadTarefaEscritaLi {
  return {
    tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
    contaId: CONTA,
    numero: String(NUMERO_LI),
    pedidoId: PEDIDO_ID,
    evento: eventoDoHistoricoLi(PEDIDO_ID, 'h-1'),
    estado: ESTADO_RASTREIO_LI.postado,
    eventoEmMs: AGORA_MS - 60_000,
    ...over,
  };
}

interface RequisicaoDeTarefa {
  readonly data: unknown;
  readonly retryCount?: number;
  readonly id?: string;
}

function rodar(req: RequisicaoDeTarefa): Promise<void> {
  return (filaEscritaLojaIntegrada as unknown as { run(r: RequisicaoDeTarefa): Promise<void> }).run(
    req,
  );
}

/** The single `logger.info` payload the dispatch emitted. */
function linhaUnica(): Record<string, unknown> {
  expect(info).toHaveBeenCalledTimes(1);
  const [mensagem, campos] = info.mock.calls[0] as [string, Record<string, unknown>];
  expect(mensagem).toBe(LINHA);
  return campos;
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  stdout = espiarStdout();
  fake = new FakeDb();
  h.db = asDb(fake);
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubEnv('LOJA_INTEGRADA_CHAMADAS', undefined);
  vi.stubEnv('LOJA_INTEGRADA_MODO_RASTREIO', 'dry-run');
  vi.stubEnv('LOJA_INTEGRADA_CANARIO_RASTREIO', undefined);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  stdout.restaurar();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

function seedPedido(): void {
  // An ACTIVE conta with no credential: a context that read the conta before
  // the switch would answer `credencial-ausente`, never `chamadas-desligadas`.
  seedConta(fake, CONTA);
  seedPedidoLi(fake, PEDIDO_ID, CONTA, { estado: ESTADO_FRETE.postado });
}

describe('a `rastreio` task', () => {
  it('runs the REAL pipeline: at dry-run with the read switch off it writes ONE deferred row, and reads no conta', async () => {
    seedPedido();
    const p = payload();

    await rodar({ data: p, retryCount: 0, id: `rastreio-${p.evento}` });

    expect(fake.ler(`${COLECAO}/${p.evento}`)).toMatchObject({
      evento: p.evento,
      status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
      tentativas: 0,
      erro: 'adiado/chamadas-desligadas',
    });
    // The pedido, and nothing of the conta: the switch refused first.
    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
    expect(linhaUnica()).toEqual({
      fila: 'filaEscritaLojaIntegrada',
      tipo: 'rastreio',
      outcome: 'deferred',
      kind: 'adiado',
      detail: null,
      contaId: CONTA,
      numero: String(NUMERO_LI),
      evento: p.evento,
      tentativa: 0,
    });
  });

  it('with the valve OFF it defers `desligado` with ZERO reads — the row waits, nothing is deleted', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_RASTREIO', undefined);
    seedPedido();
    const p = payload();

    await rodar({ data: p, retryCount: 1, id: 'rastreio-x' });

    expect(fake.ler(`${COLECAO}/${p.evento}`)).toMatchObject({
      status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
      erro: 'desligado',
    });
    expect(fake.leituras).toEqual([]);
    expect(linhaUnica()).toMatchObject({ outcome: 'deferred', kind: 'desligado', tentativa: 1 });
  });

  it('a payload the schema refuses is DROPPED by the pipeline: no row, no read, one line with the raw ids', async () => {
    seedPedido();

    await rodar({ data: { ...payload(), numero: '0165' }, retryCount: 0, id: 't' });

    expect(fake.idsEm(COLECAO)).toEqual([]);
    expect(fake.leituras).toEqual([]);
    expect(linhaUnica()).toMatchObject({
      outcome: 'dropped',
      kind: null,
      tipo: 'rastreio',
      numero: '0165',
    });
  });

  it('binds the run: the LIVE environment, the attempt and task id, a tier-0 increment, the functions logger', async () => {
    seedPedido();
    const p = payload();

    await rodar({ data: p, retryCount: 2, id: 'rastreio-abc' });

    const chamada = vi.mocked(escrita.tratarTarefaEscritaLi).mock.calls[0];
    expect(chamada?.[0]).toBe(h.db);
    expect(chamada?.[1]).toEqual(p);
    expect(chamada?.[2]).toBe(2);
    const deps = chamada?.[3];
    expect(deps?.ambiente).toBe(process.env);
    expect(deps?.registro).toEqual({ tentativa: 2, idTarefa: 'rastreio-abc' });
    expect(deps?.logger).toBe(logger);
    expect(deps?.fetch).toBeUndefined();
    const incremento = deps?.increment(3);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(3))).toBe(true);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
  });

  it('stamps the dispatch start FIRST — the clock read before anything else — and hands it to the run (the write deadline)', async () => {
    seedPedido();
    let relogio = 5_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      relogio += 7;
      return relogio;
    });

    await rodar({ data: payload(), retryCount: 0, id: 't' });

    const deps = vi.mocked(escrita.tratarTarefaEscritaLi).mock.calls[0]?.[3];
    // The FIRST value the clock answered in this dispatch.
    expect(deps?.inicioDaTarefaMs).toBe(5_000_007);
    // …and the run's own clock is the live one, read later.
    expect(deps?.agoraMs()).toBeGreaterThan(deps?.inicioDaTarefaMs ?? Infinity);
  });
});

describe('a `varredura` task', () => {
  function seedLinha(status: 'failed' | 'deferred', processedAt: number): string {
    const p = payload({ evento: eventoDoHistoricoLi(PEDIDO_ID, `h-${status}`) });
    fake.seed(`${COLECAO}/${p.evento}`, { ...p, status, tentativas: 0, erro: 'x', processedAt });
    return p.evento;
  }

  it('runs the in-queue sweep with its budget, the dispatch start and no attempt number', async () => {
    let relogio = 5_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      relogio += 7;
      return relogio;
    });

    await rodar({
      data: { tipo: TIPO_TAREFA_VARREDURA_ESCRITA_LI },
      retryCount: 1,
      id: 'varredura-1',
    });

    const chamada = vi.mocked(escrita.varrerEscritasLi).mock.calls[0];
    expect(vi.mocked(escrita.varrerEscritasLi)).toHaveBeenCalledOnce();
    expect(chamada?.[0]).toBe(h.db);
    expect(chamada?.[2]).toBe(VARREDURA_ESCRITA_ORCAMENTO_MS);
    expect(VARREDURA_ESCRITA_ORCAMENTO_MS).toBe(140_000);
    expect(chamada?.[1].ambiente).toBe(process.env);
    expect(chamada?.[1].registro).toEqual({ tentativa: null, idTarefa: 'varredura-1' });
    // Rule 7: EVERY row this dispatch re-runs measures its write deadline from
    // the dispatch's own start — the FIRST value the clock answered — never a
    // later reading (`index.test.ts` sizes the retry backoff against that bound).
    expect(chamada?.[1].inicioDaTarefaMs).toBe(5_000_007);
    expect(chamada?.[1].agoraMs()).toBeGreaterThan(chamada?.[1].inicioDaTarefaMs ?? Infinity);
    expect(vi.mocked(escrita.tratarTarefaEscritaLi)).not.toHaveBeenCalled();
  });

  it('at dry-run, a `failed` row older than an hour migrates to `deferred` with a fresh budget — the run stopped at the read switch', async () => {
    seedPedido();
    const velha = seedLinha('failed', 1);

    await rodar({ data: { tipo: TIPO_TAREFA_VARREDURA_ESCRITA_LI }, retryCount: 0, id: 'v' });

    expect(fake.ler(`${COLECAO}/${velha}`)).toMatchObject({
      status: NOTIFICACAO_RESILIENCIA_STATUS.deferred,
      tentativas: 0,
      erro: 'adiado/chamadas-desligadas',
    });
    expect(fake.leituras.filter((c) => c.startsWith('integracao/'))).toEqual([]);
    const linha = linhaUnica();
    expect(linha).toMatchObject({
      fila: 'filaEscritaLojaIntegrada',
      tipo: 'varredura',
      desligado: false,
      quente: { processadas: 1, erros: 0, parada: 'vazia' },
      adiada: { processadas: 0, erros: 0, parada: 'vazia' },
      tentativa: 0,
    });
  });

  it('at `off` it touches NEITHER lane: a seeded failed and a seeded deferred row stay exactly as they were', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_RASTREIO', 'off');
    seedPedido();
    const quente = seedLinha('failed', 1);
    const adiada = seedLinha('deferred', 1);
    const antesQuente = fake.ler(`${COLECAO}/${quente}`);
    const antesAdiada = fake.ler(`${COLECAO}/${adiada}`);

    await rodar({ data: { tipo: TIPO_TAREFA_VARREDURA_ESCRITA_LI }, retryCount: 0, id: 'v' });

    expect(fake.ler(`${COLECAO}/${quente}`)).toEqual(antesQuente);
    expect(fake.ler(`${COLECAO}/${adiada}`)).toEqual(antesAdiada);
    expect(fake.escritas).toEqual([]);
    expect(fake.consultas).toEqual([]);
    expect(linhaUnica()).toMatchObject({ tipo: 'varredura', desligado: true });
  });
});

describe('any other `tipo`', () => {
  it.each([
    ['an unknown tipo', { tipo: 'conciliacao', contaId: CONTA }],
    ['no tipo at all', { contaId: CONTA }],
    ['a reads-queue tipo', { tipo: 'pedido', contaId: CONTA }],
    ['not an object', 'rastreio'],
  ])('%s ⇒ DROPPED with one line, nothing read, nothing written, no run', async (_c, dados) => {
    await rodar({ data: dados, retryCount: 0, id: 't' });

    expect(fake.escritas).toEqual([]);
    expect(fake.leituras).toEqual([]);
    expect(vi.mocked(escrita.tratarTarefaEscritaLi)).not.toHaveBeenCalled();
    expect(vi.mocked(escrita.varrerEscritasLi)).not.toHaveBeenCalled();
    expect(linhaUnica()).toMatchObject({
      fila: 'filaEscritaLojaIntegrada',
      outcome: 'dropped',
      kind: null,
      detail: DETALHE_TIPO_DESCONHECIDO_ESCRITA_LI,
    });
  });

  it('the line carries raw ids one by one — never a spread of the data', async () => {
    await rodar({
      data: { tipo: 'conciliacao', contaId: CONTA, segredo: 'nunca-no-log', numero: { x: 1 } },
      retryCount: 0,
      id: 't',
    });
    const linha = linhaUnica();
    expect(JSON.stringify(linha)).not.toContain('nunca-no-log');
    expect(linha.numero).toBeNull();
  });
});
