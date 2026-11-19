/**
 * The five-minute stock tick (step 12, PR 12-e2; its hand-offs durable since
 * PR 12-f), offline: T1–T9 against the counting fake Firestore, the REAL stock
 * and jobs producers over recording queues that, like Cloud Tasks, refuse a
 * task id they already hold, the REAL reconcile request and Start, the REAL
 * feed lease I/O, and a clock the cases drive. The real server's half (the idle
 * cost and one active tick on the emulator) is
 * `sincronizacaoEstoque.firestore.test.ts`; the delta feed the tick hands off,
 * dispatched end to end, is `provedorLoteEstoque.test.ts`'s.
 *
 * No network: every `fetch` fails the case (the tick makes no Amazon call).
 *
 * PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import {
  FLUXO_FEED_AMAZON,
  INTEGRACAO_TIPO,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON,
  MOTIVO_CONTA_AMAZON,
  idVezFeedAmazon,
  makeEstoqueUid,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { descreverFalhaDoSdkDeTarefasAmazon } from '../core/filaTarefas';
import { type CamposLogAmazon, INVALIDO } from '../core/log';
import { CANARIO_ENV_AMAZON, VALVULA_ENV_AMAZON } from '../core/valvulas';
import {
  AmazonLotesTarefasDesligadasError,
  type FilaLotesAmazon,
  criarAgendadorLotesAmazon,
} from '../feeds/agendadorLotes';
import {
  type TarefaLoteAmazon,
  execucaoIdDaJanelaFeed,
  nomeEnvioFeed,
  nomePaginaReconciliacao,
  nomeRecuperacaoFeed,
  nomeRetomadaReconciliacao,
  referenciaVezFeed,
} from '../feeds/tarefaLote';
import { CLASSE_DO_LOTE, classeDoLote } from '../feeds/vezFeed';
import { type DocData, FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  falhaDeConfiguracaoDoFunctions,
  falhaDeTarefaJaExistente,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import { AGORA_MS, caminhoAviso, caminhoConta, loggerEspiao } from '../testing/fixtures';
import { LINHAS_POR_PAGINA_JANELA, TETO_PAGINAS_JANELA, janelaDoTick } from './descobertaEstoque';
import { MOTIVO_ESTOQUE_AMAZON } from './motivosEstoque';
import {
  AmazonEstoqueRegiaoDaFilaInvalidaError,
  AmazonEstoqueTarefasDesligadasError,
  LARGURA_LOTE_ESTOQUE_AMAZON,
  criarProdutorEstoqueAmazon,
} from './produtorEstoque';
import { RETOMADA_RECONCILIACAO_MS } from './reconciliacaoEstoque';
import {
  DESFECHO_TICK_ESTOQUE_AMAZON,
  type DepsTickEstoqueAmazon,
  FOLGA_CONTA_ESTOQUE_AMAZON_MS,
  INTERVALO_TICK_ESTOQUE_AMAZON_MS,
  LEASE_TICK_ESTOQUE_AMAZON_MS,
  LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
  ORCAMENTO_CONTA_ESTOQUE_AMAZON_MS,
  ORIGEM_LOTE_TICK_ESTOQUE_AMAZON,
  ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS,
  ORCAMENTO_TICK_ESTOQUE_AMAZON_MS,
  PORTAO_TICK_ESTOQUE_AMAZON,
  REPASSE_TICK_ESTOQUE_AMAZON,
  type ResultadoContaTickEstoqueAmazon,
  type ResultadoTickEstoqueAmazon,
  TEMPO_LIMITE_TICK_ESTOQUE_AMAZON_S,
  executarTickEstoqueAmazon,
  orcamentoDaContaEstoqueAmazonMs,
  ordemDoTickEstoqueAmazon,
  resumirTickEstoqueAmazon,
} from './sincronizacaoEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  nomeDaTarefaEstoque,
  referenciaDaObservacao,
} from './tarefaEstoque';

/**
 * `janelaDoTick`, real by default; a case may make it throw something other
 * than its `RangeError` (the tick's catch around it is narrow).
 */
const planejador = vi.hoisted(() => ({ falha: null as unknown }));
vi.mock('./descobertaEstoque', async (original) => {
  const real = await original<typeof import('./descobertaEstoque')>();
  return {
    ...real,
    janelaDoTick: (...args: Parameters<typeof real.janelaDoTick>) => {
      if (planejador.falha !== null) throw planejador.falha;
      return real.janelaDoTick(...args);
    },
  };
});

const CONTA = 'conta-amz-tick';
const DEP = 'dep-tick-1';
const CANONICA = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;
const REF_CONTA = `documents/integracao/${CONTA}`;
/** The tick's instant; the stored cursor is one interval behind it. */
const T0 = AGORA_MS;
const CURSOR = T0 - INTERVALO_TICK_ESTOQUE_AMAZON_MS;
/** A stamp inside the tick's window. */
const MOVEU = T0 - 60_000;
/**
 * How far the tick's window reaches below its cursor, WRITTEN OUT: these cases
 * pin the five minutes themselves, so a shorter reach-back in the planner reds
 * them too.
 */
const CINCO_MINUTOS_MS = 300_000;
/** The switch on, the stock valve in dry-run: the tick runs (it never writes to Amazon). */
const AMBIENTE = Object.freeze({ AMAZON_CHAMADAS: 'on', AMAZON_MODO_ESTOQUE: 'dry-run' });

const sync = (id = CONTA) => `sincronizacaoEstoqueAmazon/${id}`;
/** The conta's reconcile run, its request, and its stock feed lease. */
const RUN = `reconciliacaoEstoqueAmazon/${CONTA}`;
const PEDIDO = `pedidoReconciliacaoEstoqueAmazon/${CONTA}`;
const VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const avisoSemDeposito = (id = CONTA) =>
  caminhoAviso(chaveContaPrecisaAtencao(id, MOTIVO_CONTA_AMAZON.estoqueSemDeposito));

/** Every `fetch` is a failure: the tick never reaches the network. */
const chamadasDeRede: string[] = [];
vi.stubGlobal('fetch', (input: unknown) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
});

let fake: FakeDb;
let agoraMs: number;
let espiao: ReturnType<typeof loggerEspiao>;
/** Task ids the recording queue holds (a name stays held after its task ran). */
let idsNaFila: Set<string>;
/** Every task the queue accepted, in order. */
let enfileiradas: TarefaEstoqueAmazon[];
/** Every enqueue the queue refused as already held. */
let jaExistentes: TarefaEstoqueAmazon[];
let execucoes: number;
/** The JOBS queue: the ids it holds, and every task it accepted (its name and delay). */
let idsDeLote: Set<string>;
let lotes: { tarefa: TarefaLoteAmazon; id: string | null; atrasoS: number }[];
/** Every jobs enqueue the queue refused as already held. */
let lotesJaExistentes: TarefaLoteAmazon[];

beforeEach(() => {
  planejador.falha = null;
  fake = new FakeDb();
  agoraMs = T0;
  espiao = loggerEspiao();
  idsNaFila = new Set();
  enfileiradas = [];
  jaExistentes = [];
  execucoes = 0;
  idsDeLote = new Set();
  lotes = [];
  lotesJaExistentes = [];
});

afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** The REAL producer over a recording queue (module header). */
function produtorGravador(
  opcoes: { readonly desligado?: boolean; readonly falha?: () => unknown } = {},
) {
  return criarProdutorEstoqueAmazon({
    desligado: opcoes.desligado ?? false,
    fila: () => ({
      enqueue: (tarefa, extras) => {
        const erro = opcoes.falha?.();
        if (erro !== undefined) return Promise.reject(erro);
        const id = extras?.id;
        if (id !== undefined && idsNaFila.has(id)) {
          jaExistentes.push(tarefa);
          return Promise.reject(falhaDeTarefaJaExistente(id));
        }
        if (id !== undefined) idsNaFila.add(id);
        enfileiradas.push(tarefa);
        return Promise.resolve();
      },
    }),
  });
}

/** The REAL jobs producer over a recording queue (module header). */
function agendadorGravador(
  opcoes: { readonly desligado?: boolean; readonly falha?: () => unknown } = {},
) {
  return criarAgendadorLotesAmazon({
    desligado: opcoes.desligado ?? false,
    fila: (): FilaLotesAmazon => ({
      enqueue: (tarefa, extras) => {
        const erro = opcoes.falha?.();
        if (erro !== undefined) return Promise.reject(erro);
        const id = extras?.id;
        if (id !== undefined && idsDeLote.has(id)) {
          lotesJaExistentes.push(tarefa);
          return Promise.reject(falhaDeTarefaJaExistente(id));
        }
        if (id !== undefined) idsDeLote.add(id);
        lotes.push({ tarefa, id: id ?? null, atrasoS: extras?.scheduleDelaySeconds ?? 0 });
        return Promise.resolve();
      },
    }),
  });
}

function deps(over: Partial<DepsTickEstoqueAmazon> = {}): DepsTickEstoqueAmazon {
  const produtor = produtorGravador();
  const agendador = agendadorGravador();
  return {
    db: asDb(fake),
    ambiente: AMBIENTE,
    contas: LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
    produtor: () => produtor,
    agendador: () => agendador,
    agora: () => agoraMs,
    logger: espiao.logger,
    increment,
    gerarExecucaoId: () => {
      execucoes += 1;
      return `exec-${String(execucoes)}`;
    },
    ...over,
  };
}

const tick = (over: Partial<DepsTickEstoqueAmazon> = {}) => executarTickEstoqueAmazon(deps(over));

/** An Amazon conta with its depósito (the canonical form unless told otherwise, or none). */
function conta(
  id = CONTA,
  { deposito = CANONICA as string | null, ...over }: { deposito?: string | null } & DocData = {},
): void {
  const dados: DocData = {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: `Conta ${id}`,
    ativo: true,
    padrao: false,
    selling_partner_id: null,
    ...over,
  };
  if (deposito !== null) dados.depositoOuterRef = deposito;
  fake.seed(caminhoConta(id), dados);
}

/** The conta's sync document: a cursor at the conta's depósito, no lease, no aviso. */
function sincronizacao(id = CONTA, over: DocData = {}): void {
  fake.seed(sync(id), {
    cursorMs: CURSOR,
    depositoDoCursor: CANONICA,
    vez: null,
    ultimoTickMs: null,
    falhasSeguidas: 0,
    semDeposito: false,
    ...over,
  });
}

function produto(id: string, dados: DocData = {}): void {
  fake.seed(`produtos/${id}`, { nome: `Produto ${id}`, ...dados });
}

/** An estoque row of `produto` at the depósito (canonical id and form). Returns its path. */
function linha(produtoId: string, ultimaModificacao: number, ref = CANONICA): string {
  const caminho = `produtos/${produtoId}/estoques/${makeEstoqueUid(produtoId, DEP)}`;
  fake.seed(caminho, { depositoOuterRef: ref, ultimaModificacao, quantidade: 1 });
  return caminho;
}

/** A link doc on `dono` for `sku`, of the conta. */
function vinculo(dono: string, id: string, sku: string, contaRef = REF_CONTA): void {
  fake.seed(`produtos/${dono}/prodAmazon/${id}`, {
    contaAmazonOuterRef: contaRef,
    sku,
    productDataJson: '{"pesado":true}',
  });
}

/** One produto whose row moved, with `n` links of the conta (`<prefixo>-00`, …). */
function produtoComVinculos(id: string, n: number, prefixo = id): void {
  produto(id);
  linha(id, MOVEU);
  for (let i = 0; i < n; i += 1) {
    vinculo(id, `l${String(i)}`, `${prefixo}-${String(i).padStart(4, '0')}`);
  }
}

/** The one result of a one-conta tick. */
function unica(r: ResultadoTickEstoqueAmazon): ResultadoContaTickEstoqueAmazon {
  expect(r.contas).toHaveLength(1);
  const c = r.contas[0];
  if (c === undefined) throw new Error('sem resultado');
  return c;
}

const linhasDoTick = () =>
  espiao.linhas.filter((l) => l.meta?.evento === 'estoque' && l.meta.fase === 'tick');
const linhaDaConta = (id = CONTA): { nivel: string; meta: CamposLogAmazon } => {
  const ls = linhasDoTick().filter((l) => l.meta?.conta === id);
  expect(ls).toHaveLength(1);
  const l = ls[0];
  if (l?.meta === undefined) throw new Error('sem linha');
  return { nivel: l.nivel, meta: l.meta };
};
const consultasDaJanela = () => fake.consultas.filter((q) => q.colecao === 'estoques');
const listagens = () => fake.consultas.filter((q) => q.colecao.endsWith('/prodAmazon'));
const leiturasEm = (prefixo: string) => fake.leituras.filter((c) => c.startsWith(prefixo));
const escritasEm = (prefixo: string) => fake.escritas.filter((e) => e.caminho.startsWith(prefixo));
/** The jobs queue's tasks of one tipo. */
const doTipo = (tipo: TarefaLoteAmazon['tipo']) => lotes.filter((l) => l.tarefa.tipo === tipo);

describe('the numbers', () => {
  it('budget 200 s < timeout 240 s < lease 270 s < the 300-s interval; the deadline keeps 20 s for the final write', () => {
    expect(ORCAMENTO_TICK_ESTOQUE_AMAZON_MS).toBe(200_000);
    expect(ORCAMENTO_CONTA_ESTOQUE_AMAZON_MS).toBe(200_000);
    expect(FOLGA_CONTA_ESTOQUE_AMAZON_MS).toBe(20_000);
    expect(ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS).toBe(30_000);
    expect([
      ORCAMENTO_TICK_ESTOQUE_AMAZON_MS,
      TEMPO_LIMITE_TICK_ESTOQUE_AMAZON_S * 1000,
      LEASE_TICK_ESTOQUE_AMAZON_MS,
      INTERVALO_TICK_ESTOQUE_AMAZON_MS,
    ]).toEqual([200_000, 240_000, 270_000, 300_000]);
  });

  it('a conta’s budget is min(200 s, what the tick has left), never below 0', () => {
    expect(orcamentoDaContaEstoqueAmazonMs(T0, T0)).toBe(200_000);
    expect(orcamentoDaContaEstoqueAmazonMs(T0, T0 + 150_000)).toBe(50_000);
    expect(orcamentoDaContaEstoqueAmazonMs(T0, T0 + 250_000)).toBe(0);
  });

  it('the contas are ROTATED by the tick’s five-minute slot', () => {
    const slot =
      Math.floor(T0 / INTERVALO_TICK_ESTOQUE_AMAZON_MS) * INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const base = slot - (slot % (3 * INTERVALO_TICK_ESTOQUE_AMAZON_MS));
    expect(ordemDoTickEstoqueAmazon(['a', 'b', 'c'], base)).toEqual(['a', 'b', 'c']);
    expect(
      ordemDoTickEstoqueAmazon(['a', 'b', 'c'], base + INTERVALO_TICK_ESTOQUE_AMAZON_MS),
    ).toEqual(['b', 'c', 'a']);
    expect(ordemDoTickEstoqueAmazon([], base)).toEqual([]);
  });
});

describe('★ T1: the read switch and the stock valve gate the tick BEFORE any Firestore read', () => {
  it.each([
    ['the switch unset', { AMAZON_MODO_ESTOQUE: 'on' }],
    ['the switch not EXACTLY on', { AMAZON_CHAMADAS: 'ON', AMAZON_MODO_ESTOQUE: 'on' }],
  ])('%s ⇒ ZERO Firestore operations and ONE INFO line', async (_c, ambiente) => {
    conta();
    sincronizacao();
    const listar = vi.fn(LEITOR_DE_CONTAS_ESTOQUE_AMAZON.listar);
    const produtor = vi.fn();
    const r = await tick({
      ambiente,
      contas: { ...LEITOR_DE_CONTAS_ESTOQUE_AMAZON, listar },
      produtor,
    });
    expect(r).toEqual({ portao: PORTAO_TICK_ESTOQUE_AMAZON.chamadasDesligadas, contas: [] });
    expect(fake.operacoes).toBe(0);
    expect(listar).not.toHaveBeenCalled();
    expect(produtor).not.toHaveBeenCalled();
    expect(espiao.linhas).toHaveLength(1);
    expect(espiao.linhas[0]).toMatchObject({
      nivel: 'info',
      meta: { evento: 'estoque', fase: 'tick', portao: 'chamadas-desligadas', conta: null },
    });
  });

  it('the stock valve off (unset, or not a recognised mode) ⇒ ZERO Firestore operations, ONE INFO line', async () => {
    conta();
    sincronizacao();
    for (const ambiente of [
      { AMAZON_CHAMADAS: 'on' },
      { AMAZON_CHAMADAS: 'on', AMAZON_MODO_ESTOQUE: 'On' },
    ]) {
      espiao = loggerEspiao();
      const r = await tick({ ambiente, logger: espiao.logger });
      expect(r.portao).toBe(PORTAO_TICK_ESTOQUE_AMAZON.valvulaDesligada);
      expect(espiao.linhas).toHaveLength(1);
      expect(espiao.linhas[0]?.meta).toMatchObject({ portao: 'valvula-desligada', valvula: 'off' });
    }
    expect(fake.operacoes).toBe(0);
  });

  it('NEAR-MISS: the valve in dry-run (or on) runs the tick', async () => {
    conta();
    sincronizacao();
    for (const modo of ['dry-run', 'on']) {
      agoraMs += INTERVALO_TICK_ESTOQUE_AMAZON_MS;
      const r = await tick({ ambiente: { AMAZON_CHAMADAS: 'on', AMAZON_MODO_ESTOQUE: modo } });
      expect(r.portao).toBeNull();
      expect(unica(r).desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia);
    }
  });
});

describe('★ the idle tick’s EXACT cost', () => {
  it('★ switch on, valve dry-run, one conta with its depósito and semDeposito false: 1 conta list, 1 conta read, 1 sync read, 1 lease write, ONE getAll of the reconcile run and the stock lease, 2 empty window queries, 1 final write — nothing else', async () => {
    conta();
    sincronizacao();
    produto('P');
    vinculo('P', 'l1', 'SKU-P');
    linha('P', CURSOR - CINCO_MINUTOS_MS); // just below the window's reach-back: never read
    const r = await tick();
    expect(unica(r)).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia,
      cursorAvancou: true,
      skus: 0,
      tarefas: 0,
      retomada: null,
      inicioRecuperado: false,
    });
    // The 12-e2 pin (2 reads, 0 getAll) moved by EXACTLY one getAll of two documents.
    expect(fake.contagem).toEqual({ leituras: 4, chamadasGetAll: 1, consultas: 3, escritas: 2 });
    expect(fake.leituras).toEqual([caminhoConta(CONTA), sync(), RUN, VEZ]);
    expect(
      fake.leiturasDetalhadas
        .filter((l) => l.via === 'getAll')
        .map((l) => [l.caminho, l.chamada, l.mascara]),
    ).toEqual([
      [RUN, 1, null],
      [VEZ, 1, null],
    ]);
    expect(lotes).toEqual([]);
    expect(fake.consultas.map((q) => q.colecao)).toEqual(['integracao', 'estoques', 'estoques']);
    expect(fake.escritas.map((e) => [e.verbo, e.caminho, e.comPrecondicao])).toEqual([
      ['update', sync(), true],
      ['update', sync(), true],
    ]);
    // Zero prodAmazon, produto, estoque or aviso READS (the two window queries return no row).
    expect(listagens()).toEqual([]);
    expect(leiturasEm('produtos/')).toEqual([]);
    expect(leiturasEm('avisos/')).toEqual([]);
    expect(enfileiradas).toEqual([]);
  });

  it('the final write: lease released, the cursor at the window’s end, ultimoTickMs, the flag, the counter at 0', async () => {
    conta();
    sincronizacao(CONTA, { falhasSeguidas: 2 });
    await tick();
    expect(fake.ler(sync())).toEqual({
      cursorMs: T0,
      depositoDoCursor: CANONICA,
      vez: null,
      ultimoTickMs: T0,
      falhasSeguidas: 0,
      semDeposito: false,
    });
    expect(linhaDaConta()).toMatchObject({
      nivel: 'info',
      meta: { desfecho: 'janela-vazia', paginas: 2, linhas: 0, skus: 0, truncada: false },
    });
  });

  it('★ the window query, spied: `==` per stored form (canonical first), both bounds, the key order, the stamp alone — never `in`', async () => {
    conta();
    sincronizacao();
    await tick();
    expect(consultasDaJanela()).toEqual(
      [CANONICA, NUA].map((forma) => ({
        colecao: 'estoques',
        grupo: true,
        filtros: [
          ['depositoOuterRef', forma],
          ['ultimaModificacao >', CURSOR - CINCO_MINUTOS_MS],
          ['ultimaModificacao <=', T0],
        ],
        ordens: [
          ['ultimaModificacao', 'asc'],
          ['__name__', 'asc'],
        ],
        limite: LINHAS_POR_PAGINA_JANELA,
        apos: null,
        selecao: ['ultimaModificacao'],
      })),
    );
  });
});

describe('★ T7: 1–30 SKUs ⇒ one NAMED patch task per observation', () => {
  it('a moved row ⇒ ONE delta task named by its observation (the row’s commit), the cursor advanced', async () => {
    conta();
    sincronizacao();
    produto('P');
    const caminho = linha('P', MOVEU);
    vinculo('P', 'l1', 'SKU-P');
    const r = unica(await tick());
    const commit = fake.carimboDe(caminho);
    if (commit === undefined) throw new Error('fixture');
    expect(enfileiradas).toEqual([
      {
        v: 1,
        contaId: CONTA,
        sku: 'SKU-P',
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
        referencia: referenciaDaObservacao(commit),
        depositoId: null,
      },
    ]);
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileirado,
      motivo: MOTIVO_ESTOQUE_AMAZON.emPatches,
      skus: 1,
      tarefas: 1,
      cursorAvancou: true,
    });
    expect(fake.ler(sync())?.cursorMs).toBe(T0);
  });

  it('★ the switch at the tick: 30 SKUs ⇒ 30 tasks and the cursor advanced', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', LIMIAR_FEED_ESTOQUE_AMAZON);
    const r = unica(await tick());
    expect(enfileiradas).toHaveLength(30);
    expect(new Set(enfileiradas.map((t) => t.sku)).size).toBe(30);
    expect(r).toMatchObject({
      desfecho: 'enfileirado',
      skus: 30,
      tarefas: 30,
      cursorAvancou: true,
    });
  });

  it('★ NEAR-MISS: 31 SKUs ⇒ ZERO patch tasks and ONE window feed-enviar (the window, never the SKUs), named by the window, no delay; the cursor ADVANCED', async () => {
    conta();
    sincronizacao(CONTA, { falhasSeguidas: 2 });
    produtoComVinculos('P', LIMIAR_FEED_ESTOQUE_AMAZON + 1);
    const r = unica(await tick());
    expect(enfileiradas).toEqual([]);
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.feedNecessario,
      motivo: MOTIVO_ESTOQUE_AMAZON.emFeed,
      entrega: 'enfileirada',
      skus: 31,
      tarefas: 0,
      cursorAvancou: true,
    });
    // The tick's window WHOLE, written out: the range from 5 min below the
    // cursor, the stamp rule and the commit filter at cursor − 20 s, never
    // forcing, no wait — named by (conta, that range).
    const desdeMs = CURSOR - CINCO_MINUTOS_MS;
    const execucaoId = execucaoIdDaJanelaFeed(CONTA, desdeMs, T0);
    expect(lotes).toEqual([
      {
        tarefa: {
          v: 1,
          tipo: 'feed-enviar',
          fluxo: 'estoque',
          contaId: CONTA,
          execucaoId,
          origem: ORIGEM_LOTE_TICK_ESTOQUE_AMAZON,
          lote: {
            tipo: 'janela',
            desdeMs,
            ateMs: T0,
            manterDesdeMs: CURSOR - 20_000,
            commitAposMs: CURSOR - 20_000,
            forcarPorCommit: false,
            esperaAteMs: null,
            depositoId: DEP,
          },
        },
        id: nomeEnvioFeed(CONTA, execucaoId),
        atrasoS: 0,
      },
    ]);
    // The payload is the planner's own window, field for field (bounds and keep rule).
    const planejada = janelaDoTick({ cursorMs: CURSOR, agoraMs: T0 });
    const [enviado] = lotes;
    if (planejada === null || enviado?.tarefa.tipo !== 'feed-enviar') throw new Error('fixture');
    expect(enviado.tarefa.lote).toEqual({
      tipo: 'janela',
      desdeMs: planejada.desdeMs,
      ateMs: planejada.ateMs,
      manterDesdeMs: planejada.manterDesdeMs,
      commitAposMs: planejada.commitAposMs,
      forcarPorCommit: planejada.forcarPorCommit,
      esperaAteMs: null,
      depositoId: DEP,
    });
    // NEAR-MISS: the batch's class is the tick's (it records a bare start), commit filter and all.
    expect(classeDoLote(enviado.tarefa.lote)).toBe(CLASSE_DO_LOTE.janelaDoTick);
    // The payload never carries a SKU: its size is the same whatever the batch's.
    expect(JSON.stringify(lotes)).not.toContain('P-00');
    // A durable hand-off is a clean end: the cursor at the window's end, the counter at 0.
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0, vez: null, falhasSeguidas: 0 });
    expect(linhaDaConta()).toMatchObject({
      nivel: 'info',
      meta: { repasse: 'feed-necessario', entrega: 'enfileirada', skus: 31 },
    });
  });

  it('★ the same window handed off twice (a tick that crashed before its final write) is ONE batch: the second answers ALREADY_EXISTS', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', LIMIAR_FEED_ESTOQUE_AMAZON + 1);
    // The first run's final write is lost: the cursor stays where it was.
    fake.antesDaProximaEscrita(sync(), () => undefined); // the lease
    fake.antesDaProximaEscrita(sync(), () => {
      throw grpc(14, 'UNAVAILABLE');
    });
    expect(unica(await tick())).toMatchObject({ desfecho: 'erro-firestore' });
    // The dead run's lease expires; the same window, the same clock.
    const lease = fake.ler(sync())?.vez as { ateMs: number };
    fake.seed(sync(), { ...fake.ler(sync()), vez: { ...lease, ateMs: T0 } });
    const r = unica(await tick());
    expect(r).toMatchObject({ repasse: 'feed-necessario', entrega: 'ja-enfileirada' });
    expect(doTipo('feed-enviar')).toHaveLength(1);
    expect(lotesJaExistentes).toHaveLength(1);
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0 });
  });

  it('★ 3,000 SKUs ⇒ the delta-feed hand-off; 3,001 ⇒ the reconcile hand-off (a request, then Start) — the cursor advanced both times, zero patch tasks', async () => {
    conta();
    sincronizacao(CONTA, { falhasSeguidas: 2 });
    // 100 produtos × 30 links: 3,000 SKUs from 100 rows (no truncation).
    for (let i = 0; i < 100; i += 1) produtoComVinculos(`P${String(i).padStart(3, '0')}`, 30);
    const r1 = unica(await tick());
    expect(r1).toMatchObject({
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.feedNecessario,
      skus: MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON,
      truncada: false,
      cursorAvancou: true,
    });
    expect(doTipo('feed-enviar')).toHaveLength(1);
    // The next tick's window still holds every row (its overlap), plus one more produto.
    for (let i = 0; i < 100; i += 1) linha(`P${String(i).padStart(3, '0')}`, T0 - 5_000);
    produtoComVinculos('PX', 1);
    linha('PX', T0 + 60_000);
    agoraMs += INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r2 = unica(await tick());
    expect(r2).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      motivo: MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
      entrega: 'pedido',
      skus: MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON + 1,
      truncada: false,
      cursorAvancou: true,
    });
    expect(enfileiradas).toEqual([]);
    expect(doTipo('feed-enviar')).toHaveLength(1);
    expect(fake.ler(sync())).toMatchObject({ cursorMs: agoraMs, falhasSeguidas: 0 });
    // The request, then Start: a run claimed at the conta's depósito, its page 0 named.
    expect(fake.ler(PEDIDO)).toMatchObject({ pendente: false, pedidoEmMs: agoraMs });
    const run = fake.ler(RUN) as { execucaoId: string };
    expect(run).toMatchObject({ fase: 'varrendo', depositoOuterRef: CANONICA, proximaPagina: 0 });
    expect(doTipo('reconciliacao')).toEqual([
      {
        tarefa: {
          v: 1,
          tipo: 'reconciliacao',
          contaId: CONTA,
          execucaoId: run.execucaoId,
          pagina: 0,
        },
        id: nomePaginaReconciliacao(CONTA, run.execucaoId, 0),
        atrasoS: 0,
      },
    ]);
  });

  it('a SKU the task payload cannot carry is COUNTED and left out; the others go, the cursor advances', async () => {
    conta();
    sincronizacao();
    produto('P');
    linha('P', MOVEU);
    vinculo('P', 'l1', 'SKU-OK');
    vinculo('P', 'l2', 'X'.repeat(81));
    const r = unica(await tick());
    expect(enfileiradas.map((t) => t.sku)).toEqual(['SKU-OK']);
    expect(r).toMatchObject({ desfecho: 'enfileirado', skus: 2, tarefas: 1, foraDaTarefa: 1 });
  });

  it('NEAR-MISS: a window whose every SKU no payload can carry builds NO producer, counts them, and moves the cursor', async () => {
    conta();
    sincronizacao();
    produto('P');
    linha('P', MOVEU);
    vinculo('P', 'l1', 'X'.repeat(81));
    const produtor = vi.fn(() => produtorGravador());
    const r = unica(await tick({ produtor }));
    expect(produtor).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      desfecho: 'enfileirado',
      skus: 1,
      tarefas: 0,
      foraDaTarefa: 1,
      cursorAvancou: true,
    });
    expect(fake.ler(sync())?.cursorMs).toBe(T0);
  });

  it('★ the cursor moves to the window’s END, never to the clock at the final write: a row stamped in between is the next tick’s', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 1);
    // 30 s pass between planning the window (at T0) and the final write: more than the overlap.
    const r = unica(await tick({ agora: () => T0 + 30_000 * listagens().length }));
    expect(r).toMatchObject({ desfecho: 'enfileirado', tarefas: 1, cursorAvancou: true });
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0, ultimoTickMs: T0 + 30_000 });
    // A row stamped after the window's end and before that final write.
    produto('Q');
    linha('Q', T0 + 5_000);
    vinculo('Q', 'lq', 'SKU-Q');
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    await tick();
    expect(enfileiradas.map((t) => t.sku)).toEqual(['P-0000', 'SKU-Q']);
  });

  it('★ an EMPTY window moves the cursor to its end too, never to the clock at the final write', async () => {
    conta();
    sincronizacao();
    const r = unica(await tick({ agora: () => T0 + 30_000 * consultasDaJanela().length }));
    expect(r).toMatchObject({ desfecho: 'janela-vazia', cursorAvancou: true });
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0, ultimoTickMs: T0 + 60_000 });
  });
});

describe('★ observations: the overlap dedupes, a re-write mints a new task', () => {
  it('★ the same row read by two ticks (the overlap) ⇒ ONE task: the second answers ALREADY_EXISTS', async () => {
    conta();
    sincronizacao();
    produto('P');
    linha('P', T0 - 5_000); // inside the next tick's 20-s overlap below its cursor
    vinculo('P', 'l1', 'SKU-P');
    await tick();
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r = unica(await tick());
    expect(enfileiradas).toHaveLength(1);
    expect(jaExistentes).toHaveLength(1);
    expect(r).toMatchObject({ desfecho: 'enfileirado', tarefas: 0, jaEnfileiradas: 1 });
  });

  it('★ inverted clocks: a second write lands with ultimaModificacao unchanged (its clock lost the max) ⇒ the next tick mints a NEW task — its commit moved', async () => {
    conta();
    sincronizacao();
    produto('P');
    const caminho = linha('P', T0 - 5_000); // the first write, stamped 1000
    vinculo('P', 'l1', 'SKU-P');
    await tick();
    const commitA = fake.carimboDe(caminho);
    // The second write: an increment whose `now` was taken before the first write's: the stamp stays.
    fake.seed(caminho, {
      depositoOuterRef: CANONICA,
      ultimaModificacao: T0 - 5_000,
      quantidade: 2,
    });
    const commitB = fake.carimboDe(caminho);
    if (commitA === undefined || commitB === undefined) throw new Error('fixture');
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r = unica(await tick());
    expect(r).toMatchObject({ tarefas: 1, jaEnfileiradas: 0 });
    expect(enfileiradas.map((t) => t.referencia)).toEqual([
      referenciaDaObservacao(commitA),
      referenciaDaObservacao(commitB),
    ]);
    // NEAR-MISS: the two observations share the row's stamp — a name keyed on
    // `ultimaModificacao` would have answered ALREADY_EXISTS and the second write would wait.
    expect(fake.ler(caminho)?.ultimaModificacao).toBe(T0 - 5_000);
    expect(new Set(enfileiradas.map((t) => nomeDaTarefaEstoque(t))).size).toBe(2);
  });

  it('★ a kit sale (only the kit’s own stamp moves) enqueues the kit’s SKU; a component sale does NOT (the accepted residue)', async () => {
    conta();
    sincronizacao();
    // A REAL kit → component relation: the component's sale still moves only its own row.
    produto('KIT', { ehKit: true, componentesKit: { COMP: { quantidade: 1 } } });
    produto('COMP');
    vinculo('KIT', 'lk', 'SKU-KIT');
    vinculo('COMP', 'lc', 'SKU-COMP');
    // The component sells: only its row moves. The kit's sits below the overlap
    // (inside the reach-back, committed long before the cursor): never kept.
    linha('KIT', CURSOR - 60_000);
    linha('COMP', MOVEU);
    await tick();
    expect(enfileiradas.map((t) => t.sku)).toEqual(['SKU-COMP']);
    // The kit sells: its own row is stamped (no ledger row, a stamp only).
    linha('KIT', T0 + 60_000);
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    await tick();
    expect(enfileiradas.map((t) => t.sku)).toEqual(['SKU-COMP', 'SKU-KIT']);
  });

  it('★ a link on a family-of-one wrapper is found from its member’s estoque move', async () => {
    conta();
    sincronizacao();
    produto('W');
    produto('M', { paiId: 'W' });
    vinculo('W', 'lw', 'SKU-W');
    linha('M', MOVEU);
    const r = unica(await tick());
    expect(enfileiradas.map((t) => t.sku)).toEqual(['SKU-W']);
    expect(r).toMatchObject({ produtos: 1, sondas: 2, skus: 1, tarefas: 1 });
  });
});

/**
 * The millisecond the next rows seeded will COMMIT in: a marker's own. The
 * fake's clock moves one µs per write (from seven hours before T0), so the few
 * rows a case seeds next commit in that same millisecond, and a cursor taken
 * relative to it places a row's commit exactly where the case needs it — apart
 * from the row's stamp.
 */
function proximoCommitMs(): number {
  return fake.seed('relogio/marco', {}).toMillis();
}

/** The commit millisecond of `caminho`. */
function commitMsDe(caminho: string): number {
  const t = fake.carimboDe(caminho);
  if (t === undefined) throw new Error(`fixture: ${caminho} ausente`);
  return t.toMillis();
}

describe('★ the commit lag: a row stamped below the overlap but COMMITTED after the cursor', () => {
  /**
   * One conta whose cursor is `cursorMs`, one produto P with SKU-P, and P's row
   * stamped `carimboMs`; the clock one interval after the cursor. Returns the row's path.
   */
  function cenario(cursorMs: number, carimboMs: number): string {
    conta();
    sincronizacao(CONTA, { cursorMs });
    produto('P');
    vinculo('P', 'l1', 'SKU-P');
    agoraMs = cursorMs + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    return linha('P', carimboMs);
  }

  it('★ stamped cursor − 30 s, committed cursor + 1 s (after the tick that read at the cursor) ⇒ ONE delta task named by that commit, the cursor advanced', async () => {
    const cursorMs = proximoCommitMs() - 1_000;
    const caminho = cenario(cursorMs, cursorMs - 30_000);
    expect(commitMsDe(caminho)).toBe(cursorMs + 1_000);
    const r = unica(await tick());
    const commit = fake.carimboDe(caminho);
    if (commit === undefined) throw new Error('fixture');
    // A delta named by its observation (the tick enqueues every SKU as a delta;
    // that its window never forces is pinned in `descobertaEstoque.test.ts`).
    expect(enfileiradas).toEqual([
      {
        v: 1,
        contaId: CONTA,
        sku: 'SKU-P',
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
        referencia: referenciaDaObservacao(commit),
        depositoId: null,
      },
    ]);
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileirado,
      linhas: 1,
      skus: 1,
      tarefas: 1,
      cursorAvancou: true,
    });
    expect(consultasDaJanela()[0]?.filtros[1]).toEqual([
      'ultimaModificacao >',
      cursorMs - CINCO_MINUTOS_MS,
    ]);
    expect(fake.ler(sync())?.cursorMs).toBe(agoraMs);
  });

  it('★ NEAR-MISS: the same row committed at cursor − 21 s (the previous tick’s query read it) ⇒ returned, dropped, NO task — the cursor still advances', async () => {
    const cursorMs = proximoCommitMs() + 21_000;
    const caminho = cenario(cursorMs, cursorMs - 30_000);
    expect(commitMsDe(caminho)).toBe(cursorMs - 21_000);
    const r = unica(await tick());
    expect(enfileiradas).toEqual([]);
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia,
      linhas: 1,
      produtos: 0,
      skus: 0,
      cursorAvancou: true,
    });
    expect(leiturasEm('produtos/')).toEqual([]);
  });

  it('committed INSIDE the skew allowance (cursor − 10 s) ⇒ ONE task: the margin is the 20-s clock skew, never zero', async () => {
    const cursorMs = proximoCommitMs() + 10_000;
    const caminho = cenario(cursorMs, cursorMs - 30_000);
    expect(commitMsDe(caminho)).toBe(cursorMs - 10_000);
    expect(unica(await tick())).toMatchObject({ desfecho: 'enfileirado', linhas: 1, tarefas: 1 });
  });

  it('★ the residue: committed late but stamped cursor − 6 min ⇒ outside the range, NO task; stamped cursor − 4 min 59 s ⇒ ONE task', async () => {
    const cursorMs = proximoCommitMs() - 1_000;
    const caminho = cenario(cursorMs, cursorMs - 6 * 60_000);
    expect(commitMsDe(caminho)).toBe(cursorMs + 1_000);
    const r = unica(await tick());
    expect(r).toMatchObject({ desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia, linhas: 0 });
    expect(enfileiradas).toEqual([]);

    fake = new FakeDb();
    const outroCursorMs = proximoCommitMs() - 1_000;
    const outroCaminho = cenario(outroCursorMs, outroCursorMs - 4 * 60_000 - 59_000);
    expect(commitMsDe(outroCaminho)).toBe(outroCursorMs + 1_000);
    expect(unica(await tick())).toMatchObject({ desfecho: 'enfileirado', linhas: 1, tarefas: 1 });
  });

  it('★ a row stamped AND committed inside the overlap, read by two consecutive ticks ⇒ the SAME task name both times; the second enqueue meets ALREADY_EXISTS', async () => {
    const marco = proximoCommitMs();
    // The first tick reads at marco + 5 s; the row is stamped in the millisecond it commits in.
    const caminho = cenario(marco + 5_000 - INTERVALO_TICK_ESTOQUE_AMAZON_MS, marco);
    expect(commitMsDe(caminho)).toBe(marco);
    expect(unica(await tick())).toMatchObject({ tarefas: 1, jaEnfileiradas: 0 });
    agoraMs += INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    expect(unica(await tick())).toMatchObject({ tarefas: 0, jaEnfileiradas: 1 });
    const [primeira] = enfileiradas;
    const [segunda] = jaExistentes;
    if (primeira === undefined || segunda === undefined) throw new Error('duas tarefas esperadas');
    expect(enfileiradas).toHaveLength(1);
    expect(jaExistentes).toHaveLength(1);
    expect(nomeDaTarefaEstoque(segunda)).toBe(nomeDaTarefaEstoque(primeira));
    const commit = fake.carimboDe(caminho);
    if (commit === undefined) throw new Error('fixture');
    expect(segunda.referencia).toBe(referenciaDaObservacao(commit));
  });

  it('★ the cost: a row stamped in the 4 min 40 s below cursor − 20 s and committed long before is RETURNED and dropped — the idle tick’s operation count, no produto read', async () => {
    conta();
    sincronizacao();
    produto('P');
    vinculo('P', 'l1', 'SKU-P');
    const caminho = linha('P', CURSOR - 4 * 60_000);
    // Committed long before cursor − 20 s (the fake's clock starts at T0 − 7 h).
    expect(commitMsDe(caminho)).toBeLessThan(CURSOR - 20_000);
    const r = unica(await tick());
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia,
      paginas: 2,
      linhas: 1,
      produtos: 0,
      sondas: 0,
      skus: 0,
      cursorAvancou: true,
    });
    // EXACTLY the idle tick's count (its T4b getAll of the run and the lease included).
    expect(fake.contagem).toEqual({ leituras: 4, chamadasGetAll: 1, consultas: 3, escritas: 2 });
    expect(leiturasEm('produtos/')).toEqual([]);
    expect(listagens()).toEqual([]);
  });

  it('★ the cost: re-read rows count toward the page cap — 3,001 rows in that band, none kept, still truncate the window to the reconcile hand-off', async () => {
    conta();
    sincronizacao();
    let ultima = '';
    for (let i = 0; i < TETO_PAGINAS_JANELA * LINHAS_POR_PAGINA_JANELA + 1; i += 1) {
      ultima = linha(`P${String(i).padStart(5, '0')}`, CURSOR - 4 * 60_000);
    }
    // None kept: stamped below cursor − 20 s, and even the LAST row seeded
    // committed long before it.
    expect(commitMsDe(ultima)).toBeLessThan(CURSOR - 20_000);
    const r = unica(await tick());
    expect(r).toMatchObject({
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      entrega: 'pedido',
      truncada: true,
      paginas: TETO_PAGINAS_JANELA,
      produtos: 0,
    });
    // The reconcile hand-off is durable, so the cursor moves past the window.
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0 });
  });
});

describe('★ T7’s deadline: the cursor moves only past a window that was wholly enqueued', () => {
  it('★ a tick stopped after half its enqueues keeps the cursor; the next tick enqueues only the rest (ALREADY_EXISTS for the first half)', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 20);
    // The deadline passes once ten enqueues were started.
    const r1 = unica(await tick({ agora: () => (enfileiradas.length >= 10 ? T0 + 200_000 : T0) }));
    expect(r1).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.orcamentoEsgotado,
      motivo: MOTIVO_ESTOQUE_AMAZON.orcamentoEsgotado,
      orcamentoEsgotado: true,
      tarefas: 10,
      naoTentadas: 10,
      cursorAvancou: false,
    });
    expect(fake.ler(sync())).toMatchObject({ cursorMs: CURSOR, vez: null, falhasSeguidas: 1 });
    expect(linhaDaConta().nivel).toBe('warn');

    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r2 = unica(await tick());
    expect(r2).toMatchObject({ desfecho: 'enfileirado', tarefas: 10, jaEnfileiradas: 10 });
    expect(new Set(enfileiradas.map((t) => t.sku)).size).toBe(20);
    expect(enfileiradas).toHaveLength(20);
    expect(fake.ler(sync())).toMatchObject({ cursorMs: agoraMs, falhasSeguidas: 0 });
  });

  it('★ NEAR-MISS: a deadline that already passed before the batch starts NOTHING (checked before every enqueue)', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 3);
    // The clock passes the deadline once the partition was listed: the batch is next.
    const r = unica(await tick({ agora: () => (listagens().length > 0 ? T0 + 190_000 : T0) }));
    expect(enfileiradas).toEqual([]);
    expect(r).toMatchObject({ desfecho: 'orcamento-esgotado', tarefas: 0, naoTentadas: 3 });
  });

  it.each([
    [FOLGA_CONTA_ESTOQUE_AMAZON_MS + 1, 1, 0],
    [FOLGA_CONTA_ESTOQUE_AMAZON_MS, 0, 1],
  ])(
    '★ the deadline is the conta’s budget minus the 20-s margin: %i ms before the budget’s end ⇒ %i task(s) started',
    async (antesDoFim, tarefas, naoTentadas) => {
      conta();
      sincronizacao();
      produtoComVinculos('P', 1);
      const noLote = T0 + ORCAMENTO_CONTA_ESTOQUE_AMAZON_MS - antesDoFim;
      const r = unica(await tick({ agora: () => (listagens().length > 0 ? noLote : T0) }));
      expect(r).toMatchObject({ tarefas, naoTentadas });
    },
  );

  it('at most 16 enqueues in flight', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 30);
    let emVoo = 0;
    let maximo = 0;
    const produtor = criarProdutorEstoqueAmazon({
      desligado: false,
      fila: () => ({
        enqueue: async () => {
          emVoo += 1;
          maximo = Math.max(maximo, emVoo);
          await Promise.resolve();
          emVoo -= 1;
        },
      }),
    });
    const r = unica(await tick({ produtor: () => produtor }));
    expect(r.tarefas).toBe(30);
    expect(maximo).toBe(LARGURA_LOTE_ESTOQUE_AMAZON);
  });

  it.each([
    [
      'the stock queue’s valve',
      () => produtorGravador({ desligado: true }),
      new AmazonEstoqueTarefasDesligadasError().name,
    ],
    [
      'a named transient',
      () => produtorGravador({ falha: () => falhaDoFunctions('unavailable', 503) }),
      'AmazonTarefasTransitoriasError',
    ],
    [
      'a malformed queue region',
      () => produtorGravador({ falha: () => new AmazonEstoqueRegiaoDaFilaInvalidaError() }),
      'AmazonEstoqueRegiaoDaFilaInvalidaError',
    ],
    [
      'a missing queue region',
      () =>
        produtorGravador({
          falha: () => new MissingRegionError('teste: sem região', ['AMAZON_TASKS_REGION']),
        }),
      'MissingRegionError',
    ],
    [
      'a raw Cloud Tasks failure',
      () => produtorGravador({ falha: () => falhaDeConfiguracaoDoFunctions('projeto') }),
      descreverFalhaDoSdkDeTarefasAmazon(falhaDeConfiguracaoDoFunctions('projeto')),
    ],
  ])(
    'a contained enqueue failure (%s) keeps the cursor, names the class at WARNING, releases the lease — and the other conta still runs',
    async (_c, criar, erro) => {
      const OUTRA = 'conta-amz-tick-b';
      conta();
      conta(OUTRA);
      sincronizacao();
      sincronizacao(OUTRA);
      produtoComVinculos('P', 2);
      const produtor = criar();
      const r = await tick({ produtor: () => produtor });
      const porConta = Object.fromEntries(r.contas.map((c) => [c.contaId, c]));
      expect(porConta[CONTA]).toMatchObject({
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
        erro,
        cursorAvancou: false,
      });
      expect(porConta[OUTRA]).toMatchObject({ desfecho: 'janela-vazia', cursorAvancou: true });
      expect(fake.ler(sync())).toMatchObject({ cursorMs: CURSOR, vez: null, falhasSeguidas: 1 });
      expect(linhaDaConta()).toMatchObject({ nivel: 'warn', meta: { erro } });
    },
  );

  it('NEAR-MISS: an UNNAMED enqueue failure (a bug) is not contained — the tick rejects', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 2);
    const quebrado = produtorGravador({ falha: () => new TypeError('bug') });
    await expect(tick({ produtor: () => quebrado })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('★ T5–T6: a window the tick cannot map goes to a reconcile', () => {
  it('★ a truncated window (3,001 rows) ⇒ ZERO produto reads and ZERO partition listings, ONE reconcile request, the cursor ADVANCED past the window', async () => {
    conta();
    sincronizacao(CONTA, { falhasSeguidas: 2 });
    for (let i = 0; i < TETO_PAGINAS_JANELA * LINHAS_POR_PAGINA_JANELA + 1; i += 1) {
      linha(`P${String(i).padStart(5, '0')}`, MOVEU);
    }
    const r = unica(await tick());
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      motivo: MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
      entrega: 'pedido',
      truncada: true,
      paginas: TETO_PAGINAS_JANELA,
      produtos: 0,
      sondas: 0,
      cursorAvancou: true,
    });
    expect(listagens()).toEqual([]);
    // The one getAll is T4b's (the run and the lease): no produto is read.
    expect(leiturasEm('produtos/')).toEqual([]);
    // A TICK's request: never the loop-guarded automatic one.
    expect(fake.ler(PEDIDO)).toMatchObject({ pedidoEmMs: T0, reexecucaoAutomaticaEmMs: null });
    expect(doTipo('reconciliacao')).toHaveLength(1);
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0, vez: null, falhasSeguidas: 0 });
  });

  it('★ the reconcile request whose page-0 enqueue the jobs queue refuses ⇒ enfileiramento-falhou naming the class, the cursor KEPT (the next tick asks again)', async () => {
    conta();
    sincronizacao();
    for (let i = 0; i < TETO_PAGINAS_JANELA * LINHAS_POR_PAGINA_JANELA + 1; i += 1) {
      linha(`P${String(i).padStart(5, '0')}`, MOVEU);
    }
    const desligado = agendadorGravador({ desligado: true });
    const r = unica(await tick({ agendador: () => desligado }));
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      erro: new AmazonLotesTarefasDesligadasError().name,
      entrega: null,
      cursorAvancou: false,
    });
    expect(fake.ler(sync())).toMatchObject({ cursorMs: CURSOR, vez: null, falhasSeguidas: 1 });
    expect(linhaDaConta().nivel).toBe('warn');
  });

  it('★ a slow db (each listing 2 s) ⇒ the tick ends with the reconcile hand-off BEFORE its timeout, never killed by it', async () => {
    conta();
    sincronizacao();
    for (let i = 0; i < 200; i += 1) produtoComVinculos(`P${String(i).padStart(3, '0')}`, 1);
    const relogio = () => T0 + 2_000 * listagens().length;
    const r = unica(await tick({ agora: relogio }));
    expect(r).toMatchObject({
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      motivo: MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
      entrega: 'pedido',
      prazo: 'vinculos',
      tarefas: 0,
      cursorAvancou: true,
    });
    expect(r.sondas).toBeLessThan(200);
    expect(fake.ler(sync())?.falhasSeguidas).toBe(0);
    expect(fake.ler(PEDIDO)).toMatchObject({ pendente: false });
    // The final write landed, inside the function's timeout; the cursor is the window's end.
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0, vez: null });
    expect(fake.ler(sync())?.ultimoTickMs).toBeLessThan(
      T0 + TEMPO_LIMITE_TICK_ESTOQUE_AMAZON_S * 1000,
    );
  });

  it('★ a cursor older than 24 hours (the clamp) ⇒ ZERO window queries, the reconcile hand-off, the cursor ADVANCED to now', async () => {
    conta();
    const antigo = T0 - 25 * 60 * 60 * 1000;
    sincronizacao(CONTA, { cursorMs: antigo, falhasSeguidas: 2 });
    produtoComVinculos('P', 1);
    const r = unica(await tick());
    expect(r).toMatchObject({
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      motivo: MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
      entrega: 'pedido',
      truncada: true,
      paginas: 0,
    });
    expect(consultasDaJanela()).toEqual([]);
    expect(listagens()).toEqual([]);
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0, vez: null, falhasSeguidas: 0 });
  });

  it('★ the deadline BETWEEN window pages (T5) says the reads were slow, not how much moved: orcamento-esgotado at WARNING, the cursor kept, the counter + 1 — never a hand-off', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 1);
    const r = unica(
      await tick({ agora: () => (consultasDaJanela().length > 0 ? T0 + 190_000 : T0) }),
    );
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.orcamentoEsgotado,
      motivo: MOTIVO_ESTOQUE_AMAZON.orcamentoEsgotado,
      repasse: null,
      prazo: 'janela',
      orcamentoEsgotado: true,
      paginas: 1,
      tarefas: 0,
    });
    expect(listagens()).toEqual([]);
    expect(fake.ler(sync())).toMatchObject({ cursorMs: CURSOR, vez: null, falhasSeguidas: 1 });
    expect(linhaDaConta()).toMatchObject({
      nivel: 'warn',
      meta: { prazo: 'janela', repasse: null },
    });
  });

  it('★ NEAR-MISS: the deadline once the window is read, before the PRODUTOS (T6), is the reconcile hand-off', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 1);
    const r = unica(
      await tick({ agora: () => (consultasDaJanela().length >= 2 ? T0 + 190_000 : T0) }),
    );
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      motivo: MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
      entrega: 'pedido',
      prazo: 'produtos',
      paginas: 2,
    });
    // The window's end is T0 (planned before the clock jumped), and it is durable in the request.
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0, falhasSeguidas: 0 });
    expect(fake.ler(PEDIDO)).toMatchObject({ pendente: false });
  });

  it('a cursor ahead of this clock by more than the overlap ⇒ nothing read, the cursor kept', async () => {
    conta();
    sincronizacao(CONTA, { cursorMs: T0 + 60_000, falhasSeguidas: 2 });
    const r = unica(await tick());
    expect(r.desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.cursorAdiantado);
    expect(consultasDaJanela()).toEqual([]);
    expect(fake.ler(sync())).toMatchObject({
      cursorMs: T0 + 60_000,
      vez: null,
      falhasSeguidas: 2,
    });
  });

  it('★ a FAR-FUTURE cursor (the planner’s RangeError) ⇒ janela-invalida naming it, ONE reconcile request, the cursor RESET to now (below the stored one); the next conta still runs', async () => {
    const OUTRA = 'conta-amz-tick-b';
    conta();
    conta(OUTRA);
    sincronizacao(CONTA, { cursorMs: T0 + 2 * 86_400_000 });
    sincronizacao(OUTRA);
    const r = await tick();
    // The far-future conta runs FIRST in this tick's rotation, so the other
    // conta's run is what shows the tick went on past it.
    expect(r.contas.map((c) => c.contaId)).toEqual([CONTA, OUTRA]);
    const porConta = Object.fromEntries(r.contas.map((c) => [c.contaId, c]));
    expect(porConta[CONTA]).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaInvalida,
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      entrega: 'pedido',
      erro: 'RangeError',
      cursorAvancou: true,
    });
    expect(porConta[OUTRA]).toMatchObject({ desfecho: 'janela-vazia', cursorAvancou: true });
    // NEAR-MISS: an advance-only write would keep the bad cursor, and every
    // tick would refuse it again.
    expect(fake.ler(sync())).toMatchObject({ cursorMs: T0, vez: null, falhasSeguidas: 1 });
    // No window was planned for this conta: the two window queries are the other conta's.
    expect(consultasDaJanela()).toHaveLength(2);
    expect(fake.ler(PEDIDO)).toMatchObject({ pedidoEmMs: T0 });
    expect(linhaDaConta()).toMatchObject({ nivel: 'warn', meta: { erro: 'RangeError' } });
    expect(linhaDaConta(OUTRA).nivel).toBe('info');

    // The next tick reads its window from the reset cursor.
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r2 = await tick();
    expect(r2.contas.find((c) => c.contaId === CONTA)?.desfecho).toBe('janela-vazia');
  });

  it('★ NEAR-MISS: a RangeError from the window READS is not the planner’s — never contained, the tick rejects with that very error', async () => {
    conta();
    sincronizacao();
    const falha = new RangeError('teste: leitura');
    fake.falharConsulta('estoques', falha);
    await expect(tick()).rejects.toBe(falha);
    expect(linhasDoTick().filter((l) => l.meta?.desfecho === 'janela-invalida')).toEqual([]);
  });

  it('★ NEAR-MISS: anything ELSE the planner throws is a bug, never caught as an Error — the tick rejects', async () => {
    conta();
    sincronizacao();
    planejador.falha = new TypeError('teste: um defeito do planejador');
    await expect(tick()).rejects.toBeInstanceOf(TypeError);
    // The real planner again, once the failed run's lease expired: the same
    // conta reads its window.
    planejador.falha = null;
    agoraMs += INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    expect(unica(await tick()).desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia);
  });
});

describe('★ T4: the first tick, the depósito of the cursor, and the lease', () => {
  it('a first tick (no sync document) stores the cursor at now and the depósito CANONICAL — and reads no window', async () => {
    conta(CONTA, { deposito: NUA });
    const r = unica(await tick());
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.primeiroTick,
      cursorAvancou: true,
    });
    expect(consultasDaJanela()).toEqual([]);
    expect(fake.escritasEm(sync()).map((e) => e.verbo)).toEqual(['create', 'update']);
    expect(fake.ler(sync())).toEqual({
      cursorMs: T0,
      depositoDoCursor: CANONICA,
      vez: null,
      ultimoTickMs: T0,
      falhasSeguidas: 0,
      semDeposito: false,
    });
  });

  it('★ the conta’s depósito changed between two ticks ⇒ ZERO window queries from the old cursor, ONE reconcile request (a run at the NEW depósito), then the cursor and depositoDoCursor RESET there — once: the next tick reads its window', async () => {
    const ANTIGO = 'documents/depositos/dep-antigo';
    conta();
    // The old cursor sits ahead of now: the reset is not advance-only.
    sincronizacao(CONTA, { cursorMs: T0 + 10_000, depositoDoCursor: ANTIGO, falhasSeguidas: 2 });
    produtoComVinculos('P', 1);
    const r = unica(await tick());
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      motivo: MOTIVO_ESTOQUE_AMAZON.depositoMudou,
      entrega: 'pedido',
      cursorAvancou: true,
    });
    expect(linhaDaConta()).toMatchObject({
      nivel: 'warn',
      meta: { repasse: 'reconciliacao-necessaria', motivo: 'deposito-mudou' },
    });
    expect(consultasDaJanela()).toEqual([]);
    expect(enfileiradas).toEqual([]);
    expect(fake.ler(RUN)).toMatchObject({ fase: 'varrendo', depositoOuterRef: CANONICA });
    expect(doTipo('reconciliacao')).toHaveLength(1);
    expect(fake.ler(sync())).toMatchObject({
      cursorMs: T0,
      depositoDoCursor: CANONICA,
      vez: null,
      falhasSeguidas: 0,
    });

    // The next tick: the cursor's depósito is the conta's, a window is read, no second request.
    agoraMs += INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r2 = unica(await tick());
    expect(r2).toMatchObject({ desfecho: 'janela-vazia', repasse: null });
    expect(consultasDaJanela()).toHaveLength(2);
    expect(doTipo('reconciliacao')).toHaveLength(1);
  });

  it('NEAR-MISS: the depósito change whose request the jobs queue refuses KEEPS the cursor and the old depósito: the next tick asks again', async () => {
    const ANTIGO = 'documents/depositos/dep-antigo';
    conta();
    sincronizacao(CONTA, { depositoDoCursor: ANTIGO });
    const desligado = agendadorGravador({ desligado: true });
    const r = unica(await tick({ agendador: () => desligado }));
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
      motivo: MOTIVO_ESTOQUE_AMAZON.depositoMudou,
      cursorAvancou: false,
    });
    expect(fake.ler(sync())).toMatchObject({ cursorMs: CURSOR, depositoDoCursor: ANTIGO });
  });

  it('NEAR-MISS: the conta holding the BARE form of the cursor’s depósito is the same depósito — one parse, the window is read', async () => {
    conta(CONTA, { deposito: NUA });
    sincronizacao();
    const r = unica(await tick());
    expect(r.desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia);
    expect(consultasDaJanela()).toHaveLength(2);
  });

  it('a lease another tick holds ⇒ that conta is skipped, nothing written; at the very instant it expires it is taken', async () => {
    conta();
    sincronizacao(CONTA, { vez: { execucaoId: 'outro-tick', ateMs: T0 + 1 } });
    const r = unica(await tick());
    expect(r.desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.leaseOcupado);
    expect(fake.escritas).toEqual([]);
    expect(consultasDaJanela()).toEqual([]);
    agoraMs = T0 + 1;
    expect(unica(await tick()).desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia);
  });

  it('the lease write: 270 s after the tick’s start, preconditioned on the read', async () => {
    conta();
    sincronizacao();
    let vez: unknown = null;
    fake.antesDaProximaEscrita(sync(), () => undefined);
    fake.antesDaProximaEscrita(sync(), () => {
      vez = fake.ler(sync())?.vez;
    });
    await tick();
    expect(vez).toEqual({ execucaoId: 'exec-1', ateMs: T0 + LEASE_TICK_ESTOQUE_AMAZON_MS });
    expect(fake.escritasEm(sync())[0]).toMatchObject({ verbo: 'update', comPrecondicao: true });
  });

  it('★ every lease of a tick runs to 270 s after the TICK’s start: a conta reached 170 s in holds it only until then, so the next tick takes it after a crash', async () => {
    const OUTRA = 'conta-amz-tick-b';
    conta();
    conta(OUTRA);
    sincronizacao();
    sincronizacao(OUTRA);
    const [primeira, segunda] = ordemDoTickEstoqueAmazon([CONTA, OUTRA], T0);
    if (primeira === undefined || segunda === undefined) throw new Error('fixture');
    // The first conta's run takes 170 s: the second is started with its minimum budget.
    const TARDE = T0 + ORCAMENTO_TICK_ESTOQUE_AMAZON_MS - ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS;
    fake.antesDaProximaEscrita(sync(primeira), () => undefined);
    fake.antesDaProximaEscrita(sync(primeira), () => {
      agoraMs = TARDE;
    });
    // The second conta's run dies before its final write: its lease is left behind.
    let vez: unknown = null;
    fake.antesDaProximaEscrita(sync(segunda), () => undefined);
    fake.antesDaProximaEscrita(sync(segunda), () => {
      vez = fake.ler(sync(segunda))?.vez;
      throw grpc(14, 'UNAVAILABLE');
    });
    const r = await tick();
    expect(r.contas.map((c) => [c.contaId, c.desfecho])).toEqual([
      [primeira, 'janela-vazia'],
      [segunda, 'erro-firestore'],
    ]);
    // NEAR-MISS: timed from the conta's own start it would run to TARDE + 270 s,
    // past the next tick's start, and that tick would skip the conta.
    expect(vez).toEqual({ execucaoId: 'exec-2', ateMs: T0 + LEASE_TICK_ESTOQUE_AMAZON_MS });
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r2 = await tick();
    expect(r2.contas.find((c) => c.contaId === segunda)?.desfecho).toBe('janela-vazia');
    expect(fake.ler(sync(segunda))?.vez).toBeNull();
  });

  it('a final write that loses its precondition TWICE under our own lease writes nothing (lease-perdido): the lease is left to expire', async () => {
    conta();
    sincronizacao();
    const tocar = () => {
      fake.seed(sync(), { ...fake.ler(sync()), ultimoTickMs: 1 });
    };
    fake.antesDaProximaEscrita(sync(), () => undefined); // the lease
    fake.antesDaProximaEscrita(sync(), tocar); // the final write
    fake.antesDaProximaEscrita(sync(), tocar); // its one retry
    const r = unica(await tick());
    expect(r.desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.leasePerdido);
    expect(fake.ler(sync())).toMatchObject({
      cursorMs: CURSOR,
      ultimoTickMs: 1,
      vez: { execucaoId: 'exec-1' },
    });
  });

  it('the sync document DELETED under our lease ⇒ lease-perdido, and the final write never re-creates it', async () => {
    conta();
    sincronizacao();
    fake.antesDaProximaEscrita(sync(), () => undefined); // the lease
    fake.antesDaProximaEscrita(sync(), () => {
      fake.apagar(sync());
    });
    const r = unica(await tick());
    expect(r.desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.leasePerdido);
    expect(fake.ler(sync())).toBeUndefined();
  });

  it('another tick taking the EXPIRED lease between the read and the lease write (FAILED_PRECONDITION) ⇒ lease-ocupado, nothing written', async () => {
    conta();
    sincronizacao();
    fake.antesDaProximaEscrita(sync(), () => {
      fake.seed(sync(), {
        ...fake.ler(sync()),
        vez: { execucaoId: 'outro-tick', ateMs: T0 + 100_000 },
      });
    });
    const r = unica(await tick());
    expect(r.desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.leaseOcupado);
    expect(fake.escritas).toEqual([]);
    expect(consultasDaJanela()).toEqual([]);
  });

  it('another tick creating the document first (ALREADY_EXISTS) ⇒ lease-ocupado, nothing more written', async () => {
    conta();
    fake.antesDaProximaEscrita(sync(), () => {
      fake.seed(sync(), { vez: { execucaoId: 'outro-tick', ateMs: T0 + 100_000 } });
    });
    const r = unica(await tick());
    expect(r.desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.leaseOcupado);
    expect(fake.escritas).toEqual([]);
  });

  it('the final write that lost its precondition to ANOTHER tick’s lease writes nothing (lease-perdido)', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 1);
    fake.antesDaProximaEscrita(sync(), () => undefined); // the lease
    fake.antesDaProximaEscrita(sync(), () => {
      fake.seed(sync(), {
        ...fake.ler(sync()),
        vez: { execucaoId: 'outro-tick', ateMs: T0 + 300_000 },
      });
    });
    const r = unica(await tick());
    expect(r.desfecho).toBe(DESFECHO_TICK_ESTOQUE_AMAZON.leasePerdido);
    expect(fake.ler(sync())).toMatchObject({
      cursorMs: CURSOR,
      vez: { execucaoId: 'outro-tick' },
    });
    expect(linhaDaConta().nivel).toBe('warn');
  });

  it('a final write whose precondition failed while the lease is STILL ours is RE-DERIVED from the re-read: the cursor never moves below the stored one', async () => {
    conta();
    sincronizacao();
    fake.antesDaProximaEscrita(sync(), () => undefined); // the lease
    fake.antesDaProximaEscrita(sync(), () => {
      // A hand edit under our lease: the cursor pushed past the window's end.
      fake.seed(sync(), { ...fake.ler(sync()), cursorMs: T0 + 50_000, falhasSeguidas: 3 });
    });
    const r = unica(await tick());
    expect(r).toMatchObject({ desfecho: 'janela-vazia', cursorAvancou: false });
    expect(fake.ler(sync())).toMatchObject({
      cursorMs: T0 + 50_000,
      vez: null,
      falhasSeguidas: 0,
      ultimoTickMs: T0,
    });
  });
});

describe('★ T7: 31–3,000 SKUs in the form the stock valve gives a batch', () => {
  const ligado = (canario: string | undefined) => ({
    AMAZON_CHAMADAS: 'on',
    [VALVULA_ENV_AMAZON.estoque]: 'on',
    [CANARIO_ENV_AMAZON.estoque]: canario,
  });

  it('★ under a canary LIST ⇒ ONLY the canary’s SKUs, as named patch tasks per observation; the others counted, no feed-enviar; the cursor advanced', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', LIMIAR_FEED_ESTOQUE_AMAZON + 1);
    const lista = `${CONTA}:P-0003,${CONTA}:P-0007,outra-conta:P-0001`;
    const r = unica(await tick({ ambiente: ligado(lista) }));
    expect(enfileiradas.map((t) => [t.sku, t.origem])).toEqual([
      ['P-0003', 'delta'],
      ['P-0007', 'delta'],
    ]);
    expect(lotes).toEqual([]);
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileirado,
      motivo: MOTIVO_ESTOQUE_AMAZON.emPatches,
      repasse: null,
      skus: 31,
      tarefas: 2,
      foraDoCanario: 29,
      cursorAvancou: true,
    });
    expect(linhaDaConta().meta).toMatchObject({ foraDoCanario: 29 });
  });

  it.each([
    ['on with the canary exactly *', '*'],
    ['on with no canary list (a dry-run of the batch)', undefined],
  ])('NEAR-MISS: %s ⇒ the window feed-enviar, zero patch tasks', async (_c, canario) => {
    conta();
    sincronizacao();
    produtoComVinculos('P', LIMIAR_FEED_ESTOQUE_AMAZON + 1);
    const r = unica(await tick({ ambiente: ligado(canario) }));
    expect(enfileiradas).toEqual([]);
    expect(doTipo('feed-enviar')).toHaveLength(1);
    expect(r).toMatchObject({ repasse: 'feed-necessario', foraDoCanario: 0, cursorAvancou: true });
  });

  it.each([
    [
      'the jobs queue’s valve',
      () => agendadorGravador({ desligado: true }),
      'AmazonLotesTarefasDesligadasError',
    ],
    [
      'a named transient',
      () => agendadorGravador({ falha: () => falhaDoFunctions('unavailable', 503) }),
      'AmazonTarefasTransitoriasError',
    ],
    [
      'a missing queue region',
      () =>
        agendadorGravador({
          falha: () => new MissingRegionError('teste: sem região', ['AMAZON_TASKS_REGION']),
        }),
      'MissingRegionError',
    ],
    [
      'a raw Cloud Tasks failure',
      () => agendadorGravador({ falha: () => falhaDeConfiguracaoDoFunctions('projeto') }),
      descreverFalhaDoSdkDeTarefasAmazon(falhaDeConfiguracaoDoFunctions('projeto')),
    ],
  ])(
    '★ the delta feed’s enqueue refused (%s) ⇒ enfileiramento-falhou naming the class, the cursor KEPT, the lease released',
    async (_c, criar, erro) => {
      conta();
      sincronizacao();
      produtoComVinculos('P', LIMIAR_FEED_ESTOQUE_AMAZON + 1);
      const agendador = criar();
      const r = unica(await tick({ agendador: () => agendador }));
      expect(r).toMatchObject({
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
        repasse: REPASSE_TICK_ESTOQUE_AMAZON.feedNecessario,
        entrega: null,
        erro,
        cursorAvancou: false,
      });
      expect(fake.ler(sync())).toMatchObject({ cursorMs: CURSOR, vez: null, falhasSeguidas: 1 });
      expect(linhaDaConta()).toMatchObject({ nivel: 'warn', meta: { erro } });
    },
  );

  it('NEAR-MISS: an UNNAMED failure of the jobs producer (a bug) is not contained — the tick rejects', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', LIMIAR_FEED_ESTOQUE_AMAZON + 1);
    const quebrado = agendadorGravador({ falha: () => new TypeError('bug') });
    await expect(tick({ agendador: () => quebrado })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('★ T4b: the reconcile run re-kicked, the stranded start recovered', () => {
  const MIN = 60_000;
  /** A live run of the conta, its last progress `parado` ms ago. */
  function runVivo(parado: number, over: DocData = {}): void {
    fake.seed(RUN, {
      execucaoId: 'run-velho',
      fase: 'varrendo',
      depositoOuterRef: CANONICA,
      proximaPagina: 2,
      paginas: 2,
      progressoEmMs: T0 - parado,
      iniciadaEmMs: T0 - 60 * MIN,
      ...over,
    });
  }
  /** The stock feed lease: `montando`, expiring at `ateMs`, holding `pendenteDesdeMs`. */
  function vez(over: DocData = {}): void {
    fake.seed(VEZ, {
      estado: 'montando',
      execucaoId: 'exec-morto',
      ateMs: T0 - 1,
      atualizadoEmMs: T0 - 11 * MIN,
      pendenteDesdeMs: T0 - 30 * MIN,
      ...over,
    });
  }

  it('★ a live run 16 min without progress ⇒ its page proximaPagina RE-KICKED, named by the stall; a second tick over the same stall is ALREADY_EXISTS', async () => {
    conta();
    sincronizacao();
    runVivo(16 * MIN);
    const r = unica(await tick());
    expect(r).toMatchObject({ desfecho: 'janela-vazia', retomada: 'retomada' });
    expect(doTipo('reconciliacao')).toEqual([
      {
        tarefa: { v: 1, tipo: 'reconciliacao', contaId: CONTA, execucaoId: 'run-velho', pagina: 2 },
        id: nomeRetomadaReconciliacao(CONTA, 'run-velho', 2, T0 - 16 * MIN),
        atrasoS: 0,
      },
    ]);
    // The re-kick writes nothing: the run is the page's to move.
    expect(escritasEm(RUN)).toEqual([]);
    agoraMs += INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    expect(unica(await tick())).toMatchObject({ retomada: 'ja-retomada' });
    expect(doTipo('reconciliacao')).toHaveLength(1);
    expect(lotesJaExistentes).toHaveLength(1);
  });

  it('★ a crash after the claim and before page 0’s enqueue (no progress yet) ⇒ the next tick ≥ 15 min later re-enqueues page 0, named by the claim', async () => {
    conta();
    sincronizacao();
    runVivo(0, { proximaPagina: 0, paginas: 0, progressoEmMs: null, iniciadaEmMs: T0 - 16 * MIN });
    expect(unica(await tick())).toMatchObject({ retomada: 'retomada' });
    expect(doTipo('reconciliacao').map((l) => [l.tarefa, l.id])).toEqual([
      [
        { v: 1, tipo: 'reconciliacao', contaId: CONTA, execucaoId: 'run-velho', pagina: 0 },
        nomeRetomadaReconciliacao(CONTA, 'run-velho', 0, T0 - 16 * MIN),
      ],
    ]);
  });

  it.each([
    ['14 min stale', 14 * MIN, {}],
    ['EXACTLY 15 min stale', RETOMADA_RECONCILIACAO_MS, {}],
    ['ended (concluida), 3 h ago', 3 * 60 * MIN, { fase: 'concluida' }],
  ])('NEAR-MISS: a run %s ⇒ no re-kick', async (_c, parado, over) => {
    conta();
    sincronizacao();
    runVivo(parado, over);
    expect(unica(await tick())).toMatchObject({ desfecho: 'janela-vazia', retomada: null });
    expect(lotes).toEqual([]);
  });

  it('★ the stranded start: an EXPIRED montando lease holding a start ⇒ ONE named vez recovery FIRST, then the start cleared; a second tick does nothing', async () => {
    conta();
    sincronizacao();
    vez();
    let antesDaEscrita = -1;
    fake.antesDaProximaEscrita(VEZ, () => {
      antesDaEscrita = doTipo('feed-recuperar').length;
    });
    const r = unica(await tick());
    expect(r).toMatchObject({ desfecho: 'janela-vazia', inicioRecuperado: true });
    expect(doTipo('feed-recuperar')).toEqual([
      {
        tarefa: {
          v: 1,
          tipo: 'feed-recuperar',
          fluxo: 'estoque',
          contaId: CONTA,
          desfecho: 'vez',
          feedId: null,
          execucaoId: 'exec-morto',
          snapshotEmMs: null,
          pendenteDesdeMs: T0 - 30 * MIN,
          janela: null,
        },
        id: nomeRecuperacaoFeed(CONTA, referenciaVezFeed('exec-morto'), T0 - 30 * MIN),
        atrasoS: 0,
      },
    ]);
    // NEAR-MISS: a start cleared before its recovery is durable would be lost to a crash.
    expect(antesDaEscrita).toBe(1);
    expect(fake.ler(VEZ)).toMatchObject({
      estado: 'montando',
      execucaoId: 'exec-morto',
      pendenteDesdeMs: null,
      atualizadoEmMs: T0,
    });
    expect(escritasEm(VEZ).map((e) => [e.verbo, e.comPrecondicao])).toEqual([['update', true]]);
    agoraMs += INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    expect(unica(await tick())).toMatchObject({ inicioRecuperado: false });
    expect(doTipo('feed-recuperar')).toHaveLength(1);
    expect(escritasEm(VEZ)).toHaveLength(1);
  });

  it('NEAR-MISS: a lease another holder took between T4b’s getAll and the lease I/O’s own re-read ⇒ nothing recovered, nothing written, inicioRecuperado false', async () => {
    conta();
    sincronizacao();
    vez();
    const base = asDb(fake) as unknown as Record<string | symbol, unknown>;
    let tomada = false;
    const db = new Proxy(base, {
      get(t, prop) {
        const v: unknown = Reflect.get(t, prop, t);
        if (typeof v !== 'function') return v;
        const f = v as (...a: unknown[]) => Promise<unknown>;
        if (prop !== 'getAll') return f.bind(t);
        return async (...a: unknown[]) => {
          const r = await f.apply(t, a);
          if (!tomada) {
            tomada = true;
            // Right after T4b's read: a live holder takes the lease over.
            fake.seed(VEZ, {
              estado: 'montando',
              execucaoId: 'exec-novo',
              ateMs: T0 + 10 * MIN,
              atualizadoEmMs: T0,
              pendenteDesdeMs: T0 - 30 * MIN,
            });
          }
          return r;
        };
      },
    }) as unknown as Firestore;
    expect(unica(await tick({ db }))).toMatchObject({
      desfecho: 'janela-vazia',
      inicioRecuperado: false,
    });
    expect(doTipo('feed-recuperar')).toEqual([]);
    expect(escritasEm(VEZ)).toEqual([]);
  });

  it('★ a re-run after the clearing write was lost ⇒ the recovery answers ALREADY_EXISTS and the start is cleared ONCE', async () => {
    conta();
    sincronizacao();
    vez();
    fake.antesDaProximaEscrita(VEZ, () => {
      throw grpc(14, 'UNAVAILABLE');
    });
    expect(unica(await tick())).toMatchObject({ desfecho: 'erro-firestore', codigoGrpc: 14 });
    expect(doTipo('feed-recuperar')).toHaveLength(1);
    expect(fake.ler(VEZ)?.pendenteDesdeMs).toBe(T0 - 30 * MIN);
    // The dead run's lease of the sync document expires; the next tick takes over.
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    expect(unica(await tick())).toMatchObject({ inicioRecuperado: true });
    expect(doTipo('feed-recuperar')).toHaveLength(1);
    expect(lotesJaExistentes).toHaveLength(1);
    expect(fake.ler(VEZ)?.pendenteDesdeMs).toBeNull();
    expect(escritasEm(VEZ)).toHaveLength(1);
  });

  it.each([
    ['an UNEXPIRED montando with a start (its holder may still release it)', { ateMs: T0 + 1 }],
    ['an expired montando with NO start', { pendenteDesdeMs: null }],
    [
      'an expired enviando with a start (the uncertain path’s, never the tick’s)',
      { estado: 'enviando', antesDoEnvioMs: T0 - 20 * MIN },
    ],
  ])('NEAR-MISS: %s ⇒ nothing enqueued, nothing written, the lease read ONCE', async (_c, over) => {
    conta();
    sincronizacao();
    vez(over);
    expect(unica(await tick())).toMatchObject({
      desfecho: 'janela-vazia',
      inicioRecuperado: false,
    });
    expect(lotes).toEqual([]);
    expect(escritasEm(VEZ)).toEqual([]);
    expect(leiturasEm(VEZ)).toHaveLength(1);
  });

  it('★ the jobs queue refusing T4b’s enqueue ⇒ enfileiramento-falhou naming the class, NO window read, the start KEPT, the lease released', async () => {
    conta();
    sincronizacao();
    vez();
    produtoComVinculos('P', 1);
    const desligado = agendadorGravador({ desligado: true });
    const r = unica(await tick({ agendador: () => desligado }));
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
      erro: 'AmazonLotesTarefasDesligadasError',
      inicioRecuperado: false,
      cursorAvancou: false,
    });
    expect(consultasDaJanela()).toEqual([]);
    expect(enfileiradas).toEqual([]);
    expect(fake.ler(VEZ)?.pendenteDesdeMs).toBe(T0 - 30 * MIN);
    expect(fake.ler(sync())).toMatchObject({ cursorMs: CURSOR, vez: null, falhasSeguidas: 1 });
  });

  it.each([
    [
      'the reconcile run',
      () =>
        fake.seed(RUN, {
          execucaoId: 'run-velho',
          fase: 'outra',
          depositoOuterRef: CANONICA,
          iniciadaEmMs: T0,
        }),
      'ReconciliacaoEstoqueDocumentoInvalidoError',
      'fase',
    ],
    [
      'the stock feed lease',
      () => fake.seed(VEZ, { estado: 'livre' }),
      'AmazonVezFeedInvalidaError',
      'ateMs,atualizadoEmMs',
    ],
  ])(
    'a stored %s that no longer parses costs ONLY its own step: named with its fields at WARNING, and the window is still read (NEAR-MISS: the delta path halted as documento-invalido); the other conta still runs',
    async (_c, semear, erro, campos) => {
      const OUTRA = 'conta-amz-tick-b';
      conta();
      conta(OUTRA);
      sincronizacao();
      sincronizacao(OUTRA);
      semear();
      const r = await tick();
      const porConta = Object.fromEntries(r.contas.map((c) => [c.contaId, c]));
      expect(porConta[CONTA]).toMatchObject({
        desfecho: 'janela-vazia',
        manutencaoInvalida: `${erro}:${campos}`,
        retomada: null,
        inicioRecuperado: false,
        erro: null,
      });
      expect(porConta[CONTA]?.paginas).toBeGreaterThan(0);
      expect(porConta[OUTRA]).toMatchObject({ desfecho: 'janela-vazia', manutencaoInvalida: null });
      expect(linhaDaConta().nivel).toBe('warn');
    },
  );

  it('a lease write that keeps losing its precondition ⇒ conflito (contained: the next tick re-derives); the other conta still runs', async () => {
    const OUTRA = 'conta-amz-tick-b';
    conta();
    conta(OUTRA);
    sincronizacao();
    sincronizacao(OUTRA);
    vez();
    const tocar = () => {
      fake.seed(VEZ, { ...fake.ler(VEZ), atualizadoEmMs: T0 - 10 * MIN });
    };
    fake.antesDaProximaEscrita(VEZ, tocar);
    fake.antesDaProximaEscrita(VEZ, tocar);
    fake.antesDaProximaEscrita(VEZ, tocar);
    const r = await tick();
    const porConta = Object.fromEntries(r.contas.map((c) => [c.contaId, c]));
    expect(porConta[CONTA]).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.conflito,
      erro: 'AmazonVezFeedEmConflitoError',
    });
    expect(porConta[OUTRA]).toMatchObject({ desfecho: 'janela-vazia' });
    expect(fake.ler(VEZ)?.pendenteDesdeMs).toBe(T0 - 30 * MIN);
    expect(linhaDaConta().nivel).toBe('warn');
  });
});

describe('★ semDeposito: the aviso only on a TRANSITION, and before the flag', () => {
  it('★ false → true: the aviso RAISED once, clocked by the sync document’s read, before the flag is stored — and no window read', async () => {
    conta(CONTA, { deposito: null });
    sincronizacao(CONTA, { falhasSeguidas: 2 });
    const r = unica(await tick());
    expect(r).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.semDeposito,
      motivo: MOTIVO_ESTOQUE_AMAZON.contaSemDeposito,
      aviso: 'levantado',
      semDeposito: true,
    });
    expect(consultasDaJanela()).toEqual([]);
    const aviso = fake.ler(avisoSemDeposito());
    const lease = fake.escritasEm(sync())[0];
    if (lease === undefined) throw new Error('sem lease');
    expect(aviso).toMatchObject({ motivo: 'estoque-sem-deposito', resolvidoEm: null });
    // The T4 read happened right before the lease write took the next stamp.
    expect(aviso?.relogioEvento).toBe(relogioDoDocumentoUs(lease.writeTime) - 1);
    // The aviso landed BEFORE the final write.
    const ordem = fake.escritas.map((e) => e.caminho);
    expect(ordem.indexOf(avisoSemDeposito())).toBeLessThan(ordem.lastIndexOf(sync()));
    expect(fake.ler(sync())).toMatchObject({
      semDeposito: true,
      cursorMs: CURSOR,
      vez: null,
      falhasSeguidas: 2,
    });
    expect(linhaDaConta().nivel).toBe('warn');
  });

  it('★ true → true: NO aviso call at all (no aviso read or write)', async () => {
    conta(CONTA, { deposito: null });
    sincronizacao(CONTA, { semDeposito: true });
    const r = unica(await tick());
    expect(r).toMatchObject({ aviso: null, semDeposito: true });
    expect(leiturasEm('avisos/')).toEqual([]);
    expect(escritasEm('avisos/')).toEqual([]);
    // T4b's one getAll (the run and the lease) runs whatever the depósito.
    expect(fake.contagem).toEqual({ leituras: 4, chamadasGetAll: 1, consultas: 1, escritas: 2 });
  });

  it('★ true → false: the aviso RESOLVED once, and the window is read', async () => {
    conta();
    sincronizacao(CONTA, { semDeposito: true });
    const r = unica(await tick());
    expect(r).toMatchObject({ aviso: 'resolvido', semDeposito: false, desfecho: 'janela-vazia' });
    expect(fake.ler(avisoSemDeposito())?.resolvidoEm).not.toBeNull();
    expect(fake.ler(sync())).toMatchObject({ semDeposito: false, cursorMs: T0 });
  });

  it('a conta whose depósito ref names no depósito (another collection) counts as none', async () => {
    conta(CONTA, { deposito: 'documents/clientes/x' });
    sincronizacao();
    expect(unica(await tick())).toMatchObject({ desfecho: 'sem-deposito', aviso: 'levantado' });
  });

  it('a depósito whose id the stock documents cannot store (outside their id grammar) counts as none — nothing thrown', async () => {
    conta(CONTA, { deposito: 'documents/depositos/dep.ponto' });
    sincronizacao();
    expect(unica(await tick())).toMatchObject({ desfecho: 'sem-deposito', aviso: 'levantado' });
    expect(consultasDaJanela()).toEqual([]);
  });

  it('★ the aviso write THROWING ⇒ that conta fails (contained), the stored flag is UNCHANGED, and the next tick raises it', async () => {
    conta(CONTA, { deposito: null });
    sincronizacao();
    fake.falharEscrita(avisoSemDeposito(), grpc(14, 'UNAVAILABLE'));
    const r1 = unica(await tick());
    expect(r1).toMatchObject({
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.erroFirestore,
      codigoGrpc: 14,
    });
    // NEAR-MISS: a flag committed first would read `true → true` next tick, and never raise.
    expect(fake.ler(sync())).toMatchObject({ semDeposito: false });
    expect(linhaDaConta().nivel).toBe('warn');

    fake.falharEscrita(avisoSemDeposito(), null);
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS; // the dead tick's lease has expired
    espiao = loggerEspiao();
    const r2 = unica(await tick({ logger: espiao.logger }));
    expect(r2).toMatchObject({ aviso: 'levantado', semDeposito: true });
    expect(fake.ler(avisoSemDeposito())?.resolvidoEm).toBeNull();
    expect(fake.ler(sync())).toMatchObject({ semDeposito: true, vez: null });
  });

  it('★ a raise that LANDED before a lost final write is RESOLVED by the first run that takes over the unreleased lease once the depósito is set — though the flag never moved', async () => {
    conta(CONTA, { deposito: null });
    sincronizacao();
    fake.antesDaProximaEscrita(sync(), () => undefined); // the lease
    fake.antesDaProximaEscrita(sync(), () => {
      throw grpc(14, 'UNAVAILABLE'); // the final write is lost
    });
    expect(unica(await tick())).toMatchObject({ desfecho: 'erro-firestore', codigoGrpc: 14 });
    expect(fake.ler(avisoSemDeposito())?.resolvidoEm).toBeNull();
    expect(fake.ler(sync())).toMatchObject({ semDeposito: false, vez: { execucaoId: 'exec-1' } });

    conta(); // the depósito is set
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS; // the dead run's lease has expired
    const r2 = unica(await tick());
    // NEAR-MISS: gated on the transition alone (false → false), no aviso call — open forever.
    expect(r2).toMatchObject({ desfecho: 'janela-vazia', aviso: 'resolvido', semDeposito: false });
    expect(fake.ler(avisoSemDeposito())?.resolvidoEm).not.toBeNull();
    expect(fake.ler(sync())).toMatchObject({ semDeposito: false, vez: null });

    // The steady state again (a released lease, the flag unchanged): no aviso call.
    const leituras = leiturasEm('avisos/').length;
    const escritas = escritasEm('avisos/').length;
    agoraMs += INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    expect(unica(await tick()).aviso).toBeNull();
    expect(leiturasEm('avisos/')).toHaveLength(leituras);
    expect(escritasEm('avisos/')).toHaveLength(escritas);
  });

  it('★ a resolve that LANDED before a lost final write: the depósito removed again ⇒ the run that takes over the lease RAISES — though the flag still reads true', async () => {
    conta();
    sincronizacao(CONTA, { semDeposito: true });
    fake.antesDaProximaEscrita(sync(), () => undefined); // the lease
    fake.antesDaProximaEscrita(sync(), () => {
      throw grpc(14, 'UNAVAILABLE'); // the final write is lost
    });
    expect(unica(await tick())).toMatchObject({ desfecho: 'erro-firestore', aviso: null });
    expect(fake.ler(avisoSemDeposito())?.resolvidoEm).not.toBeNull();
    expect(fake.ler(sync())).toMatchObject({ semDeposito: true });

    conta(CONTA, { deposito: null }); // the depósito is removed again
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r2 = unica(await tick());
    // NEAR-MISS: gated on the transition alone (true → true), no raise — resolved forever.
    expect(r2).toMatchObject({ desfecho: 'sem-deposito', aviso: 'levantado', semDeposito: true });
    expect(fake.ler(avisoSemDeposito())?.resolvidoEm).toBeNull();
  });
});

describe('★ T9: the ONE line per conta names no SKU, ref or value', () => {
  it('after an enqueued run, a depósito change and a first tick, no line carries a SKU, the depósito, a ref or an observation', async () => {
    const OUTRA = 'conta-amz-tick-b';
    conta();
    sincronizacao();
    produto('P');
    const caminho = linha('P', MOVEU);
    vinculo('P', 'l1', 'SKU-P');
    expect(unica(await tick()).desfecho).toBe('enfileirado');
    const commit = fake.carimboDe(caminho);
    if (commit === undefined) throw new Error('fixture');
    // The depósito changes under the cursor; another conta has its first tick.
    sincronizacao(CONTA, { depositoDoCursor: 'documents/depositos/dep-antigo' });
    conta(OUTRA);
    agoraMs = T0 + INTERVALO_TICK_ESTOQUE_AMAZON_MS;
    const r = await tick();
    expect(Object.fromEntries(r.contas.map((c) => [c.contaId, c.desfecho]))).toEqual({
      [CONTA]: 'repassado',
      [OUTRA]: 'primeiro-tick',
    });
    expect(linhasDoTick()).toHaveLength(3);
    const texto = JSON.stringify(espiao.linhas);
    for (const proibido of [
      'SKU-P',
      DEP,
      'dep-antigo',
      REF_CONTA,
      referenciaDaObservacao(commit),
    ]) {
      expect(texto, proibido).not.toContain(proibido);
    }
  });
});

describe('a conta that fails: contained per conta, anything else rejects the tick', () => {
  it('a Firestore status error on one conta ⇒ that conta’s line, and the other conta still runs', async () => {
    const OUTRA = 'conta-amz-tick-b';
    conta();
    conta(OUTRA);
    sincronizacao();
    sincronizacao(OUTRA);
    fake.falharLeitura(sync(), grpc(14, 'UNAVAILABLE'));
    const r = await tick();
    const porConta = Object.fromEntries(r.contas.map((c) => [c.contaId, c.desfecho]));
    expect(porConta).toEqual({ [CONTA]: 'erro-firestore', [OUTRA]: 'janela-vazia' });
  });

  it('NEAR-MISS: any OTHER error is a bug — the tick rejects', async () => {
    conta();
    sincronizacao();
    fake.falharLeitura(sync(), new TypeError('bug'));
    await expect(tick()).rejects.toBeInstanceOf(TypeError);
  });

  it('a listed conta whose id is outside the conta-id grammar is id-de-conta-invalido at WARNING: nothing read or written for it, and the other conta runs', async () => {
    const FORA = 'conta.x';
    conta(FORA);
    conta();
    sincronizacao();
    const listar = () =>
      Promise.resolve([
        { integracaoId: FORA, nome: 'fora', ativo: true },
        { integracaoId: CONTA, nome: 'dentro', ativo: true },
      ]);
    const r = await tick({ contas: { ...LEITOR_DE_CONTAS_ESTOQUE_AMAZON, listar } });
    expect(Object.fromEntries(r.contas.map((c) => [c.contaId, c.desfecho]))).toEqual({
      [FORA]: 'id-de-conta-invalido',
      [CONTA]: 'janela-vazia',
    });
    expect(fake.leituras.filter((c) => c.includes(FORA))).toEqual([]);
    expect(fake.escritas.filter((e) => e.caminho.includes(FORA))).toEqual([]);
    // The logger writes an id outside the grammar as its placeholder, never verbatim.
    expect(linhaDaConta(INVALIDO)).toMatchObject({
      nivel: 'warn',
      meta: { desfecho: 'id-de-conta-invalido' },
    });
  });

  it('a sync document that no longer parses ⇒ documento-invalido naming its fields, nothing written', async () => {
    conta();
    sincronizacao(CONTA, { cursorMs: 'ontem' });
    const r = unica(await tick());
    expect(r).toMatchObject({ desfecho: 'documento-invalido', campos: 'cursorMs' });
    expect(fake.escritas).toEqual([]);
    expect(linhaDaConta().nivel).toBe('warn');
  });

  it('an inactive conta is skipped with no line; a listed conta now gone writes nothing', async () => {
    conta(CONTA, { ativo: false });
    sincronizacao();
    const r = await tick();
    expect(r.contas.map((c) => c.desfecho)).toEqual(['inativa']);
    expect(linhasDoTick()).toEqual([]);
    expect(fake.escritas).toEqual([]);
    expect(fake.leituras).toEqual([]);

    const sumida = vi.fn(() => Promise.resolve(null));
    fake.seed(caminhoConta(CONTA), { ...fake.ler(caminhoConta(CONTA)), ativo: true });
    const r3 = await tick({ contas: { ...LEITOR_DE_CONTAS_ESTOQUE_AMAZON, ler: sumida } });
    expect(r3.contas.map((c) => c.desfecho)).toEqual(['conta-inexistente']);
    expect(fake.escritas).toEqual([]);
  });

  it('T3 reads the conta RAW: no longer an Amazon conta ⇒ conta-inexistente; inactive at the read ⇒ skipped with no line — nothing written either way', async () => {
    conta();
    sincronizacao();
    const lida = (dados: DocData) => vi.fn(() => Promise.resolve(dados));
    const r1 = await tick({
      contas: { ...LEITOR_DE_CONTAS_ESTOQUE_AMAZON, ler: lida({ tipo: 1, ativo: true }) },
    });
    expect(r1.contas.map((c) => c.desfecho)).toEqual(['conta-inexistente']);
    const r2 = await tick({
      contas: {
        ...LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
        ler: lida({ tipo: INTEGRACAO_TIPO.amazon, ativo: false, depositoOuterRef: CANONICA }),
      },
    });
    expect(r2.contas.map((c) => c.desfecho)).toEqual(['inativa']);
    expect(fake.escritas).toEqual([]);
    expect(linhaDaConta().meta.desfecho).toBe('conta-inexistente');
  });

  it.each([
    [ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS - 1, 'sem-tempo'],
    [ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS, 'janela-vazia'],
  ])('a conta the tick can give %i ms ⇒ %s', async (restante, desfecho) => {
    const OUTRA = 'conta-amz-tick-b';
    conta();
    conta(OUTRA);
    sincronizacao();
    sincronizacao(OUTRA);
    const [primeira, segunda] = ordemDoTickEstoqueAmazon([CONTA, OUTRA], T0);
    if (primeira === undefined || segunda === undefined) throw new Error('fixture');
    fake.antesDaProximaEscrita(sync(primeira), () => undefined);
    fake.antesDaProximaEscrita(sync(primeira), () => {
      agoraMs = T0 + ORCAMENTO_TICK_ESTOQUE_AMAZON_MS - restante;
    });
    const r = await tick();
    expect(r.contas.map((c) => [c.contaId, c.desfecho])).toEqual([
      [primeira, 'janela-vazia'],
      [segunda, desfecho],
    ]);
    expect(linhaDaConta(segunda).nivel).toBe(desfecho === 'sem-tempo' ? 'warn' : 'info');
  });

  it('a conta the tick can no longer give its minimum budget is sem-tempo: nothing read for it', async () => {
    const OUTRA = 'conta-amz-tick-b';
    conta();
    conta(OUTRA);
    sincronizacao();
    sincronizacao(OUTRA);
    const [primeira, segunda] = ordemDoTickEstoqueAmazon([CONTA, OUTRA], T0);
    if (primeira === undefined || segunda === undefined) throw new Error('fixture');
    fake.antesDaProximaEscrita(sync(primeira), () => undefined);
    fake.antesDaProximaEscrita(sync(primeira), () => {
      agoraMs =
        T0 + ORCAMENTO_TICK_ESTOQUE_AMAZON_MS - ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS + 1;
    });
    const r = await tick();
    expect(r.contas.map((c) => [c.contaId, c.desfecho])).toEqual([
      [primeira, 'janela-vazia'],
      [segunda, 'sem-tempo'],
    ]);
    expect(fake.leituras.filter((c) => c.endsWith(segunda))).toEqual([]);
    expect(linhaDaConta(segunda).nivel).toBe('warn');
  });
});

describe('the tick’s summary', () => {
  it('counts the contas by outcome and the tasks enqueued', async () => {
    conta();
    sincronizacao();
    produtoComVinculos('P', 2);
    const r = await tick();
    expect(resumirTickEstoqueAmazon(r)).toEqual({
      fase: 'tick',
      portao: null,
      contas: 1,
      desfecho_enfileirado: 1,
      tarefas: 2,
    });
  });
});
