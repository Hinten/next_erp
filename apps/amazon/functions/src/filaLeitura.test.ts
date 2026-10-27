import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { FieldValue } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { AmazonNetworkError, AmazonNotFoundError } from '@delfrance/integrations-amazon-sp-api';
import { ORIGEM_NOTIFICACAO_AMAZON, TIPO_TAREFA_AMAZON } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../lib/amazon/core/contaCache';
import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import type {
  ImportadorPedidoAmazon,
  PayloadNotificacaoAmazon,
} from '../../lib/amazon/notificacoes/notificacao';
import { importarPedidoAmazon } from '../../lib/amazon/pedidos/importarPedido';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  AUTORIZADO_EM_MS,
  REFRESH_TOKEN_A,
  SPID_A,
  SPID_B,
  espiarStdout,
  refDe,
  seedConta,
  seedCredencial,
  stubAmbiente,
} from '../../lib/amazon/testing/fixtures';

/**
 * The reads queue's BODY: the `tipo` dispatch, the drop of an unknown `tipo`,
 * the ONE log line, and what the root binds into the pipeline — above all the
 * importer seam, which only the roots read, and the app's one logger.
 *
 * The channel's pipeline runs REAL (the read switch, the routing read, the
 * context loader, the shared core) against the fake Firestore;
 * `tratarTarefaLeituraAmazon` and the seam's `importadorPedidoAmazon`
 * (`destinos.ts` since PR 5-e) are only spied through, so a test can see what
 * the root passed and hand it a sentinel importer — or `null`, the empty seam. The declared options live in `index.test.ts`. No network is
 * reachable (D11): every `fetch` is refused and counted.
 */
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA = '1-compute@developer.gserviceaccount.com';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));

vi.mock('../../lib/amazon/notificacoes/notificacao', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/amazon/notificacoes/notificacao')>();
  return { ...real, tratarTarefaLeituraAmazon: vi.fn(real.tratarTarefaLeituraAmazon) };
});
vi.mock('../../lib/amazon/notificacoes/destinos', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/amazon/notificacoes/destinos')>();
  return { ...real, importadorPedidoAmazon: vi.fn(real.importadorPedidoAmazon) };
});
// Every ViaCEP client built through the module's export, recorded OUTSIDE a
// `vi.fn` so `vi.clearAllMocks` cannot wipe the module-load call: the root must
// bind the REAL client it built, not a stub that answers nothing.
const viaCep = vi.hoisted(() => ({ criados: [] as unknown[] }));
vi.mock('@delfrance/core/cep', async (importOriginal) => {
  const real = await importOriginal<typeof import('@delfrance/core/cep')>();
  return {
    ...real,
    createViaCepClient: (...args: Parameters<typeof real.createViaCepClient>) => {
      const cliente = real.createViaCepClient(...args);
      viaCep.criados.push(cliente);
      return cliente;
    },
  };
});

const { DETALHE_TIPO_DESCONHECIDO_AMAZON, filaLeituraAmazon } = await import('./filaLeitura');
const notificacao = await import('../../lib/amazon/notificacoes/notificacao');
const destinos = await import('../../lib/amazon/notificacoes/destinos');

afterAll(() => {
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

const ID = 'conta-1';
const COLECAO = 'notificacoesAmazon';
const PEDIDO = '000-0000000-0000001';
const NOTIFICACAO = '00000000-0000-0000-0000-000000000001';

function push(over: Partial<Extract<PayloadNotificacaoAmazon, { origem: 'push' }>> = {}) {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.push,
    sellerId: SPID_A,
    amazonOrderId: PEDIDO,
    notificationId: NOTIFICACAO,
    publishTimeMs: AGORA_MS - 1000,
    ...over,
  } satisfies PayloadNotificacaoAmazon;
}

function poll(over: Partial<Extract<PayloadNotificacaoAmazon, { origem: 'poll' }>> = {}) {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
    sellerId: SPID_A,
    amazonOrderId: PEDIDO,
    contaId: ID,
    lastUpdatedUs: AGORA_MS * 1000 + 123,
    ...over,
  } satisfies PayloadNotificacaoAmazon;
}

interface RequisicaoDeTarefa {
  readonly data: unknown;
  readonly retryCount?: number;
  readonly id?: string;
}

function rodar(req: RequisicaoDeTarefa): Promise<void> {
  return (filaLeituraAmazon as unknown as { run(r: RequisicaoDeTarefa): Promise<void> }).run(req);
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

/** The ONE `evento: 'tarefa'` line the dispatch wrote. */
function linhaDaTarefa(): Record<string, unknown> {
  const daTarefa = linhas().filter(
    (l) => l.evento === 'tarefa' && l.message === '[amazon] tarefa da fila de leitura',
  );
  expect(daTarefa).toHaveLength(1);
  return daTarefa[0] ?? {};
}

describe('a `pedido` task', () => {
  it('runs the REAL pipeline: with the read switch off it writes ONE deferred row and reads nothing', async () => {
    const p = push();

    await rodar({ data: p, retryCount: 0, id: 'tarefa-1' });

    const caminho = `${COLECAO}/${notificacao.docIdNotificacaoAmazon(p)}`;
    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    expect(fake.escritas.map((e) => [e.verbo, e.caminho])).toEqual([['create', caminho]]);
    expect(fake.ler(caminho)).toMatchObject({
      status: 'deferred',
      tentativas: 0,
      erro: 'adiado/chamadas-desligadas',
    });
    expect(linhaDaTarefa()).toEqual({
      fila: 'filaLeituraAmazon',
      resultado: 'deferred',
      detalhe: null,
      // The step-5 import's report: null on every arm without one (one shape).
      acao: null,
      itens: null,
      linhasPreservadas: null,
      linhasDivergentes: null,
      linhasSemProduto: null,
      tipo: 'pedido',
      origem: 'push',
      amazonOrderId: PEDIDO,
      notificationId: NOTIFICACAO,
      evento: 'tarefa',
      conta: null,
      fluxo: 'intake',
      tentativa: 0,
      idTarefa: 'tarefa-1',
      severity: 'INFO',
      message: '[amazon] tarefa da fila de leitura',
    });
  });

  it("a poll task's line names its conta, read off the raw data by grammar", async () => {
    await rodar({ data: poll(), retryCount: 1, id: 'tarefa-2' });

    expect(linhaDaTarefa()).toMatchObject({
      resultado: 'deferred',
      origem: 'poll',
      conta: ID,
      notificationId: null,
      tentativa: 1,
    });
  });

  it('hands the pipeline the attempt, the task id, the live environment, a real clock and increment, the app logger and the seam', async () => {
    await rodar({ data: push(), retryCount: 2, id: 'tarefa-7' });

    const chamada = vi.mocked(notificacao.tratarTarefaLeituraAmazon).mock.calls[0];
    expect(chamada).toBeDefined();
    const [db, dados, deps] = chamada ?? [];
    expect(db).toBe(h.db);
    expect(dados).toEqual(push());
    expect(deps?.registro).toEqual({ fluxo: 'intake', tentativa: 2, idTarefa: 'tarefa-7' });
    expect(deps?.ambiente).toBe(process.env);
    // The app's ONE logger — never firebase-functions' and never console.
    expect(deps?.logger).toBe(LOGGER_STDOUT_AMAZON);
    expect(deps?.fetch).toBeUndefined();
    // The seam, read per dispatch: the step-5 order import (PR 5-e).
    expect(destinos.importadorPedidoAmazon).toHaveBeenCalledTimes(1);
    expect(deps?.importador).toBe(importarPedidoAmazon);
    // …with its CEP lookup, the root's one process-wide client: built ONCE, at
    // module load, by the real `createViaCepClient` — and that very object is
    // what the pipeline gets (a stub answering `null` would silently turn the
    // UF recovery off and store every unknown-UF endereço as AC).
    expect(viaCep.criados).toHaveLength(1);
    expect(deps?.viaCep).toBe(viaCep.criados[0]);

    const antes = Date.now();
    const agora = deps?.agora();
    expect(agora).toBeGreaterThanOrEqual(antes);
    expect(agora).toBeLessThanOrEqual(Date.now());

    const incremento = deps?.increment(3);
    expect(incremento).toBeInstanceOf(FieldValue);
    expect((incremento as FieldValue).isEqual(FieldValue.increment(3))).toBe(true);
    // NEAR-MISS: the step is passed through, not fixed at 1.
    expect((incremento as FieldValue).isEqual(FieldValue.increment(1))).toBe(false);
  });

  it('★ D11 with the FILLED seam and the switch unset: the task DEFERS at the switch — never importador-ausente, no read, no call', async () => {
    // The real seam (no mock override): the order import is bound, and the read
    // switch — checked first — is the only gate left before the window (W5).
    await rodar({ data: push(), retryCount: 0, id: 'tarefa-10' });

    const deps = vi.mocked(notificacao.tratarTarefaLeituraAmazon).mock.calls[0]?.[2];
    expect(deps?.importador).toBe(importarPedidoAmazon);
    expect(fake.leituras).toEqual([]);
    expect(fake.consultas).toEqual([]);
    const caminho = `${COLECAO}/${notificacao.docIdNotificacaoAmazon(push())}`;
    expect(fake.ler(caminho)).toMatchObject({
      status: 'deferred',
      erro: 'adiado/chamadas-desligadas',
    });
  });

  it('a missing retryCount is attempt 0 and a missing id is null — never undefined in the log', async () => {
    await rodar({ data: push() });

    const deps = vi.mocked(notificacao.tratarTarefaLeituraAmazon).mock.calls[0]?.[2];
    expect(deps?.registro).toEqual({ fluxo: 'intake', tentativa: 0, idTarefa: null });
    expect(linhaDaTarefa()).toMatchObject({ tentativa: 0, idTarefa: null });
  });
});

describe('the importer binding and the final attempt', () => {
  beforeEach(() => {
    // The switch ON, an LWA pair, and a conta that routes with a fresh access
    // token — so a run reaches the importer seam with NO network call. The
    // clock is the fixtures' (the credential is minted against it).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA_MS);
    stubAmbiente(AMBIENTE_LIGADO);
    seedConta(fake, ID, { selling_partner_id: SPID_A });
    seedCredencial(fake, ID);
  });

  it('passes the importer the REAL seam table hands back, read per dispatch: importado ⇒ done, no row', async () => {
    const importados: PayloadNotificacaoAmazon[] = [];
    const sentinela: ImportadorPedidoAmazon = (_db, _contexto, payload) => {
      importados.push(payload);
      return Promise.resolve({ kind: 'importado' });
    };
    vi.mocked(destinos.importadorPedidoAmazon).mockReturnValueOnce(sentinela);

    await rodar({ data: push(), retryCount: 0, id: 'tarefa-3' });

    expect(importados).toEqual([push()]);
    expect(fake.escritas).toEqual([]);
    expect(linhaDaTarefa()).toMatchObject({
      resultado: 'done',
      detalhe: 'importado',
      conta: ID,
      severity: 'INFO',
    });
  });

  it('a transient failure RETHROWS before the last attempt (sanitized, no line) and persists `failed` on it (a WARNING line)', async () => {
    const ref = refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS);
    const falha: ImportadorPedidoAmazon = () =>
      Promise.reject(
        new AmazonNetworkError(
          {
            destino: 'sp-api',
            operacao: 'getOrder',
            metodo: 'GET',
            caminho: `/orders/2026-01-01/orders/${PEDIDO}`,
            correlationId: 'corr-1',
            requestIdAmazon: null,
            refCredencial: ref,
          },
          new TypeError('rede-causa-fora-do-log'),
        ),
      );
    vi.mocked(destinos.importadorPedidoAmazon).mockReturnValue(falha);

    // What the task wrapper's own "Unhandled error" line would `util.format`:
    // the sanitized error, with no credential ref, no path and no cause.
    const lancado = await rodar({ data: push(), retryCount: 0, id: 'tarefa-4' }).then(
      () => expect.unreachable('a falha transitória é relançada'),
      (e: unknown) => e,
    );
    expect(lancado).toBeInstanceOf(notificacao.FalhaTarefaAmazonError);
    const formatado = format(lancado);
    expect(formatado).not.toContain(ref);
    expect(formatado).not.toContain('/orders/');
    expect(formatado).not.toContain('rede-causa-fora-do-log');
    expect(linhas().filter((l) => l.evento === 'tarefa')).toEqual([]);

    await rodar({ data: push(), retryCount: notificacao.TASK_MAX_ATTEMPTS - 1, id: 'tarefa-4' });

    const caminho = `${COLECAO}/${notificacao.docIdNotificacaoAmazon(push())}`;
    expect(fake.ler(caminho)).toMatchObject({ status: 'failed' });
    expect(linhaDaTarefa()).toMatchObject({ resultado: 'failed', severity: 'WARNING' });
  });
});

describe('an unknown `tipo`', () => {
  it.each<[string, unknown]>([
    ['another tipo', { ...push(), tipo: 'vinculo' }],
    ['no tipo at all', { origem: 'push', amazonOrderId: PEDIDO }],
    ['a tipo behind a getter', Object.defineProperty({}, 'tipo', { get: () => 'pedido' })],
    ['a non-object', 'pedido'],
  ])(
    '%s ⇒ dropped with ONE line, zero Firestore operations, the pipeline never called',
    async (_caso, dados) => {
      await rodar({ data: dados, retryCount: 0, id: 'tarefa-5' });

      expect(fake.operacoes).toBe(0);
      expect(notificacao.tratarTarefaLeituraAmazon).not.toHaveBeenCalled();
      expect(linhaDaTarefa()).toMatchObject({
        resultado: 'dropped',
        detalhe: DETALHE_TIPO_DESCONHECIDO_AMAZON,
        // The raw tipo is never echoed: only a value the grammar admits is logged.
        tipo: null,
        // Lost for good (a producer ahead of its consumer): a person must see it.
        severity: 'WARNING',
      });
      expect(DETALHE_TIPO_DESCONHECIDO_AMAZON).toBe('tipo-desconhecido');
    },
  );
});

describe("the line's severity — WARNING exactly when nothing will re-drive the notification", () => {
  beforeEach(() => {
    // As in the importer block: the switch on, a conta that routes with a fresh
    // access token, so each run reaches its arm with NO network call.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA_MS);
    stubAmbiente(AMBIENTE_LIGADO);
    seedConta(fake, ID, { selling_partner_id: SPID_A });
    seedCredencial(fake, ID);
  });

  afterEach(() => {
    // `mockReturnValue` outlives `vi.clearAllMocks`: put the real seam back.
    vi.mocked(destinos.importadorPedidoAmazon).mockReset();
  });

  const naoEncontrado: ImportadorPedidoAmazon = () =>
    Promise.reject(
      new AmazonNotFoundError({
        destino: 'sp-api',
        operacao: 'getOrder',
        metodo: 'GET',
        caminho: `/orders/2026-01-01/orders/${PEDIDO}`,
        correlationId: 'corr-2',
        requestIdAmazon: null,
        refCredencial: refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS),
        status: 404,
      }),
    );

  it.each<[string, unknown, ImportadorPedidoAmazon | null, Record<string, unknown>]>([
    [
      'a 404 on the order ⇒ PARKED, terminal: no sweep re-drives it',
      push(),
      naoEncontrado,
      { resultado: 'parked', detalhe: null, severity: 'WARNING' },
    ],
    [
      'a `pedido` payload the task schema refuses ⇒ DROPPED by the core with no row',
      { ...push(), amazonOrderId: '000-0000000-00000001' },
      null,
      { resultado: 'dropped', detalhe: 'payload-invalido', tipo: 'pedido', severity: 'WARNING' },
    ],
    [
      'an unknown tipo ⇒ DROPPED before the pipeline',
      { ...push(), tipo: 'vinculo' },
      null,
      { resultado: 'dropped', detalhe: DETALHE_TIPO_DESCONHECIDO_AMAZON, severity: 'WARNING' },
    ],
    // NEAR-MISSES: the drops that are the pipeline working, and a defer the
    // deferred sweep re-drives.
    [
      'a poll for a conta that no longer exists ⇒ an EXPECTED drop',
      poll({ contaId: 'conta-2' }),
      null,
      { resultado: 'dropped', detalhe: 'conta-inexistente', severity: 'INFO' },
    ],
    [
      'a poll whose conta now holds another seller ⇒ an EXPECTED drop',
      poll({ sellerId: SPID_B }),
      null,
      { resultado: 'dropped', detalhe: 'vendedor-mudou', severity: 'INFO' },
    ],
    [
      'the empty importer seam (mocked null since PR 5-e) ⇒ DEFERRED',
      push(),
      null,
      { resultado: 'deferred', detalhe: null, severity: 'INFO' },
    ],
    [
      'a non-BR order ⇒ an EXPECTED drop (step 5)',
      push(),
      () => Promise.resolve({ kind: 'marketplace-estrangeiro' }),
      { resultado: 'dropped', detalhe: 'marketplace-estrangeiro', severity: 'INFO' },
    ],
    [
      'an import that BLOCKED the order on a D17 divergence ⇒ done, but a WARNING: a person must look',
      push(),
      () =>
        Promise.resolve({
          kind: 'importado',
          detalhe: {
            acao: 'atualizado',
            itens: 'divergencia-itens-aprovado',
            linhasPreservadas: 0,
            linhasDivergentes: 2,
            linhasSemProduto: 0,
          },
        }),
      {
        resultado: 'done',
        detalhe: 'importado',
        acao: 'atualizado',
        itens: 'divergencia-itens-aprovado',
        linhasPreservadas: 0,
        linhasDivergentes: 2,
        linhasSemProduto: 0,
        severity: 'WARNING',
      },
    ],
    [
      'NEAR-MISS: an import whose lines were kept on a reversal ⇒ done, INFO, the counts on the line',
      push(),
      () =>
        Promise.resolve({
          kind: 'sem-mudanca',
          detalhe: {
            acao: null,
            itens: 'itens-preservados-reversao',
            linhasPreservadas: 3,
            linhasDivergentes: 0,
            linhasSemProduto: 1,
          },
        }),
      {
        resultado: 'done',
        detalhe: 'sem-mudanca',
        acao: null,
        itens: 'itens-preservados-reversao',
        linhasPreservadas: 3,
        linhasDivergentes: 0,
        linhasSemProduto: 1,
        severity: 'INFO',
      },
    ],
  ])('%s', async (_caso, dados, importador, esperado) => {
    vi.mocked(destinos.importadorPedidoAmazon).mockReturnValue(importador);

    await rodar({ data: dados, retryCount: 0, id: 'tarefa-8' });

    expect(linhaDaTarefa()).toMatchObject(esperado);
  });

  it('the parked arm really parked a row (anti-vacuity for its WARNING)', async () => {
    vi.mocked(destinos.importadorPedidoAmazon).mockReturnValue(naoEncontrado);

    await rodar({ data: push(), retryCount: 0, id: 'tarefa-9' });

    const caminho = `${COLECAO}/${notificacao.docIdNotificacaoAmazon(push())}`;
    expect(fake.ler(caminho)).toMatchObject({ status: 'parked', erro: 'pedido-inexistente' });
  });
});

describe('the log line', () => {
  it.each<[string, unknown]>([
    ['a valid push', push()],
    ['a valid poll', poll()],
    ['a push the schema drops', { ...push(), amazonOrderId: '000-0000000-00000001' }],
    ['an unknown tipo carrying a seller', { ...push(), tipo: 'outro' }],
  ])('%s: NEVER carries the seller id, by value or by key', async (_caso, dados) => {
    await rodar({ data: dados, retryCount: 0, id: 'tarefa-6' });

    const texto = stdout.linhas().join('\n');
    // Anti-vacuity: a line was written, and the raw data really held the seller.
    expect(linhaDaTarefa()).toBeDefined();
    expect(JSON.stringify(dados)).toContain(SPID_A);
    expect(texto).not.toContain(SPID_A);
    expect(texto).not.toMatch(/sellerId|SellerId|selling_partner_id/);
  });
});

describe('the call shape', () => {
  it('is `onTaskDispatched(` with NO type argument — the shape the invoker inventory discovers', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./filaLeitura.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(fonte).not.toMatch(/onTaskDispatched\s*</);
    expect(fonte.match(/onTaskDispatched\(/g) ?? []).toHaveLength(1);
    expect(fonte).toContain('export const filaLeituraAmazon = onTaskDispatched(\n');
  });
});
