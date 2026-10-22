import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ORIGEM_NOTIFICACAO_LI, TIPO_TAREFA_LI } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../lib/lojaIntegrada/core/contaCache';
import type {
  ImportadorPedidoLi,
  PayloadNotificacaoLi,
} from '../../lib/lojaIntegrada/notificacoes/notificacao';
import { importarPedidoLi } from '../../lib/lojaIntegrada/pedidos/importarPedido';
import { FakeDb, asDb } from '../../lib/lojaIntegrada/testing/fakeDb';
import {
  AGORA_MS,
  espiarStdout,
  seedConta,
  seedCredencial,
} from '../../lib/lojaIntegrada/testing/fixtures';

/**
 * The reads queue's BODY: the `tipo` dispatch, the drop of an unknown `tipo`,
 * the ONE log line, and what the root binds into the pipeline — above all the
 * importer seam, which only the roots read.
 *
 * The channel's pipeline runs REAL (the context loader, the read switch, the
 * shared core) against the fake Firestore; `tratarTarefaLeituraLi` and
 * `importadorPedidoLi` are only spied through, so a test can see what the root
 * passed and hand it a sentinel importer. The declared options live in
 * `index.test.ts`. No network is reachable.
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

vi.mock('../../lib/lojaIntegrada/notificacoes/notificacao', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../lib/lojaIntegrada/notificacoes/notificacao')>();
  return {
    ...real,
    importadorPedidoLi: vi.fn(real.importadorPedidoLi),
    tratarTarefaLeituraLi: vi.fn(real.tratarTarefaLeituraLi),
  };
});

const { DETALHE_TIPO_DESCONHECIDO_LI, filaLeituraLojaIntegrada } = await import('./filaLeitura');
const notificacao = await import('../../lib/lojaIntegrada/notificacoes/notificacao');

afterAll(() => {
  if (originalFunctionsRegion === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

const ID = 'conta-li-1';
const COLECAO = 'notificacoesLojaIntegrada';

function pedido(over: Partial<PayloadNotificacaoLi> = {}): PayloadNotificacaoLi {
  return {
    tipo: TIPO_TAREFA_LI.pedido,
    contaId: ID,
    numero: '1234',
    origem: ORIGEM_NOTIFICACAO_LI.poll,
    dataModificacaoLi: '2026-10-13T08:15:58.123456',
    ...over,
  };
}

interface RequisicaoDeTarefa {
  readonly data: unknown;
  readonly retryCount?: number;
  readonly id?: string;
}

function rodar(req: RequisicaoDeTarefa): Promise<void> {
  return (filaLeituraLojaIntegrada as unknown as { run(r: RequisicaoDeTarefa): Promise<void> }).run(
    req,
  );
}

/** The single `logger.info` payload the dispatch emitted. */
function linhaUnica(): Record<string, unknown> {
  expect(info).toHaveBeenCalledTimes(1);
  const [mensagem, campos] = info.mock.calls[0] as [string, Record<string, unknown>];
  expect(mensagem).toBe('[loja-integrada] tarefa da fila de leitura');
  return campos;
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

/** The `chamada-bloqueada` lines the context loader wrote to stdout. */
function linhasBloqueadas(): Record<string, unknown>[] {
  return stdout
    .escritas()
    .map((linha) => JSON.parse(linha) as Record<string, unknown>)
    .filter((linha) => linha.evento === 'chamada-bloqueada');
}

describe('a `pedido` task', () => {
  it('runs the REAL pipeline: with the read switch off it writes ONE deferred row and reads nothing', async () => {
    seedConta(fake, ID);
    seedCredencial(fake, ID);
    const p = pedido();

    await rodar({ data: p, retryCount: 0, id: 'tarefa-1' });

    const caminho = `${COLECAO}/${notificacao.docIdNotificacaoLi(p)}`;
    expect(fake.leituras).toEqual([]);
    expect(fake.escritas.map((e) => [e.verbo, e.caminho])).toEqual([['create', caminho]]);
    expect(fake.ler(caminho)).toMatchObject({
      status: 'deferred',
      tentativas: 0,
      erro: 'adiado/chamadas-desligadas',
    });
    expect(linhaUnica()).toEqual({
      fila: 'filaLeituraLojaIntegrada',
      outcome: 'deferred',
      kind: 'adiado',
      detail: null,
      tipo: 'pedido',
      contaId: ID,
      numero: '1234',
      origem: 'poll',
      tentativa: 0,
    });
  });

  it("binds the run's registro: flow `intake`, the Cloud Tasks attempt and the task id reach the call lines", async () => {
    const p = pedido();

    await rodar({ data: p, retryCount: 2, id: 'tarefa-7' });

    // The read switch's refusal is the one line a run writes until the window;
    // it carries exactly what every Loja Integrada call line would.
    expect(linhasBloqueadas()).toEqual([
      expect.objectContaining({
        conta: ID,
        fluxo: 'intake',
        tentativa: 2,
        idTarefa: 'tarefa-7',
        idNotificacao: notificacao.docIdNotificacaoLi(p),
      }),
    ]);
    expect(linhaUnica().tentativa).toBe(2);
  });

  it('hands the pipeline the attempt, the live environment and a real clock, increment and sleep', async () => {
    await rodar({ data: pedido(), retryCount: 1, id: 'tarefa-2' });

    const chamada = vi.mocked(notificacao.tratarTarefaLeituraLi).mock.calls[0];
    expect(chamada).toBeDefined();
    const [db, dados, retryCount, deps] = chamada ?? [];
    expect(db).toBe(h.db);
    expect(dados).toEqual(pedido());
    expect(retryCount).toBe(1);
    expect(deps?.ambiente).toBe(process.env);
    expect(deps?.registro).toEqual({ fluxo: 'intake', tentativa: 1, idTarefa: 'tarefa-2' });
    expect(deps?.logger).toBe(logger);
    expect(deps?.fetch).toBeUndefined();

    const antes = Date.now();
    const agora = deps?.agoraMs();
    expect(agora).toBeGreaterThanOrEqual(antes);
    expect(agora).toBeLessThanOrEqual(Date.now());

    const incremento = deps?.increment(3);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(3))).toBe(true);

    // The importer's `mapa` union: the union sentinel itself, every element passed through.
    const uniao = deps?.arrayUnion('x', 'y');
    expect(uniao).toBeInstanceOf(FieldValue);
    expect((uniao as FieldValue).isEqual(FieldValue.arrayUnion('x', 'y'))).toBe(true);
    // NEAR-MISS: never the removal sentinel, and never a dropped element.
    expect((uniao as FieldValue).isEqual(FieldValue.arrayRemove('x', 'y'))).toBe(false);
    expect((uniao as FieldValue).isEqual(FieldValue.arrayUnion('x'))).toBe(false);

    // ONE process-wide CEP client: its memo and in-flight dedup span every run.
    await rodar({ data: pedido(), retryCount: 0, id: 'tarefa-3' });
    const outra = vi.mocked(notificacao.tratarTarefaLeituraLi).mock.calls[1]?.[3];
    expect(deps?.viaCep).toBeDefined();
    expect(outra?.viaCep).toBe(deps?.viaCep);

    // The pacer's sleep really waits the interval it is given.
    vi.useFakeTimers();
    try {
      let acordou = false;
      const espera = deps?.esperar(2_000).then(() => {
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

  it('a missing retryCount is attempt 0 and a missing id is null — never undefined in the log', async () => {
    await rodar({ data: pedido() });

    const deps = vi.mocked(notificacao.tratarTarefaLeituraLi).mock.calls[0]?.[3];
    expect(deps?.registro).toEqual({ fluxo: 'intake', tentativa: 0, idTarefa: null });
    expect(linhaUnica().tentativa).toBe(0);
  });
});

describe('the importer binding', () => {
  beforeEach(() => {
    // A healthy conta, so a run past the switch reaches the importer seam.
    seedConta(fake, ID);
    seedCredencial(fake, ID);
  });

  it('passes the importer the REAL seam table hands back, read per dispatch', async () => {
    // The switch ON, so the run reaches the seam — which hands back a sentinel.
    vi.stubEnv('LOJA_INTEGRADA_CHAMADAS', 'on');
    const importados: PayloadNotificacaoLi[] = [];
    const sentinela: ImportadorPedidoLi = (_db, _contexto, payload) => {
      importados.push(payload);
      return Promise.resolve({ kind: 'importado' });
    };
    vi.mocked(notificacao.importadorPedidoLi).mockReturnValueOnce(sentinela);

    await rodar({ data: pedido(), retryCount: 0, id: 'tarefa-3' });

    expect(notificacao.importadorPedidoLi).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notificacao.tratarTarefaLeituraLi).mock.calls[0]?.[3].importador).toBe(
      sentinela,
    );
    expect(importados).toEqual([pedido()]);
    // Resolved: nothing persisted, and the log line is the only trace.
    expect(fake.escritas).toEqual([]);
    expect(linhaUnica()).toMatchObject({ outcome: 'done', kind: 'importado', detail: 'importado' });
  });

  it('D17: the root binds the step-5 order import, and with the switch unset the task DEFERS at the switch — never importador-ausente, no read, no call', async () => {
    // The switch as it stays everywhere until the window: unset (beforeEach).
    const p = pedido();

    await rodar({ data: p, retryCount: 0, id: 'tarefa-4' });

    // The REAL seam, untouched: the order import itself reaches the pipeline…
    expect(notificacao.importadorPedidoLi).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notificacao.tratarTarefaLeituraLi).mock.calls[0]?.[3].importador).toBe(
      importarPedidoLi,
    );
    // …and the context's switch stops the run before any Firestore read, so the
    // importer never starts (its first act would be a detail GET, then a read).
    expect(fake.leituras).toEqual([]);
    expect(fake.ler(`${COLECAO}/${notificacao.docIdNotificacaoLi(p)}`)).toMatchObject({
      status: 'deferred',
      tentativas: 0,
      erro: 'adiado/chamadas-desligadas',
    });
    expect(linhasBloqueadas()).toEqual([
      expect.objectContaining({ conta: ID, fluxo: 'intake', idTarefa: 'tarefa-4' }),
    ]);
    expect(linhaUnica()).toMatchObject({ outcome: 'deferred', kind: 'adiado', detail: null });
  });
});

describe('any other `tipo`', () => {
  it.each<[string, unknown]>([
    ['an unknown tipo', { ...pedido(), tipo: 'importacao' }],
    ['no tipo at all', { contaId: ID, numero: '1234', origem: 'poll', dataModificacaoLi: null }],
    ['a tipo that is not a string', { ...pedido(), tipo: ['pedido'] }],
    ['a null payload', null],
    ['a string payload', 'pedido'],
  ])(
    '%s is DROPPED: no pipeline run, no Firestore operation, one log line',
    async (_nome, dados) => {
      await rodar({ data: dados, retryCount: 0, id: 'tarefa-5' });

      expect(notificacao.tratarTarefaLeituraLi).not.toHaveBeenCalled();
      expect(notificacao.importadorPedidoLi).not.toHaveBeenCalled();
      expect(fake.leituras).toEqual([]);
      expect(fake.escritas).toEqual([]);
      expect(linhaUnica()).toMatchObject({
        fila: 'filaLeituraLojaIntegrada',
        outcome: 'dropped',
        kind: null,
        detail: DETALHE_TIPO_DESCONHECIDO_LI,
      });
    },
  );

  it('the drop line names the raw ids it can, and never a value it cannot vouch for', async () => {
    await rodar({
      data: {
        tipo: 'importacao',
        contaId: ID,
        numero: '1234',
        origem: 'poll',
        cliente: { nome: 'valor-que-nao-vai-ao-log' },
      },
      retryCount: 1,
    });

    const campos = linhaUnica();
    expect(campos).toEqual({
      fila: 'filaLeituraLojaIntegrada',
      outcome: 'dropped',
      kind: null,
      detail: 'tipo-desconhecido',
      tipo: 'importacao',
      contaId: ID,
      numero: '1234',
      origem: 'poll',
      tentativa: 1,
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('valor-que-nao-vai-ao-log');
  });

  // NEAR-MISS of the dispatch: an INHERITED `tipo` is not the task's own.
  it('a `tipo` reached only through the prototype is not a `pedido` task', async () => {
    const dados: unknown = Object.create({ tipo: 'pedido' });

    await rodar({ data: dados, retryCount: 0 });

    expect(notificacao.tratarTarefaLeituraLi).not.toHaveBeenCalled();
    expect(linhaUnica()).toMatchObject({ outcome: 'dropped', detail: 'tipo-desconhecido' });
  });
});

describe('a `pedido` task whose payload does not parse', () => {
  it('reaches the pipeline, which DROPS it without a document', async () => {
    await rodar({ data: { ...pedido(), numero: '0123' }, retryCount: 0 });

    expect(notificacao.tratarTarefaLeituraLi).toHaveBeenCalledTimes(1);
    expect(fake.escritas).toEqual([]);
    expect(linhaUnica()).toMatchObject({
      outcome: 'dropped',
      kind: null,
      detail: 'payload-invalido',
      tipo: 'pedido',
    });
  });
});

describe('a transient failure', () => {
  it('rethrows for the queue’s retry, and writes NO dispatch line', async () => {
    vi.stubEnv('LOJA_INTEGRADA_CHAMADAS', 'on');
    seedConta(fake, ID);
    seedCredencial(fake, ID);
    const falha = new TypeError('falha desconhecida do importador');
    vi.mocked(notificacao.importadorPedidoLi).mockReturnValueOnce(() => Promise.reject(falha));

    await expect(rodar({ data: pedido(), retryCount: 0, id: 'tarefa-6' })).rejects.toBe(falha);
    expect(info).not.toHaveBeenCalled();
  });
});
