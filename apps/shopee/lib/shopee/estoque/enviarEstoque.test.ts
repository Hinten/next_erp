import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeClient,
  type ShopeeErrorKind,
} from '@delfrance/integrations-shopee';

// ⚠️ The REAL admin handles, the REAL `escreverAviso`/`resolverAviso` and the
// REAL `linkEstoque` writers over the shared fake Firestore — never mocks of
// them. Half of what this module promises is a property of those writers (a
// clean send is the ONLY clearer; a partial must not stamp `estoqueEnviadoEm`;
// the clamp aviso is CLOSED by the next unclamped send), and a mocked writer
// cannot show any of it.
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { chaveEstoqueAcimaDoDisponivel } from './avisoEstoque';
import {
  MAX_MODELOS_POR_TASK,
  PAUSE_REENQUEUE_JITTER_MAX_S,
  pausaFeriasH,
  pausaLojaH,
  promocaoRetryMin,
  ratePauseMin,
} from './constantesEstoque';
import { MOTIVO_ESTOQUE_SHOPEE, RESULTADO_MODELO } from './errosEstoque';
import type { TarefaDeEstoqueShopee } from './planoEstoque';
import type { AgendadorEstoqueShopee, OpcoesDeEnfileiramento } from './shopeeStockTasks';
import {
  OUTCOME_ENVIO_ESTOQUE,
  processShopeeStockSendTask,
  shopeeStockSendTaskSchema,
  type EnvioEstoqueDeps,
  type ResultadoEnvioEstoqueShopee,
} from './enviarEstoque';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_760_000_000_000;
const INTEGRACAO = 'int-1';
const ANCORA = 'prod-abc';
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';
const LINK_DOC = 'link-1';
const VAR_A = 'varlink-a';
const VAR_B = 'varlink-b';
const ITEM_ID = 2_500_139_861;
const MODELO_A = 2_000_458_802;
const MODELO_B = 2_000_458_803;
const CAMINHO_ESTADO = `estoqueShopeeSync/${INTEGRACAO}`;
const CAMINHO_LINK = `produtos/${ANCORA}/prodshopee/${LINK_DOC}`;
const CAMINHO_VAR_A = `produtos/${FILHO_A}/variashopee/${VAR_A}`;
const CAMINHO_VAR_B = `produtos/${FILHO_B}/variashopee/${VAR_B}`;
const CAMINHO = '/api/v2/product/update_stock';

/** The two readings the fingerprint copies, as the seeded link holds them. */
const ESTADO_ANUNCIO = 'ativo';
const ITEM_STATUS = 'NORMAL';

const FONTE = readFileSync(fileURLToPath(new URL('./enviarEstoque.ts', import.meta.url)), 'utf8');

function tarefa(over: Partial<TarefaDeEstoqueShopee> = {}): TarefaDeEstoqueShopee {
  return {
    integracaoId: INTEGRACAO,
    produtoId: ANCORA,
    linkDocId: LINK_DOC,
    itemId: ITEM_ID,
    categoryId: null,
    sweepId: 'sweep-1',
    sweepComputadoEmMs: AGORA_MS - 5_000,
    reenfileiramentos: 0,
    parte: 1,
    totalDePartes: 1,
    modelos: [
      { modelId: MODELO_A, produtoId: FILHO_A, varLinkDocId: VAR_A, quantidade: 7 },
      { modelId: MODELO_B, produtoId: FILHO_B, varLinkDocId: VAR_B, quantidade: 3 },
    ],
    ...over,
  };
}

/** The no-model listing: ONE entry, `modelId: 0`, on the anchor itself. */
function tarefaSemModelo(quantidade = 4): TarefaDeEstoqueShopee {
  return tarefa({
    modelos: [{ modelId: 0, produtoId: ANCORA, varLinkDocId: null, quantidade }],
  });
}

type EnvelopeUpdate = Awaited<ReturnType<ShopeeClient['updateStock']>>;

function envelope(over: {
  readonly sucesso?: readonly number[];
  readonly falhas?: readonly (readonly [number, string])[];
  readonly error?: string;
}): EnvelopeUpdate {
  return {
    request_id: 'req-1',
    error: over.error ?? '',
    message: '',
    warning: null,
    response: {
      success_list: (over.sucesso ?? []).map((model_id) => ({
        model_id,
        location_id: null,
        // ⚠️ Deliberately a value NOBODY sent: the echo is not the authority.
        stock: 9_999,
      })),
      failure_list: (over.falhas ?? []).map(([model_id, failed_reason]) => ({
        model_id,
        failed_reason,
      })),
    },
  } as unknown as EnvelopeUpdate;
}

function apiError(
  code: string,
  message: string,
  kind: ShopeeErrorKind = SHOPEE_ERROR_KIND.other,
): ShopeeApiError {
  return new ShopeeApiError(message, { code, kind, httpStatus: 200, path: CAMINHO });
}

function burst(retryAfterSeconds: number | null = null): ShopeeRateLimitError {
  return new ShopeeRateLimitError('limite de rajada', {
    code: 'error_rate_limit',
    kind: SHOPEE_ERROR_KIND.burst,
    httpStatus: 429,
    path: CAMINHO,
    retryAfterSeconds,
  });
}

function cotaDiaria(): ShopeeRateLimitError {
  return new ShopeeRateLimitError('cota diária', {
    code: 'error_daily_quota',
    kind: SHOPEE_ERROR_KIND.daily,
    httpStatus: 429,
    path: CAMINHO,
    // Present ON PURPOSE: the daily arm must ignore it.
    retryAfterSeconds: 30,
  });
}

/** A promotion body `get_item_promotion` would answer. */
function promocoes(linhas: readonly (readonly [number, number])[], itemId = ITEM_ID): unknown {
  return {
    success_list: [
      {
        item_id: itemId,
        promotion: linhas.map(([model_id, reservado]) => ({
          model_id,
          promotion_id: '77001',
          promotion_type: 'DISCOUNT',
          promotion_staging: 'ongoing',
          promotion_stock_info_v2: { summary_info: { total_reserved_stock: reservado } },
        })),
      },
    ],
    failure_list: [],
  };
}

class AgendadorFake implements AgendadorEstoqueShopee {
  readonly chamadas: { payload: TarefaDeEstoqueShopee; opts?: OpcoesDeEnfileiramento }[] = [];
  erro: Error | null = null;
  async enqueue(payload: TarefaDeEstoqueShopee, opts?: OpcoesDeEnfileiramento): Promise<void> {
    this.chamadas.push({ payload, opts });
    if (this.erro !== null) throw this.erro;
  }
}

interface ClienteFake {
  readonly ordem: string[];
  readonly corpos: unknown[];
  updateStock: ReturnType<typeof vi.fn>;
  getItemPromotion: ReturnType<typeof vi.fn>;
  getShopHolidayMode: ReturnType<typeof vi.fn>;
}

/**
 * A stub client that records the ORDER of its calls — several assertions here
 * are about a rung running BEFORE another Shopee call, which a per-method spy
 * cannot show.
 */
function clienteFake(plano: {
  readonly updateStock?: readonly unknown[];
  readonly promocao?: unknown;
  readonly ferias?: unknown;
}): ClienteFake {
  const ordem: string[] = [];
  const corpos: unknown[] = [];
  const respostas = [...(plano.updateStock ?? [])];
  return {
    ordem,
    corpos,
    updateStock: vi.fn(async (body: unknown) => {
      ordem.push('updateStock');
      corpos.push(body);
      const r = respostas.shift();
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error('clienteFake: updateStock sem resposta planejada');
      return r;
    }),
    getItemPromotion: vi.fn(async () => {
      ordem.push('getItemPromotion');
      if (plano.promocao instanceof Error) throw plano.promocao;
      return plano.promocao ?? { success_list: [], failure_list: [] };
    }),
    getShopHolidayMode: vi.fn(async () => {
      ordem.push('getShopHolidayMode');
      if (plano.ferias instanceof Error) throw plano.ferias;
      return plano.ferias ?? { holiday_mode_on: true, holiday_mode_end_time: null };
    }),
  };
}

interface Cenario {
  readonly db: FakeDb;
  readonly scheduler: AgendadorFake;
  readonly client: ClienteFake;
  readonly deps: EnvioEstoqueDeps;
  readonly clientFor: ReturnType<typeof vi.fn>;
}

function cenario(
  plano: Parameters<typeof clienteFake>[0] = {},
  over: Partial<EnvioEstoqueDeps> = {},
): Cenario {
  const db = new FakeDb();
  db.seed(CAMINHO_ESTADO, { pausadoAte: null, pauseCount: 0 });
  db.seed(CAMINHO_LINK, {
    item_id: ITEM_ID,
    estadoAnuncio: ESTADO_ANUNCIO,
    item_status: ITEM_STATUS,
  });
  db.seed(CAMINHO_VAR_A, { model_id: MODELO_A });
  db.seed(CAMINHO_VAR_B, { model_id: MODELO_B });

  const scheduler = new AgendadorFake();
  const client = clienteFake(plano);
  const clientFor = vi.fn(async () => client as unknown as ShopeeClient);
  const deps: EnvioEstoqueDeps = {
    scheduler,
    nowMs: AGORA_MS,
    increment,
    ignoreSyncFlag: true,
    jitterSec: () => 0,
    clientFor,
    ...over,
  };
  return { db, scheduler, client, deps, clientFor };
}

function correr(c: Cenario, payload: unknown = tarefa()): Promise<ResultadoEnvioEstoqueShopee> {
  return processShopeeStockSendTask(asDb(c.db), payload, c.deps);
}

function patchesEm(db: FakeDb, caminho: string): Record<string, unknown>[] {
  return db.patches.filter((p) => p.path === caminho).map((p) => p.patch);
}

function unicoPatch(db: FakeDb, caminho: string): Record<string, unknown> {
  const todos = patchesEm(db, caminho);
  expect(todos).toHaveLength(1);
  return todos[0] ?? {};
}

/**
 * The state doc is written with `merge` (an UPSERT), which {@link FakeDb}
 * records in `writes` rather than in the update-only `patches` view.
 */
function unicaEscrita(db: FakeDb, caminho: string): Record<string, unknown> {
  const todos = db.writes.filter((w) => w.path === caminho).map((w) => w.patch);
  expect(todos).toHaveLength(1);
  return todos[0] ?? {};
}

/** The body the module actually sent, as a `[model_id, stock]` list. */
function listaEnviada(c: ClienteFake, i = 0): [number, number][] {
  const body = c.corpos[i] as {
    stock_list: { model_id: number; seller_stock: { stock: number }[] }[];
  };
  return body.stock_list.map((e) => [e.model_id, e.seller_stock[0]?.stock ?? -1]);
}

const logs: unknown[][] = [];
beforeEach(() => {
  for (const nivel of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
      logs.push([nivel, ...args]);
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  logs.length = 0;
});

/* -------------------------------------------------------------------------- */
/*  (1) o payload — a paridade com o planejador                                */
/* -------------------------------------------------------------------------- */

describe('shopeeStockSendTaskSchema', () => {
  it('1 — ⚠️ PAR: uma TarefaDeEstoqueShopee do planejador atravessa INALTERADA', () => {
    // Os dois lados de um contrato `.strict()`. Um campo acrescentado ao
    // planejador e não aqui é um DESCARTE silencioso na fila, não um erro de
    // compilação — este par é a única rede que enxerga a grafia.
    const t = tarefa();
    const lido = shopeeStockSendTaskSchema.safeParse(t);
    expect(lido.success).toBe(true);
    expect(lido.success && lido.data).toEqual(t);
    // E a saída do zod ASSINA no tipo do planejador (a direção que o
    // agendador exige: Array -> ReadonlyArray).
    const paraAFila: TarefaDeEstoqueShopee = lido.success
      ? lido.data
      : /* istanbul ignore next */ t;
    expect(paraAFila.modelos).toHaveLength(2);
  });

  it('2 — ⚠️ NEAR-MISS: um campo A MAIS é recusado (.strict), não ignorado', () => {
    const lido = shopeeStockSendTaskSchema.safeParse({ ...tarefa(), depositoId: 'dep-1' });
    expect(lido.success).toBe(false);
  });

  it('3 — `parte` é 1-BASED: um 0 é payload inválido, não a primeira parte', () => {
    expect(shopeeStockSendTaskSchema.safeParse(tarefa({ parte: 0 })).success).toBe(false);
    expect(shopeeStockSendTaskSchema.safeParse(tarefa({ parte: 1 })).success).toBe(true);
  });

  it('4 — ⚠️ PAR: modelId 0 e quantidade 0 são valores LEGÍTIMOS', () => {
    const lido = shopeeStockSendTaskSchema.safeParse(tarefaSemModelo(0));
    expect(lido.success).toBe(true);
    expect(lido.success && lido.data.modelos[0]?.modelId).toBe(0);
    expect(lido.success && lido.data.modelos[0]?.quantidade).toBe(0);
  });

  it('5 — ⚠️ NEAR-MISS: itemId -1 e um `modelos` vazio são recusados', () => {
    expect(shopeeStockSendTaskSchema.safeParse(tarefa({ itemId: -1 })).success).toBe(false);
    expect(shopeeStockSendTaskSchema.safeParse(tarefa({ modelos: [] })).success).toBe(false);
  });

  it('6 — não há `.max(50)` no zod: o corte do chunker é a rung 1, observável', () => {
    const grande = tarefa({
      modelos: Array.from({ length: MAX_MODELOS_POR_TASK + 1 }, (_, i) => ({
        modelId: i,
        produtoId: FILHO_A,
        varLinkDocId: VAR_A,
        quantidade: 1,
      })),
    });
    expect(shopeeStockSendTaskSchema.safeParse(grande).success).toBe(true);
  });
});

describe('rung 0 — o payload inválido', () => {
  it('7 — DESCARTA logando apenas CAMINHOS de campo, nunca o corpo', async () => {
    const c = cenario();
    const r = await correr(c, { integracaoId: INTEGRACAO, segredo: 'NAO-DEVE-APARECER' });

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.descartado);
    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.payloadInvalido);
    expect(JSON.stringify(logs)).not.toContain('NAO-DEVE-APARECER');
    expect(JSON.stringify(logs)).toContain('produtoId');
    expect(c.clientFor).not.toHaveBeenCalled();
    expect(Object.keys(c.db.patches)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) a válvula mestre — ACIMA do portão de pausa                            */
/* -------------------------------------------------------------------------- */

describe('rung 0.5 — a válvula', () => {
  it('8 — com a flag desligada, ZERO leituras de Firestore e ZERO chamadas Shopee', async () => {
    // M-56. A válvula ABAIXO do portão de pausa custaria uma leitura do
    // documento de estado por tarefa de uma fila inteira que não vai enviar
    // nada — e a fila pode ter milhares de tarefas em voo quando ela fecha.
    vi.stubEnv('SHOPEE_STOCK_SYNC_ENABLED', '');
    const c = cenario({}, { ignoreSyncFlag: undefined });

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.pulado);
    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.syncDesabilitado);
    expect(c.db.caminhos).toEqual([]);
    expect(c.clientFor).not.toHaveBeenCalled();
    expect(c.scheduler.chamadas).toEqual([]);
  });

  it('9 — ⚠️ NEAR-MISS: `ignoreSyncFlag !== true`, nunca `=== true`', async () => {
    // M-57. Com a comparação invertida, a FILA (que não passa a opção) passaria
    // a ignorar a válvula e o empurrão manual passaria a obedecê-la — os dois
    // exatamente ao contrário, e nada falharia.
    vi.stubEnv('SHOPEE_STOCK_SYNC_ENABLED', '');

    const semOpcao = cenario({}, { ignoreSyncFlag: undefined });
    expect((await correr(semOpcao)).motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.syncDesabilitado);

    const falso = cenario({}, { ignoreSyncFlag: false });
    expect((await correr(falso)).motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.syncDesabilitado);

    const verdadeiro = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    expect((await correr(verdadeiro)).outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviado);
  });

  it('10 — com a flag LIGADA no ambiente, a fila envia sem nenhuma opção', async () => {
    vi.stubEnv('SHOPEE_STOCK_SYNC_ENABLED', '1');
    const c = cenario(
      { updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] },
      { ignoreSyncFlag: undefined },
    );
    expect((await correr(c)).outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviado);
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) a rung 51 — ANTES do cliente                                           */
/* -------------------------------------------------------------------------- */

describe('rung 1 — o corte do chunker', () => {
  it('11 — 51 modelos: recusa registrada no ANÚNCIO e ZERO chamadas Shopee', async () => {
    // M-58. Abaixo da construção do cliente isto gastaria um token, um contexto
    // e uma chamada para provar o que a contagem já dizia.
    const c = cenario();
    const grande = tarefa({
      modelos: Array.from({ length: MAX_MODELOS_POR_TASK + 1 }, (_, i) => ({
        modelId: i,
        produtoId: FILHO_A,
        varLinkDocId: VAR_A,
        quantidade: 1,
      })),
    });

    const r = await correr(c, grande);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.erroRegistrado);
    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite);
    expect(r.codigo).toBe(`erp:${MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite}`);
    expect(c.clientFor).not.toHaveBeenCalled();
    expect(c.client.ordem).toEqual([]);
    expect(unicoPatch(c.db, CAMINHO_LINK)).toMatchObject({
      estoqueRecusaMotivo: MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite,
      estoqueRecusaEstado: ESTADO_ANUNCIO,
      estoqueRecusaItemStatus: ITEM_STATUS,
    });
  });

  it('12 — ⚠️ NEAR-MISS: exatamente 50 modelos PASSAM', async () => {
    const c = cenario({
      updateStock: [
        envelope({ sucesso: Array.from({ length: MAX_MODELOS_POR_TASK }, (_, i) => i) }),
      ],
    });
    const limite = tarefa({
      modelos: Array.from({ length: MAX_MODELOS_POR_TASK }, (_, i) => ({
        modelId: i,
        produtoId: FILHO_A,
        varLinkDocId: VAR_A,
        quantidade: 1,
      })),
    });

    expect((await correr(c, limite)).outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviado);
    expect(c.client.updateStock).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) o portão de pausa                                                      */
/* -------------------------------------------------------------------------- */

describe('rung 2 — a conta pausada', () => {
  it('13 — re-enfileira com ATRASO, sem chamar a Shopee e sem lançar', async () => {
    const c = cenario();
    c.db.seed(CAMINHO_ESTADO, { pausadoAte: AGORA_MS + 60_000, pauseCount: 2 });

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.pausadoReenfileirado);
    expect(r.pausadoAte).toBe(AGORA_MS + 60_000);
    expect(c.clientFor).not.toHaveBeenCalled();
    expect(c.scheduler.chamadas).toHaveLength(1);
    expect(c.scheduler.chamadas[0]?.payload.reenfileiramentos).toBe(1);
    expect(c.scheduler.chamadas[0]?.opts).toEqual({ scheduleDelaySeconds: 60 });
  });

  it('14 — o jitter é SOMADO ao atraso e vem da dep, nunca de um sorteio local', async () => {
    const c = cenario({}, { jitterSec: (max) => max });
    c.db.seed(CAMINHO_ESTADO, { pausadoAte: AGORA_MS + 60_000, pauseCount: 0 });

    await correr(c);

    expect(c.scheduler.chamadas[0]?.opts).toEqual({
      scheduleDelaySeconds: 60 + PAUSE_REENQUEUE_JITTER_MAX_S,
    });
  });

  it('15 — esgotados os re-enfileiramentos, DESCARTA em vez de girar para sempre', async () => {
    const c = cenario();
    c.db.seed(CAMINHO_ESTADO, { pausadoAte: AGORA_MS + 60_000, pauseCount: 0 });

    const r = await correr(c, tarefa({ reenfileiramentos: 10 }));

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.descartado);
    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.pausaReenqueuesEsgotados);
    expect(c.scheduler.chamadas).toEqual([]);
  });

  it('16 — a válvula de tasks fechada vira um DESCARTE nomeado, não uma falha', async () => {
    const c = cenario();
    c.db.seed(CAMINHO_ESTADO, { pausadoAte: AGORA_MS + 60_000, pauseCount: 0 });
    c.scheduler.erro = Object.assign(new Error('desabilitada'), {
      name: 'ShopeeStockTasksDisabledError',
    });
    // A classe real, não um sósia: o narrow é `instanceof`.
    const { ShopeeStockTasksDisabledError } = await import('./errosEstoque');
    c.scheduler.erro = new ShopeeStockTasksDisabledError();

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.descartado);
    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.tasksDesabilitadas);
  });

  it('17 — ⚠️ NEAR-MISS: `pausadoAte === nowMs` NÃO está pausada e envia', async () => {
    // A igualdade é liberação: a tarefa re-enfileirada para exatamente
    // `pausadoAte` chegaria e gastaria um segundo re-enfileiramento à toa.
    const c = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    c.db.seed(CAMINHO_ESTADO, { pausadoAte: AGORA_MS, pauseCount: 0 });

    expect((await correr(c)).outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviado);
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) a atribuição por model_id                                              */
/* -------------------------------------------------------------------------- */

describe('rung 4/5 — a chamada e a atribuição', () => {
  it('18 — o corpo é `{item_id, stock_list:[{model_id, seller_stock:[{stock}]}]}` SEM location_id', async () => {
    const c = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    await correr(c);

    const body = c.client.updateStock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      item_id: ITEM_ID,
      stock_list: [
        { model_id: MODELO_A, seller_stock: [{ stock: 7 }] },
        { model_id: MODELO_B, seller_stock: [{ stock: 3 }] },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('location_id');
  });

  it('19 — ⚠️ PAR: as listas EMBARALHADAS dão o MESMO resultado (atribuição por model_id)', async () => {
    // M-59. Por posição, `success_list` invertida atribuiria a quantidade de A
    // à linha de B — um resultado errado que contagem nenhuma enxerga.
    const naOrdem = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    const invertida = cenario({ updateStock: [envelope({ sucesso: [MODELO_B, MODELO_A] })] });

    const a = await correr(naOrdem);
    const b = await correr(invertida);

    expect(b.modelos).toEqual(a.modelos);
    expect(a.modelos.map((m) => [m.modelId, m.quantidadeEnviada])).toEqual([
      [MODELO_A, 7],
      [MODELO_B, 3],
    ]);
  });

  it('20 — ⚠️ NEAR-MISS: `model_id: 0` é chave legítima e NÃO some do Map', async () => {
    // M-60. Um `if (modelId)` em qualquer ponto transforma a escrita do anúncio
    // simples num erro de estrutura na Shopee.
    const c = cenario({ updateStock: [envelope({ sucesso: [0] })] });

    const r = await correr(c, tarefaSemModelo(4));

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviado);
    expect(r.modelos).toHaveLength(1);
    expect(r.modelos[0]?.resultado).toBe(RESULTADO_MODELO.enviado);
    expect(listaEnviada(c.client)).toEqual([[0, 4]]);
  });

  it('21 — `failure_list` é lido MESMO com `error` vazio (P9)', async () => {
    // M-61. A ausência de um erro lançado não é a ausência de uma recusa: a
    // sonda mediu um model_id inválido ao lado de um válido respondendo HTTP
    // 200, `error: ''` e AS DUAS listas populadas.
    const c = cenario({
      updateStock: [
        envelope({ sucesso: [MODELO_A], falhas: [[MODELO_B, 'model ID not exist in sku']] }),
      ],
    });

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviadoParcial);
    expect(r.modelos.map((m) => m.resultado)).toEqual([
      RESULTADO_MODELO.enviado,
      RESULTADO_MODELO.recusado,
    ]);
  });

  it('22 — o registrado é o que foi ENVIADO, nunca o eco de `success_list[].stock`', async () => {
    // M-73. O passo 11 mediu um eco defasado neste provedor.
    const c = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    const r = await correr(c);

    expect(r.quantidadeEnviada).toBe(10);
    expect(r.modelos.map((m) => m.quantidadeEnviada)).toEqual([7, 3]);
    expect(unicoPatch(c.db, CAMINHO_LINK).estoqueEnviado).toBe(10);
  });

  it('23 — um modelo em NENHUMA das listas é `sem-resposta`: contado, sem recusa gravada', async () => {
    const c = cenario({ updateStock: [envelope({ sucesso: [MODELO_A] })] });

    const r = await correr(c);

    expect(r.modelos[1]?.resultado).toBe(RESULTADO_MODELO.semResposta);
    expect(r.modelos[1]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.modeloSemResposta);
    // Nenhuma recusa no FILHO — não há diagnóstico a gravar.
    expect(patchesEm(c.db, CAMINHO_VAR_B)).toEqual([]);
    // E NÃO é um envio limpo: um limpo apagaria uma recusa ainda viva.
    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviadoParcial);
  });

  it('24 — o sender NUNCA faz leitura de verificação (ordem de chamada)', async () => {
    // M-74. Uma leitura pós-envio faria deste módulo um QUINTO escritor de
    // `item_status`, e as recusas da Shopee já são exatas no HTTP 200.
    const c = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    await correr(c);
    expect(c.client.ordem).toEqual(['updateStock']);
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) as escritas de volta                                                   */
/* -------------------------------------------------------------------------- */

describe('rung 6 — as escritas de volta', () => {
  it('25 — LIMPO: carimba estoqueEnviadoEm e zera os seis campos de recusa', async () => {
    const c = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    await correr(c);

    const patch = unicoPatch(c.db, CAMINHO_LINK);
    expect(patch.estoqueEnviadoEm).toBe(AGORA_MS);
    expect(patch.estoqueRecusaEm).toBeNull();
    expect(patch.estoqueRecusaEstado).toBeNull();
  });

  it('26 — ⚠️ NEAR-MISS: um PARCIAL não carimba estoqueEnviadoEm nem chama o limpador', async () => {
    // M-87. `estoqueEnviadoEm` é a âncora contra a qual a visibilidade das
    // linhas-filhas é comparada; carimbá-lo aqui faria toda linha que este
    // mesmo envio acabou de escrever ler como obsoleta no instante em que caiu.
    const c = cenario({
      updateStock: [
        envelope({ sucesso: [MODELO_A], falhas: [[MODELO_B, 'error_item_uneditable']] }),
      ],
    });

    await correr(c);

    const patch = unicoPatch(c.db, CAMINHO_LINK);
    expect(Object.hasOwn(patch, 'estoqueEnviadoEm')).toBe(false);
    expect(patch.estoqueRecusaMotivo).toBe(MOTIVO_ESTOQUE_SHOPEE.envioParcial);
  });

  it('27 — PARCIAL: uma recusa por modelo recusado, no FILHO, com o texto VERBATIM', async () => {
    const c = cenario({
      updateStock: [
        envelope({ sucesso: [MODELO_A], falhas: [[MODELO_B, 'model ID not exist in sku']] }),
      ],
    });

    await correr(c);

    expect(patchesEm(c.db, CAMINHO_VAR_A)).toEqual([]);
    expect(unicoPatch(c.db, CAMINHO_VAR_B)).toEqual({
      estoqueRecusaEm: AGORA_MS,
      estoqueRecusaCodigo: 'model ID not exist in sku',
      ultimaModificacao: AGORA_MS,
    });
  });

  it('28 — PARCIAL: o código do anúncio é o da PRIMEIRA recusa, nunca uma junção', async () => {
    const c = cenario({
      updateStock: [
        envelope({
          falhas: [
            [MODELO_A, 'primeira razao'],
            [MODELO_B, 'segunda razao'],
          ],
        }),
      ],
    });

    const r = await correr(c);

    expect(r.codigo).toBe('primeira razao');
    expect(unicoPatch(c.db, CAMINHO_LINK).estoqueRecusaCodigo).toBe('primeira razao');
  });

  it('29 — TERMINAL: grava AS DUAS metades da impressão digital, exatamente como lidas', async () => {
    // Sem as duas, o conjunto de pulo do portão nunca arma; com uma inventada,
    // ele arma contra uma leitura que ninguém fez.
    const c = cenario({
      updateStock: [apiError('product.error_item_uneditable', 'item is not editable')],
    });

    const r = await correr(c);

    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.anuncioNaoEditavel);
    expect(unicoPatch(c.db, CAMINHO_LINK)).toMatchObject({
      estoqueRecusaEstado: ESTADO_ANUNCIO,
      estoqueRecusaItemStatus: ITEM_STATUS,
      estoqueRecusaAte: null,
    });
  });

  it('30 — TERMINAL: o código é guardado VERBATIM, com o prefixo de módulo', async () => {
    // M-88. A forma sem prefixo serve só para CLASSIFICAR — dois módulos da
    // Shopee compartilham sufixos, e um código reescrito na gravação nunca mais
    // se casa com a documentação do provedor.
    const c = cenario({
      updateStock: [apiError('product.error_item_uneditable', 'item is not editable')],
    });
    await correr(c);
    expect(unicoPatch(c.db, CAMINHO_LINK).estoqueRecusaCodigo).toBe(
      'product.error_item_uneditable',
    );
  });

  it('31 — ⚠️ PAR: só o braço B carrega `ate`; os outros terminais deixam null', async () => {
    const promocao = cenario({
      updateStock: [apiError('error_cannt_edit_stock_in_promotion', 'locked by promotion')],
    });
    await correr(promocao);
    expect(unicoPatch(promocao.db, CAMINHO_LINK).estoqueRecusaAte).toBe(
      AGORA_MS + promocaoRetryMin() * 60 * 1000,
    );

    const identidade = cenario({
      updateStock: [apiError('error_item_not_found', 'item not found')],
    });
    await correr(identidade);
    expect(unicoPatch(identidade.db, CAMINHO_LINK).estoqueRecusaAte).toBeNull();
  });

  it('32 — um vínculo APAGADO no meio resolve sem lançar e sem ressuscitar o doc', async () => {
    const c = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    delete c.db.store[CAMINHO_LINK];

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviado);
    expect(c.db.store[CAMINHO_LINK]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  (7) a escada — a ORDEM de narrowing                                        */
/* -------------------------------------------------------------------------- */

describe('a escada de erros — a ordem das classes', () => {
  it('33 — um 429 de RAJADA vira pausa + re-enfileiramento, nunca `recusa-desconhecida`', async () => {
    // M-62/M-64. Um `instanceof ShopeeApiError` nu acima do braço de limite
    // engoliria as outras três classes — todas descendem dele.
    const c = cenario({ updateStock: [burst(42)] });

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.pausadoReenfileirado);
    expect(r.pausadoAte).toBe(AGORA_MS + 42_000);
    expect(unicaEscrita(c.db, CAMINHO_ESTADO)).toMatchObject({
      pausadoAte: AGORA_MS + 42_000,
      pausaMotivo: 'burst',
      pausaCodigo: 'error_rate_limit',
      pauseCount: 1,
    });
    expect(c.scheduler.chamadas[0]?.opts).toEqual({ scheduleDelaySeconds: 42 });
    // NENHUMA recusa no anúncio: a rajada não é um fato sobre esta listagem.
    expect(patchesEm(c.db, CAMINHO_LINK)).toEqual([]);
  });

  it('34 — sem `Retry-After`, a rajada usa ratePauseMin() MINUTOS', async () => {
    const c = cenario({ updateStock: [burst(null)] });
    const r = await correr(c);
    expect(r.pausadoAte).toBe(AGORA_MS + ratePauseMin() * 60 * 1000);
  });

  it('35 — a rajada NÃO consome tentativa: resolve, não lança', async () => {
    const c = cenario({ updateStock: [burst(10)] });
    await expect(correr(c)).resolves.toBeTruthy();
  });

  it('36 — a COTA DIÁRIA descarta e pausa até a virada, ignorando `Retry-After`', async () => {
    // M-66/M-67. A cota reseta num instante de relógio de parede; um
    // `Retry-After` de um proxy diz menos do que o reset documentado. E a
    // virada vem de `pausarAnuncio`, nunca re-derivada aqui.
    const c = cenario({ updateStock: [cotaDiaria()] });

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.descartado);
    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.cotaDiaria);
    expect(r.pausadoAte).toBe(proximaViradaDaCotaMs(AGORA_MS));
    expect(r.pausadoAte).not.toBe(AGORA_MS + 30_000);
    expect(c.scheduler.chamadas).toEqual([]);
  });

  it('37 — REAUTH grava lastError na CONTA e devolve SUCESSO à fila', async () => {
    // M-63. Um rethrow aqui gastaria as três tentativas contra um token que só
    // um humano pode renovar.
    const c = cenario({
      updateStock: [
        new ShopeeReauthRequiredError('token expirado', {
          code: 'error_auth_token',
          kind: SHOPEE_ERROR_KIND.reauth,
          httpStatus: 200,
          path: CAMINHO,
        }),
      ],
    });

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.erroRegistrado);
    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.reauth);
    expect(unicaEscrita(c.db, CAMINHO_ESTADO)).toMatchObject({
      lastError: 'token expirado',
      lastErrorAtMs: AGORA_MS,
    });
  });

  it('38 — ⚠️ NEAR-MISS: um ShopeeApiPartialError NÃO é lido como limite de taxa', async () => {
    const parcial = new ShopeeApiPartialError('parcial', {
      code: 'error_busi_update_stock_failed',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: CAMINHO,
      parsed: {
        request_id: 'req-2',
        error: 'error_busi_update_stock_failed',
        message: 'parcial',
        warning: null,
        response: {
          success_list: [{ model_id: MODELO_A, location_id: null, stock: 7 }],
          failure_list: [{ model_id: MODELO_B, failed_reason: 'error_item_uneditable' }],
        },
      },
    });
    const c = cenario({ updateStock: [parcial] });

    const r = await correr(c);

    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviadoParcial);
    expect(r.pausadoAte).toBeNull();
    expect(c.scheduler.chamadas).toEqual([]);
    // `success_list` do parcial CONTA COMO ENVIADO.
    expect(r.quantidadeEnviada).toBe(7);
    expect(unicoPatch(c.db, CAMINHO_VAR_B).estoqueRecusaCodigo).toBe('error_item_uneditable');
  });

  it('39 — um ShopeeNetworkError SOBE (a fila é dona dele)', async () => {
    const c = cenario({ updateStock: [new ShopeeNetworkError('conexão caiu')] });
    await expect(correr(c)).rejects.toBeInstanceOf(ShopeeNetworkError);
  });
});

/* -------------------------------------------------------------------------- */
/*  (8) a tabela dos braços, PERCORRIDA NA ORDEM                               */
/* -------------------------------------------------------------------------- */

interface LinhaDaTabela {
  readonly titulo: string;
  readonly codigo: string;
  readonly mensagem: string;
  readonly kind?: ShopeeErrorKind;
  readonly outcome: ResultadoEnvioEstoqueShopee['outcome'];
  readonly motivo: string;
}

const TABELA: readonly LinhaDaTabela[] = [
  // ---- A: o piso, PRIMEIRO e cego ao código ----
  {
    titulo: 'A · error.param com "reserved stock" cai no PISO, não em modelo-inválido',
    codigo: 'error.param',
    mensagem: 'stock can not be less than reserved stock',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido,
  },
  {
    titulo: 'A · "reserve stock" (a segunda grafia) também',
    codigo: 'product.error_busi',
    mensagem: 'seller stock less than reserve stock',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido,
  },
  // ---- G: férias, ACIMA de E e F1 ----
  {
    titulo: 'G · error_holiday_mode_change_stock pausa a conta por FÉRIAS',
    codigo: 'error_holiday_mode_change_stock',
    mensagem: 'shop is in holiday mode',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.lojaEmFerias,
  },
  {
    titulo: 'G · error_auth + "holiday mode" é FÉRIAS, não forma de loja (M-70)',
    codigo: 'shop.error_auth',
    mensagem: 'cannot update while holiday mode is on',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.lojaEmFerias,
  },
  // ---- F1: o depósito ----
  {
    titulo: 'F1 · error_auth + location_id é MULTI-ARMAZÉM',
    codigo: 'error_auth',
    mensagem: 'no permission for this location_id',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.multiArmazem,
  },
  {
    titulo: 'F1 · error_inner + "invalid stock location id" é PERMANENTE, não transitório (M-71)',
    codigo: 'error_inner',
    mensagem: 'invalid stock location id',
    kind: SHOPEE_ERROR_KIND.other,
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.multiArmazem,
  },
  {
    titulo: 'F1 · error_busi + "multi warehouse"',
    codigo: 'product.error_busi',
    mensagem: 'multi warehouse item must carry every location',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.multiArmazem,
  },
  // ---- F2: a estrutura ----
  {
    titulo: 'F2 · error_param + "different stock structure" é TERMINAL por anúncio',
    codigo: 'error_param',
    mensagem: 'item has a different stock structure',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.estruturaDeEstoqueDivergente,
  },
  // ---- E: a forma da loja, ACIMA de J ----
  {
    titulo: 'E · error_wms_shop_block_upate_stock [sic] ⇒ loja-armazem',
    codigo: 'product.error_wms_shop_block_upate_stock',
    mensagem: 'wms shop',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.lojaArmazem,
  },
  {
    titulo: 'E · error_busi_cannot_edit_vsku ⇒ loja-vsku',
    codigo: 'error_busi_cannot_edit_vsku',
    mensagem: 'cannot edit vsku',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.lojaVsku,
  },
  {
    titulo: 'E · error_seller_under_penalty ⇒ loja-com-penalidade',
    codigo: 'error_seller_under_penalty',
    mensagem: 'seller under penalty',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.lojaComPenalidade,
  },
  {
    titulo: 'E · error_perm_non_admin ⇒ sem-permissao',
    codigo: 'error_perm_non_admin',
    mensagem: 'non admin',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.semPermissao,
  },
  {
    titulo: 'E · cnsc_shop_block ⇒ loja-cnsc-nao-migrada',
    codigo: 'cnsc_shop_block',
    mensagem: 'blocked',
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.lojaCnscNaoMigrada,
  },
  {
    titulo: 'E · ⚠️ NEAR-MISS: error_server com a mensagem de FBS NÃO é transitório (M-69)',
    codigo: 'error_server',
    mensagem: 'normal stock must be equal to 0 for this fulfilment shop',
    kind: SHOPEE_ERROR_KIND.transient,
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.lojaFbs,
  },
  {
    titulo: 'E · "cnsc shop not upgraded" pela MENSAGEM',
    codigo: 'error_server',
    mensagem: 'cnsc shop not upgraded yet',
    kind: SHOPEE_ERROR_KIND.transient,
    outcome: 'descartado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.lojaCnscNaoMigrada,
  },
  // ---- B: a promoção ----
  {
    titulo: 'B · error_promotion_cantnot_update_stock [sic] ⇒ bloqueado-por-promocao',
    codigo: 'error_promotion_cantnot_update_stock',
    mensagem: 'item in promotion',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.bloqueadoPorPromocao,
  },
  {
    titulo: 'B · error_model_update_stock_model_in_promotion ⇒ bloqueado-por-promocao',
    codigo: 'error_model_update_stock_model_in_promotion',
    mensagem: 'model in promotion',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.bloqueadoPorPromocao,
  },
  // ---- C: a forma do modelo ----
  {
    titulo: 'C · error_edit_item_stock_for_item_has_model ⇒ forma-de-modelo-divergente',
    codigo: 'error_edit_item_stock_for_item_has_model',
    mensagem: 'item has models',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.formaDeModeloDivergente,
  },
  {
    titulo: 'C · error_in_item_promotion_nomodel_to_models ⇒ forma-de-modelo-divergente',
    codigo: 'error_in_item_promotion_nomodel_to_models',
    mensagem: 'nomodel to models',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.formaDeModeloDivergente,
  },
  // ---- D: a identidade ----
  {
    titulo: 'D · error_item_not_belong_shop ⇒ anuncio-de-outra-loja',
    codigo: 'error_item_not_belong_shop',
    mensagem: 'not your item',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioDeOutraLoja,
  },
  {
    titulo: 'D · error_item_not_found ⇒ anuncio-inexistente',
    codigo: 'error_item_not_found',
    mensagem: 'item not found',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioInexistente,
  },
  {
    titulo: 'D · error_nil_shopid_or_itemid ⇒ anuncio-inexistente',
    codigo: 'error_nil_shopid_or_itemid',
    mensagem: 'nil shopid',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioInexistente,
  },
  {
    titulo: 'D · error_param + "repeat model_id" ⇒ modelo-invalido',
    codigo: 'error_param',
    mensagem: 'repeat model_id in the request',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.modeloInvalido,
  },
  {
    titulo: 'D · error_param + "wrong model_id" ⇒ modelo-invalido',
    codigo: 'error_param',
    mensagem: 'wrong model_id',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.modeloInvalido,
  },
  // ---- H ----
  {
    titulo: 'H · error_item_uneditable ⇒ anuncio-nao-editavel',
    codigo: 'product.error_item_uneditable',
    mensagem: 'item is not editable',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioNaoEditavel,
  },
  // ---- K ----
  {
    titulo: 'K · um código que ninguém ensinou é recusa-desconhecida, NUNCA uma re-tentativa',
    codigo: 'product.error_brand_new_thing',
    mensagem: 'something nobody documented',
    outcome: 'erro-registrado',
    motivo: MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida,
  },
];

describe('a tabela dos braços, na ordem declarada', () => {
  for (const linha of TABELA) {
    it(`40+ — ${linha.titulo}`, async () => {
      const c = cenario({
        updateStock: [apiError(linha.codigo, linha.mensagem, linha.kind)],
        // Só o braço G chega aqui; os outros nunca pedem.
        ferias: { holiday_mode_on: true, holiday_mode_end_time: null },
        // Só o braço A chega aqui; um piso vazio o torna terminal de imediato.
        promocao: { success_list: [], failure_list: [] },
      });

      const r = await correr(c);

      expect(r.outcome).toBe(linha.outcome);
      expect(r.motivo).toBe(linha.motivo);
      expect(r.codigo).toBe(linha.codigo);
      // Nunca uma re-tentativa automática de `update_stock` fora do piso.
      expect(c.client.updateStock).toHaveBeenCalledTimes(1);
    });
  }

  it('41 — J · um transitório SOBE, sem escrever nada', async () => {
    // Um retry que der certo não pode encontrar uma recusa gravada atrás dele.
    const c = cenario({
      updateStock: [apiError('error_system_busy', 'system busy, please try later')],
    });
    await expect(correr(c)).rejects.toBeInstanceOf(ShopeeApiError);
    expect(patchesEm(c.db, CAMINHO_LINK)).toEqual([]);
  });

  it('42 — J · `kind: transient` sozinho basta, quando nenhum braço acima casou', async () => {
    const c = cenario({
      updateStock: [apiError('error_qualquer', 'hiccup', SHOPEE_ERROR_KIND.transient)],
    });
    await expect(correr(c)).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('43 — K · o console.error sai UMA vez e não carrega corpo nenhum', async () => {
    const c = cenario({
      updateStock: [apiError('product.error_brand_new_thing', 'nobody documented this')],
    });
    await correr(c);
    const erros = logs.filter((l) => l[0] === 'error');
    expect(erros).toHaveLength(1);
    expect(JSON.stringify(erros)).toContain('product.error_brand_new_thing');
  });
});

/* -------------------------------------------------------------------------- */
/*  (9) o caminho do piso                                                      */
/* -------------------------------------------------------------------------- */

describe('o caminho do piso (braço A)', () => {
  it('44 — UMA leitura de promoção, UMA re-tentativa, com a lista CLAMPADA INTEIRA', async () => {
    // M-79. A sonda mediu que um `stock_list` parcial deixa os modelos
    // omitidos intactos, então re-enviar tudo é seguro — e é a única forma que
    // funciona se a recusa era sobre o ENVELOPE.
    const c = cenario({
      updateStock: [
        apiError('error.param', 'stock can not be less than reserved stock'),
        envelope({ sucesso: [MODELO_A, MODELO_B] }),
      ],
      promocao: promocoes([[MODELO_A, 12]]),
    });

    const r = await correr(c);

    expect(c.client.ordem).toEqual(['updateStock', 'getItemPromotion', 'updateStock']);
    expect(listaEnviada(c.client, 1)).toEqual([
      [MODELO_A, 12],
      [MODELO_B, 3],
    ]);
    expect(r.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviado);
    expect(r.chamadasShopee).toBe(3);
    expect(r.modelos[0]?.clampado).toBe(true);
    expect(r.modelos[0]?.piso).toBe(12);
    expect(r.modelos[1]?.clampado).toBe(false);
  });

  it('45 — ⚠️ NEAR-MISS: uma leitura de piso VAZIA é TERMINAL, nunca um clamp a zero', async () => {
    // M-80. O módulo não aprendeu nada; uma segunda chamada idêntica também não.
    const c = cenario({
      updateStock: [apiError('error.param', 'less than reserved stock')],
      promocao: { success_list: [{ item_id: ITEM_ID, promotion: [] }], failure_list: [] },
    });

    const r = await correr(c);

    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido);
    expect(c.client.updateStock).toHaveBeenCalledTimes(1);
    expect(unicoPatch(c.db, CAMINHO_LINK).estoqueRecusaCodigo).toBe('error.param');
  });

  it('46 — uma leitura de piso que FALHA é terminal de imediato, sem re-tentativa', async () => {
    const c = cenario({
      updateStock: [apiError('error.param', 'less than reserved stock')],
      promocao: apiError('error_server', 'promotion read failed'),
    });

    const r = await correr(c);

    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido);
    expect(c.client.updateStock).toHaveBeenCalledTimes(1);
  });

  it('47 — um piso que NÃO MOVE nada é terminal: a re-tentativa seria idêntica', async () => {
    const c = cenario({
      updateStock: [apiError('error.param', 'less than reserved stock')],
      promocao: promocoes([[MODELO_A, 2]]),
    });

    const r = await correr(c);

    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido);
    expect(c.client.updateStock).toHaveBeenCalledTimes(1);
  });

  it('48 — uma SEGUNDA recusa de piso é terminal: exatamente UMA re-tentativa', async () => {
    const c = cenario({
      updateStock: [
        apiError('error.param', 'less than reserved stock'),
        apiError('error.param', 'still less than reserved stock'),
      ],
      promocao: promocoes([[MODELO_A, 12]]),
    });

    const r = await correr(c);

    expect(r.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido);
    expect(c.client.updateStock).toHaveBeenCalledTimes(2);
    expect(c.client.getItemPromotion).toHaveBeenCalledTimes(1);
  });

  it('49 — o piso é o MÁXIMO entre promoções concorrentes, e `upcoming` CONTA', async () => {
    const c = cenario({
      updateStock: [
        apiError('error.param', 'less than reserved stock'),
        envelope({ sucesso: [MODELO_A, MODELO_B] }),
      ],
      promocao: {
        success_list: [
          {
            item_id: ITEM_ID,
            promotion: [
              {
                model_id: MODELO_A,
                promotion_id: '77001',
                promotion_staging: 'ongoing',
                promotion_stock_info_v2: { summary_info: { total_reserved_stock: 9 } },
              },
              {
                model_id: MODELO_A,
                promotion_id: '77002',
                promotion_staging: 'upcoming',
                promotion_stock_info_v2: { summary_info: { total_reserved_stock: 20 } },
              },
            ],
          },
        ],
        failure_list: [],
      },
    });

    await correr(c);

    expect(listaEnviada(c.client, 1)[0]).toEqual([MODELO_A, 20]);
  });

  it('50 — o aviso sai UMA vez, com a MAIOR folga, e só com NÚMEROS', async () => {
    const c = cenario({
      updateStock: [
        apiError('error.param', 'less than reserved stock'),
        envelope({ sucesso: [MODELO_A, MODELO_B] }),
      ],
      // A é 7 -> 12 (folga 5); B é 3 -> 30 (folga 27) — B vence.
      promocao: promocoes([
        [MODELO_A, 12],
        [MODELO_B, 30],
      ]),
    });

    await correr(c);

    const chave = chaveEstoqueAcimaDoDisponivel(INTEGRACAO, FILHO_B);
    const doc = c.db.store[`avisos/${chave}`]?.data as Record<string, unknown> | undefined;
    expect(doc).toBeDefined();
    expect(doc?.params).toEqual({
      anuncio: String(ITEM_ID),
      reservado: '30',
      disponivel: '3',
    });
    // UM aviso por tarefa, não um por modelo clampado.
    const avisos = Object.keys(c.db.store).filter((p) => p.startsWith('avisos/'));
    expect(avisos).toHaveLength(1);
  });

  it('51 — ⚠️ PAR/NEAR-MISS: um envio limpo RESOLVE o aviso; um envio CLAMPADO não', async () => {
    // A linha mais importante do tipo: este envio é a ÚNICA coisa que fecha a
    // linha, e uma que fica de pé sobrevive 90 dias numa coleção sem botão de
    // dispensar. E resolver num envio que AINDA precisou do piso seria fechar
    // a linha com a evidência de que o problema continua.
    const chave = chaveEstoqueAcimaDoDisponivel(INTEGRACAO, FILHO_A);
    const caminhoDoAviso = `avisos/${chave}`;

    const clampado = cenario({
      updateStock: [
        apiError('error.param', 'less than reserved stock'),
        envelope({ sucesso: [MODELO_A, MODELO_B] }),
      ],
      promocao: promocoes([[MODELO_A, 12]]),
    });
    await correr(clampado);
    const criado = clampado.db.store[caminhoDoAviso]?.data as Record<string, unknown>;
    expect(criado.resolvidoEm ?? null).toBeNull();

    // Um SEGUNDO envio clampado NÃO resolve (é evidência de que continua).
    const outroClamp = clienteFake({
      updateStock: [
        apiError('error.param', 'less than reserved stock'),
        envelope({ sucesso: [MODELO_A, MODELO_B] }),
      ],
      promocao: promocoes([[MODELO_A, 12]]),
    });
    await processShopeeStockSendTask(asDb(clampado.db), tarefa(), {
      ...clampado.deps,
      nowMs: AGORA_MS + 1_000,
      clientFor: async () => outroClamp as unknown as ShopeeClient,
    });
    expect(
      (clampado.db.store[caminhoDoAviso]?.data as Record<string, unknown>).resolvidoEm ?? null,
    ).toBeNull();

    // O envio LIMPO seguinte fecha a linha.
    const limpo = clienteFake({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    await processShopeeStockSendTask(asDb(clampado.db), tarefa(), {
      ...clampado.deps,
      nowMs: AGORA_MS + 2_000,
      clientFor: async () => limpo as unknown as ShopeeClient,
    });
    const fechado = clampado.db.store[caminhoDoAviso]?.data as Record<string, unknown>;
    expect(fechado.resolvidoEm).not.toBeNull();
    expect(fechado.resolucaoMotivo).toBe('estoque-dentro-do-disponivel');
  });
});

/* -------------------------------------------------------------------------- */
/*  (10) férias, o log, e a disciplina de origem                               */
/* -------------------------------------------------------------------------- */

describe('o braço G — férias', () => {
  it('52 — usa `holiday_mode_end_time` (SEGUNDOS) quando é futuro', async () => {
    const fimEmSegundos = Math.floor((AGORA_MS + 7_200_000) / 1000);
    const c = cenario({
      updateStock: [apiError('error_holiday_mode_change_stock', 'holiday')],
      ferias: { holiday_mode_on: true, holiday_mode_end_time: fimEmSegundos },
    });

    const r = await correr(c);

    expect(r.pausadoAte).toBe(fimEmSegundos * 1000);
    expect(c.client.getShopHolidayMode).toHaveBeenCalledTimes(1);
  });

  it('53 — ⚠️ NEAR-MISS: um fim JÁ PASSADO cai na pausa fixa, não no passado', async () => {
    const c = cenario({
      updateStock: [apiError('error_holiday_mode_change_stock', 'holiday')],
      ferias: { holiday_mode_on: true, holiday_mode_end_time: 1 },
    });
    expect((await correr(c)).pausadoAte).toBe(AGORA_MS + pausaFeriasH());
  });

  it('54 — a leitura de férias FALHANDO vira a pausa fixa, nunca um rethrow', async () => {
    const c = cenario({
      updateStock: [apiError('error_holiday_mode_change_stock', 'holiday')],
      ferias: apiError('error_server', 'holiday read exploded'),
    });
    expect((await correr(c)).pausadoAte).toBe(AGORA_MS + pausaFeriasH());
  });

  it('55 — ⚠️ PAR: pausaFeriasH()/pausaLojaH() JÁ SÃO milissegundos, nunca horas', async () => {
    // Multiplicar de novo faria uma pausa de seis horas virar anos; usar a hora
    // crua faria dela seis milésimos de segundo. As duas são silenciosas.
    const ferias = cenario({
      updateStock: [apiError('error_holiday_mode_change_stock', 'holiday')],
      ferias: { holiday_mode_on: true, holiday_mode_end_time: null },
    });
    const rf = await correr(ferias);
    expect((rf.pausadoAte ?? 0) - AGORA_MS).toBe(6 * 60 * 60 * 1000);

    const loja = cenario({
      updateStock: [apiError('error_seller_under_penalty', 'penalty')],
    });
    const rl = await correr(loja);
    expect((rl.pausadoAte ?? 0) - AGORA_MS).toBe(24 * 60 * 60 * 1000);
    expect(pausaLojaH()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('o log e a disciplina de origem', () => {
  it('56 — UMA linha por tarefa, com `ageMs`, sem corpo e sem token', async () => {
    const c = cenario({ updateStock: [envelope({ sucesso: [MODELO_A, MODELO_B] })] });
    await correr(c);

    const infos = logs.filter((l) => l[0] === 'info');
    expect(infos).toHaveLength(1);
    const linha = infos[0]?.[2] as Record<string, unknown>;
    expect(linha.ageMs).toBe(5_000);
    expect(linha.outcome).toBe(OUTCOME_ENVIO_ESTOQUE.enviado);
    expect(Object.hasOwn(linha, 'stock_list')).toBe(false);
    expect(JSON.stringify(infos)).not.toContain('seller_stock');
  });

  it('57 — a fonte não lê relógio, não abre transação e não toca a coleção crua', () => {
    // As mesmas proibições que os greps da pasta cobrem, ditas aqui para que a
    // suíte falhe antes do gate. Os nomes são MONTADOS em tempo de execução —
    // escrevê-los inteiros faria desta verificação a primeira violação.
    const relogio = ['Date', '.now('].join('');
    const transacao = ['run', 'Transaction'].join('');
    const colecao = ['.collec', 'tion('].join('');
    const semComentarios = FONTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(semComentarios).not.toContain(relogio);
    expect(semComentarios).not.toContain(transacao);
    expect(FONTE).not.toContain(colecao);
    expect(FONTE).not.toContain(['SHOPEE', 'UNLIST', 'MAX', 'ITEMS'].join('_'));
  });

  it('58 — a virada da cota é IMPORTADA, nunca re-derivada aqui', () => {
    // M-67. Uma cópia local da aritmética de UTC+8 é exatamente a segunda
    // implementação que deriva para o plausível.
    expect(FONTE).toContain("from '../anuncios/pausarAnuncio'");
    expect(FONTE).not.toContain('DESLOCAMENTO_UTC8_MS');
  });

  it('59 — `scheduleDelaySeconds` é sempre um NÚMERO quando presente, nunca `undefined`', async () => {
    // M-65. "Sem atraso" e "um atraso de undefined" não são o mesmo pedido ao
    // Cloud Tasks; este módulo só enfileira COM atraso, e a chave tem de estar
    // presente e numérica em toda chamada que ele faz.
    const c = cenario({ updateStock: [burst(15)] });
    await correr(c);

    expect(c.scheduler.chamadas).toHaveLength(1);
    const opts = c.scheduler.chamadas[0]?.opts;
    expect(opts && Object.hasOwn(opts, 'scheduleDelaySeconds')).toBe(true);
    expect(typeof opts?.scheduleDelaySeconds).toBe('number');
  });
});
