/**
 * The feed SEND handler (step 12a, PR 12-c), E1–E6, end to end against the
 * fake Firestore: the REAL context, the REAL write engine's batch entry, the
 * REAL lease I/O (`vezFeedFirestore.ts`) and pure lease machine, the REAL jobs
 * producer over a RECORDING queue (every enqueue re-validated against the
 * payload schema, its name and its whole-seconds delay), a scripted `fetch`
 * serving `createFeedDocument`, the upload (an S3-shaped fake URL) and
 * `createFeed`, and FAKE providers built here — a window provider, a block
 * provider and a price provider — none of which imports a stock module.
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one is the only network and
 * refuses anything it was not scripted for. The read switch is `on` ONLY in the
 * object literal handed in as `ambiente`. PLACEHOLDERS ONLY (public repository).
 */
import { URL_BASE_SP_API, URL_TOKEN_LWA } from '@delfrance/integrations-amazon-sp-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { vezFeedAmazonCollection } from '@delfrance/data/admin/collections';
import {
  ESTADO_VEZ_FEED_AMAZON,
  FLUXO_FEED_AMAZON,
  type FluxoFeedAmazon,
  MOTIVO_CONTA_AMAZON,
  STATUS_REGISTRO_FEED_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { MARGEM_RENOVACAO_ACESSO_MS } from '../core/contexto';
import { CANARIO_ENV_AMAZON, VALVULA_ENV_AMAZON } from '../core/valvulas';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente, falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoAviso,
  caminhoCredencial,
  loggerEspiao,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from './agendadorLotes';
import {
  ACAO_ENVIO_FEED,
  type DepsEnviarFeedAmazon,
  ORCAMENTO_MONTAGEM_LOTE_MS,
  type ResultadoEnvioFeedAmazon,
  enviarFeedAmazon,
} from './enviarFeed';
import {
  type AbortoLoteAmazon,
  ESPACO_MINIMO_ENTRE_FEEDS_MS,
  ESPERA_LOTE_EM_VEZ_S,
  ESPERA_MAXIMA_ATRAS_DE_FEED_MS,
  ESPERA_SONDA_DISJUNTOR_MS,
  MOTIVO_ABORTO_LOTE,
  type ProvedorLoteAmazon,
} from './provedorLote';
import { PRAZO_FEED_MS } from './registroFeed';
import {
  type TarefaEnviarFeedAmazon,
  type TarefaLoteAmazon,
  nomeConsultaFeed,
  nomeIncertoFeed,
  nomeRecuperacaoFeed,
  referenciaVezFeed,
  tarefaEnviarFeedAmazonSchema,
} from './tarefaLote';
import { VALIDADE_VEZ_ENVIADO_MS, VALIDADE_VEZ_MS } from './vezFeed';
import { liberarVezFeed } from './vezFeedFirestore';

/* ---------------------------------- constants ---------------------------------- */

const CONTA = 'conta-amz-feed';
const MIN = 60_000;
const HORA = 60 * MIN;
const VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const VEZ_PRECO = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.preco, CONTA)}`;
const FEED = '50001234567';
const OUTRO_FEED = '50009999999';
const registroDe = (feedId: string) => `feedsAmazon/${idRegistroFeedAmazon(CONTA, feedId)}`;
const AVISO = caminhoAviso(chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.contaSemOperacao));
const URL_UPLOAD = 'https://example-bucket.s3.amazonaws.com/entrada?X-Amz-Signature=0000sentinela';
const CAMINHO_DOCUMENTOS = '/feeds/2021-06-30/documents';
const CAMINHO_FEEDS = '/feeds/2021-06-30/feeds';
const SKUS = Array.from({ length: 31 }, (_, i) => `SKU-TESTE-${String(i + 1).padStart(2, '0')}`);
const EXEC = 'exec-envio-teste';
const OUTRO = 'exec-outro-dono';

/* ----------------------------------- payloads ----------------------------------- */

function enviar(o: {
  execucaoId?: string;
  fluxo?: FluxoFeedAmazon;
  lote: TarefaEnviarFeedAmazon['lote'];
  origem?: string;
}): TarefaEnviarFeedAmazon {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: 'feed-enviar',
    fluxo: o.fluxo ?? 'estoque',
    contaId: CONTA,
    execucaoId: o.execucaoId ?? EXEC,
    origem: o.origem ?? 'delta',
    lote: o.lote,
  });
}

/** A TICK-born window batch (no commit filter). */
const janelaDoTick = (desdeMs = AGORA_MS - 10 * MIN, execucaoId = EXEC) =>
  enviar({
    execucaoId,
    lote: {
      tipo: 'janela',
      desdeMs,
      ateMs: desdeMs + 5 * MIN,
      manterDesdeMs: desdeMs,
      commitAposMs: null,
      esperaAteMs: null,
      depositoId: 'deposito-teste',
    },
  });

/** A RECOVERY-born window batch (a commit filter, a bounded wait). */
const janelaDaRecuperacao = (esperaAteMs: number, execucaoId = EXEC) =>
  enviar({
    execucaoId,
    origem: 'recuperacao',
    lote: {
      tipo: 'janela',
      desdeMs: AGORA_MS - 20 * MIN,
      ateMs: AGORA_MS - 1,
      manterDesdeMs: AGORA_MS - 20 * MIN,
      commitAposMs: AGORA_MS - 15 * MIN,
      esperaAteMs,
      depositoId: 'deposito-teste',
    },
  });

/** A BLOCK batch (the reconcile's). */
const blocos = (esperaAteMs = AGORA_MS + 6 * HORA, execucaoId = EXEC) =>
  enviar({
    execucaoId,
    origem: 'reconciliacao',
    lote: { tipo: 'blocos', partes: 2, esperaAteMs },
  });

/* ------------------------------------ leases ------------------------------------ */

function vez(campos: Partial<VezFeedAmazon>): VezFeedAmazon {
  return vezFeedAmazonCollection.parse({
    estado: 'livre',
    ateMs: 0,
    atualizadoEmMs: AGORA_MS - HORA,
    ...campos,
  });
}

/** Another run's known feed, submitted `idadeMs` ago. */
const enviadoDe = (idadeMs: number, campos: Partial<VezFeedAmazon> = {}) =>
  vez({
    estado: ESTADO_VEZ_FEED_AMAZON.enviado,
    execucaoId: OUTRO,
    feedId: OUTRO_FEED,
    snapshotEmMs: AGORA_MS - idadeMs - MIN,
    antesDoEnvioMs: AGORA_MS - idadeMs,
    mensagens: 40,
    bytes: 4_000,
    ateMs: AGORA_MS - idadeMs + VALIDADE_VEZ_ENVIADO_MS,
    atualizadoEmMs: AGORA_MS - idadeMs,
    origem: 'delta',
    tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
    janela: {
      desdeMs: AGORA_MS - idadeMs - 10 * MIN,
      ateMs: AGORA_MS - idadeMs - 5 * MIN,
      manterDesdeMs: AGORA_MS - idadeMs - 10 * MIN,
      commitAposMs: null,
      depositoId: 'deposito-teste',
    },
    ultimoEnvioMs: AGORA_MS - idadeMs,
    ...campos,
  });

/** Another run's maybe-submitted feed, expired in place (the uncertain outcome) `idadeMs` ago. */
const incertaDe = (idadeMs: number, campos: Partial<VezFeedAmazon> = {}) =>
  vez({
    estado: ESTADO_VEZ_FEED_AMAZON.enviando,
    execucaoId: OUTRO,
    snapshotEmMs: AGORA_MS - idadeMs - MIN,
    antesDoEnvioMs: AGORA_MS - idadeMs,
    mensagens: 40,
    bytes: 4_000,
    ateMs: AGORA_MS - idadeMs,
    atualizadoEmMs: AGORA_MS - idadeMs,
    origem: 'delta',
    tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
    janela: {
      desdeMs: AGORA_MS - idadeMs - 10 * MIN,
      ateMs: AGORA_MS - idadeMs - 5 * MIN,
      manterDesdeMs: AGORA_MS - idadeMs - 10 * MIN,
      commitAposMs: null,
      depositoId: 'deposito-teste',
    },
    ultimoEnvioMs: AGORA_MS - idadeMs,
    ...campos,
  });

/* ------------------------------------ scenario ---------------------------------- */

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  /** Reject the fetch itself (a dropped connection). */
  readonly rede?: true;
}

interface Enfileirada {
  readonly tarefa: TarefaLoteAmazon;
  readonly nome: string | null;
  readonly atrasoS: number;
  /** The lease as it was stored at the enqueue. */
  readonly vez: Record<string, unknown> | undefined;
  /** How many feed records existed at the enqueue. */
  readonly registros: number;
}

interface VistoNoCriarFeed {
  readonly vez: Record<string, unknown> | undefined;
  readonly enfileiradas: number;
  readonly agora: number;
}

/** What the fake providers record. */
interface Espiao {
  membros: number;
  readonly montar: (readonly string[])[];
  readonly repasses: (readonly string[])[];
  /** The lease's `estado` at each hand-off to the per-SKU path. */
  readonly vezNosRepasses: unknown[];
}

interface OpcoesProvedor {
  readonly skus?: readonly string[];
  /** ms the re-derivation takes (the clock moves inside `membros`). */
  readonly duracaoMembrosMs?: number;
  readonly duracaoMontarMs?: number;
  readonly membrosAbortado?: AbortoLoteAmazon;
  readonly montarAbortado?: AbortoLoteAmazon;
  /** Zero messages: every member already converged. */
  readonly convergido?: boolean;
  /** `montar` answers a snapshot taken AFTER `membros` (a provider that got it wrong). */
  readonly snapshotTardio?: boolean;
  /** Each call of `montar` throws the next error here first (consumed in order). */
  readonly falhasDoMontar?: (() => Error)[];
  /** Messages with no patch: a plan the package refuses to turn into a document. */
  readonly semPatches?: boolean;
}

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  relogio: number;
  readonly rotas: { documento: Roteiro[]; upload: Roteiro[]; feed: Roteiro[] };
  readonly chamadas: string[];
  readonly enfileiradas: Enfileirada[];
  readonly vistosNoCriarFeed: VistoNoCriarFeed[];
  readonly espiao: Espiao;
  /** Make the NEXT enqueues reject. */
  falhasDaFila: (() => Error)[];
  /** Reject ONE kind of enqueue (consulted first): an error, or `null` to let it through. */
  falharEnfileiramento: ((tarefa: TarefaLoteAmazon) => Error | null) | null;
  /** The order of the side effects: `fila:<tipo>` per landed enqueue, `repasse` per hand-off. */
  readonly ordem: string[];
  aoDocumento: (() => Promise<void>) | null;
  aoUpload: (() => Promise<void>) | null;
  aoCriarFeed: (() => Promise<void>) | null;
  /** The LWA exchange's connection drops (the forced refresh after a 401). */
  lwaCaiu: boolean;
  ambiente: Record<string, string | undefined>;
  provedor: ProvedorLoteAmazon<'estoque' | 'preco', unknown> | null;
  deps(): DepsEnviarFeedAmazon;
  rodar(t: TarefaEnviarFeedAmazon): Promise<ResultadoEnvioFeedAmazon>;
}

/** One stock message: the fulfillment-availability merge. */
function mensagem(sku: string) {
  return {
    sku,
    patches: [
      {
        op: 'merge' as const,
        path: '/attributes/fulfillment_availability',
        value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 5 }],
      },
    ],
  };
}

/** A fake provider of `fluxo` (window and block batches alike): it imports no stock module. */
function provedorDeTeste(
  c: Pick<Cenario, 'relogio' | 'espiao' | 'ordem' | 'fake'>,
  fluxo: 'estoque' | 'preco' = 'estoque',
  o: OpcoesProvedor = {},
): ProvedorLoteAmazon<'estoque' | 'preco', { readonly snapshotEmMs: number }> {
  return {
    fluxo,
    membros: (ctx) => {
      c.espiao.membros += 1;
      // The window's snapshot BEFORE its first window query (the provider's rule).
      const snapshotEmMs = ctx.agora();
      c.relogio += o.duracaoMembrosMs ?? 0;
      if (o.membrosAbortado !== undefined) return Promise.resolve(o.membrosAbortado);
      return Promise.resolve({ skus: o.skus ?? SKUS, dados: { snapshotEmMs } });
    },
    montar: (ctx, _entrada, membrosOn, dados) => {
      c.espiao.montar.push(membrosOn);
      c.relogio += o.duracaoMontarMs ?? 0;
      const falha = o.falhasDoMontar?.shift();
      if (falha !== undefined) return Promise.reject(falha());
      if (o.montarAbortado !== undefined) return Promise.resolve(o.montarAbortado);
      const semPatches = (sku: string) => ({ sku, patches: [] });
      return Promise.resolve({
        mensagens:
          o.convergido === true ? [] : membrosOn.map(o.semPatches === true ? semPatches : mensagem),
        snapshotEmMs: o.snapshotTardio === true ? ctx.agora() : dados.snapshotEmMs,
        diff: { acao: 'enviaria', skusMudados: membrosOn.length },
      });
    },
    gravarResultado: () => Promise.resolve(),
    recuperar: () => Promise.resolve({ nada: true }),
    repassarParaPatches: (_ctx, _entrada, skus) => {
      c.espiao.repasses.push(skus);
      c.espiao.vezNosRepasses.push(c.fake.ler(fluxo === 'preco' ? VEZ_PRECO : VEZ)?.estado);
      c.ordem.push('repasse');
      return Promise.resolve({ tarefas: skus.length });
    },
    motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
  };
}

function proxima(fila: Roteiro[]): Roteiro {
  const r = fila.length > 1 ? fila.shift() : fila[0];
  if (r === undefined) throw new Error('teste: rota sem resposta');
  return r;
}

function cenario(o: OpcoesProvedor & { fluxo?: 'estoque' | 'preco' } = {}): Cenario {
  const fake = new FakeDb();
  seedConta(fake, CONTA, { nome: 'Conta feed', selling_partner_id: SPID_A });
  // A token far from expiry: no LWA exchange unless a test forces one.
  seedCredencial(fake, CONTA, { expirationDate: AGORA_MS + 30 * DIA_MS });
  const log = loggerEspiao();
  let documentos = 0;
  const ids = new Set<string>();
  const c: Cenario = {
    fake,
    log,
    relogio: AGORA_MS,
    rotas: {
      documento: [{ status: 201 }],
      upload: [{ status: 200 }],
      feed: [{ status: 202, corpo: { feedId: FEED } }],
    },
    chamadas: [],
    enfileiradas: [],
    vistosNoCriarFeed: [],
    espiao: { membros: 0, montar: [], repasses: [], vezNosRepasses: [] },
    falhasDaFila: [],
    falharEnfileiramento: null,
    ordem: [],
    aoDocumento: null,
    aoUpload: null,
    aoCriarFeed: null,
    lwaCaiu: false,
    ambiente: {
      ...AMBIENTE_LIGADO,
      [VALVULA_ENV_AMAZON.estoque]: 'on',
      [CANARIO_ENV_AMAZON.estoque]: '*',
      [VALVULA_ENV_AMAZON.preco]: 'on',
      [CANARIO_ENV_AMAZON.preco]: '*',
    },
    provedor: null,
    deps: () => ({
      ambiente: c.ambiente,
      agora: () => c.relogio,
      logger: log.logger,
      increment,
      agendador: () =>
        criarAgendadorLotesAmazon({
          desligado: false,
          fila: (): FilaLotesAmazon => ({
            enqueue: (tarefa, opcoes) => {
              const seletiva = c.falharEnfileiramento?.(tarefa) ?? null;
              if (seletiva !== null) return Promise.reject(seletiva);
              const falha = c.falhasDaFila.shift();
              if (falha !== undefined) return Promise.reject(falha());
              const id = opcoes?.id;
              if (id !== undefined) {
                if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
                ids.add(id);
              }
              c.enfileiradas.push({
                tarefa,
                nome: id ?? null,
                atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                vez: fake.ler(VEZ),
                registros: fake.caminhos().filter((p) => p.startsWith('feedsAmazon/')).length,
              });
              c.ordem.push(`fila:${tarefa.tipo}`);
              return Promise.resolve();
            },
          }),
        }),
      provedor: c.provedor,
      registro: { tentativa: 0, idTarefa: 'tarefa-feed-teste-1' },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const metodo = init?.method ?? 'GET';
        if (url.href === URL_TOKEN_LWA) {
          c.chamadas.push('LWA');
          if (c.lwaCaiu) throw new TypeError('fetch failed');
          return tokenDeAcesso();
        }
        if (url.origin === new URL(URL_UPLOAD).origin && metodo === 'PUT') {
          c.chamadas.push('PUT upload');
          await c.aoUpload?.();
          const r = proxima(c.rotas.upload);
          if (r.rede === true) throw new TypeError('fetch failed');
          return new Response(
            r.status === 200 ? null : '<Error><Code>AccessDenied</Code></Error>',
            { status: r.status },
          );
        }
        if (url.origin === URL_BASE_SP_API && metodo === 'POST') {
          if (url.pathname === CAMINHO_DOCUMENTOS) {
            c.chamadas.push('POST documento');
            await c.aoDocumento?.();
            const r = proxima(c.rotas.documento);
            if (r.rede === true) throw new TypeError('fetch failed');
            documentos += 1;
            return respostaJson(
              r.status ?? 201,
              r.corpo ?? { feedDocumentId: `doc-teste-${String(documentos)}`, url: URL_UPLOAD },
            );
          }
          if (url.pathname === CAMINHO_FEEDS) {
            c.chamadas.push('POST feed');
            c.vistosNoCriarFeed.push({
              vez: fake.ler(VEZ),
              enfileiradas: c.enfileiradas.length,
              agora: c.relogio,
            });
            await c.aoCriarFeed?.();
            const r = proxima(c.rotas.feed);
            if (r.rede === true) throw new TypeError('fetch failed');
            return respostaJson(r.status ?? 202, r.corpo ?? {});
          }
        }
        c.chamadas.push(`fora do roteiro: ${metodo} ${url.pathname}`);
        throw new Error('teste: requisição fora do roteiro');
      },
      gerarCorrelationId: () => 'corr-feed-teste',
    }),
    rodar: (t) => enviarFeedAmazon(asDb(fake), t, c.deps()),
  };
  c.provedor = provedorDeTeste(c, o.fluxo, o);
  return c;
}

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
});

const criarFeeds = (c: Cenario) => c.chamadas.filter((x) => x === 'POST feed').length;
const documentos = (c: Cenario) => c.chamadas.filter((x) => x === 'POST documento').length;
const lease = (c: Cenario, caminho = VEZ) => c.fake.ler(caminho) as VezFeedAmazon | undefined;
const escritasDaVez = (c: Cenario, caminho = VEZ) => c.fake.escritasEm(caminho);
const doTipo = (c: Cenario, tipo: TarefaLoteAmazon['tipo']) =>
  c.enfileiradas.filter((x) => x.tarefa.tipo === tipo);
const semear = (c: Cenario, v: VezFeedAmazon, caminho = VEZ) => c.fake.seed(caminho, v);

/* ------------------------------------------------------------------------------ */

describe('E1–E3 — the valve, the seam row, the context', () => {
  it('the valve off ⇒ ZERO Firestore operations, nothing called, one INFO line', async () => {
    const c = cenario();
    c.ambiente[VALVULA_ENV_AMAZON.estoque] = undefined;
    const r = await c.rodar(janelaDoTick());
    expect(r.acao).toBe(ACAO_ENVIO_FEED.valvulaDesligada);
    expect(c.fake.operacoes).toBe(0);
    expect(c.chamadas).toEqual([]);
    expect(c.espiao.membros).toBe(0);
  });

  it('a null seam row ⇒ sem-provedor, the lease never read', async () => {
    const c = cenario();
    c.provedor = null;
    const r = await c.rodar(janelaDoTick());
    expect(r.acao).toBe(ACAO_ENVIO_FEED.semProvedor);
    expect(c.fake.leituras.filter((p) => p === VEZ)).toEqual([]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('the read switch off ⇒ contexto-recusado (WARNING), the lease never read, no throw', async () => {
    const c = cenario();
    c.ambiente.AMAZON_CHAMADAS = undefined;
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.contextoRecusado,
      motivo: 'chamadas-desligadas',
    });
    expect(c.fake.leituras).not.toContain(VEZ);
    expect(c.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
  });

  it.each<[string, (c: Cenario) => void, string]>([
    [
      'an inactive conta',
      (c) => seedConta(c.fake, CONTA, { selling_partner_id: SPID_A, ativo: false }),
      'conta-inativa',
    ],
    [
      'a conta with no credential',
      (c) => {
        c.fake.apagar(caminhoCredencial(CONTA));
      },
      'conta-indisponivel',
    ],
  ])(
    '★ %s ⇒ contexto-recusado (WARNING), the lease never read, nothing called, no throw',
    async (_caso, preparar, motivo) => {
      const c = cenario();
      preparar(c);
      const r = await c.rodar(janelaDoTick());
      expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.contextoRecusado, motivo });
      expect(c.fake.leituras).not.toContain(VEZ);
      expect(c.chamadas).toEqual([]);
      expect(c.espiao.membros).toBe(0);
      expect(c.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
    },
  );
});

describe('★ the happy path: the order of every write around createFeed', () => {
  it('lease montando → NAMED feed-incerto (43,200 WHOLE s) → lease enviando, all BEFORE createFeed; then enviado → record → rung 0', async () => {
    const c = cenario();
    const r = await c.rodar(janelaDoTick());

    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, feedId: FEED, registro: 'criado' });
    expect(criarFeeds(c)).toBe(1);

    // At createFeed's call: the lease already `enviando`, the uncertain wait already durable.
    const [visto] = c.vistosNoCriarFeed;
    expect(visto?.vez).toMatchObject({
      estado: 'enviando',
      execucaoId: EXEC,
      feedId: null,
      antesDoEnvioMs: AGORA_MS,
      ultimoEnvioMs: AGORA_MS,
    });
    const incertos = doTipo(c, 'feed-incerto');
    expect(incertos).toHaveLength(1);
    expect(visto?.enfileiradas).toBe(1);
    expect(incertos[0]).toMatchObject({
      nome: nomeIncertoFeed(CONTA, EXEC),
      // WHOLE seconds: the 12 h of the deadline (NEAR-MISS: ms would be 4.32e7).
      atrasoS: 43_200,
    });
    // The enqueue saw the lease still `montando`: the enqueue came FIRST.
    expect(incertos[0]?.vez).toMatchObject({ estado: 'montando', execucaoId: EXEC });

    // The lease's writes, in order: the take, `enviando`, `enviado`.
    const escritas = escritasDaVez(c);
    expect(escritas.map((w) => w.verbo)).toEqual(['create', 'update', 'update']);
    expect(escritas.map((w) => w.dados?.estado)).toEqual(['montando', 'enviando', 'enviado']);
    expect(escritas.slice(1).every((w) => w.comPrecondicao)).toBe(true);
    // The record lands AFTER the lease names the feed.
    const ordem = c.fake.escritas.map((w) => w.caminho);
    expect(ordem.indexOf(registroDe(FEED))).toBeGreaterThan(ordem.lastIndexOf(VEZ));

    expect(lease(c)).toMatchObject({
      estado: 'enviado',
      feedId: FEED,
      ateMs: AGORA_MS + VALIDADE_VEZ_ENVIADO_MS,
    });
    expect(c.fake.ler(registroDe(FEED))).toMatchObject({
      contaId: CONTA,
      feedId: FEED,
      fluxo: 'estoque',
      execucaoId: EXEC,
      tipoLote: 'janela',
      status: 'enviado',
      antesDoEnvioMs: AGORA_MS,
      snapshotEmMs: AGORA_MS,
      mensagens: SKUS.length,
      prazoEmMs: AGORA_MS + PRAZO_FEED_MS,
      origem: 'delta',
      // The batch's own window, copied from the lease (a failed feed's members are re-sent from it).
      janela: {
        desdeMs: AGORA_MS - 10 * MIN,
        ateMs: AGORA_MS - 5 * MIN,
        manterDesdeMs: AGORA_MS - 10 * MIN,
        commitAposMs: null,
        depositoId: 'deposito-teste',
      },
    });
    expect(c.fake.ler(registroDe(FEED))?.expiraEm).toBeInstanceOf(Date);

    const rodadas = doTipo(c, 'feed-resultado');
    expect(rodadas).toEqual([
      expect.objectContaining({
        nome: nomeConsultaFeed(CONTA, FEED, 0),
        atrasoS: 120,
        tarefa: expect.objectContaining({ rodada: 0, origem: 'consulta', contaId: CONTA }),
      }),
    ]);
    // Rung 0 was enqueued with the record already there (NEAR-MISS: enqueued first,
    // a rung that outran a failing create would find no record and end the chain).
    expect(rodadas[0]?.registros).toBe(1);
  });

  it('ONE dispatch line: evento estoque, fase envio, never a SKU or a document URL', async () => {
    const c = cenario();
    await c.rodar(janelaDoTick());
    const linhas = c.log.linhas.filter((l) => l.meta?.evento === 'estoque');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toMatchObject({ fase: 'envio', acao: 'enviado', feedId: FEED });
    const tudo = JSON.stringify(c.log.linhas);
    expect(tudo).not.toContain('sentinela');
    expect(tudo).not.toContain(SKUS[0]);
    expect(tudo).not.toContain(SPID_A);
  });

  it('★ the feed-incerto enqueue failing transiently ⇒ throws, the lease still montando, ZERO createFeed; the retry is retomar and submits once', async () => {
    const c = cenario();
    c.falhasDaFila.push(() => falhaDoFunctions('unavailable'));
    await expect(c.rodar(janelaDoTick())).rejects.toThrow();
    expect(criarFeeds(c)).toBe(0);
    expect(lease(c)).toMatchObject({ estado: 'montando', execucaoId: EXEC });

    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, tomada: 'retomar' });
    expect(criarFeeds(c)).toBe(1);
    expect(lease(c)).toMatchObject({ estado: 'enviado', feedId: FEED });
  });

  it('★ a crash between the lease enviado and the record ⇒ the retry is retomar-consulta: ONE record from the lease, rung 0, ZERO createFeed', async () => {
    const c = cenario();
    c.fake.falharEscrita(registroDe(FEED), grpc(14, 'indisponível'));
    await expect(c.rodar(janelaDoTick())).rejects.toThrow();
    expect(lease(c)).toMatchObject({ estado: 'enviado', feedId: FEED });
    expect(c.fake.ler(registroDe(FEED))).toBeUndefined();
    // The failing create left NO rung behind it: rung 0 waits for the record.
    expect(doTipo(c, 'feed-resultado')).toEqual([]);
    c.fake.falharEscrita(registroDe(FEED), null);

    c.relogio += MIN;
    const r = await c.rodar(janelaDoTick());
    // Rung 0 keeps its own ladder delay (the ladder spaces rungs, it never counts down).
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.consultaRetomada,
      registro: 'criado',
      atrasoS: 120,
    });
    expect(criarFeeds(c)).toBe(1);
    expect(c.fake.ler(registroDe(FEED))).toMatchObject({
      feedId: FEED,
      execucaoId: EXEC,
      antesDoEnvioMs: AGORA_MS,
      tipoLote: 'janela',
      origem: 'delta',
      mensagens: SKUS.length,
    });
    expect(doTipo(c, 'feed-resultado').map((x) => x.nome)).toEqual([
      nomeConsultaFeed(CONTA, FEED, 0),
    ]);
  });
});

describe('★ E6 — the outcomes that post nothing', () => {
  it('an all-converged build (zero messages) ⇒ sem-escrita, lease livre, ZERO document calls', async () => {
    const c = cenario({ convergido: true });
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.liberado, motivo: 'sem-escrita' });
    expect(documentos(c)).toBe(0);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });
  });

  it('a snapshot-lento abort ⇒ nothing posted, lease livre, the provider aviso, no throw, a failure counted', async () => {
    const c = cenario({
      montarAbortado: {
        abortado: MOTIVO_ABORTO_LOTE.snapshotLento,
        aviso: MOTIVO_CONTA_AMAZON.contaSemOperacao,
      },
    });
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.liberado,
      motivo: 'snapshot-lento',
      aviso: 'conta-sem-operacao',
    });
    expect(documentos(c)).toBe(0);
    expect(lease(c)).toMatchObject({
      estado: 'livre',
      falhasSeguidas: 1,
      ultimaFalhaEmMs: AGORA_MS,
    });
    expect(c.fake.ler(AVISO)).toMatchObject({ resolvidoEm: null });
  });

  it('an abort with no aviso (deposito-mudou on a window batch) raises nothing, counts nothing', async () => {
    const c = cenario({
      membrosAbortado: { abortado: MOTIVO_ABORTO_LOTE.depositoMudou, aviso: null },
    });
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ motivo: 'deposito-mudou', aviso: null });
    expect(c.fake.ler(AVISO)).toBeUndefined();
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });
  });

  it('dry-run ⇒ the whole document built, one engine line, lease livre, nothing posted', async () => {
    const c = cenario();
    c.ambiente[VALVULA_ENV_AMAZON.estoque] = 'dry-run';
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ motivo: 'simulado', mensagens: SKUS.length });
    expect(c.chamadas).toEqual([]);
    expect(lease(c)).toMatchObject({ estado: 'livre' });
  });

  it('a canary LIST ⇒ exactly the canary members handed to the per-SKU path, then livre', async () => {
    const c = cenario();
    c.ambiente[CANARIO_ENV_AMAZON.estoque] = `${CONTA}:${SKUS[0] ?? ''},${CONTA}:${SKUS[3] ?? ''}`;
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ motivo: 'so-patches', tarefas: 2 });
    expect(c.espiao.repasses).toEqual([[SKUS[0], SKUS[3]]]);
    expect(c.chamadas).toEqual([]);
    expect(lease(c)).toMatchObject({ estado: 'livre' });
  });

  it('★ a TRANSIENT failure thrown by montar (Firestore UNAVAILABLE) ⇒ rethrown for the queue: the lease still montando, NO failure counted, no aviso; the retry resumes it (retomar) and submits once', async () => {
    const c = cenario({ falhasDoMontar: [() => grpc(14, 'indisponível')] });
    await expect(c.rodar(janelaDoTick())).rejects.toMatchObject({ code: 14 });
    expect(lease(c)).toMatchObject({ estado: 'montando', execucaoId: EXEC, falhasSeguidas: 0 });
    expect(c.fake.ler(AVISO)).toBeUndefined();
    expect(c.chamadas).toEqual([]);

    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, tomada: 'retomar' });
    expect(criarFeeds(c)).toBe(1);
  });

  it('★ a plan the package REFUSES to turn into a document (a message with no patch) ⇒ documento-falhou: released, the aviso, one failure counted, WARNING, no throw, nothing posted', async () => {
    const c = cenario({ semPatches: true });
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.liberado,
      motivo: 'documento-falhou',
      aviso: 'conta-sem-operacao',
    });
    expect(c.chamadas).toEqual([]);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });
    expect(c.fake.ler(AVISO)).toMatchObject({ resolvidoEm: null });
    expect(c.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
  });

  it('★ the members are deduplicated before the batch entry: a provider answering [A, A, B] builds a 2-message document', async () => {
    const [a = '', b = ''] = SKUS;
    const c = cenario({ skus: [a, a, b] });
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, mensagens: 2, membros: 2 });
    expect(c.espiao.montar).toEqual([[a, b]]);
  });
});

describe('★ E5 — the shared 240-s build budget and the window snapshot', () => {
  it('a fake WINDOW provider drives the path: membros re-derives, the build fits the budget, the feed is submitted', async () => {
    const c = cenario({ duracaoMembrosMs: 100_000, duracaoMontarMs: 100_000 });
    const r = await c.rodar(janelaDoTick());
    expect(r.acao).toBe(ACAO_ENVIO_FEED.enviado);
    expect(c.espiao.membros).toBe(1);
    expect(c.espiao.montar).toEqual([SKUS]);
  });

  it('★ a slow membros PAST the budget ⇒ snapshot-lento, nothing posted (NEAR-MISS: exactly 240 s submits)', async () => {
    const lenta = cenario({ duracaoMembrosMs: ORCAMENTO_MONTAGEM_LOTE_MS + 1 });
    const r = await lenta.rodar(janelaDoTick());
    expect(r).toMatchObject({ motivo: 'snapshot-lento', aviso: 'conta-sem-operacao' });
    expect(lenta.espiao.montar).toEqual([]);
    expect(lenta.chamadas).toEqual([]);

    const justa = cenario({ duracaoMembrosMs: ORCAMENTO_MONTAGEM_LOTE_MS });
    expect((await justa.rodar(janelaDoTick())).acao).toBe(ACAO_ENVIO_FEED.enviado);
  });

  it('★ a slow membros PAST the budget under a canary LIST ⇒ snapshot-lento: the budget is checked right after membros, not only before montar, so the members leave through the ABORT (all of them, a failure counted), never the canary path (NEAR-MISS: exactly 240 s hands the canary member over, nothing counted)', async () => {
    const canario = `${CONTA}:${SKUS[0] ?? ''}`;
    const lenta = cenario({ duracaoMembrosMs: ORCAMENTO_MONTAGEM_LOTE_MS + 1 });
    lenta.ambiente[CANARIO_ENV_AMAZON.estoque] = canario;
    const r = await lenta.rodar(janelaDoTick());
    expect(r).toMatchObject({ motivo: 'snapshot-lento', aviso: 'conta-sem-operacao' });
    expect(lenta.espiao.repasses).toEqual([SKUS]);
    expect(lenta.espiao.montar).toEqual([]);
    expect(lenta.chamadas).toEqual([]);
    expect(lease(lenta)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });

    const justa = cenario({ duracaoMembrosMs: ORCAMENTO_MONTAGEM_LOTE_MS });
    justa.ambiente[CANARIO_ENV_AMAZON.estoque] = canario;
    expect(await justa.rodar(janelaDoTick())).toMatchObject({ motivo: 'so-patches', tarefas: 1 });
    expect(justa.espiao.repasses).toEqual([[SKUS[0]]]);
    expect(lease(justa)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });
  });

  it('★ membros and montar SHARE the budget: 120 s + 121 s ⇒ snapshot-lento, nothing posted', async () => {
    const c = cenario({ duracaoMembrosMs: 120_000, duracaoMontarMs: 121_000 });
    const r = await c.rodar(janelaDoTick());
    expect(r.motivo).toBe('snapshot-lento');
    expect(documentos(c)).toBe(0);
    expect(lease(c)).toMatchObject({ estado: 'livre' });
  });

  it('★ THIS handler’s budget check finds the overrun of a WINDOW batch ⇒ its complete members go to the per-SKU path BEFORE the release, nothing posted; a BLOCK batch’s never do; a provider’s own abort is the provider’s to hand over', async () => {
    // Past the budget right after membros (241 s).
    const membros = cenario({ duracaoMembrosMs: ORCAMENTO_MONTAGEM_LOTE_MS + 1_000 });
    const r = await membros.rodar(janelaDoTick());
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.liberado,
      motivo: 'snapshot-lento',
      tarefas: SKUS.length,
      aviso: 'conta-sem-operacao',
    });
    expect(membros.espiao.repasses).toEqual([SKUS]);
    // Handed over while this run still held the lease: the release came after.
    expect(membros.espiao.vezNosRepasses).toEqual(['montando']);
    expect(membros.chamadas).toEqual([]);
    expect(lease(membros)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });

    // Past the budget after montar (120 s + 121 s): the members montar was handed.
    const montagem = cenario({ duracaoMembrosMs: 120_000, duracaoMontarMs: 121_000 });
    expect(await montagem.rodar(janelaDoTick())).toMatchObject({
      motivo: 'snapshot-lento',
      tarefas: SKUS.length,
    });
    expect(montagem.espiao.repasses).toEqual([SKUS]);
    expect(montagem.espiao.vezNosRepasses).toEqual(['montando']);
    expect(documentos(montagem)).toBe(0);

    // A BLOCK batch past the budget: released, never handed over.
    const bloco = cenario({ duracaoMembrosMs: ORCAMENTO_MONTAGEM_LOTE_MS + 1_000 });
    expect(await bloco.rodar(blocos())).toMatchObject({ motivo: 'snapshot-lento', tarefas: null });
    expect(bloco.espiao.repasses).toEqual([]);
    expect(lease(bloco)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });

    // The provider's OWN abort: nothing handed over here.
    const propria = cenario({
      montarAbortado: { abortado: MOTIVO_ABORTO_LOTE.snapshotLento, aviso: null },
    });
    expect(await propria.rodar(janelaDoTick())).toMatchObject({ motivo: 'snapshot-lento' });
    expect(propria.espiao.repasses).toEqual([]);
  });

  it('★ a WINDOW batch’s stored snapshot is never later than E5’s start, whatever montar answers', async () => {
    const c = cenario({ duracaoMembrosMs: 30_000, snapshotTardio: true });
    await c.rodar(janelaDoTick());
    expect(c.vistosNoCriarFeed[0]?.vez).toMatchObject({ snapshotEmMs: AGORA_MS });
    expect(c.fake.ler(registroDe(FEED))).toMatchObject({ snapshotEmMs: AGORA_MS });
  });

  it('a BLOCK batch keeps the snapshot its montar answered (before its first quantity read)', async () => {
    const c = cenario({ duracaoMembrosMs: 30_000, snapshotTardio: true });
    await c.rodar(blocos());
    expect(c.fake.ler(registroDe(FEED))).toMatchObject({ snapshotEmMs: AGORA_MS + 30_000 });
  });
});

describe('★ createFeed — what may have landed, what was not processed', () => {
  it('★ 401 then 202 ⇒ ONE record, lease enviado, antesDoEnvioMs equal to the SECOND stamp', async () => {
    const c = cenario();
    c.rotas.feed = [
      { status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
      { status: 202, corpo: { feedId: FEED } },
    ];
    c.aoCriarFeed = () => {
      c.relogio += 5_000;
      return Promise.resolve();
    };
    const r = await c.rodar(janelaDoTick());
    expect(r.acao).toBe(ACAO_ENVIO_FEED.enviado);
    expect(criarFeeds(c)).toBe(2);
    expect(documentos(c)).toBe(2);
    expect(c.chamadas).toContain('LWA');
    // The second attempt stamped after the first createFeed's 5 s.
    expect(c.vistosNoCriarFeed[1]?.vez).toMatchObject({
      estado: 'enviando',
      antesDoEnvioMs: AGORA_MS + 5_000,
    });
    expect(c.fake.ler(registroDe(FEED))).toMatchObject({ antesDoEnvioMs: AGORA_MS + 5_000 });
    expect(c.fake.caminhos().filter((p) => p.startsWith('feedsAmazon/'))).toHaveLength(1);
    // The uncertain wait was ensured once per attempt, under ONE name.
    expect(doTipo(c, 'feed-incerto')).toHaveLength(1);
  });

  it('★ 403 then 403 ⇒ lease livre, ZERO records, the provider aviso, no throw, no retry', async () => {
    const c = cenario();
    c.rotas.feed = [{ status: 403, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } }];
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.liberado, motivo: 'recusa-definitiva' });
    expect(criarFeeds(c)).toBe(2);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });
    expect(c.fake.caminhos().filter((p) => p.startsWith('feedsAmazon/'))).toEqual([]);
    expect(c.fake.ler(AVISO)).toMatchObject({ resolvidoEm: null });
    expect(doTipo(c, 'feed-enviar')).toEqual([]);
  });

  it.each<[string, Roteiro]>([
    ['a cut connection', { rede: true }],
    ['a 500', { status: 500, corpo: { errors: [{ code: 'InternalFailure', message: 'x' }] } }],
    ['a 202 with a non-digit feedId', { status: 202, corpo: { feedId: 'feed-x' } }],
  ])(
    '★ %s ⇒ UNCERTAIN: no second createFeed, no throw, lease enviando EXPIRED at once, the feed-incerto already enqueued, the aviso NOW',
    async (_caso, resposta) => {
      const c = cenario();
      c.rotas.feed = [resposta];
      const r = await c.rodar(janelaDoTick());
      expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.incerto, aviso: 'conta-sem-operacao' });
      expect(criarFeeds(c)).toBe(1);
      expect(lease(c)).toMatchObject({
        estado: 'enviando',
        execucaoId: EXEC,
        feedId: null,
        ateMs: AGORA_MS,
        falhasSeguidas: 0,
      });
      expect(doTipo(c, 'feed-incerto').map((x) => x.nome)).toEqual([nomeIncertoFeed(CONTA, EXEC)]);
      expect(c.fake.ler(AVISO)).toMatchObject({ resolvidoEm: null });
      expect(c.fake.caminhos().filter((p) => p.startsWith('feedsAmazon/'))).toEqual([]);
    },
  );

  it('★ a failure BEFORE the request left (the forced refresh after a 401 drops its LWA connection) is NOT uncertain: released by the stamp, rethrown for the queue', async () => {
    const c = cenario();
    c.rotas.feed = [{ status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } }];
    c.lwaCaiu = true;
    await expect(c.rodar(janelaDoTick())).rejects.toThrow();
    expect(criarFeeds(c)).toBe(1);
    expect(c.chamadas).toContain('LWA');
    // NEAR-MISS: read as uncertain, the lease would stay `enviando`, expired, for 12 h.
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 0, ultimoEnvioMs: AGORA_MS });
    expect(c.fake.ler(AVISO)).toBeUndefined();
  });

  it('★ NEAR-MISS: a 400 is NOT uncertain — definitive: lease livre, the aviso, no record', async () => {
    const c = cenario();
    c.rotas.feed = [{ status: 400, corpo: { errors: [{ code: 'InvalidInput', message: 'x' }] } }];
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.liberado, motivo: 'recusa-definitiva' });
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });
  });

  it('★ a 429 ⇒ lease livre, the payload re-enqueued UNNAMED after 120 s, no attempt spent, no failure counted', async () => {
    const c = cenario();
    c.rotas.feed = [{ status: 429, corpo: { errors: [{ code: 'QuotaExceeded', message: 'x' }] } }];
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.limitado, atrasoS: 120 });
    expect(criarFeeds(c)).toBe(1);
    expect(lease(c)).toMatchObject({
      estado: 'livre',
      falhasSeguidas: 0,
      ultimoEnvioMs: AGORA_MS,
    });
    expect(escritasDaVez(c).map((w) => w.dados?.estado)).toEqual([
      'montando',
      'enviando',
      'montando',
      'livre',
    ]);
    const reenvios = doTipo(c, 'feed-enviar');
    expect(reenvios).toEqual([expect.objectContaining({ nome: null, atrasoS: 120 })]);
  });

  it('★ 403 then 403 with the aviso write failing TRANSIENTLY ⇒ released FIRST, the aviso failure contained: no throw (a retry would take the lease again and repeat the refusal), one failure counted (NEAR-MISS: a non-transient aviso failure is rethrown — over a lease already livre)', async () => {
    const proibido = { status: 403, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } };
    const c = cenario();
    c.rotas.feed = [proibido];
    c.fake.falharEscrita(AVISO, grpc(14, 'indisponível'));
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.liberado,
      motivo: 'recusa-definitiva',
      recusa: null,
      aviso: null,
      avisoFalhou: true,
    });
    expect(criarFeeds(c)).toBe(2);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });
    expect(c.log.linhas.at(-1)?.meta).toMatchObject({ avisoFalhou: true });

    const rigida = cenario();
    rigida.rotas.feed = [proibido];
    rigida.fake.falharEscrita(AVISO, grpc(7, 'negado'));
    await expect(rigida.rodar(janelaDoTick())).rejects.toMatchObject({ code: 7 });
    expect(lease(rigida)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });
  });

  it.each<[string, OpcoesProvedor, Partial<Cenario['rotas']>, string]>([
    [
      'a provider abort (snapshot-lento)',
      {
        montarAbortado: {
          abortado: MOTIVO_ABORTO_LOTE.snapshotLento,
          aviso: MOTIVO_CONTA_AMAZON.contaSemOperacao,
        },
      },
      {},
      'snapshot-lento',
    ],
    [
      'a deterministic upload refusal (S3 403)',
      {},
      { upload: [{ status: 403 }] },
      'documento-falhou',
    ],
  ])(
    '★ %s with the aviso write failing TRANSIENTLY ⇒ released FIRST, the aviso failure contained: no throw, one failure counted, ZERO createFeed',
    async (_caso, opcoes, rotas, motivo) => {
      const c = cenario(opcoes);
      Object.assign(c.rotas, rotas);
      c.fake.falharEscrita(AVISO, grpc(14, 'indisponível'));
      const r = await c.rodar(janelaDoTick());
      expect(r).toMatchObject({
        acao: ACAO_ENVIO_FEED.liberado,
        motivo,
        recusa: null,
        aviso: null,
        avisoFalhou: true,
      });
      expect(criarFeeds(c)).toBe(0);
      expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });
    },
  );

  it('★ NEAR-MISS: behind a release that wrote NOTHING (another copy stamped the lease meanwhile), a transient aviso failure is rethrown, never contained', async () => {
    const c = cenario();
    c.rotas.upload = [{ status: 403 }];
    c.fake.falharEscrita(AVISO, grpc(14, 'indisponível'));
    const daOutraCopia = incertaDe(0, { execucaoId: EXEC, ateMs: AGORA_MS + 10 * MIN });
    c.aoUpload = () => {
      // Another copy of the same payload stamped the lease `enviando` meanwhile.
      semear(c, daOutraCopia);
      return Promise.resolve();
    };
    await expect(c.rodar(janelaDoTick())).rejects.toMatchObject({ code: 14 });
    expect(criarFeeds(c)).toBe(0);
    expect(lease(c)).toMatchObject({
      estado: 'enviando',
      execucaoId: EXEC,
      antesDoEnvioMs: daOutraCopia.antesDoEnvioMs,
      falhasSeguidas: daOutraCopia.falhasSeguidas,
    });
  });

  it('★ a failure BEFORE the request left — the token went stale between the upload and createFeed, and its LWA exchange dropped — is NOT uncertain: released by the stamp, no failure counted, no aviso, rethrown; the retry submits', async () => {
    const c = cenario();
    seedCredencial(c.fake, CONTA, {
      expirationDate: AGORA_MS + MARGEM_RENOVACAO_ACESSO_MS + 1_000,
    });
    c.aoUpload = () => {
      c.relogio += 2_000;
      return Promise.resolve();
    };
    c.lwaCaiu = true;
    await expect(c.rodar(janelaDoTick())).rejects.toThrow();
    expect(criarFeeds(c)).toBe(0);
    expect(c.chamadas).toContain('LWA');
    // NEAR-MISS: read as uncertain, the lease would stay `enviando`, expired, for 12 h.
    expect(lease(c)).toMatchObject({
      estado: 'livre',
      falhasSeguidas: 0,
      ultimoEnvioMs: AGORA_MS + 2_000,
    });
    expect(c.fake.ler(AVISO)).toBeUndefined();

    c.lwaCaiu = false;
    c.aoUpload = null;
    c.relogio += 3 * MIN;
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, tomada: 'tomar' });
    expect(criarFeeds(c)).toBe(1);
  });

  it('★ a refresh re-run whose UNCERTAIN WAIT fails to enqueue (transient) ⇒ the previous attempt’s enviando released by ITS stamp, no failure counted, rethrown; the retry takes the lease and submits instead of waiting 12 h', async () => {
    const c = cenario();
    c.rotas.feed = [
      { status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
      { status: 202, corpo: { feedId: FEED } },
    ];
    c.aoCriarFeed = () => {
      // The next enqueue is the re-run's uncertain wait.
      c.falhasDaFila.push(() => falhaDoFunctions('unavailable'));
      c.relogio += 5_000;
      return Promise.resolve();
    };
    await expect(c.rodar(janelaDoTick())).rejects.toThrow();
    expect(criarFeeds(c)).toBe(1);
    expect(documentos(c)).toBe(2);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });

    c.aoCriarFeed = null;
    c.relogio += 3 * MIN;
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, tomada: 'tomar' });
    expect(criarFeeds(c)).toBe(2);
  });

  it('★ the closure tracks the stamp the re-run WROTE: 401, then the re-run’s createFeed fails before its request left (the credential read) ⇒ released by the SECOND stamp, rethrown', async () => {
    const c = cenario();
    c.rotas.feed = [{ status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } }];
    c.aoCriarFeed = () => {
      c.relogio += 5_000;
      return Promise.resolve();
    };
    let uploads = 0;
    c.aoUpload = () => {
      uploads += 1;
      // The re-run's own upload is done: its createFeed's credential read fails.
      if (uploads === 2) c.fake.falharLeitura(caminhoCredencial(CONTA), grpc(14, 'indisponível'));
      return Promise.resolve();
    };
    await expect(c.rodar(janelaDoTick())).rejects.toThrow();
    expect(criarFeeds(c)).toBe(1);
    // NEAR-MISS: keyed by the FIRST stamp, the release would be refused and the
    // lease held `enviando` for 12 h by a feed that was never submitted.
    expect(lease(c)).toMatchObject({
      estado: 'livre',
      falhasSeguidas: 0,
      ultimoEnvioMs: AGORA_MS + 5_000,
    });
  });
});

describe('★ the document and its upload — nothing submitted', () => {
  it('a transient upload failure (S3 503) ⇒ released, rethrown for the queue, no failure counted', async () => {
    const c = cenario();
    c.rotas.upload = [{ status: 503 }];
    await expect(c.rodar(janelaDoTick())).rejects.toThrow();
    expect(criarFeeds(c)).toBe(0);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });
  });

  it('a deterministic upload refusal ⇒ released, the aviso, a failure counted, no throw', async () => {
    const c = cenario();
    c.rotas.upload = [{ status: 403 }];
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.liberado, motivo: 'documento-falhou' });
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });
    expect(c.fake.ler(AVISO)).toMatchObject({ resolvidoEm: null });
  });

  it('★ a 403 on createFeedDocument that persists after the forced refresh ⇒ deterministic: documento-falhou, released, the aviso, one failure counted, no throw (NEAR-MISS: read as transient, every retry would rebuild and fail again with no aviso)', async () => {
    const c = cenario();
    c.rotas.documento = [
      { status: 403, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
    ];
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.liberado,
      motivo: 'documento-falhou',
      aviso: 'conta-sem-operacao',
    });
    expect(documentos(c)).toBe(2);
    expect(c.chamadas).toContain('LWA');
    expect(criarFeeds(c)).toBe(0);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 1 });
  });

  it('a refresh re-run whose document fails ⇒ released from enviando by THIS attempt’s stamp', async () => {
    const c = cenario();
    c.rotas.feed = [{ status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } }];
    c.rotas.documento = [{ status: 201 }, { status: 400, corpo: { errors: [] } }];
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ motivo: 'documento-falhou', recusa: null });
    expect(lease(c)).toMatchObject({ estado: 'livre' });
    expect(criarFeeds(c)).toBe(1);
  });

  it('★ a refresh re-run whose upload fails TRANSIENTLY ⇒ released from enviando by THIS attempt’s stamp, no failure counted, rethrown; the retry takes the lease and submits instead of waiting 12 h', async () => {
    const c = cenario();
    c.rotas.feed = [
      { status: 401, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
      { status: 202, corpo: { feedId: FEED } },
    ];
    c.rotas.upload = [{ status: 200 }, { status: 503 }, { status: 200 }];
    await expect(c.rodar(janelaDoTick())).rejects.toThrow();
    expect(criarFeeds(c)).toBe(1);
    expect(lease(c)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });

    c.relogio += 3 * MIN;
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, tomada: 'tomar' });
    expect(criarFeeds(c)).toBe(2);
    expect(lease(c)).toMatchObject({ estado: 'enviado', feedId: FEED });
  });

  it('★ a duplicate COPY whose document fails while another copy is inside createFeed frees NOTHING (the stamp keys the attempt)', async () => {
    const c = cenario();
    let b: Promise<ResultadoEnvioFeedAmazon> | null = null;
    let liberarDocumentoDeB: () => void = () => undefined;
    const documentoDeBLiberado = new Promise<void>((resolve) => {
      liberarDocumentoDeB = resolve;
    });
    let bNoDocumento: () => void = () => undefined;
    const bChegouAoDocumento = new Promise<void>((resolve) => {
      bNoDocumento = resolve;
    });
    let documentosVistos = 0;
    c.aoDocumento = async () => {
      documentosVistos += 1;
      if (documentosVistos === 2) {
        // Copy B's document: it waits until copy A is inside createFeed, then fails.
        c.rotas.documento = [{ status: 400, corpo: { errors: [] } }];
        bNoDocumento();
        await documentoDeBLiberado;
      }
    };
    // Right before copy A writes `enviando`, copy B reads the lease `montando` (retomar).
    c.fake.antesDaProximaEscrita(VEZ, () => undefined);
    c.fake.antesDaProximaEscrita(VEZ, async () => {
      b = c.rodar(janelaDoTick());
      await bChegouAoDocumento;
    });
    c.aoCriarFeed = async () => {
      liberarDocumentoDeB();
      const rb = await (b ?? Promise.reject(new Error('B não rodou')));
      expect(rb).toMatchObject({ motivo: 'documento-falhou', recusa: 'outro-estado' });
      // Copy A's lease is untouched by B's release.
      expect(lease(c)).toMatchObject({ estado: 'enviando', execucaoId: EXEC });
    };
    const ra = await c.rodar(janelaDoTick());
    expect(ra.acao).toBe(ACAO_ENVIO_FEED.enviado);
    expect(criarFeeds(c)).toBe(1);
    expect(lease(c)).toMatchObject({ estado: 'enviado', feedId: FEED });
  });

  it('a copy that never stamped meets another copy’s enviando at marcarEnviando ⇒ vez-perdida, ZERO createFeed of its own', async () => {
    const c = cenario();
    // A reaches E5; B (same execucaoId) runs to completion before A's document answers.
    let rb: ResultadoEnvioFeedAmazon | null = null;
    let primeiro = true;
    c.aoUpload = async () => {
      if (!primeiro) return;
      primeiro = false;
      rb = await c.rodar(janelaDoTick());
    };
    const ra = await c.rodar(janelaDoTick());
    // B (the inner run) submitted; A, which built from `montando`, lost the lease to B's stamp.
    expect(rb).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado });
    expect(ra).toMatchObject({ acao: ACAO_ENVIO_FEED.vezPerdida, recusa: 'outro-estado' });
    expect(criarFeeds(c)).toBe(1);
  });
});

describe('★ E4 — the run’s OWN lease resumes its own state', () => {
  it('this run’s enviando ⇒ ZERO createFeed, the feed-incerto re-ensured for the remainder', async () => {
    const c = cenario();
    semear(c, incertaDe(HORA, { execucaoId: EXEC }));
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.incertoGarantido,
      atrasoS: (PRAZO_FEED_MS - HORA) / 1000,
    });
    expect(c.chamadas).toEqual([]);
    expect(doTipo(c, 'feed-incerto').map((x) => x.nome)).toEqual([nomeIncertoFeed(CONTA, EXEC)]);
    expect(escritasDaVez(c)).toEqual([]);
  });

  it('this run’s enviado ⇒ rung 0 re-enqueued, ZERO createFeed', async () => {
    const c = cenario();
    semear(c, enviadoDe(MIN, { execucaoId: EXEC, feedId: FEED }));
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.consultaRetomada, feedId: FEED });
    expect(c.chamadas).toEqual([]);
    expect(doTipo(c, 'feed-resultado').map((x) => x.nome)).toEqual([
      nomeConsultaFeed(CONTA, FEED, 0),
    ]);
  });

  it('★ a duplicate copy meeting its own enviado over a record the result chain already ADVANCED ⇒ ja-registrado, the record untouched (the create is tier 0, never an overwrite)', async () => {
    const c = cenario();
    expect((await c.rodar(janelaDoTick())).acao).toBe(ACAO_ENVIO_FEED.enviado);
    // Rung 0 ran meanwhile: the record moved forward.
    c.fake.seed(registroDe(FEED), {
      ...c.fake.ler(registroDe(FEED)),
      status: STATUS_REGISTRO_FEED_AMAZON.processando,
      rodadas: 1,
      atualizadoEmMs: AGORA_MS + 2 * MIN,
      processingStatus: 'IN_PROGRESS',
    });

    c.relogio += 3 * MIN;
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.consultaRetomada, registro: 'ja-registrado' });
    expect(criarFeeds(c)).toBe(1);
    expect(c.fake.ler(registroDe(FEED))).toMatchObject({
      status: STATUS_REGISTRO_FEED_AMAZON.processando,
      rodadas: 1,
      atualizadoEmMs: AGORA_MS + 2 * MIN,
      processingStatus: 'IN_PROGRESS',
    });
  });

  it('this run’s montando ⇒ rebuilt from E5 and submitted once', async () => {
    const c = cenario();
    const t = janelaDoTick();
    // What this run's own take wrote before it died building.
    semear(
      c,
      vez({
        estado: ESTADO_VEZ_FEED_AMAZON.montando,
        execucaoId: EXEC,
        ateMs: AGORA_MS + VALIDADE_VEZ_MS,
        origem: t.origem,
        tipoLote: t.lote.tipo,
        janela:
          t.lote.tipo === 'janela'
            ? {
                desdeMs: t.lote.desdeMs,
                ateMs: t.lote.ateMs,
                manterDesdeMs: t.lote.manterDesdeMs,
                commitAposMs: t.lote.commitAposMs,
                depositoId: t.lote.depositoId,
              }
            : null,
      }),
    );
    const r = await c.rodar(t);
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, tomada: 'retomar' });
    expect(criarFeeds(c)).toBe(1);
  });

  it('★ a lost lease create (ALREADY_EXISTS) ⇒ re-read and re-decided: another run took it, the start is recorded', async () => {
    const c = cenario();
    c.fake.antesDaProximaEscrita(VEZ, () => {
      c.fake.seed(
        VEZ,
        vez({
          estado: ESTADO_VEZ_FEED_AMAZON.montando,
          execucaoId: OUTRO,
          ateMs: AGORA_MS + VALIDADE_VEZ_MS,
        }),
      );
    });
    const r = await c.rodar(janelaDoTick(AGORA_MS - 10 * MIN));
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.pendenteRegistrado, tomada: 'ocupada' });
    expect(lease(c)).toMatchObject({ execucaoId: OUTRO, pendenteDesdeMs: AGORA_MS - 10 * MIN });
    expect(c.chamadas).toEqual([]);
  });

  it('★ a lost precondition re-decides on the clock of the RE-READ: a holder released while the clock crossed the 120-s floor ⇒ the batch takes it (NEAR-MISS: the first read’s clock would still wait out the floor)', async () => {
    const c = cenario();
    semear(
      c,
      vez({
        estado: ESTADO_VEZ_FEED_AMAZON.montando,
        execucaoId: OUTRO,
        ateMs: AGORA_MS + VALIDADE_VEZ_MS,
      }),
    );
    // Between the read and the start's write: the holder releases, 100 s after its
    // submission, and 30 s pass (130 s ≥ the 120-s floor).
    c.fake.antesDaProximaEscrita(VEZ, () => {
      c.fake.seed(
        VEZ,
        vez({ estado: ESTADO_VEZ_FEED_AMAZON.livre, ultimoEnvioMs: AGORA_MS - 100_000 }),
      );
      c.relogio += 30_000;
    });
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, tomada: 'tomar' });
    expect(criarFeeds(c)).toBe(1);
  });

  it('★ a lease write failing for any reason but a lost precondition PROPAGATES as itself on its FIRST attempt (never re-decided into a conflict)', async () => {
    const c = cenario();
    c.fake.falharEscrita(VEZ, grpc(14, 'indisponível'));
    const erro: unknown = await c.rodar(janelaDoTick()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toMatchObject({ code: 14 });
    expect((erro as Error).name).not.toBe('AmazonVezFeedEmConflitoError');
    expect(c.fake.leituras.filter((p) => p === VEZ)).toHaveLength(1);
    expect(c.chamadas).toEqual([]);
  });
});

describe('★ E4 — a batch another run’s lease turns away', () => {
  it('★ a TICK window behind a fresh enviado ⇒ feed-em-curso: its start recorded, ZERO Amazon calls', async () => {
    const c = cenario();
    semear(c, enviadoDe(MIN));
    const r = await c.rodar(janelaDoTick(AGORA_MS - 10 * MIN));
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.pendenteRegistrado,
      pendenteDesdeMs: AGORA_MS - 10 * MIN,
    });
    expect(lease(c)).toMatchObject({ pendenteDesdeMs: AGORA_MS - 10 * MIN, feedId: OUTRO_FEED });
    expect(c.chamadas).toEqual([]);
    expect(c.espiao.membros).toBe(0);
  });

  it('★ the start is MIN-merged: a later batch never overwrites an earlier start', async () => {
    const c = cenario();
    semear(c, enviadoDe(MIN, { pendenteDesdeMs: AGORA_MS - 20 * MIN }));
    await c.rodar(janelaDoTick(AGORA_MS - 10 * MIN, 'exec-tarde'));
    expect(lease(c)).toMatchObject({ pendenteDesdeMs: AGORA_MS - 20 * MIN });
    await c.rodar(janelaDoTick(AGORA_MS - 30 * MIN, 'exec-cedo'));
    expect(lease(c)).toMatchObject({ pendenteDesdeMs: AGORA_MS - 30 * MIN });
  });

  it('★ a BLOCK batch turned away ⇒ re-enqueued UNNAMED after 300 s, ZERO lease writes; past esperaAteMs ⇒ lote-expirado, nothing enqueued', async () => {
    const c = cenario();
    semear(c, enviadoDe(MIN));
    const r = await c.rodar(blocos(AGORA_MS + HORA));
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.aguardando, atrasoS: ESPERA_LOTE_EM_VEZ_S });
    expect(doTipo(c, 'feed-enviar')).toEqual([
      expect.objectContaining({ nome: null, atrasoS: 300 }),
    ]);
    expect(escritasDaVez(c)).toEqual([]);

    const expirado = cenario();
    semear(expirado, enviadoDe(MIN));
    const r2 = await expirado.rodar(blocos(AGORA_MS));
    expect(r2.acao).toBe(ACAO_ENVIO_FEED.loteExpirado);
    expect(expirado.enfileiradas).toEqual([]);
    expect(escritasDaVez(expirado)).toEqual([]);
  });

  it.each<[string, VezFeedAmazon, string]>([
    ['incerta-aguardar', incertaDe(HORA), 'incerta-aguardar'],
    ['ocupada-vencida', enviadoDe(PRAZO_FEED_MS), 'ocupada-vencida'],
    ['adotar-resultado', enviadoDe(VALIDADE_VEZ_ENVIADO_MS), 'adotar-resultado'],
    ['ocupada-lenta', enviadoDe(ESPERA_MAXIMA_ATRAS_DE_FEED_MS + MIN), 'ocupada-lenta'],
  ])(
    '★ the stale holder (%s): a window batch ⇒ membros re-derived and handed to patches, ZERO createFeed, ZERO lease writes',
    async (_caso, holder, motivo) => {
      const c = cenario();
      semear(c, holder);
      const r = await c.rodar(janelaDoTick());
      expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo, tarefas: SKUS.length });
      expect(c.espiao.membros).toBe(1);
      expect(c.espiao.repasses).toEqual([SKUS]);
      expect(c.chamadas).toEqual([]);
      expect(escritasDaVez(c)).toEqual([]);
    },
  );

  it.each<[string, VezFeedAmazon, string]>([
    [
      'ocupada-vencida',
      enviadoDe(PRAZO_FEED_MS, { pendenteDesdeMs: AGORA_MS - 13 * HORA }),
      'ocupada-vencida',
    ],
    [
      'ocupada-lenta',
      enviadoDe(ESPERA_MAXIMA_ATRAS_DE_FEED_MS + MIN, { pendenteDesdeMs: AGORA_MS - HORA }),
      'ocupada-lenta',
    ],
  ])(
    '★ the stale holder (%s) with a start a crashed holder left ⇒ patches, then ONE vez recovery named for the holder BEFORE the start is cleared (the lease’s only write)',
    async (_caso, holder, motivo) => {
      const c = cenario();
      semear(c, holder);
      const pendente = holder.pendenteDesdeMs;
      const r = await c.rodar(janelaDoTick());
      expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo, vezPara: pendente });
      expect(c.espiao.repasses).toEqual([SKUS]);
      const vezes = doTipo(c, 'feed-recuperar');
      expect(vezes).toEqual([
        expect.objectContaining({
          nome: nomeRecuperacaoFeed(CONTA, referenciaVezFeed(OUTRO_FEED), pendente),
          tarefa: expect.objectContaining({ desfecho: 'vez', pendenteDesdeMs: pendente }),
        }),
      ]);
      expect(vezes[0]?.vez).toMatchObject({ pendenteDesdeMs: pendente });
      expect(lease(c)).toMatchObject({ pendenteDesdeMs: null, estado: 'enviado' });
      expect(escritasDaVez(c)).toHaveLength(1);
      expect(c.chamadas).toEqual([]);
    },
  );

  it('★ a waiting batch’s UNNAMED re-enqueue is its LAST effect: the adoption enqueue failing once leaves exactly ONE unnamed copy after the retry (NEAR-MISS: enqueued first, every failed attempt would leave one more copy of the payload)', async () => {
    const c = cenario();
    semear(c, enviadoDe(VALIDADE_VEZ_ENVIADO_MS));
    let falhou = false;
    c.falharEnfileiramento = (tarefa) => {
      if (falhou || tarefa.tipo !== 'feed-resultado') return null;
      falhou = true;
      return falhaDoFunctions('unavailable');
    };
    await expect(c.rodar(blocos())).rejects.toThrow();
    expect(doTipo(c, 'feed-enviar')).toEqual([]);

    const r = await c.rodar(blocos());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.aguardando, adocao: true });
    expect(doTipo(c, 'feed-enviar')).toEqual([
      expect.objectContaining({ nome: null, atrasoS: ESPERA_LOTE_EM_VEZ_S }),
    ]);
    expect(doTipo(c, 'feed-resultado')).toHaveLength(1);
    expect(escritasDaVez(c)).toEqual([]);
  });

  it('★ NEAR-MISS: the same window batch on a FRESH enviado ⇒ recorded, ZERO patch tasks', async () => {
    const c = cenario();
    semear(c, enviadoDe(MIN));
    const r = await c.rodar(janelaDoTick());
    expect(r.acao).toBe(ACAO_ENVIO_FEED.pendenteRegistrado);
    expect(c.espiao.repasses).toEqual([]);
  });

  it('★ the 30-min bound: a window batch at +31 min goes as patches, at +29 min is recorded; a block batch at +31 min still waits', async () => {
    const lenta = cenario();
    semear(lenta, enviadoDe(31 * MIN));
    expect((await lenta.rodar(janelaDoTick())).acao).toBe(ACAO_ENVIO_FEED.repassado);

    const fresca = cenario();
    semear(fresca, enviadoDe(29 * MIN));
    expect((await fresca.rodar(janelaDoTick())).acao).toBe(ACAO_ENVIO_FEED.pendenteRegistrado);

    const bloco = cenario();
    semear(bloco, enviadoDe(31 * MIN));
    expect((await bloco.rodar(blocos())).acao).toBe(ACAO_ENVIO_FEED.aguardando);
    expect(bloco.espiao.repasses).toEqual([]);
  });

  it('★ a stored start a crashed holder left ⇒ ONE vez recovery BEFORE the start is cleared; adotar-resultado also enqueues the adoption rung', async () => {
    const c = cenario();
    const pendente = AGORA_MS - 3 * HORA;
    semear(c, enviadoDe(VALIDADE_VEZ_ENVIADO_MS, { pendenteDesdeMs: pendente }));
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, vezPara: pendente, adocao: true });
    const vezes = doTipo(c, 'feed-recuperar');
    expect(vezes).toEqual([
      expect.objectContaining({
        nome: nomeRecuperacaoFeed(CONTA, referenciaVezFeed(OUTRO_FEED), pendente),
        tarefa: expect.objectContaining({ desfecho: 'vez', pendenteDesdeMs: pendente }),
      }),
    ]);
    // Enqueued while the start was still stored: the enqueue came first.
    expect(vezes[0]?.vez).toMatchObject({ pendenteDesdeMs: pendente });
    expect(lease(c)).toMatchObject({
      pendenteDesdeMs: null,
      feedId: OUTRO_FEED,
      estado: 'enviado',
    });
    expect(escritasDaVez(c)).toHaveLength(1);
    expect(doTipo(c, 'feed-resultado')).toEqual([
      expect.objectContaining({
        nome: nomeConsultaFeed(CONTA, OUTRO_FEED, 'adocao'),
        tarefa: expect.objectContaining({ origem: 'adocao', feedId: OUTRO_FEED }),
      }),
    ]);
    expect(c.chamadas).toEqual([]);
  });

  it('★ an expired enviado ⇒ the adoption rung, NO new submission (a block batch waits)', async () => {
    const c = cenario();
    semear(c, enviadoDe(VALIDADE_VEZ_ENVIADO_MS));
    const r = await c.rodar(blocos());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.aguardando, adocao: true });
    expect(criarFeeds(c)).toBe(0);
    expect(doTipo(c, 'feed-resultado').map((x) => x.nome)).toEqual([
      nomeConsultaFeed(CONTA, OUTRO_FEED, 'adocao'),
    ]);
  });

  it('★ a RECOVERY-born window behind a fresh enviado ⇒ NO start written, re-enqueued after 300 s; free ⇒ it takes and builds; still blocked at esperaAteMs ⇒ patches, ZERO lease writes', async () => {
    const c = cenario();
    semear(c, enviadoDe(MIN));
    const t = janelaDaRecuperacao(AGORA_MS + HORA);
    const r = await c.rodar(t);
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.aguardando, atrasoS: 300 });
    expect(lease(c)).toMatchObject({ pendenteDesdeMs: null });
    expect(escritasDaVez(c)).toEqual([]);

    // The holder releases; the batch takes the lease and builds.
    semear(c, vez({ estado: ESTADO_VEZ_FEED_AMAZON.livre, ultimoEnvioMs: AGORA_MS - 10 * MIN }));
    c.relogio += 5 * MIN;
    expect((await c.rodar(t)).acao).toBe(ACAO_ENVIO_FEED.enviado);

    // NEAR-MISS: still blocked at its esperaAteMs ⇒ patches, the lease untouched.
    const tarde = cenario();
    semear(tarde, enviadoDe(MIN));
    const r3 = await tarde.rodar(janelaDaRecuperacao(AGORA_MS));
    expect(r3).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo: 'espera-esgotada' });
    expect(tarde.espiao.repasses).toEqual([SKUS]);
    expect(escritasDaVez(tarde)).toEqual([]);
  });

  it('★ incerta-recuperar with a TICK window ⇒ its start recorded, then the uncertain path folds it: ONE recovery with the start and the lease’s janela', async () => {
    const c = cenario();
    const holder = incertaDe(PRAZO_FEED_MS);
    semear(c, holder);
    const desde = AGORA_MS - 7 * MIN;
    const r = await c.rodar(janelaDoTick(desde));
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.pendenteRegistrado, pendenteDesdeMs: desde });
    expect(r.caminhoIncerto).toMatchObject({ tipo: 'recuperado', pendenteDesdeMs: desde });
    const recuperacoes = doTipo(c, 'feed-recuperar');
    expect(recuperacoes).toEqual([
      expect.objectContaining({
        nome: nomeRecuperacaoFeed(CONTA, OUTRO, desde),
        tarefa: expect.objectContaining({
          desfecho: 'incerto',
          execucaoId: OUTRO,
          feedId: null,
          pendenteDesdeMs: desde,
          janela: holder.janela,
          snapshotEmMs: holder.snapshotEmMs,
        }),
      }),
    ]);
    expect(lease(c)).toMatchObject({ estado: 'livre', pendenteDesdeMs: null, falhasSeguidas: 1 });
    expect(c.chamadas).toEqual([]);
  });

  it('★ incerta-recuperar with a RECOVERY-born window ⇒ patches, then the uncertain path', async () => {
    const c = cenario();
    semear(c, incertaDe(PRAZO_FEED_MS));
    const r = await c.rodar(janelaDaRecuperacao(AGORA_MS + HORA));
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo: 'incerta-recuperar' });
    expect(r.caminhoIncerto).toMatchObject({ tipo: 'recuperado', pendenteDesdeMs: null });
    expect(c.espiao.repasses).toEqual([SKUS]);
    expect(doTipo(c, 'feed-recuperar')).toHaveLength(1);
    expect(lease(c)).toMatchObject({ estado: 'livre' });
    // The hand-off first, THEN the uncertain path's recovery.
    expect(c.ordem.indexOf('repasse')).toBeGreaterThanOrEqual(0);
    expect(c.ordem.indexOf('repasse')).toBeLessThan(c.ordem.indexOf('fila:feed-recuperar'));
  });

  it('★ incerta-recuperar with a RECOVERY-born window and a stored start ⇒ patches, then ONE recovery: the uncertain path folds the start, the hand-off consumes nothing (no separate vez)', async () => {
    const c = cenario();
    const desde = AGORA_MS - 7 * MIN;
    semear(c, incertaDe(PRAZO_FEED_MS, { pendenteDesdeMs: desde }));
    const r = await c.rodar(janelaDaRecuperacao(AGORA_MS + HORA));
    expect(r).toMatchObject({
      acao: ACAO_ENVIO_FEED.repassado,
      motivo: 'incerta-recuperar',
      vezPara: null,
    });
    expect(r.caminhoIncerto).toMatchObject({ tipo: 'recuperado', pendenteDesdeMs: desde });
    expect(c.espiao.repasses).toEqual([SKUS]);
    expect(doTipo(c, 'feed-recuperar')).toEqual([
      expect.objectContaining({
        nome: nomeRecuperacaoFeed(CONTA, OUTRO, desde),
        tarefa: expect.objectContaining({ desfecho: 'incerto', pendenteDesdeMs: desde }),
      }),
    ]);
    expect(lease(c)).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });
});

describe('★ the uncertain outcome expires the lease at once', () => {
  it('after a cut createFeed: ateMs ≤ agora, a start recorded meanwhile became ONE vez recovery, the aviso raised; a window batch one minute later goes as patches', async () => {
    const c = cenario();
    c.rotas.feed = [{ rede: true }];
    const pendente = AGORA_MS - 4 * MIN;
    // Another run's tick batch records its start while this run is inside createFeed.
    c.aoCriarFeed = () => {
      const atual = lease(c);
      if (atual === undefined) throw new Error('sem vez');
      c.fake.seed(VEZ, { ...atual, pendenteDesdeMs: pendente });
      return Promise.resolve();
    };
    const r = await c.rodar(janelaDoTick());
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.incerto, vezPara: pendente });
    const atual = lease(c);
    expect(atual?.ateMs).toBeLessThanOrEqual(c.relogio);
    expect(atual).toMatchObject({ estado: 'enviando', feedId: null, pendenteDesdeMs: null });
    expect(doTipo(c, 'feed-recuperar')).toEqual([
      expect.objectContaining({
        nome: nomeRecuperacaoFeed(CONTA, referenciaVezFeed(EXEC), pendente),
      }),
    ]);
    expect(c.fake.ler(AVISO)).toMatchObject({ resolvidoEm: null });

    // NEAR-MISS: an unexpired lease would record the next batch and hold it 12 h.
    c.relogio += MIN;
    const seguinte = await c.rodar(janelaDoTick(AGORA_MS, 'exec-seguinte'));
    expect(seguinte).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo: 'incerta-aguardar' });
  });
});

describe('★ the breaker and the submission floor', () => {
  /** A definitive `createFeed` refusal of the batch `execucaoId`, `atrasoMs` later. */
  async function falhar(c: Cenario, execucaoId: string): Promise<void> {
    c.rotas.feed = [{ status: 400, corpo: { errors: [{ code: 'InvalidInput', message: 'x' }] } }];
    c.relogio += ESPACO_MINIMO_ENTRE_FEEDS_MS;
    const r = await c.rodar(blocos(AGORA_MS + 6 * HORA, execucaoId));
    expect(r.motivo).toBe('recusa-definitiva');
  }

  it('★ three failed releases ⇒ falhasSeguidas 3; a window batch within the hour goes as patches (no lease write); a block batch probes', async () => {
    const c = cenario();
    // A snapshot-lento abort, a deterministic document failure, a definitive refusal.
    c.provedor = provedorDeTeste(c, 'estoque', {
      montarAbortado: { abortado: MOTIVO_ABORTO_LOTE.snapshotLento, aviso: null },
    });
    await c.rodar(blocos(AGORA_MS + 6 * HORA, 'exec-falha-1'));
    c.provedor = provedorDeTeste(c);
    c.rotas.upload = [{ status: 403 }];
    c.relogio += MIN;
    await c.rodar(blocos(AGORA_MS + 6 * HORA, 'exec-falha-2'));
    c.rotas.upload = [{ status: 200 }];
    await falhar(c, 'exec-falha-3');
    const ultima = c.relogio;
    expect(lease(c)).toMatchObject({ falhasSeguidas: 3, ultimaFalhaEmMs: ultima });

    const antes = escritasDaVez(c).length;
    c.relogio = ultima + 59 * MIN;
    const janela = await c.rodar(janelaDoTick(AGORA_MS, 'exec-janela'));
    expect(janela).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo: 'disjuntor' });
    expect(escritasDaVez(c)).toHaveLength(antes);

    c.rotas.feed = [{ status: 202, corpo: { feedId: FEED } }];
    const bloco = await c.rodar(blocos(AGORA_MS + 6 * HORA, 'exec-sonda-bloco'));
    expect(bloco).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, sonda: true });
  });

  it('★ half-open: with NO block batch, a window batch 1 h after the last failure takes the lease as THE probe; a second window batch meeting it is recorded, never a second probe; the probe’s failure re-arms the hour', async () => {
    const c = cenario();
    semear(
      c,
      vez({
        estado: ESTADO_VEZ_FEED_AMAZON.livre,
        falhasSeguidas: 3,
        ultimaFalhaEmMs: AGORA_MS - ESPERA_SONDA_DISJUNTOR_MS,
        ultimoEnvioMs: AGORA_MS - 2 * HORA,
      }),
    );
    c.rotas.feed = [{ status: 400, corpo: { errors: [{ code: 'InvalidInput', message: 'x' }] } }];
    let segunda: ResultadoEnvioFeedAmazon | null = null;
    c.aoCriarFeed = async () => {
      segunda = await c.rodar(janelaDoTick(AGORA_MS - 2 * MIN, 'exec-segunda'));
    };
    const sonda = await c.rodar(janelaDoTick(AGORA_MS - 9 * MIN, 'exec-sonda'));
    expect(sonda).toMatchObject({ sonda: true, motivo: 'recusa-definitiva' });
    expect(segunda).toMatchObject({ acao: ACAO_ENVIO_FEED.pendenteRegistrado, tomada: 'ocupada' });
    expect(lease(c)).toMatchObject({ falhasSeguidas: 4, ultimaFalhaEmMs: AGORA_MS });

    c.relogio += 30 * MIN;
    const depois = await c.rodar(janelaDoTick(AGORA_MS, 'exec-depois'));
    expect(depois).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo: 'disjuntor' });
  });

  it('★ the probe’s DONE closes the breaker: the next window batch takes the lease again (NEAR-MISS: falhasSeguidas 2 takes whatever the clock)', async () => {
    const c = cenario();
    semear(
      c,
      vez({
        estado: ESTADO_VEZ_FEED_AMAZON.livre,
        falhasSeguidas: 3,
        ultimaFalhaEmMs: AGORA_MS - ESPERA_SONDA_DISJUNTOR_MS,
        ultimoEnvioMs: AGORA_MS - 2 * HORA,
      }),
    );
    expect((await c.rodar(janelaDoTick(AGORA_MS, 'exec-sonda'))).sonda).toBe(true);
    // The feed's tail releases it as `concluido`.
    c.relogio += 10 * MIN;
    await liberarVezFeed(
      asDb(c.fake),
      { fluxo: FLUXO_FEED_AMAZON.estoque, contaId: CONTA },
      { feedId: FEED },
      'concluido',
      {
        agora: () => c.relogio,
        pendenteDobrado: null,
        enfileirarVez: () => Promise.resolve(),
      },
    );
    expect(lease(c)).toMatchObject({ falhasSeguidas: 0 });
    c.rotas.feed = [{ status: 202, corpo: { feedId: OUTRO_FEED } }];
    expect(await c.rodar(janelaDoTick(AGORA_MS, 'exec-fechado'))).toMatchObject({
      acao: ACAO_ENVIO_FEED.enviado,
      sonda: false,
    });

    const duas = cenario();
    semear(
      duas,
      vez({
        estado: ESTADO_VEZ_FEED_AMAZON.livre,
        falhasSeguidas: 2,
        ultimaFalhaEmMs: AGORA_MS - MIN,
      }),
    );
    expect((await duas.rodar(janelaDoTick())).acao).toBe(ACAO_ENVIO_FEED.enviado);
  });

  it('★ the submission floor: released 90 s after its submission ⇒ the next send re-enqueues itself unnamed for 30 s, ZERO lease writes; three feeds never submit closer than 120 s', async () => {
    const c = cenario();
    const instantes: number[] = [];
    c.aoCriarFeed = () => {
      instantes.push(c.relogio);
      return Promise.resolve();
    };
    const feeds = ['50000000001', '50000000002', '50000000003'];
    for (const [i, feedId] of feeds.entries()) {
      c.rotas.feed = [{ status: 202, corpo: { feedId } }];
      const exec = `exec-sequencia-${String(i)}`;
      const escritasAntes = escritasDaVez(c).length;
      const vezAntes = lease(c);
      let r = await c.rodar(janelaDoTick(AGORA_MS, exec));
      if (i > 0) {
        expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.aguardando, atrasoS: 30 });
        // The floor's wait wrote nothing on the lease.
        expect(escritasDaVez(c)).toHaveLength(escritasAntes);
        expect(lease(c)).toEqual(vezAntes);
        c.relogio += 30_000;
        r = await c.rodar(janelaDoTick(AGORA_MS, exec));
      }
      expect(r.acao).toBe(ACAO_ENVIO_FEED.enviado);
      // A fast DONE, woken by the notification: released 90 s later.
      c.relogio += 90_000;
      await liberarVezFeed(
        asDb(c.fake),
        { fluxo: FLUXO_FEED_AMAZON.estoque, contaId: CONTA },
        { feedId },
        'concluido',
        {
          agora: () => c.relogio,
          pendenteDobrado: null,
          enfileirarVez: () => Promise.resolve(),
        },
      );
    }
    expect(instantes).toHaveLength(3);
    for (let i = 1; i < instantes.length; i += 1) {
      expect((instantes[i] ?? 0) - (instantes[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        ESPACO_MINIMO_ENTRE_FEEDS_MS,
      );
    }
    expect(doTipo(c, 'feed-enviar').every((x) => x.nome === null)).toBe(true);
  });
});

describe('★ a fake PRICE provider drives the send with no stock module (the step-13 reuse)', () => {
  it('a price block batch: its own valve, its own lease, its own line event', async () => {
    const c = cenario({ fluxo: 'preco' });
    const t = enviar({
      fluxo: FLUXO_FEED_AMAZON.preco,
      origem: 'operador',
      lote: { tipo: 'blocos', partes: 1, esperaAteMs: AGORA_MS + HORA },
    });
    const r = await c.rodar(t);
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, fluxo: 'preco' });
    expect(c.fake.ler(VEZ_PRECO)).toMatchObject({ estado: 'enviado', feedId: FEED });
    expect(c.fake.ler(VEZ)).toBeUndefined();
    expect(c.fake.ler(registroDe(FEED))).toMatchObject({ fluxo: 'preco' });
    expect(
      c.log.linhas.filter((l) => l.meta?.evento === 'preco' && l.meta.fase === 'envio'),
    ).toHaveLength(1);
  });

  it('a send-side aviso is clocked by THIS dispatch’s lease read (its readTime)', async () => {
    const c = cenario();
    c.rotas.feed = [{ status: 400, corpo: { errors: [{ code: 'InvalidInput', message: 'x' }] } }];
    await c.rodar(janelaDoTick());
    // The fake's clock moves ONE microsecond per write, and a read's `readTime`
    // is the latest stamp issued: E4's read is exactly one µs before the take's
    // create. A fresh read at the aviso would be later than the take, the
    // `enviando` and the release writes.
    const [tomada] = escritasDaVez(c);
    expect(tomada?.verbo).toBe('create');
    expect(c.fake.ler(AVISO)?.relogioEvento).toBe(
      relogioDoDocumentoUs(tomada?.writeTime ?? { seconds: 0, nanoseconds: 0 }) - 1,
    );
  });
});
