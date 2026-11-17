import { format, inspect } from 'node:util';

import { FieldValue } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AmazonHttpError,
  type ContextoRequisicaoAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import { ID_LOTE_FEED_AMAZON_REGEX, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import {
  LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
  type ResultadoTickEstoqueAmazon,
} from '../../lib/amazon/estoque/sincronizacaoEstoque';
import { FalhaTarefaAmazonError } from '../../lib/amazon/notificacoes/notificacao';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import { caminhoConta, espiarStdout } from '../../lib/amazon/testing/fixtures';

/**
 * The stock tick's COMPOSITION ROOT (`sweepAmazonStock`): what it binds into
 * the tick, its ONE summary line (and none on a gated tick, whose one line is
 * the body's), and the sanitizing boundary an escaping error crosses. The
 * declared options and their arithmetic are pinned with every other trigger's
 * in `index.test.ts`; the tick itself in `lib/amazon/estoque/sincronizacaoEstoque.test.ts`.
 *
 * The tick runs REAL against the fake Firestore; `executarTickEstoqueAmazon` is
 * spied THROUGH, so a test can hand the root a failing tick, and the stock
 * root's producer is a recording double (nothing here enqueues). No network is
 * reachable: the global `fetch` refuses and records.
 *
 * PLACEHOLDERS ONLY (public repository).
 */
const h = vi.hoisted(() => ({
  db: null as unknown,
  produtor: {
    enfileirar: (): Promise<never> => Promise.reject(new Error('teste: nada enfileira')),
    enfileirarLote: (): Promise<never> => Promise.reject(new Error('teste: nada enfileira')),
    enfileirarVerificacao: (): Promise<never> => Promise.reject(new Error('teste: nada enfileira')),
    enfileirarPausa: (): Promise<never> => Promise.reject(new Error('teste: nada enfileira')),
  },
  criarProdutor: vi.fn(),
}));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));
vi.mock('./agendadorEstoque', () => ({
  criarProdutorEstoqueAmazonDoAmbiente: () => {
    h.criarProdutor();
    return h.produtor;
  },
}));
vi.mock('../../lib/amazon/estoque/sincronizacaoEstoque', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../lib/amazon/estoque/sincronizacaoEstoque')>();
  return { ...real, executarTickEstoqueAmazon: vi.fn(real.executarTickEstoqueAmazon) };
});

const { depsDoTickEstoqueAmazon, sweepAmazonStock } = await import('./sweepEstoque');
const tick = await import('../../lib/amazon/estoque/sincronizacaoEstoque');

function rodar(): Promise<void> {
  return (sweepAmazonStock as unknown as { run(evento: unknown): Promise<void> }).run({});
}

const CONTA = 'conta-amz-raiz';
const DEPOSITO = 'documents/depositos/dep-raiz-1';

let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  stdout = espiarStdout();
  fake = new FakeDb();
  h.db = asDb(fake);
  vi.stubEnv('AMAZON_CHAMADAS', undefined);
  vi.stubEnv('AMAZON_MODO_ESTOQUE', undefined);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  stdout.restaurar();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** Every JSON line the app's logger wrote to stdout, parsed. */
function linhas(): Record<string, unknown>[] {
  return stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The root's own summary line(s). */
function resumos(): Record<string, unknown>[] {
  return linhas().filter((l) => l.message === '[amazon/estoque] tick de estoque');
}

/** An active Amazon conta with its depósito. */
function seedContaComDeposito(): void {
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta da raiz',
    ativo: true,
    padrao: false,
    selling_partner_id: null,
    depositoOuterRef: DEPOSITO,
  });
}

describe('sweepAmazonStock — the gates the body applies to what the root binds', () => {
  it('★ with the read switch unset the tick does ZERO Firestore operations, and writes ONE line: the body’s, never a summary', async () => {
    seedContaComDeposito();

    await rodar();

    expect(fake.operacoes).toBe(0);
    expect(h.criarProdutor).not.toHaveBeenCalled();
    // NEAR-MISS: a root that wrote its summary on a gated tick would make two.
    expect(linhas()).toEqual([
      expect.objectContaining({
        evento: 'estoque',
        fase: 'tick',
        portao: 'chamadas-desligadas',
        severity: 'INFO',
      }),
    ]);
    expect(resumos()).toEqual([]);
  });

  it('with the switch on and the stock valve unset (off), the same: zero operations, the body’s one line', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    seedContaComDeposito();

    await rodar();

    expect(fake.operacoes).toBe(0);
    expect(linhas()).toEqual([
      expect.objectContaining({ portao: 'valvula-desligada', valvula: 'off', severity: 'INFO' }),
    ]);
  });

  it('switch on, valve dry-run: the contas are walked — a first tick stores the cursor, builds no producer, and the root writes ONE flat summary', async () => {
    vi.stubEnv('AMAZON_CHAMADAS', 'on');
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'dry-run');
    seedContaComDeposito();
    const antes = Date.now();

    await rodar();

    const depois = Date.now();
    const sync = fake.ler(`sincronizacaoEstoqueAmazon/${CONTA}`);
    expect(sync).toMatchObject({ depositoDoCursor: DEPOSITO, vez: null, semDeposito: false });
    expect(sync?.cursorMs).toBeGreaterThanOrEqual(antes);
    expect(sync?.cursorMs).toBeLessThanOrEqual(depois);
    // A first tick reads no window and enqueues nothing: no producer is built.
    expect(fake.consultas.map((c) => c.colecao)).toEqual(['integracao']);
    expect(h.criarProdutor).not.toHaveBeenCalled();
    expect(linhas().filter((l) => l.conta === CONTA)).toEqual([
      expect.objectContaining({ desfecho: 'primeiro-tick', fase: 'tick', severity: 'INFO' }),
    ]);
    expect(resumos()).toEqual([
      {
        fase: 'tick',
        portao: null,
        contas: 1,
        'desfecho_primeiro-tick': 1,
        tarefas: 0,
        evento: 'estoque',
        fluxo: 'estoque',
        severity: 'INFO',
        message: '[amazon/estoque] tick de estoque',
      },
    ]);
  });

  it('a tick whose body answered a gate writes no summary even when handed back by a spy', async () => {
    const fechado: ResultadoTickEstoqueAmazon = { portao: 'valvula-desligada', contas: [] };
    vi.mocked(tick.executarTickEstoqueAmazon).mockResolvedValueOnce(fechado);

    await rodar();

    expect(resumos()).toEqual([]);
  });
});

describe('sweepAmazonStock — the sanitizing boundary', () => {
  const SENTINELAS = {
    ref: 'ref-SENTINELA-0f0f0f',
    caminho: 'SENTINELA-CAMINHO-7777',
    causa: 'SENTINELA-CAUSA-9999',
  } as const;
  const CTX_SUJO: ContextoRequisicaoAmazon = {
    destino: 'sp-api',
    operacao: 'getListingsItem',
    metodo: 'GET',
    caminho: `/listings/2021-08-01/items/${SENTINELAS.caminho}/SKU`,
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
    vi.mocked(tick.executarTickEstoqueAmazon).mockRejectedValueOnce(original);

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
    vi.mocked(tick.executarTickEstoqueAmazon).mockRejectedValueOnce(bug);

    await expect(rodar()).rejects.toBe(bug);
    expect(resumos()).toEqual([]);
  });
});

describe('depsDoTickEstoqueAmazon — what the root binds', () => {
  it('the codebase’s db, the environment whole and live, the production conta readers, a tier-0 increment, the app logger', () => {
    const deps = depsDoTickEstoqueAmazon();

    expect(deps.db).toBe(h.db);
    expect(deps.ambiente).toBe(process.env);
    expect(deps.contas).toBe(LEITOR_DE_CONTAS_ESTOQUE_AMAZON);
    const incremento = deps.increment(2);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
    // NEAR-MISS: the step is passed through, not fixed at 1.
    expect((incremento as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
    expect(deps.logger).toBe(LOGGER_STDOUT_AMAZON);
  });

  it('the producer is the stock root’s, as a THUNK: binding builds none, each call builds one', () => {
    const deps = depsDoTickEstoqueAmazon();
    expect(h.criarProdutor).not.toHaveBeenCalled();

    expect(deps.produtor()).toBe(h.produtor);
    expect(h.criarProdutor).toHaveBeenCalledTimes(1);
  });

  it('a fresh lease holder id per call, in the stock documents’ id grammar, and the real clock', () => {
    const deps = depsDoTickEstoqueAmazon();
    const a = deps.gerarExecucaoId();
    const b = deps.gerarExecucaoId();
    expect(a).not.toBe(b);
    expect(a).toMatch(ID_LOTE_FEED_AMAZON_REGEX);
    const antes = Date.now();
    const agora = deps.agora();
    expect(agora).toBeGreaterThanOrEqual(antes);
    expect(agora).toBeLessThanOrEqual(Date.now());
  });
});
