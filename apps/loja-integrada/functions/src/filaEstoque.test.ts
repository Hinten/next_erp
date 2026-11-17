import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  type TarefaEstoqueLi,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../lib/lojaIntegrada/core/contaCache';
import type { ResultadoEstoqueLi } from '../../lib/lojaIntegrada/estoque/processarEstoque';
import { FakeDb, asDb } from '../../lib/lojaIntegrada/testing/fakeDb';
import {
  AGORA_MS,
  caminhoCredencial,
  espiarStdout,
  seedCredencial,
} from '../../lib/lojaIntegrada/testing/fixtures';
import { ID_PRODUTO_LI } from '../../lib/lojaIntegrada/testing/pedidosLi';

/**
 * The STOCK queue's body (master plan step 12, PR 12-e): the `tipo` dispatch — `estoque` through
 * the send run, `estoque-kits` dropped until its consumer ships (PR 12-f), anything else dropped —
 * the dispatch-start stamp, the ONE log line, and what the root binds (`depsEscrita.ts`'s
 * `depsDeEstoqueLi`).
 *
 * The send run runs REAL (the valve, the conta, the produto, its links and records, the write
 * context's read switch) against the fake Firestore; `processarTarefaEstoqueLi` is only spied
 * through, so a test can read what the root passed, or hand back an outcome to see the line it
 * makes. The declared options live in `index.test.ts`. No call to the store: no network is
 * reachable, and the read switch stays off.
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

vi.mock('../../lib/lojaIntegrada/estoque/processarEstoque', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../lib/lojaIntegrada/estoque/processarEstoque')>();
  return { ...real, processarTarefaEstoqueLi: vi.fn(real.processarTarefaEstoqueLi) };
});

const {
  DETALHE_SEM_CONSUMIDOR_ESTOQUE_LI,
  DETALHE_TIPO_DESCONHECIDO_ESTOQUE_LI,
  filaEstoqueLojaIntegrada,
} = await import('./filaEstoque');
const estoque = await import('../../lib/lojaIntegrada/estoque/processarEstoque');

afterAll(() => {
  if (originalFunctionsRegion === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

const CONTA = 'conta-li-fila-est';
const PRODUTO = 'p-fila-est';
const DEP = 'dep-fila-est';
const LINHA = '[loja-integrada] tarefa da fila de estoque';

function tarefa(over: Partial<TarefaEstoqueLi> = {}): TarefaEstoqueLi {
  return {
    tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
    contaId: CONTA,
    produtoId: PRODUTO,
    origem: ORIGEM_TAREFA_ESTOQUE_LI.evento,
    janela: Math.floor(AGORA_MS / 60_000),
    estoqueId: null,
    apagado: false,
    estoqueIds: null,
    geracao: 0,
    ...over,
  };
}

interface RequisicaoDeTarefa {
  readonly data: unknown;
  readonly retryCount?: number;
  readonly id?: string;
}

function rodar(req: RequisicaoDeTarefa): Promise<void> {
  return (filaEstoqueLojaIntegrada as unknown as { run(r: RequisicaoDeTarefa): Promise<void> }).run(
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
  vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', 'dry-run');
  vi.stubEnv('LOJA_INTEGRADA_CANARIO_ESTOQUE', undefined);
  vi.stubEnv('LOJA_INTEGRADA_ESTOQUE_MAX', undefined);
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

/** A conta on a depósito, one child produto linked to it, and its canonical record there. */
function seedProduto(): void {
  fake.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja F',
    ativo: true,
    depositoOuterRef: `documents/depositos/${DEP}`,
  });
  seedCredencial(fake, CONTA);
  fake.seed(`produtos/${PRODUTO}`, { ehKit: false });
  fake.seed(`produtos/${PRODUTO}/produtolojaintegrada/l1`, {
    contaLojaIntegrada: `documents/integracao/${CONTA}`,
    id: ID_PRODUTO_LI,
    paiProdutoIntegradaId: 900_001,
  });
  fake.seed(`produtos/${PRODUTO}/estoques/est-${PRODUTO}-${DEP}`, {
    depositoOuterRef: `documents/depositos/${DEP}`,
    quantidade: 5,
    quantidadeReservada: 0,
  });
}

describe('an `estoque` task', () => {
  it('runs the REAL send run: at dry-run with the read switch off it drops at the write context — ERP reads only, no credential, nothing written', async () => {
    seedProduto();

    await rodar({ data: tarefa(), retryCount: 0, id: 'estoque-abc' });

    // The conta, the produto, its links, its record and the two probe queries;
    // never the credential: the switch refused first inside the context.
    expect(fake.leituras).not.toContain(caminhoCredencial(CONTA));
    expect(fake.leituras).toContain(`produtos/${PRODUTO}`);
    expect(fake.escritas).toEqual([]);
    expect(linhaUnica()).toEqual({
      fila: 'filaEstoqueLojaIntegrada',
      tipo: 'estoque',
      contaId: CONTA,
      produtoId: PRODUTO,
      origem: 'evento',
      geracao: 0,
      tentativa: 0,
      kind: 'descartado',
      detail: 'chamadas-desligadas',
    });
  });

  it('with the valve OFF it returns `desligado` with ZERO reads', async () => {
    vi.stubEnv('LOJA_INTEGRADA_MODO_ESTOQUE', undefined);
    seedProduto();

    await rodar({ data: tarefa(), retryCount: 1, id: 'estoque-x' });

    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    expect(linhaUnica()).toMatchObject({ kind: 'desligado', detail: null, tentativa: 1 });
  });

  it('a payload the run refuses (a quantity in it) is `payload-invalido`: no read, one line with the raw ids', async () => {
    seedProduto();

    await rodar({ data: { ...tarefa(), quantidade: 7 }, retryCount: 0, id: 't' });

    expect(fake.leituras).toEqual([]);
    expect(linhaUnica()).toMatchObject({
      kind: 'payload-invalido',
      detail: null,
      contaId: CONTA,
      produtoId: PRODUTO,
    });
  });

  it('binds the run: the RAW data, the LIVE environment, the attempt as `tentativa` AND in the registro, the task id, the stock producer', async () => {
    seedProduto();
    const t = tarefa();

    await rodar({ data: t, retryCount: 2, id: 'estoque-abc' });

    const chamada = vi.mocked(estoque.processarTarefaEstoqueLi).mock.calls[0];
    expect(chamada?.[0]).toBe(h.db);
    expect(chamada?.[1]).toBe(t);
    const deps = chamada?.[2];
    expect(deps?.ambiente).toBe(process.env);
    // `retryCount` IS the 0-based attempt — never +1, or the last attempt never concludes.
    expect(deps?.tentativa).toBe(2);
    expect(deps?.registro).toEqual({ tentativa: 2, idTarefa: 'estoque-abc' });
    expect(deps?.logger).toBe(logger);
    expect(deps?.fetch).toBeUndefined();
    expect(typeof deps?.agendador.enfileirar).toBe('function');
    const incremento = deps?.increment(3);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(3))).toBe(true);
  });

  it('stamps the dispatch start FIRST — the clock read before anything else — and hands it to the run (the write deadline)', async () => {
    seedProduto();
    let relogio = 5_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      relogio += 7;
      return relogio;
    });

    await rodar({ data: tarefa(), retryCount: 0, id: 't' });

    const deps = vi.mocked(estoque.processarTarefaEstoqueLi).mock.calls[0]?.[2];
    expect(deps?.inicioDaTarefaMs).toBe(5_000_007);
    expect(deps?.agoraMs()).toBeGreaterThan(deps?.inicioDaTarefaMs ?? Infinity);
  });

  it.each<[string, ResultadoEstoqueLi, string | number | null]>([
    ['pulado', { kind: 'pulado', motivo: 'vinculo-duplicado' }, 'vinculo-duplicado'],
    ['nao-enviado', { kind: 'nao-enviado', motivo: 'fora-do-canario' }, 'fora-do-canario'],
    ['escrito', { kind: 'escrito', seguimento: 'enfileirado' }, 'enfileirado'],
    ['escrito-lote', { kind: 'escrito-lote' }, null],
    ['refletido', { kind: 'refletido' }, null],
    ['recusado', { kind: 'recusado', status: 400 }, 400],
  ])('the line carries the outcome: %s', async (_rotulo, resultado, detail) => {
    vi.mocked(estoque.processarTarefaEstoqueLi).mockResolvedValueOnce(resultado);

    await rodar({
      data: tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva, geracao: 1 }),
      retryCount: 0,
      id: 't',
    });

    expect(linhaUnica()).toMatchObject({
      kind: resultado.kind,
      detail,
      origem: 'deriva',
      geracao: 1,
    });
  });

  it('a run that THROWS propagates — the queue retries it — and writes no line', async () => {
    const falha = new Error('transitória');
    vi.mocked(estoque.processarTarefaEstoqueLi).mockRejectedValueOnce(falha);

    await expect(rodar({ data: tarefa(), retryCount: 0, id: 't' })).rejects.toBe(falha);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('any other `tipo`', () => {
  it('`estoque-kits` ⇒ DROPPED `sem-consumidor` with one line: no run, nothing read', async () => {
    await rodar({
      data: {
        tipo: TIPO_TAREFA_ESTOQUE_LI.estoqueKits,
        contaId: CONTA,
        componenteId: 'c1',
        janela: 1,
      },
      retryCount: 0,
      id: 't',
    });

    expect(vi.mocked(estoque.processarTarefaEstoqueLi)).not.toHaveBeenCalled();
    expect(fake.leituras).toEqual([]);
    expect(linhaUnica()).toMatchObject({
      fila: 'filaEstoqueLojaIntegrada',
      tipo: 'estoque-kits',
      contaId: CONTA,
      kind: 'dropped',
      detail: DETALHE_SEM_CONSUMIDOR_ESTOQUE_LI,
    });
  });

  it.each([
    ['an unknown tipo', { tipo: 'conciliacao', contaId: CONTA }],
    ['no tipo at all', { contaId: CONTA }],
    ['a writes-queue tipo', { tipo: 'rastreio', contaId: CONTA }],
    ['not an object', 'estoque'],
  ])('%s ⇒ DROPPED `tipo-desconhecido` with one line, nothing read, no run', async (_c, dados) => {
    await rodar({ data: dados, retryCount: 0, id: 't' });

    expect(fake.escritas).toEqual([]);
    expect(fake.leituras).toEqual([]);
    expect(vi.mocked(estoque.processarTarefaEstoqueLi)).not.toHaveBeenCalled();
    expect(linhaUnica()).toMatchObject({
      fila: 'filaEstoqueLojaIntegrada',
      kind: 'dropped',
      detail: DETALHE_TIPO_DESCONHECIDO_ESTOQUE_LI,
    });
  });

  it('the line carries raw ids one by one — never a spread of the data', async () => {
    await rodar({
      data: {
        tipo: 'conciliacao',
        contaId: CONTA,
        segredo: 'nunca-no-log',
        produtoId: { x: 1 },
        geracao: 2,
      },
      retryCount: 0,
      id: 't',
    });
    const linha = linhaUnica();
    expect(JSON.stringify(linha)).not.toContain('nunca-no-log');
    expect(linha.produtoId).toBeNull();
    expect(linha.geracao).toBeNull();
    expect(Object.keys(linha).sort()).toEqual(
      [
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
