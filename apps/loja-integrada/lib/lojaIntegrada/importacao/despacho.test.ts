/**
 * ONE dispatch of the product import (`despacho.ts`), on the fake Firestore, through the REAL
 * context loader, the real phase modules and the real producer over a recording transport. What it
 * proves:
 *
 *  - the payload and the `seq` gate: a stale chain, a finished job, another conta's job do nothing
 *    beyond the job read; the continuation check re-enqueues the NAMED successor (at the
 *    conservative 60 s: it repairs a hand-off whose delay it cannot know) and stops;
 *  - the read switch FIRST: a context refusal ends the job `falhou` with its motivo and zero calls;
 *  - the time budget: a scripted clock stops a dispatch before the unit that would cross 70 s, and
 *    the next dispatch resumes at the same offset or family; per-unit checkpoints never move `seq`;
 *  - the hand-off: a transient enqueue failure AFTER the end-of-dispatch checkpoint is retried as
 *    the continuation check, which enqueues the successor once, and the job finishes; the same for
 *    the 429 pause; an answered already-exists is success; the valve closed ends the job;
 *  - the 429 pause and its ceiling, the last attempt, a cancel between units, a 401's park, a
 *    detail off its schema contained;
 *  - Simular writes only the job and its subcollections, and gives the SAME per-item verdicts as
 *    an `aplicar` run on a store where a learning from family A resolves family B.
 *
 * The category case of that equality is the complete step's (category creation is "complete"
 * only): here no category is planned at all.
 *
 * Nothing reaches the network (D17): the GLOBAL `fetch` is stubbed to throw for the whole file, and
 * the context gets a scripted store as its `fetch` seam.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  grupoDeVariacoesCollection,
  importacaoLojaIntegradaCollection,
} from '@delfrance/data/admin/collections';
import {
  CAMINHO_CATEGORIAS_LI,
  CAMINHO_MARCAS_LI,
  LiHttpError,
  URL_BASE_CDN_LI,
} from '@delfrance/integrations-loja-integrada';
import {
  ACAO_IMPORTACAO_LI,
  ACAO_ITEM_IMPORTACAO_LI,
  FASE_IMPORTACAO_LI,
  type ImportacaoLojaIntegrada,
  type ItemImportacaoLi,
  LIMITE_PAGINA_CATALOGO_LI,
  MAX_PAUSAS_429_LI,
  MODO_IMPORTACAO_LI,
  MOTIVO_CATEGORIA_SEM_VINCULO_LI,
  MOTIVO_FALHA_IMPORTACAO_LI,
  type ModoImportacaoLi,
  ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  TIPO_AVISO,
  TIPO_PAGINA_IMPORTACAO_LI,
  type TarefaImportacaoLi,
  chaveDeAviso,
  fundirLinksVariacoesLi,
  idPaginaImportacaoLi,
  importacaoLojaIntegradaSchema,
  itemImportacaoLiSchema,
  varianteFakePath,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { RITMO_LEITURA_LI_MS } from '../core/ritmo';
import { LiTarefasTransitoriasError } from '../notificacoes/agendador';
import {
  type ChamadaCatalogoLi,
  type RespostaCatalogoLi,
  categoriaLi,
  marcaLi,
  offsetDe,
  paginaCatalogoLi,
  plataformaCatalogoLi,
} from '../testing/catalogoLi';
import { FakeBucket, asBucket } from '../testing/fakeBucket';
import { type DocData, FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  caminhoAviso,
  caminhoCredencial,
  gravadorDeLog,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { caminhoItemLi, caminhoJobLi, seedJobLi } from '../testing/importacaoLi';
import {
  type LojaDeProdutosLi,
  detalheLi,
  filhoLi,
  linhaProdutoLi,
  paiLi,
  parametroDe,
  respostasDaLojaLi,
  uriOpcaoLi,
  vistaLi,
} from '../testing/produtosLi';
import {
  type FilaImportacaoLi,
  type OpcoesEnfileiramentoImportacaoLi,
  criarAgendadorImportacaoLi,
} from './agendadorImportacao';
import {
  DESFECHO_DESPACHO_IMPORTACAO_LI,
  type DepsDespachoImportacaoLi,
  camposDoRegistroDaImportacaoLi,
  categoriasSemVinculoDoJob,
  despacharImportacaoLi,
  faseDepoisDasFamiliasLi,
} from './despacho';
import { avisarCategoriaSemVinculoLi, chaveCategoriaSemVinculoLi } from './avisosImportacao';
import { cancelarImportacaoLi } from './job';
import { PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS } from './orcamento';

const sha256Hex = (texto: string) => createHash('sha256').update(texto, 'utf8').digest('hex');

const CONTA = 'conta-li-despacho';
const JOB = 'job-despacho';
const COR = 7001;

let db: FakeDb;
let fetchGlobal: ReturnType<typeof vi.fn>;
let gravador: ReturnType<typeof gravadorDeLog>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  fetchGlobal = vi.fn(() => {
    throw new Error('despacho.test: só o fetch roteirizado do contexto pode ser chamado');
  });
  vi.stubGlobal('fetch', fetchGlobal);
  db = new FakeDb();
  seedConta(db, CONTA);
  seedCredencial(db, CONTA);
  gravador = gravadorDeLog();
});
afterEach(() => {
  expect(fetchGlobal).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

/* -------------------------------- the store -------------------------------- */

/** The store: one category, one brand, and `loja`'s two product lists and details. */
function lojaCompleta(loja: LojaDeProdutosLi) {
  const produtos = respostasDaLojaLi(loja);
  return (c: ChamadaCatalogoLi): RespostaCatalogoLi => {
    if (c.caminho === CAMINHO_CATEGORIAS_LI) {
      return paginaCatalogoLi('categoria', offsetDe(c) === 0 ? [categoriaLi(900)] : [], {
        offset: offsetDe(c),
        limite: LIMITE_PAGINA_CATALOGO_LI,
        total: 1,
      });
    }
    if (c.caminho === CAMINHO_MARCAS_LI) {
      return paginaCatalogoLi('marca', offsetDe(c) === 0 ? [marcaLi(950)] : [], {
        offset: offsetDe(c),
        limite: LIMITE_PAGINA_CATALOGO_LI,
        total: 1,
      });
    }
    return produtos(c);
  };
}

/** Three simple products the ERP lacks (no link, no write), ids 10, 20, 30. */
const LOJA_SIMPLES: LojaDeProdutosLi = {
  ativos: [10, 20, 30].map((id) => linhaProdutoLi(id, { sku: `LI-${String(id)}` })),
};

/* ------------------------------ the transport ------------------------------- */

interface Envio {
  readonly tarefa: TarefaImportacaoLi;
  readonly opcoes: OpcoesEnfileiramentoImportacaoLi;
}

/** A recording transport; each queued failure rejects ONE enqueue, in order. */
function transporte() {
  const envios: Envio[] = [];
  const falhas: Error[] = [];
  const fila: FilaImportacaoLi = {
    enqueue: (tarefa, opcoes) => {
      envios.push({ tarefa, opcoes });
      const falha = falhas.shift();
      return falha === undefined ? Promise.resolve() : Promise.reject(falha);
    },
  };
  return { fila, envios, falhas };
}

type Transporte = ReturnType<typeof transporte>;

/* ---------------------------------- deps ----------------------------------- */

interface Relogio {
  agora: number;
}

interface OpcoesDeps {
  readonly responder?: (c: ChamadaCatalogoLi) => RespostaCatalogoLi;
  readonly ambiente?: Readonly<Record<string, string | undefined>>;
  readonly tentativa?: number;
  readonly t?: Transporte;
  readonly desligado?: boolean;
  readonly relogio?: Relogio;
  /** How long before the dispatch's first statement its start was stamped (ms). */
  readonly jaDecorridoMs?: number;
  readonly agendador?: DepsDespachoImportacaoLi['agendador'];
  /** The default bucket (photos); absent = a bucket asked for fails the test. */
  readonly bucket?: DepsDespachoImportacaoLi['bucket'];
  /** The CDN: the bytes of each picture path (the ORIGINAL form); absent = no CDN host answers. */
  readonly cdn?: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  /** Every CDN request, as sent. */
  readonly pedidosCdn?: string[];
}

/** The scripted store's `fetch`, with the CDN host answering `cdn`'s pictures (404 otherwise). */
function comCdn(
  fetchDaLoja: typeof globalThis.fetch,
  cdn: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  pedidos: string[],
): typeof globalThis.fetch {
  return (input, init) => {
    const texto = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(texto);
    if (url.origin !== URL_BASE_CDN_LI) return fetchDaLoja(input, init);
    pedidos.push(url.pathname);
    const bytes = cdn.get(url.pathname.slice(1));
    return Promise.resolve(
      bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpg' } }),
    );
  };
}

function montarDeps(o: OpcoesDeps = {}) {
  const relogio = o.relogio ?? { agora: AGORA_MS };
  const plataforma = plataformaCatalogoLi(o.responder ?? lojaCompleta(LOJA_SIMPLES));
  const t = o.t ?? transporte();
  const warn = vi.fn();
  const deps: DepsDespachoImportacaoLi = {
    ambiente: o.ambiente ?? AMBIENTE_LIGADO,
    agoraMs: () => relogio.agora,
    inicioMs: relogio.agora - (o.jaDecorridoMs ?? 0),
    // The pacer's 2 s, on the scripted clock.
    esperar: (ms) => {
      relogio.agora += ms;
      return Promise.resolve();
    },
    increment,
    agendador:
      o.agendador ??
      (() => criarAgendadorImportacaoLi({ fila: () => t.fila, desligado: o.desligado ?? false })),
    // A bucket asked for by a test that did not give one fails it: only photos ask for it.
    bucket:
      o.bucket ??
      (() => {
        throw new Error('despacho.test: nenhum bucket neste despacho');
      }),
    logger: { warn },
    tentativa: o.tentativa ?? 0,
    idTarefa: 'tarefa-1',
    fetch:
      o.cdn === undefined ? plataforma.fetch : comCdn(plataforma.fetch, o.cdn, o.pedidosCdn ?? []),
    escrever: gravador.escrever,
  };
  return { deps, chamadas: plataforma.chamadas, t, warn, relogio };
}

function tarefa(seq: number, over: Partial<TarefaImportacaoLi> = {}): TarefaImportacaoLi {
  return { tipo: 'importacao', contaId: CONTA, jobId: JOB, seq, ...over };
}

function jobGravado(): ImportacaoLojaIntegrada {
  return importacaoLojaIntegradaSchema.parse(db.ler(caminhoJobLi(JOB)));
}

function itens(): Map<number, ItemImportacaoLi> {
  const mapa = new Map<number, ItemImportacaoLi>();
  for (const id of db.idsEm(`${caminhoJobLi(JOB)}/itens`)) {
    mapa.set(Number(id), itemImportacaoLiSchema.parse(db.ler(caminhoItemLi(JOB, id))));
  }
  return mapa;
}

/** Every write the dispatch landed on the job document itself. */
function escritasDoJob() {
  return db.escritasEm(caminhoJobLi(JOB));
}

/**
 * Run a job from `seq` until a dispatch ends without a hand-off, each successor with a fresh start
 * stamp on the same clock. Returns every dispatch's result.
 */
async function rodarAteOFim(o: OpcoesDeps, seq = 0, maximo = 40, jobId = JOB) {
  const relogio = o.relogio ?? { agora: AGORA_MS };
  const t = o.t ?? transporte();
  const resultados = [];
  let proxima = tarefa(seq, { jobId });
  for (let i = 0; i < maximo; i += 1) {
    const { deps } = montarDeps({ ...o, relogio, t, jaDecorridoMs: 0 });
    const r = await despacharImportacaoLi(asDb(db), proxima, deps);
    resultados.push(r);
    const continua =
      r.desfecho === DESFECHO_DESPACHO_IMPORTACAO_LI.continuado ||
      r.desfecho === DESFECHO_DESPACHO_IMPORTACAO_LI.pausado ||
      r.desfecho === DESFECHO_DESPACHO_IMPORTACAO_LI.continuacao;
    if (!continua) return { resultados, t };
    const ultima = t.envios.at(-1);
    if (ultima === undefined) throw new Error('rodarAteOFim: um despacho continuou sem enfileirar');
    proxima = ultima.tarefa;
  }
  throw new Error('rodarAteOFim: o job não terminou');
}

/* ----------------------------- the seq gate -------------------------------- */

describe('the payload and the seq gate', () => {
  it('a payload the task schema refuses is DROPPED with zero reads and zero writes', async () => {
    const { deps } = montarDeps();
    const r = await despacharImportacaoLi(asDb(db), { tipo: 'importacao', contaId: CONTA }, deps);
    expect(r).toEqual({
      desfecho: 'payload-invalido',
      motivo: null,
      fase: null,
      unidades: 0,
      chamadas: 0,
    });
    expect(db.leituras).toEqual([]);
    expect(db.escritas).toEqual([]);
  });

  it('no job, and another conta’s job, are nothing: one job read, no write, no call', async () => {
    const { deps, chamadas, t } = montarDeps();
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), deps)).desfecho).toBe('nada');
    seedJobLi(db, JOB, 'outra-conta-li', { status: 'pendente' });
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), deps)).desfecho).toBe('nada');
    expect(db.leituras).toEqual([caminhoJobLi(JOB), caminhoJobLi(JOB)]);
    expect(db.escritas).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(t.envios).toEqual([]);
  });

  it.each<[string, Partial<Record<keyof ImportacaoLojaIntegrada, unknown>>, number]>([
    ['a stale chain (stored 3, task 1)', { status: 'executando', seq: 3 }, 1],
    ['a task AHEAD of the stored seq', { status: 'executando', seq: 1 }, 2],
    ['a finished job at its own seq', { status: 'concluido', seq: 2 }, 2],
    ['a cancelled job at its own seq', { status: 'cancelado', seq: 2 }, 2],
    ['stored − 1 on a job no longer running', { status: 'falhou', seq: 2 }, 1],
  ])('%s does NOTHING beyond the job read', async (_nome, over, seq) => {
    seedJobLi(db, JOB, CONTA, over);
    const { deps, chamadas, t } = montarDeps();
    const r = await despacharImportacaoLi(asDb(db), tarefa(seq), deps);
    expect(r.desfecho).toBe('nada');
    expect(db.leituras).toEqual([caminhoJobLi(JOB)]);
    expect(db.consultas).toEqual([]);
    expect(db.escritas).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(t.envios).toEqual([]);
  });

  it('stored − 1 while executando: the continuation check re-enqueues the NAMED successor at the conservative 60 s and stops — no context, no write', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'executando', seq: 2 });
    // The switch OFF: the continuation check makes no call, so it never asks.
    const { deps, chamadas, t } = montarDeps({ ambiente: {} });
    const r = await despacharImportacaoLi(asDb(db), tarefa(1), deps);
    expect(r.desfecho).toBe('continuacao');
    // It cannot tell whether the checkpoint it repairs was a budget end (2 s) or a 429 pause (60 s):
    // 60 s never cuts a pause short.
    expect(t.envios).toEqual([
      {
        tarefa: tarefa(2),
        opcoes: { id: `li-importacao-${JOB}-2`, scheduleDelaySeconds: 60 },
      },
    ]);
    expect(db.escritas).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(gravador.linhas).toEqual([]);
  });

  it('the continuation check with the tasks valve closed ends the job falhou/tarefas-desligadas', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'executando', seq: 2 });
    const { deps, t } = montarDeps({ desligado: true });
    const r = await despacharImportacaoLi(asDb(db), tarefa(1), deps);
    expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'tarefas-desligadas' });
    expect(t.envios).toEqual([]);
    expect(jobGravado()).toMatchObject({
      status: 'falhou',
      motivo: 'tarefas-desligadas',
      seq: 2,
      concluidoEmMs: AGORA_MS,
    });
  });
});

/* ------------------------------ the read switch ----------------------------- */

describe('the context FIRST', () => {
  it('the read switch off ends the job falhou/chamadas-desligadas: zero calls, and nothing read but the job', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const { deps, chamadas, t } = montarDeps({ ambiente: {} });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({
      desfecho: 'falhou',
      motivo: 'chamadas-desligadas',
      unidades: 0,
      chamadas: 0,
    });
    expect(chamadas).toEqual([]);
    expect(t.envios).toEqual([]);
    // The conta is never read: the switch is the context's first act.
    expect(db.leituras).toEqual([caminhoJobLi(JOB)]);
    expect(db.escritas.map((e) => e.caminho)).toEqual([caminhoJobLi(JOB)]);
    expect(jobGravado()).toMatchObject({ status: 'falhou', motivo: 'chamadas-desligadas', seq: 0 });
    expect(gravador.linhas.map((l) => l.campos.evento)).toEqual(['chamada-bloqueada']);
    expect(gravador.linhas[0]?.campos).toMatchObject({ fluxo: 'importacao', conta: CONTA });
  });

  it.each<[string, () => void]>([
    ['an inactive conta', () => seedConta(db, CONTA, { ativo: false })],
    [
      'a parked credential',
      () =>
        seedCredencial(db, CONTA, {
          reconexaoPendente: { status: 401, desdeMs: AGORA_MS, refCredencial: 'ref-velho' },
        }),
    ],
    ['no credential', () => db.seed(caminhoCredencial(CONTA), {})],
  ])('%s ends the job falhou/conta-indisponivel with zero calls', async (_nome, preparar) => {
    preparar();
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const { deps, chamadas } = montarDeps();
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'conta-indisponivel' });
    expect(chamadas).toEqual([]);
    expect(jobGravado()).toMatchObject({ status: 'falhou', motivo: 'conta-indisponivel' });
  });
});

/* ---------------------------------- a run ---------------------------------- */

describe('a whole job', () => {
  it('runs every phase in order, in ONE dispatch when it fits, and ends concluido', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
    const { deps, chamadas, t } = montarDeps();
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'concluido', fase: 'fim', chamadas: 4 });
    expect(chamadas.map((c) => [c.caminho, parametroDe(c, 'removido') ?? null])).toEqual([
      [CAMINHO_CATEGORIAS_LI, null],
      [CAMINHO_MARCAS_LI, null],
      ['/v1/produto/', 'false'],
      ['/v1/produto/', 'true'],
    ]);
    // Every unit checkpointed at seq 0; the job ended there, with nothing handed off.
    const fases = escritasDoJob().map((e) => (e.dados as DocData).fase ?? null);
    expect(fases).toEqual([
      null,
      null,
      'listagem',
      null,
      'lixeira',
      null,
      'orfaos',
      'evidencias',
      'aprendizado',
      'familias',
      null,
      null,
      null,
      // An `aplicar` job re-checks the tax-review list, whatever its action: its two units (no
      // earlier job to carry from, then the empty list's re-check).
      'revisao',
      null,
      'fim',
      null,
    ]);
    expect(escritasDoJob().every((e) => (e.dados as DocData).seq === undefined)).toBe(true);
    expect(t.envios).toEqual([]);
    expect(jobGravado()).toMatchObject({
      status: 'concluido',
      seq: 0,
      contadores: { familias: 3, vinculados: 0, semMudanca: 3 },
    });
    expect([...itens().keys()]).toEqual([10, 20, 30]);
  });

  it('at the catalogue’s end an `aplicar` job closes the per-category aviso of a category gone from the store; a Simular leaves it open', async () => {
    const chave = chaveCategoriaSemVinculoLi(CONTA, 999);
    const abrir = () =>
      avisarCategoriaSemVinculoLi(
        asDb(db),
        {
          jobId: 'job-anterior',
          integracaoId: CONTA,
          lojaNome: 'Loja',
          modo: MODO_IMPORTACAO_LI.aplicar,
          fimMs: AGORA_MS - 1_000,
        },
        {
          categoriaLiId: 999,
          caminho: [999],
          produtos: 1,
          motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
        },
        { increment, nowMs: AGORA_MS - 1_000 },
      );

    await abrir();
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: MODO_IMPORTACAO_LI.simular });
    await rodarAteOFim({});
    expect(db.ler(caminhoAviso(chave))?.resolvidoEm).toBeNull();

    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: MODO_IMPORTACAO_LI.aplicar });
    await rodarAteOFim({});
    // The store lists only category 900: 999 is gone, so its row closes.
    expect(db.ler(caminhoAviso(chave))).toMatchObject({
      resolucaoMotivo: 'categoria-fora-da-loja',
    });
  });

  it('the families of a `selecionados` job are the selection only, and a selected id the store no longer lists is `nao-listado`', async () => {
    seedJobLi(db, JOB, CONTA, {
      status: 'pendente',
      alvo: 'selecionados',
      selecionados: [20, 99],
    });
    const { deps } = montarDeps();
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), deps)).desfecho).toBe('concluido');
    const lidos = itens();
    expect([...lidos.keys()].sort((a, b) => a - b)).toEqual([20, 99]);
    expect(lidos.get(99)).toMatchObject({
      situacaoErp: 'nao-listado',
      pendencias: [{ codigo: 'nao-listado', acionavel: false }],
    });
    expect(jobGravado().contadores).toMatchObject({ familias: 1, pendenciasInformativas: 1 });
    // A family outside the selection cost no read: no SKU probe ever named it.
    const skusConsultados = db.consultas.flatMap((c) =>
      c.filtros.filter(([campo]) => campo === 'sku').map(([, , valor]) => valor),
    );
    expect(skusConsultados).toContain('LI-20');
    expect(skusConsultados).not.toContain('LI-10');
    expect(skusConsultados).not.toContain('LI-30');
  });
});

/* -------------------------- Simular and aplicar --------------------------- */

/** An ERP variation of grupo `cor` at variante `v`. */
function taxonomia(variante: string): DocData {
  return {
    variacoesUid: [varianteFakePath('cor', variante)],
    grupoDeVariacoesUid: ['cor'],
  };
}

/**
 * The ERP: grupo `cor` links the store's option 1 (blue) for this conta, not option 2 (green).
 * Family A (`cam`) has both colours, matched by exact SKU; family B (`can`) is a one-variation
 * family whose green child carries ANOTHER SKU than the store's — only the combination can match
 * it, once option 2 is learned from family A.
 */
function seedErpAB(): void {
  db.seed('grupoDeVariacoes/cor', {
    nome: 'Cor',
    variacoes: [
      { id: 'v-azul', nome: 'Azul' },
      { id: 'v-verde', nome: 'Verde' },
    ],
    linksVariacoesli: [
      {
        name: null,
        grade_id: COR,
        integracaoLiId: CONTA,
        variationOptions: [
          { li_option_id: 1, li_option_name: null, arakene_variation_id: ['v-azul'] },
        ],
      },
    ],
  });
  db.seed('produtos/cam', { nome: 'Camiseta', sku: 'CAM', paiId: null, filhoUnicoId: null });
  db.seed('produtos/cam-az', {
    nome: 'Camiseta Azul',
    sku: 'CAM-AZ',
    paiId: 'cam',
    ...taxonomia('v-azul'),
  });
  db.seed('produtos/cam-vd', {
    nome: 'Camiseta Verde',
    sku: 'CAM-VD',
    paiId: 'cam',
    ...taxonomia('v-verde'),
  });
  db.seed('produtos/can', { nome: 'Caneca', sku: 'CAN', paiId: null, filhoUnicoId: 'can-vd' });
  db.seed('produtos/can-vd', {
    nome: 'Caneca Verde',
    sku: 'CAN-VD',
    paiId: 'can',
    ...taxonomia('v-verde'),
  });
}

const LOJA_AB: LojaDeProdutosLi = {
  ativos: [
    paiLi(100, [101, 102], { sku: 'CAM', nome: 'Camiseta' }),
    filhoLi(101, { sku: 'CAM-AZ', variacoes: [uriOpcaoLi(COR, 1)] }),
    filhoLi(102, { sku: 'CAM-VD', variacoes: [uriOpcaoLi(COR, 2)] }),
    paiLi(200, [201], { sku: 'CAN', nome: 'Caneca' }),
    filhoLi(201, { sku: 'CAN-VERDE', variacoes: [uriOpcaoLi(COR, 2)] }),
  ],
};

/** A whole job of `modo` over the A/B store, from a fresh fake. */
async function rodarAB(modo: ModoImportacaoLi) {
  db = new FakeDb();
  seedConta(db, CONTA);
  seedCredencial(db, CONTA);
  seedErpAB();
  seedJobLi(db, JOB, CONTA, { status: 'pendente', modo });
  __resetAllReadCaches();
  const { resultados } = await rodarAteOFim({ responder: lojaCompleta(LOJA_AB) });
  return {
    resultados,
    itens: itens(),
    job: jobGravado(),
    caminhos: db.escritas.map((e) => e.caminho),
  };
}

/** An item without what only says WHEN or WHETHER it was applied. */
function veredito(item: ItemImportacaoLi | undefined) {
  if (item === undefined) return undefined;
  const { aplicada: _aplicada, atualizadoEmMs: _quando, ...resto } = item;
  return resto;
}

describe('Simular and aplicar', () => {
  it('give the SAME per-item verdicts when a learning from family A resolves family B — and Simular writes only the job', async () => {
    const simular = await rodarAB(MODO_IMPORTACAO_LI.simular);
    const aplicar = await rodarAB(MODO_IMPORTACAO_LI.aplicar);

    expect(simular.resultados.at(-1)?.desfecho).toBe('concluido');
    expect(aplicar.resultados.at(-1)?.desfecho).toBe('concluido');

    // Family B's green child is linked through the LEARNED option, with both SKUs reported.
    expect(aplicar.itens.get(200)).toMatchObject({
      situacaoErp: 'encontrado',
      erpId: 'can',
      acao: 'vincular',
      aplicada: true,
      pendencias: [
        {
          codigo: 'sku-diferente',
          acionavel: false,
          liId: 201,
          referencias: ['CAN-VERDE', 'CAN-VD'],
        },
      ],
    });
    expect(simular.itens.get(200)?.aplicada).toBe(false);

    // The same verdicts, item by item; the same counters.
    expect([...simular.itens.keys()]).toEqual([...aplicar.itens.keys()]);
    for (const id of aplicar.itens.keys()) {
      expect(veredito(simular.itens.get(id)), String(id)).toEqual(veredito(aplicar.itens.get(id)));
    }
    expect(simular.job.contadores).toEqual(aplicar.job.contadores);

    // Simular: the overlay rode the job; every write is the job or its own subcollections.
    expect(simular.job.aprendizadosSimulados).toEqual([
      { grupoId: 'cor', gradeId: COR, opcaoId: 2, varianteId: 'v-verde' },
    ]);
    const prefixo = `${caminhoJobLi(JOB)}`;
    expect(simular.caminhos.filter((c) => c !== prefixo && !c.startsWith(`${prefixo}/`))).toEqual(
      [],
    );

    // aplicar: the grupo learned, the links written; nothing else of the ERP touched.
    expect(aplicar.job.aprendizadosSimulados).toEqual([]);
    const foraDoJob = aplicar.caminhos.filter((c) => c !== prefixo && !c.startsWith(`${prefixo}/`));
    expect(
      foraDoJob.filter((c) => !/^produtos\/[^/]+\/produtolojaintegrada\/\d+$/.test(c)),
    ).toEqual([
      'grupoDeVariacoes/cor',
      // The tax-review phase of every `aplicar` job: an empty list resolves its aviso.
      caminhoAviso(chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaRevisaoFiscal, conta: CONTA })),
      caminhoAviso(
        chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias, conta: CONTA }),
      ),
    ]);
    expect(foraDoJob.filter((c) => c.includes('/produtolojaintegrada/')).sort()).toEqual([
      'produtos/cam-az/produtolojaintegrada/101',
      'produtos/cam-vd/produtolojaintegrada/102',
      'produtos/cam/produtolojaintegrada/100',
      'produtos/can-vd/produtolojaintegrada/201',
      'produtos/can/produtolojaintegrada/200',
    ]);
  });

  it('an `aplicar` job ending with an actionable pendência raises the summary aviso; a Simular of the same store raises nothing', async () => {
    const semSku: LojaDeProdutosLi = { ativos: [linhaProdutoLi(10, { sku: '' })] };
    const chave = chaveDeAviso({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
      conta: CONTA,
    });

    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'simular' });
    await rodarAteOFim({ responder: lojaCompleta(semSku) });
    expect(
      itens()
        .get(10)
        ?.pendencias.map((p) => p.codigo),
    ).toEqual(['sem-sku']);
    expect(db.ler(caminhoAviso(chave))).toBeUndefined();

    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
    await rodarAteOFim({ responder: lojaCompleta(semSku) });
    expect(db.ler(caminhoAviso(chave))).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
      resolvidoEm: null,
      params: expect.objectContaining({ 'sem-sku': 1, acionaveis: 1, job: JOB }),
    });
  });

  it('⚠️ a Simular job’s END reads none of its items: counting the pendências serves only the summary aviso, which Simular never syncs', async () => {
    const semSku: LojaDeProdutosLi = { ativos: [linhaProdutoLi(10, { sku: '' })] };
    // The count pages the job's WHOLE report: on a full store, thousands of documents read for an
    // answer nothing uses.
    const consultasDosItens = () =>
      db.consultas.filter((c) => c.colecao === `${caminhoJobLi(JOB)}/itens`).length;

    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'simular' });
    const simular = await rodarAteOFim({ responder: lojaCompleta(semSku) });
    expect(simular.resultados.at(-1)?.desfecho).toBe('concluido');
    expect(
      itens()
        .get(10)
        ?.pendencias.map((p) => p.codigo),
    ).toEqual(['sem-sku']);
    expect(consultasDosItens()).toBe(0);

    // NEAR-MISS: the same store under `aplicar` counts them — ONE page — before its stamp.
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
    const aplicar = await rodarAteOFim({ responder: lojaCompleta(semSku) });
    expect(aplicar.resultados.at(-1)?.desfecho).toBe('concluido');
    expect(consultasDosItens()).toBe(1);
  });
});

/**
 * Two ERP families whose variations the store's option 2 claims by EXACT SKU: `cam-vd` is green,
 * `can-x` is `varianteDeCan`. Option 1 (blue) is already linked for this conta.
 */
function seedErpDuasFamilias(varianteDeCan: string): void {
  db.seed('grupoDeVariacoes/cor', {
    nome: 'Cor',
    variacoes: [
      { id: 'v-azul', nome: 'Azul' },
      { id: 'v-verde', nome: 'Verde' },
      { id: 'v-roxo', nome: 'Roxo' },
    ],
    linksVariacoesli: [
      {
        name: null,
        grade_id: COR,
        integracaoLiId: CONTA,
        variationOptions: [
          { li_option_id: 1, li_option_name: null, arakene_variation_id: ['v-azul'] },
        ],
      },
    ],
  });
  for (const [raiz, filhos] of [
    [
      'cam',
      [
        ['cam-az', 'CAM-AZ', 'v-azul'],
        ['cam-vd', 'CAM-VD', 'v-verde'],
      ],
    ],
    [
      'can',
      [
        ['can-az', 'CAN-AZ', 'v-azul'],
        ['can-x', 'CAN-X', varianteDeCan],
      ],
    ],
  ] as const) {
    db.seed(`produtos/${raiz}`, { nome: raiz, sku: raiz.toUpperCase(), paiId: null });
    for (const [id, sku, variante] of filhos) {
      db.seed(`produtos/${id}`, { nome: id, sku, paiId: raiz, ...taxonomia(variante) });
    }
  }
}

const LOJA_DUAS_FAMILIAS: LojaDeProdutosLi = {
  ativos: [
    paiLi(100, [101, 102], { sku: 'CAM' }),
    filhoLi(101, { sku: 'CAM-AZ', variacoes: [uriOpcaoLi(COR, 1)] }),
    filhoLi(102, { sku: 'CAM-VD', variacoes: [uriOpcaoLi(COR, 2)] }),
    paiLi(200, [201, 202], { sku: 'CAN' }),
    filhoLi(201, { sku: 'CAN-AZ', variacoes: [uriOpcaoLi(COR, 1)] }),
    filhoLi(202, { sku: 'CAN-X', variacoes: [uriOpcaoLi(COR, 2)] }),
  ],
};

describe('claims that disagree', () => {
  it('⚠️ EQUAL: two families whose variations were matched by EXACT SKU and claim option 2 as different variantes BOTH report evidencia-divergente — nothing learned', async () => {
    seedErpDuasFamilias('v-roxo');
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
    const { resultados } = await rodarAteOFim({ responder: lojaCompleta(LOJA_DUAS_FAMILIAS) });
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    const divergente = (liId: number) => ({
      codigo: 'evidencia-divergente',
      acionavel: true,
      liId,
      referencias: [`${String(COR)}/2`],
    });
    expect(itens().get(100)?.pendencias).toEqual([divergente(102)]);
    expect(itens().get(200)?.pendencias).toEqual([divergente(202)]);
    // Linked by SKU all the same; the grupo learned nothing.
    expect(itens().get(100)).toMatchObject({ situacaoErp: 'encontrado', acao: 'vincular' });
    expect(db.escritasEm('grupoDeVariacoes/cor')).toEqual([]);
  });

  it('⚠️ NEAR-MISS: the same two families claiming the SAME variante ⇒ learned, and no pendência anywhere', async () => {
    seedErpDuasFamilias('v-verde');
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
    await rodarAteOFim({ responder: lojaCompleta(LOJA_DUAS_FAMILIAS) });
    expect(itens().get(100)?.pendencias).toEqual([]);
    expect(itens().get(200)?.pendencias).toEqual([]);
    expect(db.escritasEm('grupoDeVariacoes/cor')).toHaveLength(1);
  });

  it('a learning whose grupo write is lost TWICE is reported conflito-de-escrita on every family carrying the option — never as a mere missing link', async () => {
    seedErpDuasFamilias('v-verde');
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
    // An operator saves the grupo right before each of our two writes.
    const editar = (n: number) =>
      db.antesDaProximaEscrita('grupoDeVariacoes/cor', async () => {
        await grupoDeVariacoesCollection
          .docRef(asDb(db), {}, 'cor')
          .update({ nome: `Cor ${String(n)}` });
        if (n === 1) editar(2);
      });
    editar(1);
    const { resultados } = await rodarAteOFim({ responder: lojaCompleta(LOJA_DUAS_FAMILIAS) });
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(jobGravado().aprendizado.conflitos).toEqual([`${String(COR)}_2`]);
    const conflito = (liId: number) => ({
      codigo: 'conflito-de-escrita',
      acionavel: true,
      liId,
      referencias: [`${String(COR)}/2`],
    });
    expect(itens().get(100)?.pendencias).toEqual([conflito(102)]);
    expect(itens().get(200)?.pendencias).toEqual([conflito(202)]);
  });
});

/* --------------------------------- the budget -------------------------------- */

describe('the time budget', () => {
  it('stops BEFORE the unit that would cross 70 s, hands off at seq + 1, and the next dispatch resumes at the same offset', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const relogio = { agora: AGORA_MS };
    // Every call takes 18 s on the scripted clock, plus the pacer's 2 s: 20 s per call unit.
    const responder = (c: ChamadaCatalogoLi): RespostaCatalogoLi => {
      relogio.agora += 18_000;
      return lojaCompleta(LOJA_SIMPLES)(c);
    };
    const t = transporte();
    const um = montarDeps({ responder, relogio, t });
    const r1 = await despacharImportacaoLi(asDb(db), tarefa(0), um.deps);

    // 0 s: categories; 20 s: brands; 40 s: the link read (no call); 40 s: the listing page;
    // 60 s: its closing count (60 + 10 ≤ 70). At 60 s the trash page (60 + 22 > 70) does NOT start.
    expect(r1).toMatchObject({ desfecho: 'continuado', fase: 'lixeira', unidades: 5, chamadas: 3 });
    expect(um.chamadas).toHaveLength(3);
    expect(t.envios).toEqual([
      { tarefa: tarefa(1), opcoes: { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 2 } },
    ]);
    // Per-unit checkpoints never move seq; only the LAST write of the dispatch does.
    const seqs = escritasDoJob().map((e) => (e.dados as DocData).seq);
    expect(seqs).toEqual([undefined, undefined, undefined, undefined, undefined, 1]);
    expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1, fase: 'lixeira' });

    // The successor resumes at the trash list's first page — nothing before it is read again.
    const dois = montarDeps({ responder, relogio, t });
    await despacharImportacaoLi(asDb(db), tarefa(1), dois.deps);
    expect(dois.chamadas[0]).toMatchObject({ caminho: '/v1/produto/' });
    expect(parametroDe(dois.chamadas[0] ?? { caminho: '', query: [] }, 'removido')).toBe('true');
    expect(parametroDe(dois.chamadas[0] ?? { caminho: '', query: [] }, 'offset')).toBe('0');
  });

  it('families that call nothing are checkpointed ONE BY ONE, and the next dispatch resumes at the next family', async () => {
    const relogio = { agora: AGORA_MS };
    seedSnapshotDeFamilias([10, 20, 30, 40]);
    // Each family's item write takes 25 s on the scripted clock.
    for (const id of [10, 20, 30, 40]) {
      db.antesDaProximaEscrita(caminhoItemLi(JOB, String(id)), () => {
        relogio.agora += 25_000;
      });
    }
    const t = transporte();
    const um = montarDeps({ relogio, t });
    const r1 = await despacharImportacaoLi(asDb(db), tarefa(0), um.deps);
    // 0 s: 10; 25 s: 20; 50 s: 30 (50 + 10 ≤ 70); at 75 s family 40 does not start.
    expect(r1).toMatchObject({
      desfecho: 'continuado',
      fase: 'familias',
      unidades: 3,
      chamadas: 0,
    });
    expect([...itens().keys()]).toEqual([10, 20, 30]);
    expect(jobGravado().familias).toEqual({ cursorPaiId: 30, filhosLidos: [] });
    // One checkpoint per family, each moving the cursor past it, then the hand-off.
    expect(escritasDoJob().map((e) => (e.dados as DocData).familias)).toEqual([
      { cursorPaiId: 10, filhosLidos: [] },
      { cursorPaiId: 20, filhosLidos: [] },
      { cursorPaiId: 30, filhosLidos: [] },
      undefined,
    ]);

    const dois = montarDeps({ relogio, t });
    const r2 = await despacharImportacaoLi(asDb(db), tarefa(1), dois.deps);
    expect(r2.desfecho).toBe('concluido');
    // Families 10–30 were not redone: one item write each, ever.
    for (const id of [10, 20, 30, 40]) {
      expect(db.escritasEm(caminhoItemLi(JOB, String(id))), String(id)).toHaveLength(1);
    }
  });

  it('a dispatch whose start leaves no room for its first unit only hands off (the start stamp counts)', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const { deps, chamadas, t } = montarDeps({ jaDecorridoMs: 61_000 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'continuado', unidades: 0, chamadas: 0 });
    expect(chamadas).toEqual([]);
    expect(t.envios.map((e) => e.opcoes.id)).toEqual([`li-importacao-${JOB}-1`]);
    expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1, fase: 'catalogo' });
  });
});

/** A job already in the `familias` phase over a snapshot of simple products `ids`. */
function seedSnapshotDeFamilias(ids: readonly number[], over: DocData = {}): void {
  seedJobLi(db, JOB, CONTA, {
    status: 'executando',
    fase: 'familias',
    listagem: { proximoOffset: null, paginas: 1, linhas: ids.length, totalLi: ids.length },
    lixeira: { proximoOffset: null, paginas: 1, linhas: 0, totalLi: 0 },
    ...over,
  });
  db.seed(
    `${caminhoJobLi(JOB)}/paginas/${idPaginaImportacaoLi(TIPO_PAGINA_IMPORTACAO_LI.listagem, 0)}`,
    {
      tipo: 'listagem',
      offset: 0,
      linhas: ids.map((id) => vistaLi(linhaProdutoLi(id, { sku: `LI-${String(id)}` }))),
      linhasSemId: 0,
      limiteLido: 100,
      totalLi: ids.length,
      lidaEmMs: AGORA_MS,
    },
  );
}

/* --------------------------------- the hand-off --------------------------------- */

describe('the hand-off', () => {
  it('a transient enqueue failure AFTER the end-of-dispatch checkpoint: the retry re-enqueues the named successor ONCE, and the job finishes', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const t = transporte();
    t.falhas.push(falhaDoFunctions('unknown-error'));
    const relogio = { agora: AGORA_MS };

    const um = montarDeps({ relogio, t, jaDecorridoMs: 61_000 });
    await expect(despacharImportacaoLi(asDb(db), tarefa(0), um.deps)).rejects.toBeInstanceOf(
      LiTarefasTransitoriasError,
    );
    // The checkpoint landed before the hand-off failed.
    expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1 });

    // Cloud Tasks retries the SAME task (seq 0): stored − 1 ⇒ only the continuation check.
    const retry = montarDeps({ relogio, t, tentativa: 1 });
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), retry.deps)).desfecho).toBe(
      'continuacao',
    );
    expect(retry.chamadas).toEqual([]);
    expect(t.envios.map((e) => e.opcoes.id)).toEqual([
      `li-importacao-${JOB}-1`,
      `li-importacao-${JOB}-1`,
    ]);

    const { resultados } = await rodarAteOFim({ relogio, t }, 1);
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(jobGravado()).toMatchObject({ status: 'concluido', seq: 1 });
  });

  it('an answered task-already-exists is SUCCESS: the dispatch ends continuado, nothing thrown', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const t = transporte();
    t.falhas.push(falhaDoFunctions('task-already-exists', 409));
    const { deps } = montarDeps({ t, jaDecorridoMs: 61_000 });
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), deps)).desfecho).toBe('continuado');
  });

  it('the tasks valve CLOSED at the hand-off ends the job falhou/tarefas-desligadas — never executando with nothing queued', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const { deps, t } = montarDeps({ desligado: true, jaDecorridoMs: 61_000 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'tarefas-desligadas' });
    expect(t.envios).toEqual([]);
    // The end-of-dispatch checkpoint landed (seq 1), then the stamp on THAT seq.
    expect(jobGravado()).toMatchObject({ status: 'falhou', motivo: 'tarefas-desligadas', seq: 1 });
  });
});

/* ---------------------------------- the 429 ---------------------------------- */

/** The store answering 429 to its first `n` calls, then normally. */
function lojaCom429(n: number) {
  let restantes = n;
  const normal = lojaCompleta(LOJA_SIMPLES);
  return (c: ChamadaCatalogoLi): RespostaCatalogoLi => {
    if (restantes > 0) {
      restantes -= 1;
      return { status: 429, corpo: { erro: 'limite' } };
    }
    return normal(c);
  };
}

describe('a 429', () => {
  it('PAUSES: the end-of-dispatch checkpoint with one more pause, the named continuation 60 s later — no attempt consumed', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente', pausas429: 3 });
    const { deps, t } = montarDeps({ responder: lojaCom429(1) });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'pausado', unidades: 0 });
    expect(t.envios).toEqual([
      { tarefa: tarefa(1), opcoes: { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 } },
    ]);
    expect(jobGravado()).toMatchObject({
      status: 'executando',
      seq: 1,
      pausas429: 4,
      fase: 'catalogo',
    });
    // The catalogue page is read again by the successor, from the same cursor.
    expect(jobGravado().catalogo).toEqual({ recurso: 'categorias', proximoOffset: 0, paginas: 0 });
  });

  it(`⚠️ the pause's hand-off failing transiently is recovered by the retry's continuation check, still 60 s later — the repair never shortens a pause`, async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const t = transporte();
    t.falhas.push(falhaDoFunctions('unknown-error'));
    const relogio = { agora: AGORA_MS };
    const um = montarDeps({ responder: lojaCom429(1), relogio, t });
    await expect(despacharImportacaoLi(asDb(db), tarefa(0), um.deps)).rejects.toBeInstanceOf(
      LiTarefasTransitoriasError,
    );
    expect(jobGravado()).toMatchObject({ seq: 1, pausas429: 1 });

    const retry = montarDeps({ relogio, t, tentativa: 1 });
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), retry.deps)).desfecho).toBe(
      'continuacao',
    );
    // The retry knows nothing of the pause its dead attempt checkpointed: the conservative 60 s.
    // NEAR-MISS: OUR OWN landed budget end, answered on the last attempt, still hands off at its
    // own 2 s (`the queue’s last attempt`, the end checkpoint LANDED behind a DEADLINE_EXCEEDED).
    expect(t.envios.map((e) => e.opcoes)).toEqual([
      { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 },
      { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 },
    ]);
    const { resultados } = await rodarAteOFim({ relogio, t }, 1);
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
  });

  it(`after ${String(MAX_PAUSAS_429_LI)} pauses the next 429 ends the job falhou/limite-de-chamadas`, async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente', pausas429: MAX_PAUSAS_429_LI });
    const { deps, t } = montarDeps({ responder: lojaCom429(1) });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'limite-de-chamadas' });
    expect(t.envios).toEqual([]);
    expect(jobGravado()).toMatchObject({
      status: 'falhou',
      motivo: 'limite-de-chamadas',
      pausas429: MAX_PAUSAS_429_LI,
      seq: 0,
    });
  });
});

/* ------------------------------ the last attempt ------------------------------ */

/** The store answering 503 to every call. */
function lojaFora(): RespostaCatalogoLi {
  return { status: 503, corpo: { erro: 'fora' } };
}

describe('the queue’s last attempt', () => {
  it('a 5xx before the last attempt is RETHROWN (the queue retries), and the job is left as checkpointed', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const { deps } = montarDeps({ responder: lojaFora, tentativa: 1 });
    await expect(despacharImportacaoLi(asDb(db), tarefa(0), deps)).rejects.toBeInstanceOf(
      LiHttpError,
    );
    expect(jobGravado()).toMatchObject({ status: 'pendente', seq: 0 });
  });

  it('the same 5xx on the LAST attempt stamps falhou/tentativas-esgotadas instead', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const { deps } = montarDeps({ responder: lojaFora, tentativa: 2 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'tentativas-esgotadas' });
    expect(jobGravado()).toMatchObject({ status: 'falhou', motivo: 'tentativas-esgotadas' });
  });

  it('after the end-of-dispatch checkpoint, the last attempt stamps the job’s NEW seq', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const t = transporte();
    t.falhas.push(falhaDoFunctions('unknown-error'));
    const { deps } = montarDeps({ t, tentativa: 2, jaDecorridoMs: 61_000 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'tentativas-esgotadas' });
    expect(jobGravado()).toMatchObject({ status: 'falhou', seq: 1 });
  });

  it('NEAR-MISS: a coding bug stays LOUD on the last attempt — rethrown, never stamped', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const bug = new TypeError('produtor quebrado');
    const { deps } = montarDeps({
      tentativa: 2,
      jaDecorridoMs: 61_000,
      agendador: () => {
        throw bug;
      },
    });
    await expect(despacharImportacaoLi(asDb(db), tarefa(0), deps)).rejects.toBe(bug);
    expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1 });
  });

  it('another writer of the SAME seq: thrown before the last attempt; on it the job is stamped tentativas-esgotadas — never left executando with no task to carry it', async () => {
    for (const [tentativa, esperado] of [
      [0, 'throws'],
      [2, 'falhou'],
    ] as const) {
      db = new FakeDb();
      seedConta(db, CONTA);
      seedCredencial(db, CONTA);
      __resetAllReadCaches();
      seedSnapshotDeFamilias([10, 20]);
      // Another dispatch of seq 0 writes the job while this one runs family 10.
      db.antesDaProximaEscrita(caminhoItemLi(JOB, '10'), async () => {
        await importacaoLojaIntegradaCollection
          .docRef(asDb(db), {}, JOB)
          .update({ atualizadoEmMs: 1 });
      });
      const { deps, t } = montarDeps({ tentativa });
      const execucao = despacharImportacaoLi(asDb(db), tarefa(0), deps);
      if (esperado === 'throws') {
        await expect(execucao).rejects.toMatchObject({ name: 'LiImportacaoConcorrenteError' });
        expect(jobGravado(), String(tentativa)).toMatchObject({ status: 'executando', seq: 0 });
      } else {
        // The queue's last attempt: no retry of this task follows, and the other writer was an
        // earlier attempt of it the queue already gave up on.
        expect(await execucao).toMatchObject({
          desfecho: 'falhou',
          motivo: 'tentativas-esgotadas',
        });
        expect(jobGravado()).toMatchObject({
          status: 'falhou',
          motivo: 'tentativas-esgotadas',
          seq: 0,
        });
      }
      expect(t.envios).toEqual([]);
    }
  });

  it('⚠️ NEAR-MISS: a job the other writer already moved past this seq is never stamped — its NAMED successor is handed off, on the last attempt and before it', async () => {
    for (const tentativa of [0, 2]) {
      db = new FakeDb();
      seedConta(db, CONTA);
      seedCredencial(db, CONTA);
      __resetAllReadCaches();
      seedSnapshotDeFamilias([10, 20]);
      // Another dispatch of seq 0 ENDS its slice (seq 1) while this one runs family 10 — and may
      // never hand off (the queue gave up on it): this stop is the only one left to.
      db.antesDaProximaEscrita(caminhoItemLi(JOB, '10'), async () => {
        await importacaoLojaIntegradaCollection
          .docRef(asDb(db), {}, JOB)
          .update({ atualizadoEmMs: 1, seq: 1 });
      });
      const { deps, t } = montarDeps({ tentativa });
      const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
      expect(r.desfecho, String(tentativa)).toBe('continuacao');
      expect(jobGravado(), String(tentativa)).toMatchObject({ status: 'executando', seq: 1 });
      // A COURTESY hand-off (the other dispatch owns the successor): the conservative 60 s, so a
      // pause that dispatch ended on is never shortened — its own enqueue wins or ours waits.
      expect(t.envios, String(tentativa)).toEqual([
        { tarefa: tarefa(1), opcoes: { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 } },
      ]);
    }
  });

  it('⚠️ a COURTESY hand-off that fails transiently never kills the job the other dispatch carries: `parado` on EVERY attempt — never rethrown, never stamped', async () => {
    for (const tentativa of [0, 1, 2]) {
      db = new FakeDb();
      seedConta(db, CONTA);
      seedCredencial(db, CONTA);
      __resetAllReadCaches();
      seedSnapshotDeFamilias([10, 20]);
      // An earlier attempt of this task, still alive, ENDS its slice (seq 1) and enqueued its own
      // successor; this attempt's unit checkpoint stops on it and enqueues the same name again.
      db.antesDaProximaEscrita(caminhoItemLi(JOB, '10'), async () => {
        await importacaoLojaIntegradaCollection
          .docRef(asDb(db), {}, JOB)
          .update({ atualizadoEmMs: 1, seq: 1 });
      });
      const t = transporte();
      t.falhas.push(falhaDoFunctions('unknown-error'));
      const { deps } = montarDeps({ t, tentativa });
      // Never rethrown: a retry of this task would find the job one seq ahead and run the
      // continuation check, which carries the job as its own and stamps it on the last attempt.
      expect(
        await despacharImportacaoLi(asDb(db), tarefa(0), deps),
        String(tentativa),
      ).toMatchObject({ desfecho: 'parado', motivo: null });
      expect(jobGravado(), String(tentativa)).toMatchObject({
        status: 'executando',
        seq: 1,
        motivo: null,
        atualizadoEmMs: 1,
      });
      expect(
        t.envios.map((e) => e.opcoes),
        String(tentativa),
      ).toEqual([{ id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 }]);
    }
  });

  it('⚠️ NEAR-MISS: a courtesy whose producer throws anything ELSE (a broken deploy, a coding bug) stays loud — the same error, on the stop and on the last attempt, and the job untouched', async () => {
    const casos = [
      { via: 'aoParar', tentativa: 0 },
      { via: 'aoParar', tentativa: 2 },
      { via: 'naUltimaTentativa', tentativa: 2 },
    ] as const;
    for (const { via, tentativa } of casos) {
      db = new FakeDb();
      seedConta(db, CONTA);
      seedCredencial(db, CONTA);
      __resetAllReadCaches();
      seedSnapshotDeFamilias([10, 20, 30]);
      if (via === 'aoParar') {
        // Another dispatch of seq 0 ends its slice while this one runs family 10.
        db.antesDaProximaEscrita(caminhoItemLi(JOB, '10'), async () => {
          await importacaoLojaIntegradaCollection
            .docRef(asDb(db), {}, JOB)
            .update({ atualizadoEmMs: 1, seq: 1 });
        });
      } else {
        // Another dispatch ends its slice, and THIS end checkpoint then fails unlanded.
        db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
          await importacaoLojaIntegradaCollection
            .docRef(asDb(db), {}, JOB)
            .update({ atualizadoEmMs: 1, seq: 1 });
          throw grpc(4, 'DEADLINE_EXCEEDED');
        });
      }
      const t = transporte();
      const quebra = new TypeError('broken deploy');
      t.falhas.push(quebra);
      const { deps } = montarDeps({
        t,
        tentativa,
        ...(via === 'naUltimaTentativa' ? { jaDecorridoMs: 61_000 } : {}),
      });
      const rotulo = `${via}/${String(tentativa)}`;
      await expect(despacharImportacaoLi(asDb(db), tarefa(0), deps), rotulo).rejects.toBe(quebra);
      expect(jobGravado(), rotulo).toMatchObject({
        status: 'executando',
        seq: 1,
        motivo: null,
        atualizadoEmMs: 1,
      });
      expect(
        t.envios.map((e) => e.opcoes),
        rotulo,
      ).toEqual([{ id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 }]);
    }
  });

  it('⚠️ a courtesy failing on attempt 1 ends that task `parado`, so no last attempt ever re-targets the seq another dispatch carries and stamps it', async () => {
    seedSnapshotDeFamilias([10, 20]);
    // Another dispatch of seq 0 ENDS its slice (seq 1) while attempt 1 runs family 10.
    db.antesDaProximaEscrita(caminhoItemLi(JOB, '10'), async () => {
      await importacaoLojaIntegradaCollection
        .docRef(asDb(db), {}, JOB)
        .update({ atualizadoEmMs: 1, seq: 1 });
    });
    const t = transporte();
    t.falhas.push(falhaDoFunctions('unknown-error'));
    const um = montarDeps({ t, tentativa: 1 });
    // The task SUCCEEDS: Cloud Tasks schedules no attempt 2 of it, whose continuation check would
    // point at seq 1, fail its enqueue as well and stamp a job it never carried.
    expect(await despacharImportacaoLi(asDb(db), tarefa(0), um.deps)).toMatchObject({
      desfecho: 'parado',
      motivo: null,
    });
    expect(jobGravado()).toMatchObject({
      status: 'executando',
      seq: 1,
      motivo: null,
      atualizadoEmMs: 1,
    });
    expect(escritasDoJob().map((e) => e.dados?.['status'])).not.toContain('falhou');
    expect(t.envios.map((e) => e.opcoes)).toEqual([
      { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 },
    ]);
  });

  it('⚠️ the OWNER’s repair across attempts: attempt 1’s OWN end checkpoint lands and its enqueue fails (rethrown); the last attempt’s continuation check hands off at the conservative 60 s — and stamps only when that enqueue fails too', async () => {
    for (const falhaNaUltima of [false, true]) {
      db = new FakeDb();
      seedConta(db, CONTA);
      seedCredencial(db, CONTA);
      __resetAllReadCaches();
      seedSnapshotDeFamilias([10, 20, 30]);
      const t = transporte();
      t.falhas.push(falhaDoFunctions('unknown-error'));
      // No unit fits: a BUDGET end (its own delay 2 s), landed, then the hand-off fails.
      const um = montarDeps({ t, tentativa: 1, jaDecorridoMs: 61_000 });
      await expect(despacharImportacaoLi(asDb(db), tarefa(0), um.deps)).rejects.toBeInstanceOf(
        LiTarefasTransitoriasError,
      );
      expect(jobGravado(), String(falhaNaUltima)).toMatchObject({ status: 'executando', seq: 1 });

      // The queue's LAST attempt of the same task, on the state attempt 1 left.
      if (falhaNaUltima) t.falhas.push(falhaDoFunctions('unknown-error'));
      const dois = montarDeps({ t, tentativa: 2 });
      const r = await despacharImportacaoLi(asDb(db), tarefa(0), dois.deps);
      if (falhaNaUltima) {
        // Ours, and no retry follows: a visible failure beats a job `executando` with nothing queued.
        expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'tentativas-esgotadas' });
        expect(jobGravado()).toMatchObject({
          status: 'falhou',
          motivo: 'tentativas-esgotadas',
          seq: 1,
        });
      } else {
        expect(r).toMatchObject({ desfecho: 'continuacao', motivo: null });
        expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1, motivo: null });
      }
      // The continuation check cannot know its dead attempt's checkpoint was a budget end.
      expect(
        t.envios.map((e) => e.opcoes),
        String(falhaNaUltima),
      ).toEqual([
        { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 2 },
        { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 },
      ]);
    }
  });

  it('⚠️ the last attempt finds the job ONE seq ahead written by ANOTHER dispatch (its own end checkpoint never landed): a courtesy hand-off at 60 s; failing, `parado` — never stamped', async () => {
    for (const falha of [false, true]) {
      db = new FakeDb();
      seedConta(db, CONTA);
      seedCredencial(db, CONTA);
      __resetAllReadCaches();
      seedSnapshotDeFamilias([10, 20, 30]);
      // Another dispatch of seq 0 ends its slice, and THIS end checkpoint then fails unlanded.
      db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
        await importacaoLojaIntegradaCollection
          .docRef(asDb(db), {}, JOB)
          .update({ atualizadoEmMs: 1, seq: 1 });
        throw grpc(4, 'DEADLINE_EXCEEDED');
      });
      const t = transporte();
      if (falha) t.falhas.push(falhaDoFunctions('unknown-error'));
      const { deps } = montarDeps({ t, tentativa: 2, jaDecorridoMs: 61_000 });
      const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
      expect(r, String(falha)).toMatchObject({
        desfecho: falha ? 'parado' : 'continuacao',
        motivo: null,
      });
      expect(jobGravado(), String(falha)).toMatchObject({
        status: 'executando',
        seq: 1,
        motivo: null,
        atualizadoEmMs: 1,
      });
      expect(
        t.envios.map((e) => e.opcoes),
        String(falha),
      ).toEqual([{ id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 }]);
    }
  });

  it('⚠️ OUR 429-pause end checkpoint LANDED behind a DEADLINE_EXCEEDED, on the last attempt: the successor is handed off 60 s later — the pause is never shortened', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB), grpc(4, 'DEADLINE_EXCEEDED'));
    const { deps, t } = montarDeps({ responder: lojaCom429(1_000), tentativa: 2 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'continuacao', motivo: null });
    expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1, pausas429: 1 });
    expect(t.envios).toEqual([
      { tarefa: tarefa(1), opcoes: { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 60 } },
    ]);
  });

  it('⚠️ OUR end checkpoint LANDED behind a DEADLINE_EXCEEDED and the last attempt’s hand-off fails transiently too: the job’s NEW seq is stamped tentativas-esgotadas — the common case, where nobody else enqueued', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB), grpc(4, 'DEADLINE_EXCEEDED'));
    const t = transporte();
    t.falhas.push(falhaDoFunctions('unknown-error'));
    const { deps } = montarDeps({ t, tentativa: 2, jaDecorridoMs: 61_000 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'tentativas-esgotadas' });
    expect(jobGravado()).toMatchObject({
      status: 'falhou',
      motivo: 'tentativas-esgotadas',
      seq: 1,
    });
    expect(t.envios.map((e) => e.opcoes)).toEqual([
      { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 2 },
    ]);
  });

  it('⚠️ the END-of-dispatch checkpoint LANDED but the call failed DEADLINE_EXCEEDED, on the last attempt: the named successor is handed off, the job never stamped', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB), grpc(4, 'DEADLINE_EXCEEDED'));
    const t = transporte();
    // No unit fits: the end-of-dispatch checkpoint is the dispatch's first write.
    const { deps } = montarDeps({ t, tentativa: 2, jaDecorridoMs: 61_000 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r.desfecho).toBe('continuacao');
    expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1, motivo: null });
    // NEAR-MISS of the 429 case below: OUR landed end was a BUDGET end ⇒ its own 2 s.
    expect(t.envios).toEqual([
      { tarefa: tarefa(1), opcoes: { id: `li-importacao-${JOB}-1`, scheduleDelaySeconds: 2 } },
    ]);
    // The chain goes on from the successor.
    const { resultados } = await rodarAteOFim({ t }, 1);
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
  });

  it('⚠️ the END-of-dispatch checkpoint LANDED, came back 9 and its re-read failed UNAVAILABLE, on the last attempt: the named successor is handed off, the job never stamped', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB));
    const t = transporte();
    const { deps } = montarDeps({ t, tentativa: 2, jaDecorridoMs: 61_000 });
    // The dispatch's own job read goes first: let it through, then fail the checkpoint's re-read.
    db.antesDaProximaEscrita(caminhoJobLi(JOB), () => {
      db.falharProximaLeitura(caminhoJobLi(JOB), grpc(14, 'UNAVAILABLE'));
    });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r.desfecho).toBe('continuacao');
    expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1, motivo: null });
    expect(t.envios.map((e) => e.opcoes.id)).toEqual([`li-importacao-${JOB}-1`]);
  });

  it('NEAR-MISS: the END-of-dispatch checkpoint did NOT land (DEADLINE_EXCEEDED before it), on the last attempt: stamped tentativas-esgotadas at the SAME seq, nothing handed off', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    db.antesDaProximaEscrita(caminhoJobLi(JOB), () => {
      throw grpc(4, 'DEADLINE_EXCEEDED');
    });
    const t = transporte();
    const { deps } = montarDeps({ t, tentativa: 2, jaDecorridoMs: 61_000 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'tentativas-esgotadas' });
    expect(jobGravado()).toMatchObject({
      status: 'falhou',
      motivo: 'tentativas-esgotadas',
      seq: 0,
    });
    expect(t.envios).toEqual([]);
  });
});

/* ------------------------------ a lost reply ------------------------------ */

describe('a family unit retried after its link LANDED (its item write failed)', () => {
  const LINK_20 = 'produtos/p20/produtolojaintegrada/20';

  /**
   * A whole job of `modo` over `LOJA_SIMPLES`, whose product 20 the ERP has by SKU. With `falhar`,
   * the first dispatch's write of item 20 fails transiently AFTER its link landed (the queue
   * retries the SAME task from the last checkpoint).
   */
  async function rodarLoja(modo: ModoImportacaoLi, falhar: boolean) {
    db = new FakeDb();
    seedConta(db, CONTA);
    seedCredencial(db, CONTA);
    db.seed('produtos/p20', { nome: 'P20', sku: 'LI-20', paiId: null, filhoUnicoId: null });
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo });
    __resetAllReadCaches();
    if (falhar) {
      db.falharEscrita(caminhoItemLi(JOB, '20'), grpc(14, 'UNAVAILABLE'));
      await expect(
        despacharImportacaoLi(asDb(db), tarefa(0), montarDeps().deps),
      ).rejects.toMatchObject({ code: 14 });
      db.falharEscrita(caminhoItemLi(JOB, '20'), null);
      expect(db.escritasEm(LINK_20).map((e) => e.verbo)).toEqual(['create']);
    }
    const { resultados } = await rodarAteOFim({ tentativa: falhar ? 1 : 0 });
    return { fim: resultados.at(-1)?.desfecho, itens: itens(), job: jobGravado() };
  }

  it('⚠️ the retry reports and counts the link its job created: the uninterrupted run’s items and counters, and Simular’s', async () => {
    const limpo = await rodarLoja(MODO_IMPORTACAO_LI.aplicar, false);
    const simulado = await rodarLoja(MODO_IMPORTACAO_LI.simular, false);
    const retentado = await rodarLoja(MODO_IMPORTACAO_LI.aplicar, true);

    expect(retentado.fim).toBe('concluido');
    // The link was created ONCE, by the first attempt.
    expect(db.escritasEm(LINK_20).map((e) => e.verbo)).toEqual(['create']);
    expect(retentado.itens.get(20)).toMatchObject({
      situacaoErp: SITUACAO_ERP_ITEM_LI.encontrado,
      acao: ACAO_ITEM_IMPORTACAO_LI.vincular,
      aplicada: true,
    });
    expect(retentado.job.contadores).toMatchObject({ familias: 3, vinculados: 1, semMudanca: 2 });
    expect(retentado.job.contadores).toEqual(limpo.job.contadores);
    expect(retentado.job.contadores).toEqual(simulado.job.contadores);
    expect([...retentado.itens.keys()]).toEqual([...limpo.itens.keys()]);
    for (const id of limpo.itens.keys()) {
      // `aplicada` included: only WHEN the retry wrote it differs.
      const { atualizadoEmMs: _quando, ...doRetentado } = retentado.itens.get(id) ?? {};
      const { atualizadoEmMs: _quandoLimpo, ...doLimpo } = limpo.itens.get(id) ?? {};
      expect(doRetentado, String(id)).toEqual(doLimpo);
      expect(veredito(retentado.itens.get(id)), String(id)).toEqual(
        veredito(simulado.itens.get(id)),
      );
    }
  });
});

describe('a checkpoint whose reply was lost (the SDK retried a commit that had landed)', () => {
  it('⚠️ the END-of-dispatch checkpoint still hands off: the named successor is enqueued and the chain goes on', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB));
    const t = transporte();
    // No unit fits: the end-of-dispatch checkpoint is the dispatch's first write.
    const { deps } = montarDeps({ t, jaDecorridoMs: 61_000 });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r.desfecho).toBe('continuado');
    expect(jobGravado()).toMatchObject({ status: 'executando', seq: 1 });
    expect(t.envios.map((e) => e.opcoes.id)).toEqual([`li-importacao-${JOB}-1`]);
    const { resultados } = await rodarAteOFim({ t }, 1);
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
  });

  it('a UNIT checkpoint goes on to the next unit on the stored stamp: no throw, no retry', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    db.respostaPerdidaNaProximaEscrita(caminhoJobLi(JOB));
    const { deps } = montarDeps();
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r.desfecho).toBe('concluido');
    expect([...itens().keys()]).toEqual([10, 20, 30]);
  });
});

/* -------------------------------- the cancel -------------------------------- */

describe('a cancel', () => {
  it('between two families under "only link": the next checkpoint loses, and the dispatch stops at the next family', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    db.antesDaProximaEscrita(caminhoItemLi(JOB, '10'), async () => {
      await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS);
    });
    const { deps, t } = montarDeps();
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'parado', unidades: 1 });
    expect([...itens().keys()]).toEqual([10]);
    // The lost checkpoint was never re-applied over the cancel.
    expect(jobGravado()).toMatchObject({
      status: 'cancelado',
      familias: { cursorPaiId: null, filhosLidos: [] },
    });
    expect(t.envios).toEqual([]);
  });

  it('⚠️ landing while the job’s END counts its pendências: the summary aviso is NOT synced — a cancelled job never raises or resolves it', async () => {
    const chave = chaveDeAviso({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
      conta: CONTA,
    });
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
    // The count pages the job's own items: the operator's Cancelar lands right then.
    db.antesDaProximaConsulta(`${caminhoJobLi(JOB)}/itens`, async () => {
      await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS);
    });
    const semSku: LojaDeProdutosLi = { ativos: [linhaProdutoLi(10, { sku: '' })] };
    const { resultados } = await rodarAteOFim({ responder: lojaCompleta(semSku) });
    expect(resultados.at(-1)?.desfecho).toBe('parado');
    expect(jobGravado().status).toBe('cancelado');
    expect(db.ler(caminhoAviso(chave))).toBeUndefined();
  });

  it('⚠️ NEAR-MISS: the same job with no cancel raises the summary aviso at its end', async () => {
    const chave = chaveDeAviso({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoComPendencias,
      conta: CONTA,
    });
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
    const semSku: LojaDeProdutosLi = { ativos: [linhaProdutoLi(10, { sku: '' })] };
    const { resultados } = await rodarAteOFim({ responder: lojaCompleta(semSku) });
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(db.ler(caminhoAviso(chave))).toMatchObject({ resolvidoEm: null });
  });

  it('between two DISPATCHES, before the successor reads the job: the successor reads the cancel and does nothing', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    const t = transporte();
    const um = montarDeps({ t, jaDecorridoMs: 61_000 });
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), um.deps)).desfecho).toBe('continuado');
    await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS);
    const dois = montarDeps({ t });
    expect((await despacharImportacaoLi(asDb(db), tarefa(1), dois.deps)).desfecho).toBe('nada');
    expect(itens().size).toBe(0);
    expect(jobGravado().status).toBe('cancelado');
  });

  it('between two DISPATCHES, after the successor read the job: its first checkpoint loses and it stops', async () => {
    seedSnapshotDeFamilias([10, 20, 30]);
    const t = transporte();
    const um = montarDeps({ t, jaDecorridoMs: 61_000 });
    await despacharImportacaoLi(asDb(db), tarefa(0), um.deps);
    // The cancel lands while the successor runs its first family.
    db.antesDaProximaEscrita(caminhoItemLi(JOB, '10'), async () => {
      await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS);
    });
    const dois = montarDeps({ t });
    expect((await despacharImportacaoLi(asDb(db), tarefa(1), dois.deps)).desfecho).toBe('parado');
    expect(jobGravado()).toMatchObject({
      status: 'cancelado',
      seq: 1,
      familias: { cursorPaiId: null, filhosLidos: [] },
    });
    expect(t.envios.map((e) => e.opcoes.id)).toEqual([`li-importacao-${JOB}-1`]);
  });
});

/* ---------------------------- a family's own calls ---------------------------- */

/** A job whose listing and trash list are read, over one page of `linhas` (row views). */
function seedSnapshotLido(linhas: readonly DocData[], fase: string): void {
  seedJobLi(db, JOB, CONTA, {
    status: 'executando',
    fase,
    listagem: { proximoOffset: null, paginas: 1, linhas: linhas.length, totalLi: linhas.length },
    lixeira: { proximoOffset: null, paginas: 1, linhas: 0, totalLi: 0 },
  });
  db.seed(
    `${caminhoJobLi(JOB)}/paginas/${idPaginaImportacaoLi(TIPO_PAGINA_IMPORTACAO_LI.listagem, 0)}`,
    {
      tipo: 'listagem',
      offset: 0,
      linhas: linhas.map((l) => vistaLi(l)),
      linhasSemId: 0,
      limiteLido: 100,
      totalLi: linhas.length,
      lidaEmMs: AGORA_MS,
    },
  );
}

describe('a variation a parent claims that was never a row', () => {
  it('is detail-read in the `orfaos` phase as its OWN unit (a call), BEFORE any family is matched, and its family is planned with it without reading it again', async () => {
    // Parent 10 claims 11, which no list carried: only its detail can say what it is.
    seedSnapshotLido([paiLi(10, [11], { sku: 'LI-10' })], 'orfaos');
    const relogio = { agora: AGORA_MS };
    const filho = filhoLi(11, { sku: 'LI-11' });
    const loja = lojaCompleta({ ativos: [], detalhes: new Map([[11, detalheLi(filho, 10)]]) });
    // The detail takes 60 s on the scripted clock: no other unit fits after it.
    const responder = (c: ChamadaCatalogoLi): RespostaCatalogoLi => {
      relogio.agora += 60_000;
      return loja(c);
    };
    const t = transporte();

    const um = montarDeps({ responder, relogio, t });
    const r1 = await despacharImportacaoLi(asDb(db), tarefa(0), um.deps);
    expect(r1).toMatchObject({ desfecho: 'continuado', fase: 'orfaos', unidades: 1, chamadas: 1 });
    expect(um.chamadas.map((c) => c.caminho)).toEqual(['/v1/produto/11/']);
    expect(jobGravado().orfaos).toEqual({ cursorLiId: 11 });
    expect(itens().size).toBe(0);

    const dois = montarDeps({ responder, relogio, t });
    const r2 = await despacharImportacaoLi(asDb(db), tarefa(1), dois.deps);
    expect(r2).toMatchObject({ desfecho: 'concluido', chamadas: 0 });
    expect(dois.chamadas).toEqual([]);
    // The family was planned WITH the variation its detail attached.
    expect(itens().get(10)).toMatchObject({ liId: 10, filhos: 1, situacaoErp: 'ausente' });
    // The family phase never reads a detail of its own in this build.
    expect(jobGravado().familias.filhosLidos).toEqual([]);
  });

  it.each([
    ['the simple product first (id 10 < the parent 20)', 10],
    ['the parent first (id 20 < the simple product 30)', 30],
  ])(
    '⚠️ a SKU the never-listed variation repeats is known before ANY family is matched — %s gives the same verdict',
    async (_ordem, simplesId) => {
      // A simple product with SKU `X`, and a parent claiming 21 — never listed — whose detail
      // carries `X` too. The ERP has a root `X`: the store repeats the SKU, so neither row may be
      // matched by it, whichever is processed first.
      db.seed('produtos/erp-x', { nome: 'X', sku: 'X', paiId: null });
      seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar' });
      const loja: LojaDeProdutosLi = {
        ativos: [linhaProdutoLi(simplesId, { sku: 'X' }), paiLi(20, [21], { sku: 'P-20' })],
        detalhes: new Map([[21, detalheLi(filhoLi(21, { sku: 'X' }), 20)]]),
      };
      const { resultados } = await rodarAteOFim({ responder: lojaCompleta(loja) });
      expect(resultados.at(-1)?.desfecho).toBe('concluido');
      expect(itens().get(simplesId)).toMatchObject({
        situacaoErp: 'conflito',
        erpId: null,
        acao: 'nenhuma',
        pendencias: [{ codigo: 'sku-repetido-na-loja', acionavel: true }],
      });
      // No link of it was written under the ERP root.
      expect(db.idsEm('produtos/erp-x/produtolojaintegrada')).toEqual([]);
    },
  );
});

/**
 * A store with one family (20 ⊃ 22) and three LOOSE rows: 21, a variation no parent claims whose
 * detail names none; 31, a variation of the trashed parent 30; 40, a row of a `tipo` this build
 * does not know.
 */
const LOJA_COM_AVULSOS: LojaDeProdutosLi = {
  ativos: [
    paiLi(20, [22], { sku: 'P-20' }),
    filhoLi(21, { sku: 'F-21' }),
    filhoLi(22, { sku: 'F-22' }),
    filhoLi(31, { sku: 'F-31' }),
    linhaProdutoLi(40, { sku: 'K-40', tipo: 'kit' }),
  ],
  lixeira: [paiLi(30, [31], { sku: 'P-30', removido: true })],
  detalhes: new Map([[21, detalheLi(filhoLi(21, { sku: 'F-21' }), null)]]),
};

describe('rows a read skips', () => {
  it('a live-list row that says `removido: true` is skipped — and ONE warn line says how many, ids and counts only', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const loja: LojaDeProdutosLi = {
      ativos: [linhaProdutoLi(10, { sku: 'LI-10' }), linhaProdutoLi(15, { removido: true })],
    };
    const { deps, warn } = montarDeps({ responder: lojaCompleta(loja) });
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), deps)).desfecho).toBe('concluido');
    expect([...itens().keys()]).toEqual([10]);
    expect(warn).toHaveBeenCalledWith(
      '[loja-integrada] importação: leitura com linhas ignoradas',
      expect.objectContaining({ jobId: JOB, leitura: 'listagem', foraDoFiltro: 1, semId: 0 }),
    );
  });

  it('⚠️ NEAR-MISS: a store whose reads skip nothing logs no such line', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const { deps, warn } = montarDeps();
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), deps)).desfecho).toBe('concluido');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('loose rows — no family, never matched', () => {
  it.each([MODO_IMPORTACAO_LI.simular, MODO_IMPORTACAO_LI.aplicar])(
    '⚠️ each reaches the report as its own `avulso` item with its informational code (%s, alvo todos) — never a silent drop',
    async (modo) => {
      seedJobLi(db, JOB, CONTA, { status: 'pendente', modo });
      const { resultados } = await rodarAteOFim({ responder: lojaCompleta(LOJA_COM_AVULSOS) });
      expect(resultados.at(-1)?.desfecho).toBe('concluido');
      const avulso = (liId: number, tipo: string, codigo: string) => ({
        liId,
        tipo,
        situacaoErp: 'avulso',
        erpId: null,
        acao: 'nenhuma',
        aplicada: false,
        pendencias: [{ codigo, acionavel: false, liId: null, referencias: [] }],
      });
      expect(itens().get(21)).toMatchObject(avulso(21, 'atributo_opcao', 'orfao'));
      expect(itens().get(31)).toMatchObject(avulso(31, 'atributo_opcao', 'na-lixeira'));
      expect(itens().get(40)).toMatchObject(avulso(40, 'desconhecido', 'tipo-desconhecido'));
      expect([...itens().keys()].sort((a, b) => a - b)).toEqual([20, 21, 31, 40]);
      // Counted as what they are: informational pendências, never families.
      expect(jobGravado().contadores).toMatchObject({
        familias: 1,
        pendenciasInformativas: 3,
        pendenciasAcionaveis: 0,
      });
    },
  );

  it('⚠️ NEAR-MISS: a `selecionados` job reports only its selection — no loose row joins it', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'pendente', alvo: 'selecionados', selecionados: [20] });
    await rodarAteOFim({ responder: lojaCompleta(LOJA_COM_AVULSOS) });
    expect([...itens().keys()]).toEqual([20]);
  });
});

describe('a variation read in the SAME dispatch as its family', () => {
  it('joins the family as it was stored — the dispatch never plans from a stale assembly', async () => {
    seedSnapshotLido([paiLi(10, [11], { sku: 'LI-10' })], 'orfaos');
    const filho = filhoLi(11, { sku: 'LI-11' });
    const { deps, chamadas } = montarDeps({
      responder: lojaCompleta({ ativos: [], detalhes: new Map([[11, detalheLi(filho, 10)]]) }),
    });
    expect((await despacharImportacaoLi(asDb(db), tarefa(0), deps)).desfecho).toBe('concluido');
    expect(chamadas.map((c) => c.caminho)).toEqual(['/v1/produto/11/']);
    expect(itens().get(10)).toMatchObject({ filhos: 1, pendencias: [] });
  });
});

describe('the tax-review phase', () => {
  it('`familias` is followed by `revisao` for EVERY `aplicar` job, under either action; by `fim` under Simular', () => {
    for (const acao of [ACAO_IMPORTACAO_LI.soVincular, ACAO_IMPORTACAO_LI.completar]) {
      expect(faseDepoisDasFamiliasLi({ modo: MODO_IMPORTACAO_LI.aplicar, acao })).toBe(
        FASE_IMPORTACAO_LI.revisao,
      );
      expect(faseDepoisDasFamiliasLi({ modo: MODO_IMPORTACAO_LI.simular, acao })).toBe(
        FASE_IMPORTACAO_LI.fim,
      );
    }
  });

  it('a Simular job found in `revisao` concludes it with no work, raising and resolving nothing', async () => {
    seedJobLi(db, JOB, CONTA, { status: 'executando', fase: 'revisao', modo: 'simular' });
    const { deps, chamadas } = montarDeps();
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r).toMatchObject({ desfecho: 'concluido', unidades: 1, chamadas: 0 });
    expect(chamadas).toEqual([]);
    expect(escritasDoJob().map((e) => (e.dados as DocData).fase ?? null)).toEqual(['fim', null]);
    expect(db.escritas.filter((e) => e.caminho.startsWith('avisos/'))).toEqual([]);
    expect(db.consultas).toEqual([]);
  });

  const AVISO_REVISAO = () =>
    caminhoAviso(chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaRevisaoFiscal, conta: CONTA }));

  /** An earlier `aplicar` job of the conta that concluded with `produtoId` on its list. */
  function jobAnteriorComRevisao(produtoId: string): void {
    seedJobLi(db, 'job-anterior', CONTA, {
      status: 'concluido',
      modo: 'aplicar',
      fase: 'fim',
      iniciadoEmMs: AGORA_MS - 86_400_000,
    });
    db.seed(`${caminhoJobLi('job-anterior')}/revisao/${produtoId}`, {
      produtoId,
      motivos: ['produto-criado'],
      liId: null,
      desdeJobId: 'job-anterior',
      desdeMs: AGORA_MS - 86_400_000,
    });
  }

  it('an `aplicar` job carries the earlier job’s open entry forward, keeps it without evidence and raises the aviso with the open count', async () => {
    jobAnteriorComRevisao('p-revisao');
    db.seed('produtos/p-revisao', { nome: 'Sem imposto', sku: 'SEM-IMP', paiId: null });
    seedJobLi(db, JOB, CONTA, { status: 'executando', fase: 'revisao', modo: 'aplicar' });
    const { resultados } = await rodarAteOFim({});
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(db.ler(`${caminhoJobLi(JOB)}/revisao/p-revisao`)).toMatchObject({
      produtoId: 'p-revisao',
      desdeJobId: 'job-anterior',
    });
    expect(db.ler(AVISO_REVISAO())).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaRevisaoFiscal,
      resolvidoEm: null,
      params: expect.objectContaining({ abertos: 1, job: JOB }),
    });
    expect(jobGravado()).toMatchObject({ status: 'concluido', fase: 'fim' });
  });

  it('the entry leaves on evidence — the produto’s own `imposto` — and the aviso resolves (near-miss: the same entry without it stays)', async () => {
    jobAnteriorComRevisao('p-revisao');
    db.seed('produtos/p-revisao', { nome: 'Com imposto', sku: 'COM-IMP', paiId: null });
    db.seed('produtos/p-revisao/imposto/i-1', { ncm: '00000000' });
    seedJobLi(db, JOB, CONTA, { status: 'executando', fase: 'revisao', modo: 'aplicar' });
    await rodarAteOFim({});
    expect(db.ler(`${caminhoJobLi(JOB)}/revisao/p-revisao`)).toBeUndefined();
    expect(db.ler(AVISO_REVISAO())).toMatchObject({ resolvidoEm: expect.anything() });
  });
});

/* -------------------------------- other failures ------------------------------- */

describe('failures a dispatch answers itself', () => {
  it.each([MODO_IMPORTACAO_LI.aplicar, MODO_IMPORTACAO_LI.simular])(
    'a 401 parks the conta like every reader — under %s too, the one write a Simular makes outside its job — and ends the job falhou/conta-indisponivel',
    async (modo) => {
      seedJobLi(db, JOB, CONTA, { status: 'pendente', modo });
      const { deps, t } = montarDeps({ responder: () => ({ status: 401, corpo: { erro: 'x' } }) });
      const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
      // The refused request is the one call: nothing is sent after it.
      expect(r).toMatchObject({ desfecho: 'falhou', motivo: 'conta-indisponivel', chamadas: 1 });
      expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 401 });
      expect(t.envios).toEqual([]);
    },
  );

  it('a product detail OFF ITS SCHEMA is contained: logged, the product has no usable detail, and the job goes on', async () => {
    // Variation 21 is claimed by no listed parent: the `orfaos` phase reads its detail, whose
    // `pai` is not a string.
    const loja: LojaDeProdutosLi = {
      ativos: [paiLi(20, [22]), filhoLi(21), filhoLi(22)],
      detalhes: new Map([[21, detalheLi(filhoLi(21), null, { pai: 12345 })]]),
    };
    seedJobLi(db, JOB, CONTA, { status: 'pendente' });
    const { deps, warn } = montarDeps({ responder: lojaCompleta(loja) });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r.desfecho).toBe('concluido');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('detalhe fora do formato'),
      expect.objectContaining({ jobId: JOB, liId: 21, campos: expect.arrayContaining(['pai']) }),
    );
    expect(db.ler(`${caminhoJobLi(JOB)}/detalhes/21`)).toBeUndefined();
    expect(jobGravado().orfaos).toEqual({ cursorLiId: 21 });
  });

  it.each([
    ['an EMPTY 200', ''],
    ['an HTML 200 (a gateway page)', '<html>gateway</html>'],
  ])(
    '⚠️ NEAR-MISS: %s for a detail is a TRANSPORT failure — rethrown and retried, never "no usable detail": the retry attaches the variation to its family',
    async (_caso, corpo) => {
      const loja: LojaDeProdutosLi = {
        ativos: [paiLi(20, [22]), filhoLi(21), filhoLi(22)],
        detalhes: new Map([[21, detalheLi(filhoLi(21), 20)]]),
      };
      seedJobLi(db, JOB, CONTA, { status: 'pendente' });
      let falhas = 1;
      const base = lojaCompleta(loja);
      const responder = (c: ChamadaCatalogoLi): RespostaCatalogoLi => {
        if (c.caminho === '/v1/produto/21/' && falhas > 0) {
          falhas -= 1;
          return { status: 200, corpo: null, texto: corpo };
        }
        return base(c);
      };
      const t = transporte();
      const um = montarDeps({ responder, t });
      await expect(despacharImportacaoLi(asDb(db), tarefa(0), um.deps)).rejects.toMatchObject({
        name: 'LiSchemaError',
      });
      // Nothing moved past the variation: the retry reads it again.
      expect(jobGravado().orfaos).toEqual({ cursorLiId: null });

      const { resultados } = await rodarAteOFim({ responder, t, tentativa: 1 });
      expect(resultados.at(-1)?.desfecho).toBe('concluido');
      expect(itens().get(20)).toMatchObject({ filhos: 2, pendencias: [] });
      expect(itens().get(21)).toBeUndefined();
    },
  );
});

/* -------------------------------- the log line -------------------------------- */

describe('the log line', () => {
  it('names the raw ids one by one, the ending and the counts — never a value it cannot vouch for', () => {
    const campos = camposDoRegistroDaImportacaoLi(
      {
        desfecho: 'falhou',
        motivo: MOTIVO_FALHA_IMPORTACAO_LI.limiteDeChamadas,
        fase: FASE_IMPORTACAO_LI.listagem,
        unidades: 3,
        chamadas: 2,
      },
      { ...tarefa(4), extra: { nome: 'valor-que-nao-vai-ao-log' } },
    );
    expect(campos).toEqual({
      outcome: 'done',
      kind: 'falhou',
      detail: 'limite-de-chamadas',
      tipo: 'importacao',
      contaId: CONTA,
      jobId: JOB,
      seq: 4,
      fase: 'listagem',
      unidades: 3,
      chamadas: 2,
    });
    expect(
      camposDoRegistroDaImportacaoLi(
        { desfecho: 'payload-invalido', motivo: null, fase: null, unidades: 0, chamadas: 0 },
        { tipo: 'importacao', seq: -1, jobId: { x: 1 } },
      ),
    ).toMatchObject({ outcome: 'dropped', seq: null, jobId: null, contaId: null });
  });
});

/* --------------------------------- complete --------------------------------- */

/** grupo `cor` linking options 1..n of grade `COR` for this conta to variantes `v-1`..`v-n`. */
function seedGrupoCorDe(n: number): void {
  const ids = Array.from({ length: n }, (_, i) => `v-${String(i + 1)}`);
  const fusao = fundirLinksVariacoesLi(
    null,
    ids.map((varianteId, i) => ({
      integracaoLiId: CONTA,
      gradeId: COR,
      opcaoId: i + 1,
      varianteId,
    })),
  );
  if (!fusao.ok) throw new Error('seedGrupoCorDe: a fusão recusou a lista vazia');
  db.seed('grupoDeVariacoes/cor', {
    nome: 'Cor',
    ordem: 1,
    variacoesIds: ids,
    variacoes: ids.map((id) => ({ id, nome: `Cor ${id}` })),
    linksVariacoesli: fusao.array,
  });
}

/** A store family `sku` with `n` variations (option i ⇒ `v-i`) and every detail. */
function lojaDeUmaFamilia(paiId: number, sku: string, n: number): LojaDeProdutosLi {
  const filhos = Array.from({ length: n }, (_, i) =>
    filhoLi(paiId + i + 1, { sku: `${sku}-${String(i + 1)}`, variacoes: [uriOpcaoLi(COR, i + 1)] }),
  );
  const pai = paiLi(
    paiId,
    filhos.map((f) => f.id as number),
    { sku, nome: 'Família' },
  );
  return {
    ativos: [pai, ...filhos],
    detalhes: new Map([
      [paiId, detalheLi(pai, null)],
      ...filhos.map((f): [number, DocData] => [f.id as number, detalheLi(f, paiId)]),
    ]),
  };
}

/** A PNG: its magic number, then `n` (each picture its own bytes). */
function png(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n + 1]);
}

const imagemLi = (id: number, posicao: number) => ({
  id,
  caminho: `loja/produto/${String(id)}/foto.jpg`,
  principal: posicao === 1,
  posicao,
  mime: null,
});

const ehEscritaDoErp = (caminho: string) =>
  !caminho.startsWith('importacoesLojaIntegrada/') && !caminho.startsWith('avisos/');

describe('complete — the dispatch', () => {
  it('reads each detail the family needs as ONE unit, never twice, and creates a 50-variation family in ONE batch at the end, across several dispatches', async () => {
    seedGrupoCorDe(50);
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar', acao: 'completar' });
    const loja = lojaDeUmaFamilia(1000, 'GRANDE', 50);
    const plataforma = { responder: lojaCompleta(loja) };
    const { resultados } = await rodarAteOFim(plataforma, 0, 60);

    expect(resultados.length).toBeGreaterThan(2);
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    // Every detail asked for exactly once (51: the parent and its 50 variations).
    const lidos = db.escritas
      .filter((e) => e.caminho.startsWith(`${caminhoJobLi(JOB)}/detalhes/`))
      .map((e) => e.caminho);
    expect(lidos).toHaveLength(51);
    expect(new Set(lidos).size).toBe(51);
    // ONE commit created the whole family, after the last detail was read.
    const criacoes = db.escritas.filter(
      (e) => ehEscritaDoErp(e.caminho) && e.verbo === 'create' && e.caminho.startsWith('produtos/'),
    );
    expect(new Set(criacoes.map((e) => e.lote)).size).toBe(1);
    expect(criacoes[0]?.lote).toBeDefined();
    expect(criacoes.filter((e) => /^produtos\/[^/]+$/.test(e.caminho))).toHaveLength(51);
    const ultimaLeitura = db.escritas.reduce(
      (ultima, e, i) => (e.caminho.startsWith(`${caminhoJobLi(JOB)}/detalhes/`) ? i : ultima),
      -1,
    );
    expect(db.escritas.findIndex((e) => e === criacoes[0])).toBeGreaterThan(ultimaLeitura);
    expect(itens().get(1000)).toMatchObject({ acao: 'criar', aplicada: true, pendencias: [] });
    expect(jobGravado()).toMatchObject({
      status: 'concluido',
      familias: { cursorPaiId: null, filhosLidos: [] },
      contadores: { criados: 51, vinculados: 51 },
    });
  });

  it('a cancel between two complete units stops the dispatch at the next one: the second detail is never read', async () => {
    seedGrupoCorDe(2);
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar', acao: 'completar' });
    const loja = lojaDeUmaFamilia(1000, 'DUAS', 2);
    // The operator's Cancelar lands while the family's FIRST detail is being stored.
    db.antesDaProximaEscrita(`${caminhoJobLi(JOB)}/detalhes/1000`, async () => {
      await cancelarImportacaoLi(asDb(db), CONTA, JOB, AGORA_MS);
    });
    const { deps, chamadas } = montarDeps({ responder: lojaCompleta(loja) });
    const r = await despacharImportacaoLi(asDb(db), tarefa(0), deps);
    expect(r.desfecho).toBe('parado');
    expect(chamadas.map((c) => c.caminho).filter((c) => /^\/v1\/produto\/\d+\/$/.test(c))).toEqual([
      '/v1/produto/1000/',
    ]);
    expect(jobGravado()).toMatchObject({ status: 'cancelado' });
    expect(db.escritas.filter((e) => ehEscritaDoErp(e.caminho))).toEqual([]);
  });

  it('no bucket ⇒ `fotosIndisponiveis` on the job, no picture fetched — and the rest of the run still completes', async () => {
    const linha = linhaProdutoLi(10, { sku: 'COM-FOTO' });
    const loja: LojaDeProdutosLi = {
      ativos: [linha],
      detalhes: new Map([[10, detalheLi(linha, null, { imagens: [imagemLi(71, 1)] })]]),
    };
    seedJobLi(db, JOB, CONTA, {
      status: 'pendente',
      modo: 'aplicar',
      acao: 'completar',
      fotos: 'soSemFotos',
    });
    const pedidosCdn: string[] = [];
    const { resultados } = await rodarAteOFim({
      responder: lojaCompleta(loja),
      bucket: () => null,
      cdn: new Map([['loja/produto/71/foto.jpg', png(1)]]),
      pedidosCdn,
    });
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(jobGravado()).toMatchObject({ status: 'concluido', fotosIndisponiveis: true });
    expect(pedidosCdn).toEqual([]);
    expect(itens().get(10)).toMatchObject({ acao: 'criar', aplicada: true });
    expect(db.ler(`produtos/li-sku-${sha256Hex('COM-FOTO')}`)?.fotos ?? []).toEqual([]);
  });

  it('photos: the fill writes first, then each picture (one unit each, written once onto the produto), then the link LAST', async () => {
    db.seed('produtos/caneca', { nome: 'Caneca', sku: 'CAN-F', paiId: null, filhoUnicoId: null });
    const linha = linhaProdutoLi(20, { sku: 'CAN-F' });
    const loja: LojaDeProdutosLi = {
      ativos: [linha],
      detalhes: new Map([
        [20, detalheLi(linha, null, { imagens: [imagemLi(71, 1), imagemLi(72, 2)] })],
      ]),
    };
    seedJobLi(db, JOB, CONTA, {
      status: 'pendente',
      modo: 'aplicar',
      acao: 'completar',
      fotos: 'soSemFotos',
    });
    const bucket = new FakeBucket();
    const pedidosCdn: string[] = [];
    const { resultados } = await rodarAteOFim({
      responder: lojaCompleta(loja),
      bucket: () => asBucket(bucket),
      cdn: new Map([
        ['loja/produto/71/foto.jpg', png(1)],
        ['loja/produto/72/foto.jpg', png(2)],
      ]),
      pedidosCdn,
    });
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(pedidosCdn).toEqual(['/loja/produto/71/foto.jpg', '/loja/produto/72/foto.jpg']);
    expect(bucket.salvos).toHaveLength(2);

    const doErp = db.escritas.filter((e) => ehEscritaDoErp(e.caminho));
    const naCaneca = doErp.filter((e) => e.caminho === 'produtos/caneca');
    // Two writes on the produto: the fill, then its pictures (once, after both uploads).
    expect(naCaneca).toHaveLength(2);
    expect(Object.keys(naCaneca[1]?.dados ?? {}).sort()).toEqual([
      'fotos',
      'fotosArquivosIds',
      'ultimaModificacao',
    ]);
    const ordem = doErp.map((e) => e.caminho);
    const link = ordem.indexOf('produtos/caneca/produtolojaintegrada/20');
    expect(link).toBe(ordem.length - 1);
    expect(ordem.indexOf('produtos/caneca')).toBeLessThan(
      ordem.findIndex((c) => c.startsWith('arquivos/')),
    );
    expect(db.ler('produtos/caneca')?.fotos).toHaveLength(2);
    expect(itens().get(20)).toMatchObject({ acao: 'completar', aplicada: true });
    expect(itens().get(20)?.camposPreenchidos.at(-1)).toBe('fotos');
    expect(jobGravado()).toMatchObject({
      status: 'concluido',
      contadores: { fotos: 2, completados: 1, vinculados: 1 },
      // The family's progress is gone once it closed.
      revisao: expect.not.objectContaining({ cursorProdutoId: expect.stringMatching(/^f:/) }),
    });
  });

  /** One store simple product `sku` (id 20) with ONE picture, and its ERP produto `caneca`. */
  function lojaDeUmaFoto(sku: string): LojaDeProdutosLi {
    db.seed('produtos/caneca', { nome: 'Caneca', sku, paiId: null, filhoUnicoId: null });
    const linha = linhaProdutoLi(20, { sku });
    seedJobLi(db, JOB, CONTA, {
      status: 'pendente',
      modo: 'aplicar',
      acao: 'completar',
      fotos: 'soSemFotos',
    });
    return {
      ativos: [linha],
      detalhes: new Map([[20, detalheLi(linha, null, { imagens: [imagemLi(71, 1)] })]]),
    };
  }

  it('the prepared family’s progress rides its unit’s checkpoint: on a clock that moves at EVERY reading the run ends — the fill written once, then the picture', async () => {
    const loja = lojaDeUmaFoto('CAN-R');
    const bucket = new FakeBucket();
    const pedidosCdn: string[] = [];
    // Every reading costs 1 s, so a unit that does nothing still spends the budget: a progress
    // that never reached a checkpoint shows as a run that never ends, never as a hung suite.
    let agora = AGORA_MS;
    const relogio: Relogio = {
      get agora() {
        agora += 1_000;
        return agora;
      },
      set agora(ms: number) {
        agora = ms;
      },
    };
    const { resultados } = await rodarAteOFim({
      responder: lojaCompleta(loja),
      relogio,
      bucket: () => asBucket(bucket),
      cdn: new Map([['loja/produto/71/foto.jpg', png(1)]]),
      pedidosCdn,
    });
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(pedidosCdn).toEqual(['/loja/produto/71/foto.jpg']);
    // The preparation ran ONCE (its fill), then the picture's own write.
    const naCaneca = db.escritasEm('produtos/caneca');
    expect(naCaneca).toHaveLength(2);
    expect(Object.keys(naCaneca[1]?.dados ?? {}).sort()).toEqual([
      'fotos',
      'fotosArquivosIds',
      'ultimaModificacao',
    ]);
    // Between the two, a checkpoint carried the family's progress.
    const comProgresso = escritasDoJob().filter((e) => {
      const revisao = (e.dados as { revisao?: { cursorProdutoId?: unknown } }).revisao;
      return (
        typeof revisao?.cursorProdutoId === 'string' && revisao.cursorProdutoId.startsWith('f:')
      );
    });
    expect(comProgresso.length).toBeGreaterThan(0);
  });

  it('a photo unit starts only while its 52 s worst case fits — never on the 10 s a family unit needs', async () => {
    const loja = lojaDeUmaFoto('CAN-O');
    const bucket = new FakeBucket();
    const relogio: Relogio = { agora: AGORA_MS };
    const t = transporte();
    // Each CDN request: how far into ITS dispatch it was sent (the pacer's 2 s already waited).
    const decorridos: number[] = [];
    let proxima = tarefa(0);
    let ultimo: string | null = null;
    for (let i = 0; i < 40 && ultimo !== DESFECHO_DESPACHO_IMPORTACAO_LI.concluido; i += 1) {
      // The FIRST dispatch starts 30 s late: the family's preparation still fits (a few calls and
      // 10 s), its picture's 52 s does not.
      const jaDecorridoMs = i === 0 ? 30_000 : 0;
      const inicio = relogio.agora - jaDecorridoMs;
      const pedidos: string[] = [];
      const { deps } = montarDeps({
        responder: lojaCompleta(loja),
        relogio,
        t,
        jaDecorridoMs,
        bucket: () => asBucket(bucket),
        cdn: new Map([['loja/produto/71/foto.jpg', png(1)]]),
        pedidosCdn: pedidos,
      });
      const doDespacho = deps.fetch;
      if (doDespacho === undefined) throw new Error('despacho.test: montarDeps dá um fetch');
      const r = await despacharImportacaoLi(asDb(db), proxima, {
        ...deps,
        fetch: async (input, init) => {
          const antes = pedidos.length;
          const resposta = await doDespacho(input, init);
          if (pedidos.length > antes) decorridos.push(relogio.agora - inicio);
          return resposta;
        },
      });
      ultimo = r.desfecho;
      // Anti-vacuity: the late dispatch DID reach the picture — the family is prepared, its
      // picture pending, when it hands off.
      if (i === 0) expect(jobGravado().revisao.cursorProdutoId).toMatch(/^f:/);
      const enviada = t.envios.at(-1)?.tarefa;
      if (r.desfecho === DESFECHO_DESPACHO_IMPORTACAO_LI.continuado && enviada !== undefined) {
        proxima = enviada;
      }
    }
    expect(ultimo).toBe(DESFECHO_DESPACHO_IMPORTACAO_LI.concluido);
    // The first dispatch prepared the family and left the picture to the next one.
    expect(decorridos).toHaveLength(1);
    expect(decorridos[0]).toBeLessThanOrEqual(
      ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS -
        PIOR_CASO_UNIDADE_IMPORTACAO_LI_MS.foto +
        RITMO_LEITURA_LI_MS,
    );
    expect(db.ler('produtos/caneca')?.fotos).toHaveLength(1);
  });

  it('a second complete run over an unchanged store writes NO ERP document (idempotence)', async () => {
    db.seed('produtos/caneca', { nome: 'Caneca', sku: 'CAN-I', paiId: null, filhoUnicoId: null });
    const existente = linhaProdutoLi(20, { sku: 'CAN-I' });
    const nova = linhaProdutoLi(30, { sku: 'NOVA-I' });
    const loja: LojaDeProdutosLi = {
      ativos: [existente, nova],
      detalhes: new Map([
        [20, detalheLi(existente, null)],
        [30, detalheLi(nova, null)],
      ]),
    };
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar', acao: 'completar' });
    await rodarAteOFim({ responder: lojaCompleta(loja) });
    expect(itens().get(20)).toMatchObject({ acao: 'completar' });
    expect(itens().get(30)).toMatchObject({ acao: 'criar' });

    const antes = db.escritas.length;
    seedJobLi(db, 'job-despacho-2', CONTA, {
      status: 'pendente',
      modo: 'aplicar',
      acao: 'completar',
      iniciadoEmMs: AGORA_MS + 1,
    });
    const { resultados } = await rodarAteOFim(
      { responder: lojaCompleta(loja) },
      0,
      40,
      'job-despacho-2',
    );
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(db.escritas.slice(antes).filter((e) => ehEscritaDoErp(e.caminho))).toEqual([]);
  });
});

/** The A/B store under "complete", plus two store-only products in ONE unlinked store category. */
const LOJA_AB_COMPLETA: LojaDeProdutosLi = (() => {
  const p1 = linhaProdutoLi(10, { sku: 'P1', categorias: ['/api/v1/categoria/900'] });
  const p2 = linhaProdutoLi(20, { sku: 'P2', categorias: ['/api/v1/categoria/900'] });
  const ativos = [p1, p2, ...LOJA_AB.ativos];
  const paiDe = new Map<number, number>([
    [101, 100],
    [102, 100],
    [201, 200],
  ]);
  return {
    ativos,
    detalhes: new Map(
      ativos.map((linha): [number, DocData] => {
        const id = linha.id as number;
        return [id, detalheLi(linha, paiDe.get(id) ?? null)];
      }),
    ),
  };
})();

describe('complete — Simular and aplicar', () => {
  it('give the SAME per-item verdicts on ONE fixture where a category created for product 1 serves product 2 and a learning from family A resolves family B — and Simular writes only the job', async () => {
    async function rodarModo(modo: ModoImportacaoLi) {
      db = new FakeDb();
      seedConta(db, CONTA);
      seedCredencial(db, CONTA);
      seedErpAB();
      seedJobLi(db, JOB, CONTA, {
        status: 'pendente',
        modo,
        acao: 'completar',
        categorias: 'criarEVincular',
      });
      __resetAllReadCaches();
      const { resultados } = await rodarAteOFim({ responder: lojaCompleta(LOJA_AB_COMPLETA) });
      return {
        resultados,
        itens: itens(),
        job: jobGravado(),
        caminhos: db.escritas.map((e) => e.caminho),
        ler: (caminho: string) => db.ler(caminho),
      };
    }
    const simular = await rodarModo(MODO_IMPORTACAO_LI.simular);
    const aplicar = await rodarModo(MODO_IMPORTACAO_LI.aplicar);
    expect(simular.resultados.at(-1)?.desfecho).toBe('concluido');
    expect(aplicar.resultados.at(-1)?.desfecho).toBe('concluido');

    expect([...simular.itens.keys()]).toEqual([...aplicar.itens.keys()]);
    for (const id of aplicar.itens.keys()) {
      expect(veredito(simular.itens.get(id)), String(id)).toEqual(veredito(aplicar.itens.get(id)));
    }
    expect(simular.job.contadores).toEqual(aplicar.job.contadores);

    // Family B's green child is matched through the LEARNED option, under "complete" too.
    expect(aplicar.itens.get(200)?.pendencias).toContainEqual({
      codigo: 'sku-diferente',
      acionavel: false,
      liId: 201,
      referencias: ['CAN-VERDE', 'CAN-VD'],
    });
    // The category: created ONCE (by product 1) and taken by product 2.
    const categoria = `li-${CONTA}-900`;
    expect(aplicar.ler(`categorias/${categoria}`)).toMatchObject({ nome: 'Categoria 900' });
    for (const sku of ['P1', 'P2']) {
      expect(aplicar.ler(`produtos/li-sku-${sha256Hex(sku)}`)).toMatchObject({
        categoriaProdutoOuterRef: `documents/categorias/${categoria}`,
      });
    }
    expect(aplicar.caminhos.filter((c) => c === `categorias/${categoria}`)).toHaveLength(1);
    expect(simular.job.mapaCategorias).toContainEqual(
      expect.objectContaining({ id: 900, erpCategoriaId: categoria, vinculo: 'simulada' }),
    );
    expect(simular.job.aprendizadosSimulados).toEqual([
      { grupoId: 'cor', gradeId: COR, opcaoId: 2, varianteId: 'v-verde' },
    ]);
    // Simular: every write is the job or its own subcollections.
    const prefixo = caminhoJobLi(JOB);
    expect(simular.caminhos.filter((c) => c !== prefixo && !c.startsWith(`${prefixo}/`))).toEqual(
      [],
    );
  });
});

describe('complete — the per-category aviso at the job’s end', () => {
  const loja = (): LojaDeProdutosLi => {
    const p1 = linhaProdutoLi(10, { sku: 'C1', categorias: ['/api/v1/categoria/900'] });
    const p2 = linhaProdutoLi(20, { sku: 'C2', categorias: ['/api/v1/categoria/900'] });
    return {
      ativos: [p1, p2],
      detalhes: new Map([
        [10, detalheLi(p1, null)],
        [20, detalheLi(p2, null)],
      ]),
    };
  };

  it('an `aplicar` job that imported products WITHOUT their unlinked store category raises ONE row for it, counting them; a Simular raises none', async () => {
    const caminho = caminhoAviso(chaveCategoriaSemVinculoLi(CONTA, 900));
    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'simular', acao: 'completar' });
    await rodarAteOFim({ responder: lojaCompleta(loja()) });
    expect(
      itens()
        .get(10)
        ?.pendencias.map((p) => p.codigo),
    ).toContain('categoria-sem-vinculo');
    expect(db.ler(caminho)).toBeUndefined();

    seedJobLi(db, JOB, CONTA, { status: 'pendente', modo: 'aplicar', acao: 'completar' });
    const { resultados } = await rodarAteOFim({ responder: lojaCompleta(loja()) });
    expect(resultados.at(-1)?.desfecho).toBe('concluido');
    expect(db.ler(caminho)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaCategoriaSemVinculo,
      resolvidoEm: null,
      params: expect.objectContaining({ produtos: 2, caminho: '900', motivo: 'sem-vinculo' }),
    });
    // Both created produtos joined the tax review — each root AND its sole member, the unit an
    // order line resolves to (its taxes are the NF-e's): created, with no category.
    expect(db.idsEm(`${caminhoJobLi(JOB)}/revisao`).sort()).toEqual(
      ['C1', 'C2']
        .flatMap((sku) => [`li-sku-${sha256Hex(sku)}`, `li-sku-${sha256Hex(sku)}-un`])
        .sort(),
    );
  });

  it('categoriasSemVinculoDoJob: one row per store category, products summed across refusals naming it ⟷ NEAR-MISS a refusal needing no row adds none', () => {
    const mapa = [
      {
        id: 900,
        nome: 'C',
        pai: { tipo: 'raiz' as const },
        erpCategoriaId: null,
        vinculo: 'sem-vinculo' as const,
      },
    ];
    expect(
      categoriasSemVinculoDoJob({ mapaCategorias: mapa }, [
        { codigo: PENDENCIA_IMPORTACAO_LI.categoriaSemVinculo, referencias: ['900'], itens: 2 },
        {
          codigo: PENDENCIA_IMPORTACAO_LI.categoriaRecusada,
          referencias: ['900', 'ausente'],
          itens: 5,
        },
        { codigo: PENDENCIA_IMPORTACAO_LI.categoriaRecusada, referencias: ['ilegivel'], itens: 4 },
      ]),
    ).toEqual([
      {
        categoriaLiId: 900,
        caminho: [900],
        motivo: MOTIVO_CATEGORIA_SEM_VINCULO_LI.semVinculo,
        produtos: 2,
      },
    ]);
  });
});
