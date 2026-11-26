import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_PRECO_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_PRECO_LI,
  type TarefaPrecoLi,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../lib/lojaIntegrada/core/contaCache';
import type { ResultadoPrecoLi } from '../../lib/lojaIntegrada/preco/processarPreco';
import { FakeDb, asDb } from '../../lib/lojaIntegrada/testing/fakeDb';
import {
  AGORA_MS,
  caminhoCredencial,
  espiarStdout,
  seedCredencial,
} from '../../lib/lojaIntegrada/testing/fixtures';
import { ID_PAI_PRECO_LI } from '../../lib/lojaIntegrada/testing/precoLi';

/**
 * The PRICE queue's body (master plan step 13, PR 13-d): the `tipo` dispatch — `preco` through the
 * send run, anything else dropped — the dispatch-start stamp, the ONE log line, and what the root
 * binds (`depsEscrita.ts`'s `depsDePrecoLi`).
 *
 * The send run runs REAL (the valve, the clear's forma, the conta, the produto, its links, its
 * parent, the duplicate probe, the write context's read switch) against the fake Firestore;
 * `processarTarefaPrecoLi` is only spied through, so a test can read what the root passed, or hand
 * back an outcome to see the line it makes. Both producer roots are spied through too, so a test
 * can see WHICH one the run was handed. The declared options live in `index.test.ts`. No call to
 * the store: no network is reachable, and the read switch stays off. Every value is invented.
 *
 * `FUNCTIONS_REGION` and `TASKS_INVOKER_SA` are stubbed before the import, as the build would
 * inline them, and restored after.
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

vi.mock('../../lib/lojaIntegrada/preco/processarPreco', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../lib/lojaIntegrada/preco/processarPreco')>();
  return { ...real, processarTarefaPrecoLi: vi.fn(real.processarTarefaPrecoLi) };
});
vi.mock('./agendadorPreco', async (importOriginal) => {
  const real = await importOriginal<typeof import('./agendadorPreco')>();
  return {
    ...real,
    criarAgendadorPrecoLiDoAmbiente: vi.fn(real.criarAgendadorPrecoLiDoAmbiente),
  };
});
vi.mock('./agendadorEstoque', async (importOriginal) => {
  const real = await importOriginal<typeof import('./agendadorEstoque')>();
  return {
    ...real,
    criarAgendadorEstoqueLiDoAmbiente: vi.fn(real.criarAgendadorEstoqueLiDoAmbiente),
  };
});

const { DETALHE_TIPO_DESCONHECIDO_PRECO_LI, filaPrecoLojaIntegrada } = await import('./filaPreco');
const preco = await import('../../lib/lojaIntegrada/preco/processarPreco');
const raizPreco = await import('./agendadorPreco');
const raizEstoque = await import('./agendadorEstoque');

afterAll(() => {
  if (originalFunctionsRegion === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

const CONTA = 'conta-li-fila-preco';
const PRODUTO = 'p-fila-preco';
const PAI = 'p-fila-preco-pai';
const TAB_N = 'tab-fila-preco-normal';
const ID = 1001;
const LINHA = '[loja-integrada] tarefa da fila de preço';

function tarefa(over: Partial<TarefaPrecoLi> = {}): TarefaPrecoLi {
  return {
    tipo: TIPO_TAREFA_PRECO_LI,
    contaId: CONTA,
    produtoId: PRODUTO,
    origem: ORIGEM_TAREFA_PRECO_LI.evento,
    janela: Math.floor(AGORA_MS / 60_000),
    geracao: 0,
    baixar: false,
    ...over,
  };
}

interface RequisicaoDeTarefa {
  readonly data: unknown;
  readonly retryCount?: number;
  readonly id?: string;
}

function rodar(req: RequisicaoDeTarefa): Promise<void> {
  return (filaPrecoLojaIntegrada as unknown as { run(r: RequisicaoDeTarefa): Promise<void> }).run(
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
  vi.stubEnv('LOJA_INTEGRADA_MODO_PRECO', 'dry-run');
  vi.stubEnv('LOJA_INTEGRADA_CANARIO_PRECO', undefined);
  vi.stubEnv('LOJA_INTEGRADA_PRECO_PROMO_LIMPO', undefined);
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

/** A conta with its normal tabela, one child produto under a propagating parent, linked to it. */
function seedProduto(): void {
  fake.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja F',
    ativo: true,
    tabelaNormalOuterRef: `documents/listaDePrecos/${TAB_N}`,
    tabelaPromocionalOuterRef: null,
  });
  seedCredencial(fake, CONTA);
  fake.seed(`produtos/${PRODUTO}`, { paiId: PAI, precos: {} });
  fake.seed(`produtos/${PAI}`, {
    precos: { [TAB_N]: { valor: 55.56 } },
    propagatePriceToChildren: true,
  });
  fake.seed(`produtos/${PRODUTO}/produtolojaintegrada/l1`, {
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: ID,
    paiProdutoIntegradaId: ID_PAI_PRECO_LI,
  });
}

describe('a `preco` task', () => {
  it('runs the REAL send run: at dry-run with the read switch off it drops at the write context — the ERP reads only (child 6), no credential, nothing written', async () => {
    seedProduto();

    await rodar({ data: tarefa(), retryCount: 0, id: 'preco-abc' });

    // The conta, the produto, its links, its parent and the two probe queries; never the
    // credential: the switch refused first inside the context.
    expect(fake.leituras).toEqual([
      `integracao/${CONTA}`,
      `produtos/${PRODUTO}`,
      `produtos/${PAI}`,
    ]);
    expect(fake.consultas).toHaveLength(3);
    expect(fake.leituras).not.toContain(caminhoCredencial(CONTA));
    expect(fake.escritas).toEqual([]);
    expect(linhaUnica()).toEqual({
      fila: 'filaPrecoLojaIntegrada',
      tipo: 'preco',
      contaId: CONTA,
      produtoId: PRODUTO,
      origem: 'evento',
      geracao: 0,
      baixar: false,
      tentativa: 0,
      kind: 'descartado',
      detail: 'chamadas-desligadas',
    });
  });

  it('with the price valve OFF it returns `desligado` with ZERO reads', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_PRECO', undefined);
    seedProduto();

    await rodar({ data: tarefa(), retryCount: 1, id: 'preco-x' });

    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    expect(linhaUnica()).toMatchObject({ kind: 'desligado', detail: null, tentativa: 1 });
  });

  it('⚠️ NEAR-MISS: the STOCK valve at `dry-run` does not open the price run — each flow has its own valve', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_PRECO', undefined);
    vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', 'dry-run');
    seedProduto();

    await rodar({ data: tarefa(), retryCount: 0, id: 'preco-x' });

    expect(fake.leituras).toEqual([]);
    expect(linhaUnica()).toMatchObject({ kind: 'desligado' });
  });

  it('a payload the run refuses (a price in it) is `payload-invalido`: no read, one line with the raw ids', async () => {
    seedProduto();

    await rodar({ data: { ...tarefa(), cheio: 55.56 }, retryCount: 0, id: 't' });

    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    expect(linhaUnica()).toMatchObject({
      kind: 'payload-invalido',
      detail: null,
      contaId: CONTA,
      produtoId: PRODUTO,
      baixar: false,
    });
  });

  it('an unreadable clear forma refuses the run before any read (`forma-invalida`)', async () => {
    vi.stubEnv('LOJA_INTEGRADA_PRECO_PROMO_LIMPO', 'NULO');
    seedProduto();

    await rodar({ data: tarefa(), retryCount: 0, id: 't' });

    expect(fake.leituras).toEqual([]);
    expect(linhaUnica()).toMatchObject({ kind: 'forma-invalida', detail: null });
  });

  it('binds the run: the RAW data, the LIVE environment, the attempt as `tentativa` AND in the registro, the task id, the PRICE producer', async () => {
    seedProduto();
    const t = tarefa();

    await rodar({ data: t, retryCount: 2, id: 'preco-abc' });

    const chamada = vi.mocked(preco.processarTarefaPrecoLi).mock.calls[0];
    expect(chamada?.[0]).toBe(h.db);
    expect(chamada?.[1]).toBe(t);
    const deps = chamada?.[2];
    expect(deps?.ambiente).toBe(process.env);
    // `retryCount` IS the 0-based attempt — never +1, or the last attempt never concludes.
    expect(deps?.tentativa).toBe(2);
    expect(deps?.registro).toEqual({ tentativa: 2, idTarefa: 'preco-abc' });
    expect(deps?.logger).toBe(logger);
    expect(deps?.fetch).toBeUndefined();
    // The PRICE queue's producer, built once for this dispatch — never the stock one.
    expect(vi.mocked(raizPreco.criarAgendadorPrecoLiDoAmbiente)).toHaveBeenCalledTimes(1);
    expect(deps?.agendador).toBe(
      vi.mocked(raizPreco.criarAgendadorPrecoLiDoAmbiente).mock.results[0]?.value,
    );
    expect(vi.mocked(raizEstoque.criarAgendadorEstoqueLiDoAmbiente)).not.toHaveBeenCalled();
    const incremento = deps?.increment(3);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(3))).toBe(true);
  });

  it('the environment is LIVE, not a snapshot: a value set after the producer was built is what the run reads', async () => {
    seedProduto();
    vi.mocked(preco.processarTarefaPrecoLi).mockImplementationOnce(async (_db, _dados, deps) => {
      vi.stubEnv('LOJA_INTEGRADA_PRECO_PROMO_LIMPO', 'zero');
      expect(deps.ambiente.LOJA_INTEGRADA_PRECO_PROMO_LIMPO).toBe('zero');
      return { kind: 'desligado' };
    });

    await rodar({ data: tarefa(), retryCount: 0, id: 't' });

    expect(linhaUnica()).toMatchObject({ kind: 'desligado' });
  });

  it('stamps the dispatch start FIRST — the clock read before anything else — and hands it to the run (the write deadline)', async () => {
    seedProduto();
    let relogio = 5_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      relogio += 7;
      return relogio;
    });

    await rodar({ data: tarefa(), retryCount: 0, id: 't' });

    const deps = vi.mocked(preco.processarTarefaPrecoLi).mock.calls[0]?.[2];
    expect(deps?.inicioDaTarefaMs).toBe(5_000_007);
    expect(deps?.agoraMs()).toBeGreaterThan(deps?.inicioDaTarefaMs ?? Infinity);
  });

  it.each<[string, ResultadoPrecoLi, string | number | null]>([
    ['pulado', { kind: 'pulado', motivo: 'vinculo-duplicado' }, 'vinculo-duplicado'],
    ['descartado', { kind: 'descartado', motivo: 'sem-restauracao' }, 'sem-restauracao'],
    ['nao-enviado', { kind: 'nao-enviado', motivo: 'fora-do-canario' }, 'fora-do-canario'],
    ['escrito', { kind: 'escrito', seguimento: 'enfileirado' }, 'enfileirado'],
    ['escrito-lote', { kind: 'escrito-lote' }, null],
    ['refletido', { kind: 'refletido' }, null],
    ['nao-baixado', { kind: 'nao-baixado', folhas: ['cheio', 'efetivo'] }, 'cheio,efetivo'],
    ['recusado', { kind: 'recusado', status: 400 }, 400],
    ['forma-invalida', { kind: 'forma-invalida' }, null],
  ])('the line carries the outcome: %s', async (_rotulo, resultado, detail) => {
    vi.mocked(preco.processarTarefaPrecoLi).mockResolvedValueOnce(resultado);

    await rodar({
      data: tarefa({ origem: ORIGEM_TAREFA_PRECO_LI.deriva, geracao: 1, baixar: true }),
      retryCount: 0,
      id: 't',
    });

    expect(linhaUnica()).toMatchObject({
      kind: resultado.kind,
      detail,
      origem: 'deriva',
      geracao: 1,
      baixar: true,
    });
  });

  it('a run that THROWS propagates — the queue retries it — and writes no line', async () => {
    const falha = new Error('transitória');
    vi.mocked(preco.processarTarefaPrecoLi).mockRejectedValueOnce(falha);

    await expect(rodar({ data: tarefa(), retryCount: 0, id: 't' })).rejects.toBe(falha);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('any other `tipo`', () => {
  it.each([
    ['a stock tipo', { tipo: TIPO_TAREFA_ESTOQUE_LI.estoque, contaId: CONTA }],
    ['the kit fan-out tipo', { tipo: TIPO_TAREFA_ESTOQUE_LI.estoqueKits, contaId: CONTA }],
    ['a writes-queue tipo', { tipo: 'rastreio', contaId: CONTA }],
    ['no tipo at all', { contaId: CONTA, produtoId: PRODUTO }],
    ['a near-miss spelling', { tipo: 'Preco', contaId: CONTA }],
    ['not an object', 'preco'],
  ])('%s ⇒ DROPPED `tipo-desconhecido` with one line, nothing read, no run', async (_c, dados) => {
    seedProduto();

    await rodar({ data: dados, retryCount: 0, id: 't' });

    expect(fake.escritas).toEqual([]);
    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    expect(vi.mocked(preco.processarTarefaPrecoLi)).not.toHaveBeenCalled();
    expect(linhaUnica()).toMatchObject({
      fila: 'filaPrecoLojaIntegrada',
      kind: 'dropped',
      detail: DETALHE_TIPO_DESCONHECIDO_PRECO_LI,
    });
  });

  it('the line carries raw ids one by one — never a spread of the data', async () => {
    await rodar({
      data: {
        tipo: 'conciliacao',
        contaId: { x: 1 },
        segredo: 'nunca-no-log',
        produtoId: PRODUTO,
        geracao: 2,
        baixar: 'sim',
      },
      retryCount: 0,
      id: 't',
    });
    const linha = linhaUnica();
    expect(JSON.stringify(linha)).not.toContain('nunca-no-log');
    expect(linha.contaId).toBeNull();
    expect(linha.produtoId).toBe(PRODUTO);
    expect(linha.geracao).toBeNull();
    expect(linha.baixar).toBeNull();
    expect(Object.keys(linha).sort()).toEqual(
      [
        'baixar',
        'contaId',
        'detail',
        'fila',
        'geracao',
        'kind',
        'origem',
        'produtoId',
        'tentativa',
        'tipo',
      ].sort(),
    );
  });
});
