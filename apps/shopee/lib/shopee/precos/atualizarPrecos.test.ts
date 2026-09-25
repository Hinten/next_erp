/**
 * O job de preço da conta inteira (`atualizarPrecos.ts`, #1521, passo 13, PR 2).
 *
 * Tudo roda sobre o `FakeDb` compartilhado, estendido AQUI (e só aqui) com as
 * duas coisas que o job usa e o dublê não modela:
 *
 *  - `db.batch()` — o checkpoint por item é UM lote (reconcile C-p). Cada
 *    `commit()` fica registrado inteiro em `lotes`, e `commitsQueFalham` injeta
 *    uma falha num commit específico ANTES de qualquer escrita aplicar — é o que
 *    prova que a linha do relatório e o consumo da `fila` caem juntos ou não caem;
 *  - `{ merge: true }` com mescla PROFUNDA de mapas, no lote e no `tx.set` da
 *    transação — o Firestore real funde o mapa `linhas` de um shard, e o `set`
 *    do dublê substituiria o shard inteiro (o que faria a linha sintética de um
 *    cancelamento apagar as linhas dos itens já enviados).
 *
 * O remetente, a leitura de página, a leitura de preços e o veredito da conta
 * são INJETADOS (as costuras de `DepsDespachoPreco`): a propriedade sob teste é
 * o que o job faz com as respostas deles, e a loja Shopee de mentira abaixo
 * (`LojaFake`) guarda o preço que "já pousou" — é ela que transforma o replay de
 * um envio que pousou em `pulado preco-igual`, como o remetente real faz (S4).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import {
  envioPrecoShopeeCollection,
  estoqueShopeeSyncCollection,
  relatorioEnvioPrecoShopeeCollection,
} from '@delfrance/data/admin/collections';
import type { OccReadable, OccTransaction } from '@delfrance/data/testing';
import {
  ENVIO_PRECO_FASE,
  ENVIO_PRECO_SHOPEE_STATUS,
  RETENCAO_ENVIO_PRECO_SHOPEE_DIAS,
  envioPrecoShopeeSchema,
  type EnvioPrecoShopee,
  type EnvioPrecoShopeeFilaItem,
  type LinhaRelatorioEnvioPreco,
} from '@delfrance/schemas';

import { erroContidoPorConta } from '../core/containment';
import { ShopeeContaNotConfiguredError, type ShopeeContext } from '../core/shopee';
import { ShopeeTasksDisabledError } from '../shopeeTasks';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  MARGEM_RELATORIO_ENVIO_PRECO_SHOPEE_DIAS,
  cancelarEnvioPrecoShopee,
  ehJobOrfao,
  envioPrecoShopeeTaskSchema,
  expiraEmDoEnvioShopee,
  expiraEmDoRelatorioShopee,
  finalizarEnvioPrecoShopee,
  iniciarEnvioPrecoShopee,
  processarEnvioPrecoShopee,
  type AgendadorPrecoShopee,
  type DepsDespachoPreco,
  type DespachoEnvioPreco,
  type OpcoesDeEnfileiramentoPreco,
} from './atualizarPrecos';
import {
  AMOSTRA_FALHAS_CAP,
  AMOSTRA_PULOS_CAP,
  ENVIO_PRECO_MANUAL_MAX_TENTATIVAS,
  ENVIO_PRECO_MAX_PARQUES,
  ENVIO_PRECO_MAX_PAUSAS,
  ENVIO_PRECO_MAX_TENTATIVAS,
  ENVIO_PRECO_ORFAO_MS,
  PARQUE_JITTER_MAX_S,
  SHOPEE_PRICE_SYNC_QUEUE,
  itensPorDespachoPreco,
  pageLimitPreco,
} from './constantesPreco';
import type { enviarPrecoDoItem, LinhaModeloPreco, ResultadoEnvioPreco } from './enviarPreco';
import {
  MENSAGEM_POR_MOTIVO_PRECO,
  MOTIVOS_QUE_CARIMBAM,
  MOTIVO_PRECO_SHOPEE,
  ShopeeEnvioPrecoEmAndamentoError,
  ShopeePriceSyncTasksDisabledError,
} from './errosPreco';
import { produtosQuePrecificam, type FamiliaDePreco, type ItemDePreco } from './planoPreco';
import type { ContextoContaPreco, VereditoContaPreco } from './regiaoPreco';
import type { VarLinkShopeeCru } from '../core/vinculosShopee';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

/** O remetente, como costura. */
type Enviar = typeof enviarPrecoDoItem;
/** Uma costura opcional de `DepsDespachoPreco`, já sem o `undefined`. */
type Costura<K extends keyof DepsDespachoPreco> = NonNullable<DepsDespachoPreco[K]>;

const INT = 'int-1';
const JOB = 'job-1';
const T0 = 1_760_000_000_000;
const MINUTO_MS = 60 * 1_000;
const HORA_MS = 60 * MINUTO_MS;
const DIA_MS = 24 * HORA_MS;
const TABELA = 'tab-normal';
const ITEM = 2500139861;
const MODELO_A = 2000458802;
const MODELO_B = 2000458803;
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';

const CAMINHO_DO_JOB = envioPrecoShopeeCollection.docPath({}, JOB);
const shard = (indice: string): string =>
  relatorioEnvioPrecoShopeeCollection.docPath({ envioId: JOB }, indice);
const CAMINHO_DO_ESTADO = estoqueShopeeSyncCollection.docPath({}, INT);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Um mapa simples — a mescla profunda do Firestore só atravessa estes. */
function ehObjetoSimples(v: unknown): v is DocData {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/** `{ merge: true }` do Firestore: mapas se fundem em profundidade, o resto substitui. */
function fundir(base: DocData | undefined, patch: DocData): DocData {
  const saida: DocData = { ...(base ?? {}) };
  for (const [chave, valor] of Object.entries(patch)) {
    const atual = saida[chave];
    saida[chave] = ehObjetoSimples(valor) && ehObjetoSimples(atual) ? fundir(atual, valor) : valor;
  }
  return saida;
}

/** O `FakeDb` com `batch()` e a mescla profunda — veja o cabeçalho. */
class FakeDbDeJob extends FakeDb {
  /** Cada commit de lote que APLICOU, com as suas escritas em ordem. */
  readonly lotes: { path: string; data: DocData }[][] = [];
  /** Commits (contados a partir de 1) que lançam em vez de aplicar. */
  readonly commitsQueFalham = new Map<number, Error>();
  private commits = 0;

  batch() {
    const escritas: { path: string; data: DocData; merge: boolean }[] = [];
    const lote = {
      set: (ref: { path: string }, data: DocData, opts?: { merge?: boolean }) => {
        escritas.push({ path: ref.path, data, merge: opts?.merge === true });
        return lote;
      },
      commit: () => {
        this.commits += 1;
        const falha = this.commitsQueFalham.get(this.commits);
        if (falha !== undefined) return Promise.reject(falha);
        this.lotes.push(escritas.map((e) => ({ path: e.path, data: e.data })));
        for (const e of escritas) {
          this.seed(e.path, e.merge ? fundir(this.store[e.path]?.data, e.data) : e.data);
          this.writes.push({ path: e.path, patch: e.data });
        }
        return Promise.resolve();
      },
    };
    return lote;
  }

  override runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return super.runTransaction((tx) =>
      fn({
        ...tx,
        set: (ref, data, opts?: { merge?: boolean }) =>
          tx.set(ref, opts?.merge === true ? fundir(this.store[ref.path]?.data, data) : data),
      }),
    );
  }
}

/** A loja Shopee de mentira: o preço que JÁ pousou, por (anúncio, modelo). */
interface LojaFake {
  readonly precos: Map<string, number>;
  readonly escritas: { itemId: number; modelId: number; preco: number }[];
}

const chaveDaLoja = (itemId: number, modelId: number): string =>
  `${String(itemId)}:${String(modelId)}`;

/**
 * O remetente de mentira: envia o que difere, pula o que já está igual (S4),
 * uma linha por alvo e na mesma ordem (S1).
 */
function remetente(loja: LojaFake): Mock<Enviar> {
  return vi.fn<Enviar>(async (item: ItemDePreco): Promise<ResultadoEnvioPreco> => {
    await Promise.resolve();
    const modelos: LinhaModeloPreco[] = item.alvos.map((alvo) => {
      const chave = chaveDaLoja(item.itemId, alvo.modelId);
      const anterior = loja.precos.get(chave) ?? null;
      const base = {
        modelId: alvo.modelId,
        produtoId: alvo.produtoId,
        varLinkDocId: alvo.varLinkDocId,
        precoAlvo: alvo.precoAlvo,
        precoAnterior: anterior,
        codigo: null,
      };
      if (alvo.precoAlvo === null) {
        return { ...base, resultado: 'pulado', motivo: MOTIVO_PRECO_SHOPEE.precoNaoEncontrado };
      }
      if (anterior === alvo.precoAlvo) {
        return { ...base, resultado: 'pulado', motivo: MOTIVO_PRECO_SHOPEE.precoIgual };
      }
      loja.precos.set(chave, alvo.precoAlvo);
      loja.escritas.push({ itemId: item.itemId, modelId: alvo.modelId, preco: alvo.precoAlvo });
      return { ...base, resultado: 'enviado', motivo: null };
    });
    const primeiraPulada = modelos.find((l) => l.resultado === 'pulado');
    if (modelos.some((l) => l.resultado === 'enviado') || primeiraPulada === undefined) {
      return { tipo: 'enviado', modelos, chamadasShopee: 1 };
    }
    return {
      tipo: 'pulado',
      motivo: primeiraPulada.motivo ?? MOTIVO_PRECO_SHOPEE.precoIgual,
      modelos,
      chamadasShopee: 1,
    };
  });
}

/** Um resultado fixo, qualquer que seja o item — para os ramos sem linhas. */
function responde(r: ResultadoEnvioPreco): Mock<Enviar> {
  return vi.fn<Enviar>(async (): Promise<ResultadoEnvioPreco> => {
    await Promise.resolve();
    return r;
  });
}

/** O `precos` de um produto numa tabela. */
function precos(valor: number): unknown {
  return { [TABELA]: { valor } };
}

function link(itemId: number, linkDocId: string, extra: DocData = {}): DocData {
  return { contaProdutoShopeeOuterRef: `integracoes/${INT}`, item_id: itemId, linkDocId, ...extra };
}

/** Uma família de anúncio SEM modelos; o `precos` da família é o do PLANO (e o job o ignora). */
function familiaSemModelo(anchorId: string, itemId: number, precoDoPlano = 15): FamiliaDePreco {
  return {
    anchorId,
    precos: precos(precoDoPlano),
    links: [link(itemId, `link-${anchorId}`)],
    children: [],
  };
}

function varLink(anchorId: string, modelId: number, varLinkDocId: string): VarLinkShopeeCru {
  return {
    contaVariacaoShopeeOuterRef: `integracoes/${INT}`,
    produtoShopeeOuterRef: `produtos/${anchorId}/prodshopee/link-${anchorId}`,
    model_id: modelId,
    varLinkDocId,
  };
}

/** Uma família COM dois modelos, cada um preçado pelo SEU filho. */
function familiaComModelos(anchorId: string, itemId: number): FamiliaDePreco {
  return {
    anchorId,
    precos: precos(99),
    links: [link(itemId, `link-${anchorId}`)],
    children: [
      { produtoId: FILHO_A, precos: precos(12), varLinks: [varLink(anchorId, MODELO_A, 'var-a')] },
      { produtoId: FILHO_B, precos: precos(22), varLinks: [varLink(anchorId, MODELO_B, 'var-b')] },
    ],
  };
}

/** Uma família que o PLANO pula: `kit-derivado` (kit nativo da Shopee). */
function familiaKit(anchorId: string, itemId: number): FamiliaDePreco {
  return {
    anchorId,
    precos: precos(10),
    links: [link(itemId, `link-${anchorId}`, { kitNativo: true })],
    children: [],
  };
}

/** Uma família sem anúncio NESTA conta: `sem-link`. */
function familiaDeOutraConta(anchorId: string): FamiliaDePreco {
  return {
    anchorId,
    precos: precos(10),
    links: [{ contaProdutoShopeeOuterRef: 'integracoes/int-2', item_id: ITEM, linkDocId: 'l-x' }],
    children: [],
  };
}

/** Um item da fila, SEM modelos. */
function itemSemModelo(anchorId: string, itemId: number): EnvioPrecoShopeeFilaItem {
  return { produtoId: anchorId, linkDocId: `link-${anchorId}`, itemId, modelos: [] };
}

/** Um item da fila COM os dois modelos de `familiaComModelos`. */
function itemComModelos(anchorId: string, itemId: number): EnvioPrecoShopeeFilaItem {
  return {
    produtoId: anchorId,
    linkDocId: `link-${anchorId}`,
    itemId,
    modelos: [
      { modelId: MODELO_A, produtoId: FILHO_A, varLinkDocId: 'var-a' },
      { modelId: MODELO_B, produtoId: FILHO_B, varLinkDocId: 'var-b' },
    ],
  };
}

const CONTEXTO_DA_CONTA = {
  integracaoId: INT,
  client: {} as ShopeeClient,
  regiao: 'BR',
  moeda: 'BRL',
  multiplo: 4,
  tabelaNormalId: TABELA,
} as ContextoContaPreco;

/** O mundo de um teste: o banco, a loja, a página, os preços e todas as costuras. */
interface Mundo {
  readonly db: FakeDbDeJob;
  readonly loja: LojaFake;
  /** Todas as famílias da conta, que a leitura de página serve em ordem de id. */
  familias: FamiliaDePreco[];
  /** O `precos` de cada produto NO BANCO — a leitura de DRENO lê daqui. */
  readonly banco: Map<string, unknown>;
  readonly enfileirados: {
    payload: unknown;
    opts: OpcoesDeEnfileiramentoPreco | undefined;
  }[];
  readonly scheduler: { readonly enqueue: Mock<AgendadorPrecoShopee['enqueue']> };
  readonly resolverContexto: Mock<Costura<'resolverContexto'>>;
  readonly avaliarConta: Mock<Costura<'avaliarConta'>>;
  readonly lerPagina: Mock<Costura<'lerPagina'>>;
  readonly lerPrecos: Mock<Costura<'lerPrecos'>>;
  readonly criarLeitorDeBase: Mock<Costura<'criarLeitorDeBase'>>;
  enviar: Mock<Enviar>;
}

function mundo(): Mundo {
  const db = new FakeDbDeJob();
  const loja: LojaFake = { precos: new Map(), escritas: [] };
  const m: Mundo = {
    db,
    loja,
    familias: [],
    banco: new Map(),
    enfileirados: [],
    scheduler: { enqueue: vi.fn<AgendadorPrecoShopee['enqueue']>() },
    resolverContexto: vi.fn<Costura<'resolverContexto'>>(),
    avaliarConta: vi.fn<Costura<'avaliarConta'>>(),
    lerPagina: vi.fn<Costura<'lerPagina'>>(),
    lerPrecos: vi.fn<Costura<'lerPrecos'>>(),
    criarLeitorDeBase: vi.fn<Costura<'criarLeitorDeBase'>>(),
    enviar: remetente(loja),
  };
  m.scheduler.enqueue.mockImplementation(
    async (payload: unknown, opts?: OpcoesDeEnfileiramentoPreco) => {
      await Promise.resolve();
      m.enfileirados.push({ payload, opts });
    },
  );
  m.resolverContexto.mockImplementation(async () => {
    await Promise.resolve();
    return {
      integracaoId: INT,
      conta: { shop_id: 987654, tabelaNormalOuterRef: `tabelaPreco/${TABELA}` },
    } as unknown as ShopeeContext;
  });
  m.avaliarConta.mockImplementation(async (): Promise<VereditoContaPreco> => {
    await Promise.resolve();
    return { ok: true, contexto: CONTEXTO_DA_CONTA };
  });
  m.lerPagina.mockImplementation(
    async (
      _db: unknown,
      args: { afterAnchorId: string | null; pageLimit: number },
    ): Promise<{ familias: FamiliaDePreco[]; nextAfterAnchorId: string | null }> => {
      await Promise.resolve();
      const ordenadas = [...m.familias].sort((a, b) => (a.anchorId < b.anchorId ? -1 : 1));
      const cursor = args.afterAnchorId;
      const resto = cursor === null ? ordenadas : ordenadas.filter((f) => f.anchorId > cursor);
      const pagina = resto.slice(0, args.pageLimit);
      const ultima = pagina[pagina.length - 1];
      return {
        familias: pagina,
        nextAfterAnchorId:
          pagina.length === args.pageLimit && ultima !== undefined ? ultima.anchorId : null,
      };
    },
  );
  m.lerPrecos.mockImplementation(async (_db: unknown, ids: readonly string[]) => {
    await Promise.resolve();
    const saida = new Map<string, unknown>();
    for (const id of ids) if (m.banco.has(id)) saida.set(id, m.banco.get(id));
    return saida;
  });
  m.criarLeitorDeBase.mockImplementation(() => async () => Promise.resolve(null));
  return m;
}

function deps(m: Mundo, nowMs = T0, over: Partial<DepsDespachoPreco> = {}): DepsDespachoPreco {
  return {
    db: asDb(m.db),
    scheduler: m.scheduler,
    nowMs,
    resolverContexto: m.resolverContexto,
    avaliarConta: m.avaliarConta,
    lerPagina: m.lerPagina,
    lerPrecos: m.lerPrecos,
    criarLeitorDeBase: m.criarLeitorDeBase,
    enviar: m.enviar,
    ...over,
  };
}

function rodar(
  m: Mundo,
  retryCount = 0,
  nowMs = T0,
  over: Partial<DepsDespachoPreco> = {},
): Promise<DespachoEnvioPreco> {
  return processarEnvioPrecoShopee(
    deps(m, nowMs, over),
    { jobId: JOB, integracaoId: INT },
    retryCount,
  );
}

/** Semeia um job `running` já parseado (todos os defaults aplicados). */
function semearJob(m: Mundo, over: Partial<EnvioPrecoShopee> & DocData = {}): void {
  m.db.seed(
    CAMINHO_DO_JOB,
    envioPrecoShopeeSchema.parse({
      integracaoId: INT,
      status: 'running',
      startedAt: T0,
      updatedAt: T0,
      expiraEm: expiraEmDoEnvioShopee(T0),
      ...over,
    }) as DocData,
  );
}

function jobNoBanco(m: Mundo, caminho = CAMINHO_DO_JOB): EnvioPrecoShopee {
  const dados = m.db.store[caminho]?.data;
  expect(dados, `o job ${caminho} existe`).toBeDefined();
  return envioPrecoShopeeSchema.parse(dados);
}

function linhasDoShard(m: Mundo, indice = '0000'): Record<string, LinhaRelatorioEnvioPreco> {
  return (m.db.store[shard(indice)]?.data['linhas'] ?? {}) as Record<
    string,
    LinhaRelatorioEnvioPreco
  >;
}

/** As linhas de um shard, em ordem de chave, como `[motivo, resultado]`. */
function motivosDoShard(m: Mundo, indice = '0000'): [string | null, string][] {
  return Object.entries(linhasDoShard(m, indice))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, l]) => [l.motivo, l.resultado]);
}

/** Os preços-alvo que o remetente RECEBEU, por chamada. */
function alvosRecebidos(m: Mundo): (number | null)[][] {
  return m.enviar.mock.calls.map((c) => (c[0] as ItemDePreco).alvos.map((a) => a.precoAlvo));
}

/* -------------------------------------------------------------------------- */
/*                          as constantes e os erros                           */
/* -------------------------------------------------------------------------- */

describe('as constantes do job (PR 2)', () => {
  it('PAR: a fila, o teto de tentativas, os tetos de pausa/parque, o órfão de 6 h e as amostras', () => {
    expect(SHOPEE_PRICE_SYNC_QUEUE).toBe('processShopeePriceSync');
    expect(ENVIO_PRECO_MAX_TENTATIVAS).toBe(3);
    expect(ENVIO_PRECO_MAX_PAUSAS).toBe(50);
    expect(ENVIO_PRECO_MAX_PARQUES).toBe(3);
    expect(ENVIO_PRECO_ORFAO_MS).toBe(6 * HORA_MS);
    expect(AMOSTRA_PULOS_CAP).toBe(200);
    expect(AMOSTRA_FALHAS_CAP).toBe(100);
    expect(PARQUE_JITTER_MAX_S).toBe(30);
  });

  it('⛔ a escada manual NUNCA é mais longa que a da fila (o pino do passo 12, copiado)', () => {
    expect(ENVIO_PRECO_MANUAL_MAX_TENTATIVAS).toBeLessThanOrEqual(ENVIO_PRECO_MAX_TENTATIVAS);
  });

  it('⛔ o órfão é escrito como produto de unidades nomeadas, nunca um literal de milissegundos', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./constantesPreco.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte).toContain('export const ENVIO_PRECO_ORFAO_MS = 6 * MS_POR_HORA;');
    expect(fonte).toContain("envInt('SHOPEE_PRICE_PAGE_LIMIT', 25)");
    expect(fonte).toContain("envInt('SHOPEE_PRICE_ITEMS_PER_DISPATCH', 10)");
  });

  it('pageLimitPreco — PAR: 25 por padrão, um valor válido é lido; QUASE-IGUAL: 0 vira 1 e 99 vira 50', () => {
    expect(pageLimitPreco()).toBe(25);
    vi.stubEnv('SHOPEE_PRICE_PAGE_LIMIT', '7');
    expect(pageLimitPreco()).toBe(7);
    for (const [bruto, esperado] of [
      ['0', 1],
      ['1', 1],
      ['50', 50],
      ['51', 50],
      ['99', 50],
      ['abc', 25],
    ] as const) {
      vi.stubEnv('SHOPEE_PRICE_PAGE_LIMIT', bruto);
      expect(pageLimitPreco(), bruto).toBe(esperado);
    }
  });

  it('pageLimitPreco — ⛔ o botão da página do ESTOQUE não mexe na página do preço', () => {
    vi.stubEnv('SHOPEE_STOCK_ANCHOR_PAGE_LIMIT', '3');
    expect(pageLimitPreco()).toBe(25);
  });

  it('itensPorDespachoPreco — PAR: 10 por padrão; QUASE-IGUAL: 0 vira 1 e 11 vira 10 (o teto)', () => {
    expect(itensPorDespachoPreco()).toBe(10);
    for (const [bruto, esperado] of [
      ['0', 1],
      ['3', 3],
      ['10', 10],
      ['11', 10],
      ['25', 10],
    ] as const) {
      vi.stubEnv('SHOPEE_PRICE_ITEMS_PER_DISPATCH', bruto);
      expect(itensPorDespachoPreco(), bruto).toBe(esperado);
    }
  });

  it('itensPorDespachoPreco — o TETO × 20 s cabe em 70 % do timeout de 300 s da fila (nenhum valor aceito estoura)', () => {
    // O pior caso por item é ≈ 20 s (a docblock soma as partes). O teto é o
    // maior valor que o botão aceita, então medir o teto cobre todos.
    vi.stubEnv('SHOPEE_PRICE_ITEMS_PER_DISPATCH', '9999');
    expect(itensPorDespachoPreco() * 20).toBeLessThanOrEqual(0.7 * 300);
  });
});

describe('os dois erros e os dois motivos do job', () => {
  it('PAR: `job-interrompido` e `job-cancelado` rendem a SUA frase e não carimbam vínculo nenhum', () => {
    expect(MENSAGEM_POR_MOTIVO_PRECO['job-interrompido']).toBe(
      'A atualização foi interrompida antes deste ponto; os itens restantes não foram tentados.',
    );
    expect(MENSAGEM_POR_MOTIVO_PRECO['job-cancelado']).toBe(
      'A atualização foi cancelada; os itens restantes não foram tentados.',
    );
    expect(MOTIVOS_QUE_CARIMBAM.has('job-interrompido')).toBe(false);
    expect(MOTIVOS_QUE_CARIMBAM.has('job-cancelado')).toBe(false);
  });

  it('o 409 do "já em andamento" é um ShopeeError com código e status próprios', () => {
    const err = new ShopeeEnvioPrecoEmAndamentoError('x');
    expect(err).toBeInstanceOf(ShopeeError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('SHOPEE_PRICE_SYNC_RUNNING');
    expect(err.name).toBe('ShopeeEnvioPrecoEmAndamentoError');
  });

  it('PAR / QUASE-IGUAL: a válvula do PREÇO não é contida por conta; a da fila de pushes É', () => {
    const doPreco = new ShopeePriceSyncTasksDisabledError();
    expect(doPreco.status).toBe(503);
    expect(doPreco.code).toBe('SHOPEE_PRICE_SYNC_ENQUEUE_FAILED');
    expect(doPreco).not.toBeInstanceOf(ShopeeError);
    expect(erroContidoPorConta(doPreco)).toBe(false);
    // O quase-igual: a classe do pipeline de push É contida — usá-la aqui faria
    // um job virar um `lastError` de conta em vez de ser carimbado `failed`.
    expect(erroContidoPorConta(new ShopeeTasksDisabledError())).toBe(true);
  });

  it('o corpo da tarefa é `{ jobId, integracaoId }` ESTRITO — QUASE-IGUAL: uma chave a mais é recusada', () => {
    expect(envioPrecoShopeeTaskSchema.safeParse({ jobId: JOB, integracaoId: INT }).success).toBe(
      true,
    );
    expect(
      envioPrecoShopeeTaskSchema.safeParse({ jobId: JOB, integracaoId: INT, extra: 1 }).success,
    ).toBe(false);
    expect(envioPrecoShopeeTaskSchema.safeParse({ jobId: '', integracaoId: INT }).success).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                    o TTL                                    */
/* -------------------------------------------------------------------------- */

describe('o TTL do job (reconcile C-y)', () => {
  it('PAR (M-T1): o job vence 180 dias depois de `startedAt` e o shard 7 dias depois dele — ambos `Date`', () => {
    const doJob = expiraEmDoEnvioShopee(T0);
    const doShard = expiraEmDoRelatorioShopee(T0);
    expect(doJob).toBeInstanceOf(Date);
    expect(doShard).toBeInstanceOf(Date);
    expect(RETENCAO_ENVIO_PRECO_SHOPEE_DIAS).toBe(180);
    expect(MARGEM_RELATORIO_ENVIO_PRECO_SHOPEE_DIAS).toBe(7);
    expect(doJob.getTime()).toBe(T0 + 180 * DIA_MS);
    expect(doShard.getTime() - doJob.getTime()).toBe(7 * DIA_MS);
  });

  it('QUASE-IGUAL (M-T2): o MESMO instante como época numérica é RECUSADO pelo campo — um TTL ignora número', () => {
    const campo = envioPrecoShopeeSchema.shape.expiraEm;
    expect(campo.safeParse(expiraEmDoEnvioShopee(T0)).success).toBe(true);
    expect(campo.safeParse(expiraEmDoEnvioShopee(T0).getTime()).success).toBe(false);
  });

  it('M-T1: o job CRIADO carrega um `Date` exatamente 180 dias depois do seu `startedAt`', async () => {
    const m = mundo();
    const jobId = await iniciarEnvioPrecoShopee(asDb(m.db), {
      contexto: CONTEXTO_DA_CONTA,
      baixarPreco: false,
      startedBy: 'uid-1',
      nowMs: T0,
    });
    const criado = m.db.store[envioPrecoShopeeCollection.docPath({}, jobId)]?.data;
    expect(criado?.['expiraEm']).toBeInstanceOf(Date);
    expect((criado?.['expiraEm'] as Date).getTime()).toBe(
      (criado?.['startedAt'] as number) + 180 * DIA_MS,
    );
  });

  it('M-T3: o shard é carimbado a partir de `startedAt`, NÃO de `nowMs` — um replay um dia depois vê o MESMO instante', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)] });
    vi.stubEnv('SHOPEE_PRICE_ITEMS_PER_DISPATCH', '1');
    m.banco.set('a1', precos(20));
    m.banco.set('a2', precos(30));
    await rodar(m, 0, T0 + HORA_MS);
    const primeiro = m.db.store[shard('0000')]?.data['expiraEm'] as Date;
    await rodar(m, 0, T0 + DIA_MS);
    const segundo = m.db.store[shard('0000')]?.data['expiraEm'] as Date;
    expect(primeiro).toBeInstanceOf(Date);
    expect(primeiro.getTime()).toBe(expiraEmDoRelatorioShopee(T0).getTime());
    expect(segundo.getTime()).toBe(primeiro.getTime());
    // O quase-igual: a chave errada daria um instante que se move com o relógio.
    expect(segundo.getTime()).not.toBe(expiraEmDoRelatorioShopee(T0 + DIA_MS).getTime());
  });
});

/* -------------------------------------------------------------------------- */
/*                                   o início                                  */
/* -------------------------------------------------------------------------- */

describe('iniciarEnvioPrecoShopee', () => {
  const iniciar = (m: Mundo, nowMs = T0, contexto = CONTEXTO_DA_CONTA) =>
    iniciarEnvioPrecoShopee(asDb(m.db), { contexto, baixarPreco: true, startedBy: 'uid-1', nowMs });

  it('cria UM job `running` com todos os padrões, a conta DO CONTEXTO e o instante dado — e não enfileira', async () => {
    const m = mundo();
    const jobId = await iniciar(m);
    const job = jobNoBanco(m, envioPrecoShopeeCollection.docPath({}, jobId));
    expect(job).toMatchObject({
      integracaoId: INT,
      status: 'running',
      baixarPreco: true,
      startedBy: 'uid-1',
      startedAt: T0,
      updatedAt: T0,
      afterAnchorId: null,
      planejamentoConcluido: false,
      fila: [],
      relatorioLinhas: 0,
      retomarEm: null,
    });
    expect(m.db.idsEm('enviosPrecoShopee')).toEqual([jobId]);
    expect(m.scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('M27: com a válvula FECHADA lança ANTES de qualquer leitura ou escrita — zero documentos', async () => {
    const m = mundo();
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
    await expect(iniciar(m)).rejects.toBeInstanceOf(ShopeePriceSyncTasksDisabledError);
    expect(m.db.idsEm('enviosPrecoShopee')).toEqual([]);
    expect(m.db.consultasCompletas).toEqual([]);
    expect(m.db.writes).toEqual([]);
  });

  it('um job VIVO da conta ⇒ 409, nenhum documento novo — e a consulta é (integracaoId, status) com limite 1', async () => {
    const m = mundo();
    semearJob(m, { updatedAt: T0 - HORA_MS });
    await expect(iniciar(m)).rejects.toBeInstanceOf(ShopeeEnvioPrecoEmAndamentoError);
    expect(m.db.idsEm('enviosPrecoShopee')).toEqual([JOB]);
    expect(m.db.consultasCompletas).toEqual([
      {
        fonte: 'enviosPrecoShopee',
        clausulas: [
          ['integracaoId', '==', INT],
          ['status', '==', 'running'],
        ],
        ordens: [],
        limite: 1,
        apos: null,
      },
    ]);
  });

  it('QUASE-IGUAL: um job vivo de OUTRA conta não bloqueia esta', async () => {
    const m = mundo();
    semearJob(m, { integracaoId: 'int-2' });
    const jobId = await iniciar(m);
    expect(jobId).not.toBe(JOB);
    expect(jobNoBanco(m).status).toBe('running');
  });

  it('M29: um ÓRFÃO (7 h parado, sem parque) é carimbado `failed` com UMA linha `job-interrompido` — e o novo nasce', async () => {
    const m = mundo();
    semearJob(m, {
      updatedAt: T0 - 7 * HORA_MS,
      fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)],
    });
    const jobId = await iniciar(m);
    expect(jobId).not.toBe(JOB);
    const velho = jobNoBanco(m);
    expect(velho).toMatchObject({
      status: 'failed',
      erro: 'job órfão — superado por um novo envio',
      filaRestante: 2,
      relatorioLinhas: 1,
      relatorioShards: 1,
      relatorioCompleto: false,
      finishedAt: T0,
    });
    expect(motivosDoShard(m)).toEqual([['job-interrompido', 'nao-tentado']]);
    expect(jobNoBanco(m, envioPrecoShopeeCollection.docPath({}, jobId)).status).toBe('running');
  });

  it('M28: 7 h parado mas ESTACIONADO com `retomarEm` à frente ⇒ 409, não é reclamado', async () => {
    const m = mundo();
    semearJob(m, { updatedAt: T0 - 7 * HORA_MS, retomarEm: T0 + 5 * HORA_MS });
    await expect(iniciar(m)).rejects.toBeInstanceOf(ShopeeEnvioPrecoEmAndamentoError);
    expect(jobNoBanco(m).status).toBe('running');
  });

  it('QUASE-IGUAL de M28: o parque cuja retomada passou há 2 h É reclamado', async () => {
    const m = mundo();
    semearJob(m, { updatedAt: T0 - 7 * HORA_MS, retomarEm: T0 - 2 * HORA_MS });
    await iniciar(m);
    expect(jobNoBanco(m).status).toBe('failed');
  });

  it('⚠️ C-q: a CORRIDA do início é ACEITA — dois inícios intercalados ⇒ DOIS jobs `running` (fechar isto é uma edição deliberada)', async () => {
    const m = mundo();
    const [a, b] = await Promise.all([iniciar(m), iniciar(m)]);
    expect(a).not.toBe(b);
    const vivos = m.db
      .idsEm('enviosPrecoShopee')
      .map((id) => jobNoBanco(m, envioPrecoShopeeCollection.docPath({}, id)))
      .filter((j) => j.status === ENVIO_PRECO_SHOPEE_STATUS.running && j.integracaoId === INT);
    expect(vivos).toHaveLength(2);
  });
});

describe('ehJobOrfao — o predicado da reclamação', () => {
  it('PAR: 6 h + 1 ms parado e sem parque é órfão; QUASE-IGUAL: exatamente 6 h não é', () => {
    expect(ehJobOrfao({ updatedAt: T0 - ENVIO_PRECO_ORFAO_MS - 1, retomarEm: null }, T0)).toBe(
      true,
    );
    expect(ehJobOrfao({ updatedAt: T0 - ENVIO_PRECO_ORFAO_MS, retomarEm: null }, T0)).toBe(false);
  });

  it('PAR: um `updatedAt` ausente ou lixo não prova vida (órfão); QUASE-IGUAL: um recente prova', () => {
    expect(ehJobOrfao({ updatedAt: undefined, retomarEm: null }, T0)).toBe(true);
    expect(ehJobOrfao({ updatedAt: '123', retomarEm: null }, T0)).toBe(true);
    expect(ehJobOrfao({ updatedAt: T0 - MINUTO_MS, retomarEm: null }, T0)).toBe(false);
  });

  it('PAR: retomada há 1 h + 1 ms libera; QUASE-IGUAL: retomada há exatamente 1 h (ou no futuro) ainda protege', () => {
    const parado = T0 - 7 * HORA_MS;
    expect(ehJobOrfao({ updatedAt: parado, retomarEm: T0 - HORA_MS - 1 }, T0)).toBe(true);
    expect(ehJobOrfao({ updatedAt: parado, retomarEm: T0 - HORA_MS }, T0)).toBe(false);
    expect(ehJobOrfao({ updatedAt: parado, retomarEm: T0 + HORA_MS }, T0)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                          a finalização e o cancelamento                     */
/* -------------------------------------------------------------------------- */

describe('finalizarEnvioPrecoShopee / cancelarEnvioPrecoShopee', () => {
  const cancelar = (m: Mundo, integracaoId = INT, nowMs = T0 + MINUTO_MS) =>
    cancelarEnvioPrecoShopee(asDb(m.db), { jobId: JOB, integracaoId, nowMs });

  it('o cancelamento grava `cancelled`, `filaRestante` do SNAPSHOT e UMA linha `job-cancelado` com o TTL do run', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)] });
    expect(await cancelar(m)).toBe('stamped');
    expect(jobNoBanco(m)).toMatchObject({
      status: 'cancelled',
      erro: null,
      filaRestante: 2,
      relatorioLinhas: 1,
      relatorioShards: 1,
      relatorioCompleto: false,
      finishedAt: T0 + MINUTO_MS,
    });
    const dadosDoShard = m.db.store[shard('0000')]?.data;
    expect(dadosDoShard?.['timestamp']).toBe(T0 + MINUTO_MS);
    expect((dadosDoShard?.['expiraEm'] as Date).getTime()).toBe(
      expiraEmDoRelatorioShopee(T0).getTime(),
    );
    const [linha] = Object.values(linhasDoShard(m));
    expect(linha).toMatchObject({
      produtoId: INT,
      resultado: 'nao-tentado',
      fase: 'envio',
      motivo: 'job-cancelado',
      linkDocId: null,
      anuncioId: null,
    });
  });

  it('M44: a escada 404 — conta ERRADA ⇒ `wrong-integracao` e o job intocado; ausente ⇒ `not-found`; terminal ⇒ `not-running`', async () => {
    const m = mundo();
    semearJob(m);
    expect(await cancelar(m, 'int-2')).toBe('wrong-integracao');
    expect(jobNoBanco(m).status).toBe('running');
    expect(m.db.store[shard('0000')]).toBeUndefined();
    semearJob(m, { status: 'completed' });
    expect(await cancelar(m)).toBe('not-running');
    expect(
      await cancelarEnvioPrecoShopee(asDb(m.db), {
        jobId: 'nao-existe',
        integracaoId: INT,
        nowMs: T0,
      }),
    ).toBe('not-found');
  });

  it('a linha sintética cai no shard que o `relatorioLinhas` PERSISTIDO escolhe — na fronteira, o shard seguinte', async () => {
    const m = mundo();
    semearJob(m, { relatorioLinhas: 500, relatorioShards: 1 });
    await cancelar(m);
    expect(Object.keys(linhasDoShard(m, '0001'))).toHaveLength(1);
    expect(jobNoBanco(m)).toMatchObject({ relatorioLinhas: 501, relatorioShards: 2 });
  });

  it('classe B: um retry de OCC RECALCULA a fila e o shard a partir do VENCEDOR, nunca de um valor capturado', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)] });
    // O ref do HANDLE (nunca um `.doc()` cru), visto pelo motor como o que ele é.
    const ref = envioPrecoShopeeCollection.docRef(
      asDb(m.db),
      {},
      JOB,
    ) as unknown as OccReadable<unknown>;
    let concorrente = false;
    m.db.occ.beforeCommit = async () => {
      if (concorrente) return;
      concorrente = true;
      // Outro escritor transacional muda o job entre a leitura e o commit.
      await m.db.runTransaction(async (tx) => {
        await tx.get(ref);
        tx.update(ref, { fila: [], relatorioLinhas: 500 });
      });
    };
    expect(await cancelar(m)).toBe('stamped');
    expect(m.db.occ.txLog.filter((e) => e.phase === 'abort').length).toBeGreaterThan(0);
    expect(jobNoBanco(m)).toMatchObject({
      status: 'cancelled',
      filaRestante: 0,
      relatorioLinhas: 501,
    });
    expect(Object.keys(linhasDoShard(m, '0001'))).toHaveLength(1);
  });

  it('`completed` só por transação: sem `linhaTerminal`, nenhuma linha e nenhum `filaRestante`', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)] });
    const r = await finalizarEnvioPrecoShopee(asDb(m.db), JOB, {
      status: ENVIO_PRECO_SHOPEE_STATUS.completed,
      relatorioCompleto: true,
      finishedAt: T0,
      updatedAt: T0,
    });
    expect(r).toBe('stamped');
    expect(jobNoBanco(m)).toMatchObject({ status: 'completed', filaRestante: 0 });
    expect(m.db.store[shard('0000')]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                                 o plano                                     */
/* -------------------------------------------------------------------------- */

describe('o despacho — o PLANO', () => {
  it('um job ausente ou não `running` ⇒ `noop`, sem ler a conta', async () => {
    const m = mundo();
    expect(await rodar(m)).toBe('noop');
    semearJob(m, { status: 'cancelled' });
    expect(await rodar(m)).toBe('noop');
    expect(m.resolverContexto).not.toHaveBeenCalled();
  });

  it('M41: uma página só de PULOS de plano não constrói cliente — zero veredito, zero leitor de base, zero envio, zero preço', async () => {
    const m = mundo();
    semearJob(m);
    m.familias = [familiaKit('a1', ITEM), familiaDeOutraConta('a2')];
    expect(await rodar(m)).toBe('done');
    expect(m.resolverContexto).toHaveBeenCalledTimes(1);
    expect(m.avaliarConta).not.toHaveBeenCalled();
    expect(m.criarLeitorDeBase).not.toHaveBeenCalled();
    expect(m.enviar).not.toHaveBeenCalled();
    expect(m.lerPrecos).not.toHaveBeenCalled();
    expect(motivosDoShard(m)).toEqual([
      ['kit-derivado', 'pulado'],
      ['sem-link', 'pulado'],
    ]);
    expect(jobNoBanco(m)).toMatchObject({
      status: 'completed',
      relatorioCompleto: true,
      planejados: 0,
      pulados: 2,
      planejamentoConcluido: true,
    });
  });

  it('M31: 3 âncoras em páginas de 2 ⇒ duas páginas, nenhuma lida duas vezes, e o fim só depois do `null`', async () => {
    const m = mundo();
    vi.stubEnv('SHOPEE_PRICE_PAGE_LIMIT', '2');
    semearJob(m);
    m.familias = [familiaKit('a1', ITEM), familiaKit('a2', ITEM + 1), familiaKit('a3', ITEM + 2)];
    expect(await rodar(m)).toBe('continued');
    expect(jobNoBanco(m)).toMatchObject({ afterAnchorId: 'a2', planejamentoConcluido: false });
    expect(m.enfileirados).toEqual([
      { payload: { jobId: JOB, integracaoId: INT }, opts: undefined },
    ]);
    expect(await rodar(m)).toBe('done');
    expect(
      m.lerPagina.mock.calls.map((c) => (c[1] as { afterAnchorId: string | null }).afterAnchorId),
    ).toEqual([null, 'a2']);
    expect(m.lerPagina.mock.calls.map((c) => (c[1] as { pageLimit: number }).pageLimit)).toEqual([
      2, 2,
    ]);
    expect(Object.keys(linhasDoShard(m))).toHaveLength(3);
    expect(jobNoBanco(m)).toMatchObject({ status: 'completed', pulados: 3 });
  });

  it('M30: com a `fila` NÃO vazia, nenhuma página é lida', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: false });
    m.banco.set('a1', precos(20));
    await rodar(m);
    expect(m.lerPagina).not.toHaveBeenCalled();
  });

  it('um anúncio planejado entra na `fila` como IDENTIDADE (sem preço) e não escreve linha no plano', async () => {
    const m = mundo();
    semearJob(m);
    m.familias = [familiaComModelos('a1', ITEM)];
    m.avaliarConta.mockImplementation(async () => {
      await Promise.resolve();
      return { ok: false, motivo: 'regiao-nao-suportada', regiao: 'SG', erro: null };
    });
    await rodar(m);
    // O plano commitou a fila ANTES do dreno recusar: o primeiro lote é o do plano.
    const loteDoPlano = m.db.lotes[0];
    const patch = loteDoPlano?.find((e) => e.path === CAMINHO_DO_JOB)?.data;
    expect(patch?.['fila']).toEqual([itemComModelos('a1', ITEM)]);
    expect(patch?.['planejados']).toBe(1);
    expect(loteDoPlano?.some((e) => e.path === shard('0000'))).toBe(false);
  });

  it('`modelos-excedem-limite`: o pulo com modelos conhecidos escreve UMA linha POR MODELO (e uma amostra por anúncio)', async () => {
    const m = mundo();
    semearJob(m);
    const filhos = Array.from({ length: 51 }, (_, i) => ({
      produtoId: `filho-${String(i).padStart(2, '0')}`,
      precos: precos(10),
      varLinks: [varLink('a1', MODELO_A + i, `var-${String(i)}`)],
    }));
    m.familias = [{ ...familiaComModelos('a1', ITEM), children: filhos }];
    await rodar(m);
    const linhas = Object.values(linhasDoShard(m));
    expect(linhas).toHaveLength(51);
    expect(new Set(linhas.map((l) => l.variacaoProdutoId)).size).toBe(51);
    expect(
      linhas.every(
        (l) => l.motivo === 'modelos-excedem-limite' && l.fase === ENVIO_PRECO_FASE.plano,
      ),
    ).toBe(true);
    expect(jobNoBanco(m)).toMatchObject({ pulados: 51 });
    expect(jobNoBanco(m).skips).toHaveLength(1);
  });

  it('C-v caso 3: conta de `tipo` errado ⇒ `failed` NA TENTATIVA 0, uma linha `job-interrompido`, nenhuma página lida', async () => {
    const m = mundo();
    semearJob(m);
    m.familias = [familiaKit('a1', ITEM)];
    m.resolverContexto.mockImplementation(async () => {
      await Promise.resolve();
      throw new ShopeeContaNotConfiguredError(`Integração ${INT} não é do tipo Shopee.`);
    });
    expect(await rodar(m, 0)).toBe('failed');
    expect(m.lerPagina).not.toHaveBeenCalled();
    expect(jobNoBanco(m)).toMatchObject({ status: 'failed', relatorioCompleto: false });
    expect(motivosDoShard(m)).toEqual([['job-interrompido', 'nao-tentado']]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   o dreno                                   */
/* -------------------------------------------------------------------------- */

describe('o despacho — o DRENO', () => {
  it('⚠️ M37: o preço é lido no DRENO — a tabela mudou entre o plano e o envio ⇒ o remetente recebe o NOVO valor', async () => {
    const m = mundo();
    vi.stubEnv('SHOPEE_PRICE_PAGE_LIMIT', '1');
    semearJob(m);
    // O plano vê 15 na família; o banco já diz 20 quando o dreno roda.
    m.familias = [familiaSemModelo('a1', ITEM, 15), familiaSemModelo('a2', ITEM + 1, 15)];
    m.banco.set('a1', precos(20));
    m.banco.set('a2', precos(25));
    await rodar(m);
    expect(alvosRecebidos(m)).toEqual([[20]]);
    // Entre dois despachos o operador muda a tabela da segunda âncora.
    m.banco.set('a2', precos(26));
    await rodar(m);
    expect(alvosRecebidos(m)).toEqual([[20], [26]]);
    expect(m.lerPrecos.mock.calls.map((c) => c[1])).toEqual([['a1'], ['a2']]);
  });

  it('um anúncio COM modelos lê o preço de CADA FILHO — nunca a âncora', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemComModelos('a1', ITEM)], planejamentoConcluido: true });
    m.banco.set('a1', precos(99));
    m.banco.set(FILHO_A, precos(12));
    m.banco.set(FILHO_B, precos(22));
    await rodar(m);
    expect(m.lerPrecos.mock.calls.map((c) => c[1])).toEqual([[FILHO_A, FILHO_B]]);
    expect(m.lerPrecos.mock.calls[0]?.[1]).toEqual(
      produtosQuePrecificam(itemComModelos('a1', ITEM)),
    );
    expect(alvosRecebidos(m)).toEqual([[12, 22]]);
  });

  it('UM leitor de base por despacho, sobre o LOTE inteiro; o que sobra da fila continua no próximo', async () => {
    const m = mundo();
    vi.stubEnv('SHOPEE_PRICE_ITEMS_PER_DISPATCH', '2');
    semearJob(m, {
      fila: [
        itemSemModelo('a1', ITEM),
        itemSemModelo('a2', ITEM + 1),
        itemSemModelo('a3', ITEM + 2),
      ],
      planejamentoConcluido: true,
    });
    for (const id of ['a1', 'a2', 'a3']) m.banco.set(id, precos(20));
    expect(await rodar(m)).toBe('continued');
    expect(m.criarLeitorDeBase).toHaveBeenCalledTimes(1);
    expect(m.criarLeitorDeBase.mock.calls[0]?.[1]).toEqual([ITEM, ITEM + 1]);
    expect(m.enviar).toHaveBeenCalledTimes(2);
    expect(jobNoBanco(m).fila.map((i) => i.produtoId)).toEqual(['a3']);
    // Todos os envios recebem o MESMO leitor, a mesma conta e o `baixarPreco` do job.
    const leitores = new Set(
      m.enviar.mock.calls.map((c) => (c[1] as { lerBase: unknown }).lerBase),
    );
    expect(leitores.size).toBe(1);
    expect(m.enviar.mock.calls[0]?.[1]).toMatchObject({
      conta: CONTEXTO_DA_CONTA,
      nowMs: T0,
      baixarPreco: false,
    });
  });

  it('M32: o checkpoint POR ITEM é UM lote com o patch do job E o shard — um por item drenado', async () => {
    const m = mundo();
    semearJob(m, {
      fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)],
      planejamentoConcluido: true,
    });
    m.banco.set('a1', precos(20));
    m.banco.set('a2', precos(30));
    expect(await rodar(m)).toBe('done');
    expect(m.db.lotes).toHaveLength(2);
    for (const lote of m.db.lotes) {
      expect(lote.map((e) => e.path)).toEqual([CAMINHO_DO_JOB, shard('0000')]);
      // Nunca um `status` no checkpoint — só a transação escreve status terminal.
      expect(Object.keys(lote[0]?.data ?? {})).not.toContain('status');
    }
    expect(m.db.lotes.map((l) => (l[0]?.data['fila'] as unknown[]).length)).toEqual([1, 0]);
  });

  it('⚠️ C-p: uma queda no checkpoint do item 2 não grava NEM a linha NEM o consumo; o retry reenvia e o envio que pousou vira `preco-igual`', async () => {
    const m = mundo();
    semearJob(m, {
      fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)],
      planejamentoConcluido: true,
    });
    m.banco.set('a1', precos(20));
    m.banco.set('a2', precos(30));
    // O commit 2 é o checkpoint do item 2 — o envio dele JÁ pousou na loja.
    m.db.commitsQueFalham.set(2, Object.assign(new Error('UNAVAILABLE'), { code: 14 }));
    await expect(rodar(m, 0)).rejects.toThrow('UNAVAILABLE');
    let job = jobNoBanco(m);
    expect(job.fila.map((i) => i.produtoId)).toEqual(['a2']);
    expect(Object.keys(linhasDoShard(m))).toHaveLength(1);

    expect(await rodar(m, 1)).toBe('done');
    // A loja recebeu UMA escrita por anúncio — o replay não escreveu de novo.
    expect(m.loja.escritas.map((e) => e.itemId)).toEqual([ITEM, ITEM + 1]);
    job = jobNoBanco(m);
    expect(job).toMatchObject({ status: 'completed', enviados: 1, pulados: 1, fila: [] });
    expect(motivosDoShard(m)).toEqual([
      [null, 'enviado'],
      ['preco-igual', 'pulado'],
    ]);
  });

  it('M38: o CONJUNTO de linhas é função da entrada da fila — um anúncio de 2 modelos pulado inteiro escreve 2 chaves, e o replay as mesmas 2', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemComModelos('a1', ITEM)], planejamentoConcluido: false });
    m.familias = [];
    m.banco.set(FILHO_A, precos(12));
    m.banco.set(FILHO_B, precos(22));
    // A loja já tem os dois preços: o anúncio inteiro é `preco-igual`.
    m.loja.precos.set(chaveDaLoja(ITEM, MODELO_A), 12);
    m.loja.precos.set(chaveDaLoja(ITEM, MODELO_B), 22);
    await rodar(m);
    const chaves = Object.keys(linhasDoShard(m)).sort();
    expect(chaves).toHaveLength(2);
    // O replay do mesmo item (outro despacho, outro resultado) sobrescreve as MESMAS chaves.
    semearJob(m, { fila: [itemComModelos('a1', ITEM)], planejamentoConcluido: true });
    m.loja.precos.clear();
    await rodar(m);
    expect(Object.keys(linhasDoShard(m)).sort()).toEqual(chaves);
    expect(chaves.map((k) => linhasDoShard(m)[k]?.variacaoProdutoId).sort()).toEqual([
      FILHO_A,
      FILHO_B,
    ]);
  });

  it('as linhas do dreno: `preco` é o PRETENDIDO em toda linha, o `codigo` vira `erro` cortado em 300, e a amostra é uma por anúncio', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemComModelos('a1', ITEM)], planejamentoConcluido: true });
    m.banco.set(FILHO_A, precos(12));
    m.banco.set(FILHO_B, precos(22));
    const longo = `error_param: ${'x'.repeat(400)}`;
    m.enviar = vi.fn<Enviar>(async (item: ItemDePreco): Promise<ResultadoEnvioPreco> => {
      await Promise.resolve();
      return {
        tipo: 'falha',
        motivo: 'envio-parcial',
        codigo: null,
        mensagem: null,
        carimbado: false,
        chamadasShopee: 1,
        modelos: [
          {
            modelId: MODELO_A,
            produtoId: FILHO_A,
            varLinkDocId: 'var-a',
            precoAlvo: item.alvos[0]?.precoAlvo ?? null,
            precoAnterior: 10,
            resultado: 'enviado',
            motivo: null,
            codigo: null,
          },
          {
            modelId: MODELO_B,
            produtoId: FILHO_B,
            varLinkDocId: 'var-b',
            precoAlvo: item.alvos[1]?.precoAlvo ?? null,
            precoAnterior: 20,
            resultado: 'falha',
            motivo: 'modelo-invalido',
            codigo: longo,
          },
        ],
      };
    });
    await rodar(m);
    const porFilho = new Map(Object.values(linhasDoShard(m)).map((l) => [l.variacaoProdutoId, l]));
    expect(porFilho.get(FILHO_A)).toMatchObject({
      resultado: 'enviado',
      motivo: null,
      erro: null,
      preco: 12,
      precoAnterior: 10,
      anuncioId: String(ITEM),
      linkDocId: 'link-a1',
      produtoId: 'a1',
    });
    expect(porFilho.get(FILHO_B)).toMatchObject({
      resultado: 'falha',
      motivo: 'modelo-invalido',
      preco: 22,
      precoAnterior: 20,
    });
    expect(porFilho.get(FILHO_B)?.erro).toHaveLength(300);
    const job = jobNoBanco(m);
    expect(job).toMatchObject({ enviados: 1, falhas: 1, pulados: 0 });
    expect(job.failures).toEqual([
      {
        itemId: String(ITEM),
        produtoId: 'a1',
        code: 'modelo-invalido',
        linkDocId: 'link-a1',
        precoAnterior: 20,
        error: longo.slice(0, 300),
      },
    ]);
  });

  it('as amostras param no TETO e os contadores continuam exatos', async () => {
    const m = mundo();
    const cheia = Array.from({ length: AMOSTRA_PULOS_CAP }, (_, i) => ({
      itemId: String(i),
      produtoId: `p-${String(i)}`,
      code: 'preco-igual',
      linkDocId: null,
      precoAnterior: null,
    }));
    semearJob(m, {
      fila: [itemSemModelo('a1', ITEM)],
      planejamentoConcluido: true,
      skips: cheia,
      pulados: 200,
    });
    m.banco.set('a1', precos(20));
    m.loja.precos.set(chaveDaLoja(ITEM, 0), 20);
    await rodar(m);
    const job = jobNoBanco(m);
    expect(job.skips).toHaveLength(AMOSTRA_PULOS_CAP);
    expect(job.pulados).toBe(201);
  });

  it('M40: o fim escreve `completed` + `relatorioCompleto: true` pela transação ⇒ `done`', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.banco.set('a1', precos(20));
    expect(await rodar(m)).toBe('done');
    expect(jobNoBanco(m)).toMatchObject({
      status: 'completed',
      relatorioCompleto: true,
      finishedAt: T0,
      filaRestante: 0,
    });
  });

  it('M39: um cancelamento que pousa NO MEIO do envio vence — o item em voo termina e o `completed` vira `noop`', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.banco.set('a1', precos(20));
    const real = remetente(m.loja);
    m.enviar = vi.fn<Enviar>(async (item, d) => {
      await cancelarEnvioPrecoShopee(asDb(m.db), { jobId: JOB, integracaoId: INT, nowMs: T0 });
      return real(item, d);
    });
    expect(await rodar(m)).toBe('noop');
    const job = jobNoBanco(m);
    expect(job.status).toBe('cancelled');
    expect(job.relatorioCompleto).toBe(false);
    // O item em voo terminou (linha `enviado`) E a linha do cancelamento está lá.
    expect(
      motivosDoShard(m)
        .map(([motivo]) => motivo)
        .sort(),
    ).toEqual(['job-cancelado', null].sort());
  });

  it('um cancelamento durante o dreno não compra mais um despacho — `noop` e nada enfileirado', async () => {
    const m = mundo();
    vi.stubEnv('SHOPEE_PRICE_ITEMS_PER_DISPATCH', '1');
    semearJob(m, {
      fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)],
      planejamentoConcluido: true,
    });
    m.banco.set('a1', precos(20));
    const real = remetente(m.loja);
    m.enviar = vi.fn<Enviar>(async (item, d) => {
      await cancelarEnvioPrecoShopee(asDb(m.db), { jobId: JOB, integracaoId: INT, nowMs: T0 });
      return real(item, d);
    });
    expect(await rodar(m)).toBe('noop');
    expect(m.scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('S1 na superfície: um remetente que perde uma linha LANÇA antes de qualquer escrita daquele item', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemComModelos('a1', ITEM)], planejamentoConcluido: true });
    m.enviar = responde({ tipo: 'enviado', modelos: [], chamadasShopee: 1 });
    await expect(rodar(m, 0)).rejects.toThrow('linhas incompletas');
    expect(m.db.lotes).toEqual([]);
    expect(jobNoBanco(m).fila).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                         pausas, parques e falhas                            */
/* -------------------------------------------------------------------------- */

describe('o despacho — PAUSA, PARQUE e FALHA', () => {
  const pausaBurst = (retryAfterSeconds: number | null): ResultadoEnvioPreco => ({
    tipo: 'pausa',
    pausa: 'burst',
    ate: null,
    retryAfterSeconds,
    codigo: 'error_rate_limit',
    chamadasShopee: 1,
  });

  it('M34: rajada ⇒ a cabeça NÃO é consumida, `pausas + 1`, reenfileira com o `Retry-After` ⇒ `continued`', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.enviar = responde(pausaBurst(42));
    expect(await rodar(m)).toBe('continued');
    const job = jobNoBanco(m);
    expect(job.fila).toHaveLength(1);
    expect(job.pausas).toBe(1);
    expect(job.status).toBe('running');
    expect(m.enfileirados).toEqual([
      { payload: { jobId: JOB, integracaoId: INT }, opts: { scheduleDelaySeconds: 42 } },
    ]);
  });

  it('M73: rajada SEM `Retry-After` ⇒ o atraso é o `ratePauseMin()` do ESTOQUE × 60 (um limitador, um número)', async () => {
    const m = mundo();
    vi.stubEnv('SHOPEE_STOCK_RATE_PAUSE_MIN', '7');
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.enviar = responde(pausaBurst(null));
    await rodar(m);
    expect(m.enfileirados[0]?.opts).toEqual({ scheduleDelaySeconds: 420 });
  });

  it('M33: o checkpoint SEM linhas de uma pausa não mexe no contador de linhas', async () => {
    const m = mundo();
    semearJob(m, {
      fila: [itemSemModelo('a1', ITEM)],
      planejamentoConcluido: true,
      relatorioLinhas: 5,
      relatorioShards: 1,
    });
    m.enviar = responde(pausaBurst(10));
    await rodar(m);
    const patch = m.db.lotes[0]?.[0]?.data ?? {};
    expect(Object.keys(patch)).not.toContain('relatorioLinhas');
    expect(Object.keys(patch)).not.toContain('relatorioShards');
    expect(jobNoBanco(m)).toMatchObject({ relatorioLinhas: 5, relatorioShards: 1 });
  });

  it('M35: a 51ª rajada ⇒ `failed` com uma linha `job-interrompido`, sem reenfileirar', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true, pausas: 50 });
    m.enviar = responde(pausaBurst(10));
    expect(await rodar(m)).toBe('failed');
    expect(m.scheduler.enqueue).not.toHaveBeenCalled();
    expect(jobNoBanco(m)).toMatchObject({ status: 'failed', pausas: 51, filaRestante: 1 });
    expect(motivosDoShard(m)).toEqual([['job-interrompido', 'nao-tentado']]);
  });

  it('M36: cota DIÁRIA ⇒ ESTACIONA: `retomarEm` na virada, `parques + 1`, ainda `running`, atraso = até a virada + jitter ⇒ `pausado`', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    const virada = T0 + 3 * HORA_MS + 500;
    m.enviar = responde({
      tipo: 'pausa',
      pausa: 'cota-diaria',
      ate: virada,
      retryAfterSeconds: null,
      codigo: 'error_limit',
      chamadasShopee: 1,
    });
    const jitter = vi.fn(() => 13);
    expect(await rodar(m, 0, T0, { jitterSec: jitter })).toBe('pausado');
    expect(jitter).toHaveBeenCalledWith(PARQUE_JITTER_MAX_S);
    expect(jobNoBanco(m)).toMatchObject({
      status: 'running',
      retomarEm: virada,
      parques: 1,
      fila: [itemSemModelo('a1', ITEM)],
    });
    expect(m.enfileirados[0]?.opts).toEqual({ scheduleDelaySeconds: 3 * 3600 + 1 + 13 });
  });

  it('o quarto parque ⇒ `failed`', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true, parques: 3 });
    m.enviar = responde({
      tipo: 'pausa',
      pausa: 'cota-diaria',
      ate: T0 + HORA_MS,
      retryAfterSeconds: null,
      codigo: 'error_limit',
      chamadasShopee: 1,
    });
    expect(await rodar(m)).toBe('failed');
    expect(jobNoBanco(m)).toMatchObject({ status: 'failed', parques: 4 });
  });

  it('o despacho que RETOMA um parque limpa o `retomarEm` no seu primeiro checkpoint', async () => {
    const m = mundo();
    semearJob(m, {
      fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)],
      planejamentoConcluido: true,
      retomarEm: T0 - MINUTO_MS,
      parques: 1,
    });
    m.banco.set('a1', precos(20));
    m.banco.set('a2', precos(20));
    await rodar(m);
    expect(m.db.lotes[0]?.[0]?.data['retomarEm']).toBeNull();
    expect(jobNoBanco(m).retomarEm).toBeNull();
  });

  it('M42: a pausa de COTA DIÁRIA do estoque é LIDA ⇒ estaciona até ela, zero veredito, zero envio — e o doc do estoque NÃO é escrito', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.db.seed(CAMINHO_DO_ESTADO, { pausadoAte: T0 + 2 * HORA_MS, pausaMotivo: 'cota-diaria' });
    expect(await rodar(m)).toBe('pausado');
    expect(m.avaliarConta).not.toHaveBeenCalled();
    expect(m.enviar).not.toHaveBeenCalled();
    expect(jobNoBanco(m)).toMatchObject({ retomarEm: T0 + 2 * HORA_MS, parques: 1 });
    expect(m.db.writes.filter((w) => w.path === CAMINHO_DO_ESTADO)).toEqual([]);
  });

  it('a pausa de RAJADA do estoque ⇒ o braço da rajada, pelo tempo que falta', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.db.seed(CAMINHO_DO_ESTADO, { pausadoAte: T0 + 90_500, pausaMotivo: 'burst' });
    expect(await rodar(m)).toBe('continued');
    expect(m.enfileirados[0]?.opts).toEqual({ scheduleDelaySeconds: 91 });
    expect(jobNoBanco(m)).toMatchObject({ pausas: 1, parques: 0 });
    expect(m.enviar).not.toHaveBeenCalled();
  });

  it('QUASE-IGUAL de M42: uma pausa de FÉRIAS do estoque não é pausa de preço — o dreno segue', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.db.seed(CAMINHO_DO_ESTADO, { pausadoAte: T0 + 2 * HORA_MS, pausaMotivo: 'loja-em-ferias' });
    m.banco.set('a1', precos(20));
    expect(await rodar(m)).toBe('done');
    expect(m.enviar).toHaveBeenCalledTimes(1);
  });

  it('M74: o veredito da conta RECUSA no dreno ⇒ `failed` + uma linha `job-interrompido`, remetente nunca chamado', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.avaliarConta.mockImplementation(async () => {
      await Promise.resolve();
      return { ok: false, motivo: 'regiao-nao-suportada', regiao: 'MY', erro: null };
    });
    expect(await rodar(m)).toBe('failed');
    expect(m.enviar).not.toHaveBeenCalled();
    const job = jobNoBanco(m);
    expect(job.status).toBe('failed');
    expect(job.erro).toContain('regiao-nao-suportada');
    expect(job.filaRestante).toBe(1);
    expect(motivosDoShard(m)).toEqual([['job-interrompido', 'nao-tentado']]);
  });

  it('um limite de RAJADA na leitura da loja (o veredito) pausa como o do remetente — nenhuma tentativa gasta', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.avaliarConta.mockImplementation(async () => {
      await Promise.resolve();
      throw new ShopeeRateLimitError('rajada', {
        code: 'error_rate_limit',
        kind: 'burst',
        httpStatus: 429,
        path: '/api/v2/shop/get_shop_info',
        retryAfterSeconds: 9,
      });
    });
    expect(await rodar(m, 0)).toBe('continued');
    expect(m.enfileirados[0]?.opts).toEqual({ scheduleDelaySeconds: 9 });
  });

  it('um `fatal` (reauth) ⇒ `failed`, o item fica na fila (contado em `filaRestante`)', async () => {
    const m = mundo();
    semearJob(m, {
      fila: [itemSemModelo('a1', ITEM), itemSemModelo('a2', ITEM + 1)],
      planejamentoConcluido: true,
    });
    m.banco.set('a1', precos(20));
    m.enviar = responde({
      tipo: 'fatal',
      motivo: 'reauth',
      erro: 'ShopeeReauthRequiredError: invalid_acceess_token',
      chamadasShopee: 1,
    });
    expect(await rodar(m)).toBe('failed');
    expect(m.enviar).toHaveBeenCalledTimes(1);
    const job = jobNoBanco(m);
    expect(job).toMatchObject({ status: 'failed', filaRestante: 2 });
    expect(job.erro).toContain('reauth');
    // O erro do remetente vai ao log; o documento carrega só a frase do motivo.
    expect(job.erro).not.toContain('invalid_acceess_token');
  });

  it('a escada: um erro transitório RELANÇA nas tentativas 0 e 1 e CARIMBA `failed` na última', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.banco.set('a1', precos(20));
    m.enviar = vi.fn<Enviar>(async () => {
      await Promise.resolve();
      throw Object.assign(new Error('DEADLINE_EXCEEDED'), { code: 4 });
    });
    await expect(rodar(m, 0)).rejects.toThrow('DEADLINE_EXCEEDED');
    await expect(rodar(m, ENVIO_PRECO_MAX_TENTATIVAS - 2)).rejects.toThrow('DEADLINE_EXCEEDED');
    expect(jobNoBanco(m).status).toBe('running');
    expect(await rodar(m, ENVIO_PRECO_MAX_TENTATIVAS - 1)).toBe('failed');
    expect(jobNoBanco(m)).toMatchObject({ status: 'failed', erro: 'DEADLINE_EXCEEDED' });
  });

  it('QUASE-IGUAL da escada: uma classe de PRIMEIRA tentativa (ShopeeConfigError) carimba já na tentativa 0', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.resolverContexto.mockImplementation(async () => {
      await Promise.resolve();
      throw new ShopeeConfigError('SHOPEE_PARTNER_ID ausente');
    });
    expect(await rodar(m, 0)).toBe('failed');
  });

  it('a válvula fecha no meio do job: o reenfileiramento da pausa lança ⇒ `failed` na tentativa 0', async () => {
    const m = mundo();
    semearJob(m, { fila: [itemSemModelo('a1', ITEM)], planejamentoConcluido: true });
    m.enviar = responde(pausaBurst(5));
    m.scheduler.enqueue.mockImplementation(async () => {
      await Promise.resolve();
      throw new ShopeePriceSyncTasksDisabledError();
    });
    expect(await rodar(m, 0)).toBe('failed');
    expect(jobNoBanco(m).status).toBe('failed');
  });
});

/* -------------------------------------------------------------------------- */
/*                           o texto do módulo                                 */
/* -------------------------------------------------------------------------- */

describe('o texto de atualizarPrecos.ts', () => {
  const FONTE = readFileSync(
    fileURLToPath(new URL('./atualizarPrecos.ts', import.meta.url)),
    'utf8',
  );

  it('não lê relógio nem ambiente: o instante é SEMPRE parâmetro', () => {
    expect(FONTE.includes(['Date', 'now('].join('.'))).toBe(false);
    expect(FONTE.includes(['process', 'env'].join('.'))).toBe(false);
    expect(FONTE.includes(['next', 'server'].join('/'))).toBe(false);
  });

  it('o preço do dreno passa por `produtosQuePrecificam` — a MESMA fonte do envio manual, nunca uma cópia', () => {
    expect(FONTE).toContain('lerPrecos(db, produtosQuePrecificam(planejado))');
    const manual = readFileSync(
      fileURLToPath(new URL('./enviarPrecoManual.ts', import.meta.url)),
      'utf8',
    );
    expect(manual).not.toMatch(/function produtosQuePrecificam/);
    expect(manual).toContain('produtosQuePrecificam(planejado)');
  });
});
