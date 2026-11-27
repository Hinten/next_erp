/**
 * The PRICE feed provider (step 13, PR 13-f), against the counting fake
 * Firestore: the REAL run and parts I/O, the REAL shared link and unit
 * readers, the REAL write-back and avisos seam, the REAL price producer over a
 * recording queue; and, end to end, the REAL send handler (`feeds/enviarFeed.ts`)
 * with the REAL context, write engine and lease I/O, driving this provider;
 * and the run's REAL Decide (`execucaoPreco.ts`) naming the batches it sends.
 * Amazon is a scripted `fetch` serving the feed's document, its upload (an
 * S3-shaped fake URL) and `createFeed`, and REFUSING anything else.
 *
 * ⚠️ D11: the global `fetch` refuses; the read switch is `on` only in the
 * object literals handed in. PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { URL_BASE_SP_API, URL_TOKEN_LWA } from '@delfrance/integrations-amazon-sp-api';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import {
  DESFECHO_LOTE_PRECO_AMAZON,
  type EnvioPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  FLUXO_FEED_AMAZON,
  type FaixaPrecoAmazon,
  INTEGRACAO_TIPO,
  type ItemDivergenciaPrecoAmazon,
  MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON,
  type OfertaPrecoAmazon,
  TIPO_OFERTA_PRECO_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
  execucaoPrecoAmazonSchema,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
  motivoSemEnvioLotePrecoAmazonSchema,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_LISTINGS_AMAZON,
  chaveContaPrecisaAtencao,
  sincronizarAvisoContaListingsAmazon,
} from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { type ContextoAmazon, loadAmazonContext } from '../core/contexto';
import { camposSeguros } from '../core/log';
import { CANARIO_ENV_AMAZON, VALVULA_ENV_AMAZON, lerValvula } from '../core/valvulas';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from '../feeds/agendadorLotes';
import type { RaizLoteAmazon } from '../feeds/destinosLote';
import { type ResultadoEnvioFeedAmazon, enviarFeedAmazon } from '../feeds/enviarFeed';
import {
  type ContextoLoteAmazon,
  FIM_SEM_ENVIO_LOTE,
  type FimSemEnvioLote,
  ORCAMENTO_MONTAGEM_LOTE_MS,
} from '../feeds/provedorLote';
import {
  MAX_SKUS_COM_PROBLEMA_GRAVADOS,
  type ProblemaItemSku,
  type ProblemaSku,
} from '../feeds/relatorioFeed';
import {
  type TarefaEnviarFeedAmazon,
  type TarefaLoteAmazon,
  execucaoIdDoLoteBlocosFeed,
  tarefaEnviarFeedAmazonSchema,
} from '../feeds/tarefaLote';
import { FLUXO_LISTING_AMAZON } from '../listings/fluxoListing';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  loggerEspiao,
  respostaJson,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import { gravarParteDivergenciaPrecoAmazon } from './divergenciasPrecoFirestore';
import { paginaPrecoAmazon } from './execucaoPreco';
import { ehIssuePrecoAmazon } from './issuesPreco';
import { type FilaPrecoAmazon, criarProdutorPrecoAmazon } from './produtorPreco';
import {
  CAMPOS_VINCULO_LOTE_PRECO_AMAZON,
  DESFECHOS_QUE_FALHAM_PRECO_AMAZON,
  type DadosLotePrecoAmazon,
  LOTE_ENCERRADO_PRECO_AMAZON,
  MOTIVO_SEM_ENVIO_DO_FIM,
  type ProvedorLotePrecoAmazon,
  SEM_ENVIO_QUE_FALHA_PRECO_AMAZON,
  criarProvedorLotePrecoAmazon,
} from './provedorLotePreco';
import { FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS } from './processarPreco';
import {
  type TarefaPaginaPrecoAmazon,
  type TarefaPrecoSkuAmazon,
  nomeDaTarefaPrecoAmazon,
} from './tarefaPreco';

/* -------------------------------------------------------------------------- */
/*                                  constants                                 */
/* -------------------------------------------------------------------------- */

const CONTA = 'conta-amz-provedor-preco';
const REF_CONTA = `documents/integracao/${CONTA}`;
const NORMAL = 'tab-normal';
const PROMO = 'tab-promo';
const RUN = `precosAmazon/${CONTA}`;
const EXEC = 'exec-preco-provedor-1';
const OUTRA_EXEC = 'exec-preco-provedor-2';
const FEED = '50007654321';
const MIN = 60_000;
const HORA = 60 * MIN;
const VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.preco, CONTA)}`;
const URL_UPLOAD = 'https://example-bucket.s3.amazonaws.com/entrada?X-Amz-Signature=0000sentinela';
const CAMINHO_DOCUMENTOS = '/feeds/2021-06-30/documents';
const CAMINHO_FEEDS = '/feeds/2021-06-30/feeds';
const AVISO_FEED = caminhoAviso(
  chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.feedPrecoFalhou),
);
const AVISO_RECUSA = caminhoAviso(
  chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon),
);
const loteId = (k: number, run = EXEC) => execucaoIdDoLoteBlocosFeed(CONTA, run, k);

/* -------------------------------------------------------------------------- */
/*                                  the world                                 */
/* -------------------------------------------------------------------------- */

const rede: string[] = [];

interface Enfileirada<T> {
  readonly tarefa: T;
  readonly nome: string | null;
  readonly atrasoS: number;
}

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
}

function oferta(base: number, minimo = base, maximo = base): OfertaPrecoAmazon {
  return { tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base, minimo, maximo };
}

function faixa(base: number, minimo = base, maximo = base): FaixaPrecoAmazon {
  return { base, minimo, maximo };
}

interface OpcoesMembro {
  readonly oferta?: OfertaPrecoAmazon;
  readonly faixa?: FaixaPrecoAmazon;
  readonly tipoProduto?: string;
  readonly lidoEmMs?: number;
}

/** One part member: the page read Amazon at 50, the faixa 60 (an increase), unless told. */
function membro(sku: string, o: OpcoesMembro = {}): ItemDivergenciaPrecoAmazon {
  return {
    sku,
    vinculo: `produtos/p-${sku}/prodAmazon/l1`,
    unidadeId: `p-${sku}`,
    oferta: o.oferta ?? oferta(50),
    faixa: o.faixa ?? faixa(60),
    tipoProduto: o.tipoProduto ?? 'LUGGAGE',
    lidoEmMs: o.lidoEmMs ?? AGORA_MS - HORA,
  };
}

function mundo() {
  const fake = new FakeDb();
  for (const colecao of ['prodAmazon', 'produtos', 'precosAmazon', 'divergenciasPrecoAmazon']) {
    fake.exigirMascaraEm(colecao);
  }
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta provedor de preço',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    tabelaNormalOuterRef: `documents/listaDePrecos/${NORMAL}`,
    tabelaPromocionalOuterRef: `documents/listaDePrecos/${PROMO}`,
  });
  seedCredencial(fake, CONTA, { expirationDate: AGORA_MS + 365 * DIA_MS });
  const log = loggerEspiao();
  const idsPreco = new Set<string>();
  const idsLote = new Set<string>();
  const m = {
    fake,
    log,
    relogio: AGORA_MS,
    tarefasPreco: [] as Enfileirada<TarefaPrecoSkuAmazon>[],
    tarefasLote: [] as Enfileirada<TarefaLoteAmazon>[],
    chamadas: [] as string[],
    documentos: [] as Record<string, unknown>[],
    rotaFeed: { status: 202, corpo: { feedId: FEED } } as Roteiro,
    comProdutorPreco: true,
    ambiente: {
      ...AMBIENTE_LIGADO,
      [VALVULA_ENV_AMAZON.preco]: 'on',
      [CANARIO_ENV_AMAZON.preco]: '*',
    } as Record<string, string | undefined>,
    raiz(): RaizLoteAmazon {
      return {
        agendadorLotes: () => {
          throw new Error('teste: o provedor de preço não usa o produtor de lotes');
        },
        produtorEstoque: () => {
          throw new Error('teste: o provedor de preço não usa o produtor de estoque');
        },
        ...(m.comProdutorPreco
          ? {
              produtorPreco: () =>
                criarProdutorPrecoAmazon({
                  desligado: false,
                  fila: (): FilaPrecoAmazon => ({
                    enqueue: (tarefa, opcoes) => {
                      const id = opcoes?.id;
                      if (id !== undefined) {
                        if (idsPreco.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
                        idsPreco.add(id);
                      }
                      m.tarefasPreco.push({
                        tarefa,
                        nome: id ?? null,
                        atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                      });
                      return Promise.resolve();
                    },
                  }),
                }),
            }
          : {}),
        esperar: () => Promise.reject(new Error('teste: nenhuma espera aqui')),
        increment,
        gerarExecucaoId: () => {
          throw new Error('teste: o provedor de preço não gera execução');
        },
        ambiente: () => m.ambiente,
      };
    },
    provedor: null as unknown as ProvedorLotePrecoAmazon,
    ctx(): ContextoLoteAmazon {
      return {
        contexto: { integracaoId: CONTA } as unknown as ContextoAmazon,
        db: asDb(fake),
        logger: log.logger,
        agora: () => m.relogio,
        sellerId: SPID_A,
        relogioVez: null,
        vez: null,
      };
    },
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const metodo = init?.method ?? 'GET';
      if (url.href === URL_TOKEN_LWA) {
        m.chamadas.push('LWA');
        return tokenDeAcesso();
      }
      if (url.origin === new URL(URL_UPLOAD).origin && metodo === 'PUT') {
        m.chamadas.push('PUT upload');
        const corpo = new TextDecoder().decode(init?.body as Uint8Array);
        m.documentos.push(JSON.parse(corpo) as Record<string, unknown>);
        return new Response(null, { status: 200 });
      }
      if (url.origin === URL_BASE_SP_API && metodo === 'POST') {
        if (url.pathname === CAMINHO_DOCUMENTOS) {
          m.chamadas.push('POST documento');
          return respostaJson(201, { feedDocumentId: 'doc-preco-1', url: URL_UPLOAD });
        }
        if (url.pathname === CAMINHO_FEEDS) {
          m.chamadas.push('POST feed');
          return respostaJson(m.rotaFeed.status ?? 202, m.rotaFeed.corpo ?? {});
        }
      }
      m.chamadas.push(`fora do roteiro: ${metodo} ${url.pathname}`);
      throw new Error('teste: requisição fora do roteiro');
    }) as typeof globalThis.fetch,
    /** The REAL send of `t`, this world's provider bound. */
    enviar(t: TarefaEnviarFeedAmazon): Promise<ResultadoEnvioFeedAmazon> {
      return enviarFeedAmazon(asDb(fake), t, {
        ambiente: m.ambiente,
        agora: () => m.relogio,
        logger: log.logger,
        increment,
        agendador: () =>
          criarAgendadorLotesAmazon({
            desligado: false,
            fila: (): FilaLotesAmazon => ({
              enqueue: (tarefa, opcoes) => {
                const id = opcoes?.id;
                if (id !== undefined) {
                  if (idsLote.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
                  idsLote.add(id);
                }
                m.tarefasLote.push({
                  tarefa,
                  nome: id ?? null,
                  atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                });
                return Promise.resolve();
              },
            }),
          }),
        provedor: m.provedor,
        registro: { tentativa: 0, idTarefa: 'tarefa-lote-preco' },
        fetch: m.fetch,
        gerarCorrelationId: () => 'corr-lote-preco',
      });
    },
  };
  m.provedor = criarProvedorLotePrecoAmazon(m.raiz());
  return m;
}
type Mundo = ReturnType<typeof mundo>;

/** A ledger entry of batch `k`, covering `partes` parts from `parteInicial`. */
function entradaDoLivro(k: number, parteInicial: number, partes: number, run = EXEC) {
  return {
    execucaoIdLote: loteId(k, run),
    parteInicial,
    partes,
    itens: partes,
    desfecho: null,
    motivoSemEnvio: null,
  };
}

/** The run, `decidindo` with `lotes` batches, unless told. */
function semearRun(
  m: Mundo,
  o: {
    readonly execucaoId?: string;
    readonly fase?: string;
    readonly baixarPreco?: boolean;
    readonly lotes?: Record<string, ReturnType<typeof entradaDoLivro>>;
  } = {},
): void {
  m.fake.seed(
    RUN,
    execucaoPrecoAmazonSchema.parse({
      execucaoId: o.execucaoId ?? EXEC,
      fase: o.fase ?? FASE_EXECUCAO_PRECO_AMAZON.decidindo,
      baixarPreco: o.baixarPreco ?? false,
      solicitadaPor: 'operador-teste',
      iniciadaEmMs: AGORA_MS - 2 * HORA,
      lotes: o.lotes ?? { '0': entradaDoLivro(0, 0, 1) },
    }) as unknown as Record<string, unknown>,
  );
}

async function semearParte(
  m: Mundo,
  n: number,
  itens: readonly ItemDivergenciaPrecoAmazon[],
  execucaoId = EXEC,
): Promise<void> {
  await gravarParteDivergenciaPrecoAmazon(asDb(m.fake), {
    contaId: CONTA,
    execucaoId,
    parte: n,
    itens,
    agoraMs: AGORA_MS - HORA,
  });
}

interface OpcoesErp {
  readonly normal?: number | null;
  readonly promo?: number | null;
  readonly envio?: EnvioPrecoAmazon | null;
  readonly contaRef?: string;
  readonly skuDoLink?: string;
}

/** The ERP side of `sku`: its produto (the price lists) and its link doc. */
function erp(m: Mundo, sku: string, o: OpcoesErp = {}): void {
  const normal = o.normal === undefined ? 60 : o.normal;
  m.fake.seed(`produtos/p-${sku}`, {
    nome: `Produto ${sku}`,
    precos: {
      ...(normal === null ? {} : { [NORMAL]: { valor: normal } }),
      ...(o.promo === undefined || o.promo === null ? {} : { [PROMO]: { valor: o.promo } }),
    },
  });
  m.fake.seed(`produtos/p-${sku}/prodAmazon/l1`, {
    contaAmazonOuterRef: o.contaRef ?? REF_CONTA,
    sku: o.skuDoLink ?? sku,
    productDataJson: { pesado: 'x'.repeat(32) },
    ...(o.envio === undefined || o.envio === null ? {} : { envioPrecoAmazon: o.envio }),
  });
}

/** A stored price outcome of our own patch. */
function envioPatch(
  resultado: EnvioPrecoAmazon['resultado'],
  base: number,
  emMs = AGORA_MS - MIN,
): EnvioPrecoAmazon {
  return {
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs,
    oferta: faixa(base),
    resultado,
    submissionId: resultado === 'incerto' ? null : 'sub-teste-1',
    feedId: null,
    problemas: [],
  };
}

/** Batch `k`'s `feed-enviar`, a range of the run's parts. */
function lote(
  o: {
    readonly k?: number;
    readonly run?: string;
    readonly parteInicial?: number;
    readonly partes?: number;
    readonly esperaAteMs?: number;
  } = {},
): TarefaEnviarFeedAmazon & { readonly fluxo: 'preco' } {
  const run = o.run ?? EXEC;
  const t = tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: 'feed-enviar',
    fluxo: 'preco',
    contaId: CONTA,
    execucaoId: loteId(o.k ?? 0, run),
    origem: 'execucao',
    lote: {
      tipo: 'blocos',
      execucaoIdRun: run,
      parteInicial: o.parteInicial ?? 0,
      partes: o.partes ?? 1,
      esperaAteMs: o.esperaAteMs ?? AGORA_MS + 48 * HORA,
    },
  });
  if (t.fluxo !== FLUXO_FEED_AMAZON.preco) throw new Error('teste: um lote de preço');
  return t as TarefaEnviarFeedAmazon & { readonly fluxo: 'preco' };
}

type LotePreco = TarefaEnviarFeedAmazon & { readonly fluxo: 'preco' };

async function membrosDe(m: Mundo, t: LotePreco) {
  const r = await m.provedor.membros(m.ctx(), t);
  if ('abortado' in r) throw new Error('teste: membros abortou');
  return r;
}

async function montarTudo(m: Mundo, t: LotePreco) {
  const r = await membrosDe(m, t);
  return { membros: r, montagem: await m.provedor.montar(m.ctx(), t, r.skus, r.dados) };
}

function mensagensDe(montagem: Awaited<ReturnType<typeof montarTudo>>['montagem']) {
  if ('abortado' in montagem) throw new Error('teste: montar abortou');
  return montagem.mensagens;
}

function diffDe(montagem: Awaited<ReturnType<typeof montarTudo>>['montagem']) {
  if ('abortado' in montagem) throw new Error('teste: montar abortou');
  return montagem.diff;
}

/** The first offer element a message sends. */
function ofertaEnviada(mensagem: { readonly patches: readonly { readonly value?: unknown }[] }) {
  const [patch] = mensagem.patches;
  const [elemento] = (patch?.value ?? []) as Record<string, unknown>[];
  const preco = (campo: string) =>
    ((elemento?.[campo] as { schedule: { value_with_tax: number }[] }[] | undefined)?.[0]
      ?.schedule[0]?.value_with_tax ?? null) as number | null;
  return {
    base: preco('our_price'),
    minimo: preco('minimum_seller_allowed_price'),
    maximo: preco('maximum_seller_allowed_price'),
  };
}

function lotesDoRun(m: Mundo) {
  return (m.fake.ler(RUN)?.lotes ?? {}) as Record<
    string,
    { desfecho: string | null; motivoSemEnvio: string | null }
  >;
}

function aviso(m: Mundo, caminho = AVISO_FEED) {
  return m.fake.ler(caminho) as { resolvidoEm: unknown; relogioEvento: number } | undefined;
}

/** A Firestore clock the world issues now (a read's `readTime`). */
async function relogioAgora(m: Mundo) {
  const snap = await integracaoCollection.docRef(asDb(m.fake), {}, CONTA).get();
  return snap.readTime;
}

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

/* -------------------------------------------------------------------------- */
/*                                 the factory                                */
/* -------------------------------------------------------------------------- */

describe('the price provider: its fixed members', () => {
  it('its fluxo, its feed-failure aviso, the report’s per-item issues, the price predicate', () => {
    const m = mundo();
    expect(m.provedor.fluxo).toBe('preco');
    expect(m.provedor.motivoFalha).toBe(MOTIVO_CONTA_AMAZON.feedPrecoFalhou);
    expect(m.provedor.relatorio).toEqual({ incluir: ['issues'] });
    const preco = { code: '19037', severity: 'ERROR', categories: ['INVALID_PRICE'] };
    const nome = { code: '90220', severity: 'ERROR', attributeNames: ['item_name'] };
    expect(m.provedor.issueDeItemRelevante?.(preco)).toBe(ehIssuePrecoAmazon(preco));
    expect(m.provedor.issueDeItemRelevante?.(preco)).toBe(true);
    // NEAR-MISS: an issue about another attribute is not a price one.
    expect(m.provedor.issueDeItemRelevante?.(nome)).toBe(false);
  });

  it('★ the ledger’s vocabulary IS the core’s closed end set, member by member', () => {
    expect(Object.values(FIM_SEM_ENVIO_LOTE).sort()).toEqual(
      [...motivoSemEnvioLotePrecoAmazonSchema.options].sort(),
    );
    for (const fim of Object.values(FIM_SEM_ENVIO_LOTE)) {
      expect(MOTIVO_SEM_ENVIO_DO_FIM[fim], fim).toBe(fim);
    }
    // The failing ends: everything that reports a problem, nothing that merely did not send.
    expect([...SEM_ENVIO_QUE_FALHA_PRECO_AMAZON].sort()).toEqual(
      [
        MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.abortado,
        MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.documentoFalhou,
        MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.loteExpirado,
        MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.recusaDefinitiva,
        MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.repasseAbortado,
      ].sort(),
    );
  });

  it('★ binding builds nothing and calls nothing of the root (every producer a thunk)', () => {
    const chamados: string[] = [];
    const recusa = (nome: string) => () => {
      chamados.push(nome);
      throw new Error(`teste: ${nome} chamado no vínculo`);
    };
    criarProvedorLotePrecoAmazon({
      agendadorLotes: recusa('agendadorLotes'),
      produtorEstoque: recusa('produtorEstoque'),
      produtorPreco: recusa('produtorPreco'),
      esperar: recusa('esperar'),
      increment: recusa('increment'),
      gerarExecucaoId: recusa('gerarExecucaoId'),
      ambiente: recusa('ambiente'),
    });
    expect(chamados).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               the effective valve                          */
/* -------------------------------------------------------------------------- */

describe('★ valvulaEfetiva: the preview flag at the send', () => {
  const entrada = (m: Mundo, ambiente: Record<string, string | undefined>) => ({
    ambiente,
    logger: m.log.logger,
    envelope: { conta: CONTA, tentativa: 0, idTarefa: 'tarefa-valvula' },
  });

  it('the flag + on + * ⇒ dry-run, and ONE ERROR line (NEAR-MISS: without the flag the valve is unchanged)', () => {
    const m = mundo();
    const com = { ...m.ambiente, AMAZON_PRECO_SO_VALIDACAO: '1' };
    const lida = lerValvula('preco', com);
    expect(m.provedor.valvulaEfetiva?.(lida, entrada(m, com)).modo).toBe('dry-run');
    expect(m.log.linhas.filter((l) => l.nivel === 'error')).toHaveLength(1);
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({
      evento: 'preco',
      veredito: 'validacao-com-todos',
      modoLido: 'on',
      modo: 'dry-run',
    });
    const sem = lerValvula('preco', m.ambiente);
    expect(m.provedor.valvulaEfetiva?.(sem, entrada(m, m.ambiente))).toBe(sem);
    expect(m.log.linhas).toHaveLength(1);
  });

  it('the flag + on + a LIST ⇒ unchanged (its tasks preview); the flag + off ⇒ off', () => {
    const m = mundo();
    const lista = {
      ...m.ambiente,
      AMAZON_PRECO_SO_VALIDACAO: '1',
      [CANARIO_ENV_AMAZON.preco]: `${CONTA}:SKU-1`,
    };
    const v = lerValvula('preco', lista);
    expect(m.provedor.valvulaEfetiva?.(v, entrada(m, lista))).toEqual(v);
    const desligado = { ...lista, [VALVULA_ENV_AMAZON.preco]: undefined };
    expect(
      m.provedor.valvulaEfetiva?.(lerValvula('preco', desligado), entrada(m, desligado)).modo,
    ).toBe('off');
    expect(m.log.linhas).toEqual([]);
  });

  it('a flag value that is not exactly 1 is OFF (the send is real) and ONE WARNING says so', () => {
    const m = mundo();
    const errado = { ...m.ambiente, AMAZON_PRECO_SO_VALIDACAO: 'true' };
    const v = lerValvula('preco', errado);
    expect(m.provedor.valvulaEfetiva?.(v, entrada(m, errado)).modo).toBe('on');
    expect(m.log.linhas).toHaveLength(1);
    expect(m.log.linhas[0]).toMatchObject({ nivel: 'warn' });
    expect(m.log.linhas[0]?.meta).toMatchObject({ leitura: 'ignorado' });
    expect(JSON.stringify(m.log.linhas)).not.toContain('"true"');
  });
});

/* -------------------------------------------------------------------------- */
/*                                   membros                                  */
/* -------------------------------------------------------------------------- */

describe('★ membros: the run’s bond first, then its parts by id', () => {
  it('the current run (decidindo, or concluida) ⇒ its parts’ SKUs, each with its part', async () => {
    for (const fase of [
      FASE_EXECUCAO_PRECO_AMAZON.decidindo,
      FASE_EXECUCAO_PRECO_AMAZON.concluida,
    ]) {
      const m = mundo();
      semearRun(m, { fase, baixarPreco: true });
      await semearParte(m, 0, [membro('SKU-B'), membro('SKU-A')]);
      await semearParte(m, 1, [membro('SKU-C')]);
      const r = await membrosDe(m, lote({ partes: 2 }));
      expect(r.skus).toEqual(['SKU-A', 'SKU-B', 'SKU-C']);
      expect(r.dados.parada).toBeNull();
      expect(r.dados.baixarPreco).toBe(true);
      expect(r.dados.membros.get('SKU-C')?.parte).toBe(1);
      // By id, masked: never a query of the parts, the run read to its four fields.
      expect(m.fake.consultas.filter((c) => c.colecao.includes('divergencias'))).toEqual([]);
      expect(m.fake.leiturasDetalhadas.find((l) => l.caminho === RUN)?.mascara).toEqual([
        'execucaoId',
        'fase',
        'baixarPreco',
        'lotes',
      ]);
    }
  });

  it('★ stand-down: another run, no run, or a cancelled one ⇒ NO member and no part read (NEAR-MISS: the current run’s batch has its members)', async () => {
    for (const [semente, motivo] of [
      [{ execucaoId: OUTRA_EXEC }, 'execucao-substituida'],
      [null, 'execucao-substituida'],
      [{ fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada }, 'execucao-cancelada'],
      [{ fase: FASE_EXECUCAO_PRECO_AMAZON.paginando }, 'execucao-cancelada'],
    ] as const) {
      const m = mundo();
      if (semente !== null) semearRun(m, { ...semente, baixarPreco: true });
      await semearParte(m, 0, [membro('SKU-A')]);
      const lidasAntes = m.fake.leituras.length;
      const r = await membrosDe(m, lote());
      expect(r.skus, motivo).toEqual([]);
      expect(r.dados.parada, motivo).toBe(motivo);
      expect(r.dados.baixarPreco).toBe(false);
      expect(m.fake.leituras.slice(lidasAntes)).toEqual([RUN]);
      expect(m.log.linhas.at(-1)?.meta).toMatchObject({ fase: 'feed-membros', motivo });
      // …and the build and the hand-off of a stood-down batch do nothing either.
      const montagem = await m.provedor.montar(m.ctx(), lote(), ['SKU-A'], r.dados);
      expect(mensagensDe(montagem)).toEqual([]);
      expect(await m.provedor.repassarParaPatches(m.ctx(), lote(), ['SKU-A'], r.dados)).toEqual({
        tarefas: 0,
      });
      expect(m.tarefasPreco).toEqual([]);
    }
    const atual = mundo();
    semearRun(atual);
    await semearParte(atual, 0, [membro('SKU-A')]);
    expect((await membrosDe(atual, lote())).skus).toEqual(['SKU-A']);
  });

  it('★ a missing part is counted parte-ausente, the rest built; one SKU in two parts is ONE member (the first part wins)', async () => {
    const m = mundo();
    semearRun(m, { lotes: { '0': entradaDoLivro(0, 0, 3) } });
    await semearParte(m, 0, [membro('SKU-A', { faixa: faixa(61) })]);
    await semearParte(m, 2, [membro('SKU-A', { faixa: faixa(99) }), membro('SKU-B')]);
    const r = await membrosDe(m, lote({ partes: 3 }));
    expect(r.skus).toEqual(['SKU-A', 'SKU-B']);
    expect(r.dados.membros.get('SKU-A')).toMatchObject({ parte: 0, item: { faixa: faixa(61) } });
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({ parteAusente: 1, repetidos: 1, membros: 2 });
  });
});

/* -------------------------------------------------------------------------- */
/*                                    montar                                  */
/* -------------------------------------------------------------------------- */

describe('★ montar: the faixa, the links and our own later sends re-read at SEND time', () => {
  it('a tabela edit between the page and the send is in the document (NEAR-MISS: the page-time faixa is never sent)', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A', { faixa: faixa(60) })]);
    erp(m, 'SKU-A', { normal: 70, promo: 65 });
    const [mensagem, ...resto] = mensagensDe((await montarTudo(m, lote())).montagem);
    expect(resto).toEqual([]);
    expect(mensagem?.sku).toBe('SKU-A');
    expect(ofertaEnviada(mensagem ?? { patches: [] })).toEqual({
      base: 70,
      minimo: 65,
      maximo: 70,
    });
  });

  it('★ a member EQUAL to its page-time offer is still sent (Amazon may have moved since the page: a push this run cannot see)', async () => {
    const m = mundo();
    semearRun(m);
    // Page 50 vs ERP 60; the ERP back to 50 before the send: equal to what the page read.
    await semearParte(m, 0, [membro('SKU-A', { oferta: oferta(50), faixa: faixa(60) })]);
    erp(m, 'SKU-A', { normal: 50 });
    const { montagem } = await montarTudo(m, lote());
    expect(mensagensDe(montagem).map(ofertaEnviada)).toEqual([
      { base: 50, minimo: 50, maximo: 50 },
    ]);
    expect(diffDe(montagem)).toMatchObject({ igualAPagina: 1, mensagens: 1, igual: 1 });
  });

  it('★ a decrease against our own later ACCEPTED send (ERP 55, page 50, our 60) without consent ⇒ dropped (NEAR-MISS: the page’s offer alone ⇒ an increase, sent)', async () => {
    const m = mundo();
    semearRun(m, { baixarPreco: false });
    await semearParte(m, 0, [membro('SKU-A', { oferta: oferta(50), faixa: faixa(60) })]);
    erp(m, 'SKU-A', { normal: 55, envio: envioPatch('aceito', 60) });
    const { montagem } = await montarTudo(m, lote());
    expect(mensagensDe(montagem)).toEqual([]);
    expect(diffDe(montagem)).toMatchObject({ 'reducao-sem-consentimento': 1 });

    const n = mundo();
    semearRun(n, { baixarPreco: false });
    await semearParte(n, 0, [membro('SKU-A', { oferta: oferta(50), faixa: faixa(60) })]);
    erp(n, 'SKU-A', { normal: 55 });
    expect(mensagensDe((await montarTudo(n, lote())).montagem).map(ofertaEnviada)).toEqual([
      { base: 55, minimo: 55, maximo: 55 },
    ]);
  });

  it('★ an UNAPPLIED later send is not a reference: an incerto 40 a 4xx left (page 50, ERP 45, no consent) ⇒ dropped (NEAR-MISS: the same entry aceito ⇒ sent as an increase)', async () => {
    for (const [resultado, enviado] of [
      ['incerto', false],
      ['recusado', false],
      ['aceito', true],
      ['aceito-com-avisos', true],
    ] as const) {
      const m = mundo();
      semearRun(m, { baixarPreco: false });
      await semearParte(m, 0, [membro('SKU-A', { oferta: oferta(50), faixa: faixa(60) })]);
      erp(m, 'SKU-A', { normal: 45, envio: envioPatch(resultado, 40) });
      const { montagem } = await montarTudo(m, lote());
      expect(mensagensDe(montagem).length, resultado).toBe(enviado ? 1 : 0);
      if (!enviado) {
        expect(diffDe(montagem), resultado).toMatchObject({ 'reducao-sem-consentimento': 1 });
      }
    }
  });

  it('★ the floor: with consent, a send-time base below the page-time faixa base ⇒ reducao-apos-pagina (NEAR-MISS: at the floor ⇒ sent)', async () => {
    for (const [normal, enviado] of [
      [44.99, false],
      [45, true],
    ] as const) {
      const m = mundo();
      semearRun(m, { baixarPreco: true });
      await semearParte(m, 0, [membro('SKU-A', { oferta: oferta(50), faixa: faixa(45) })]);
      erp(m, 'SKU-A', { normal });
      const { montagem } = await montarTudo(m, lote());
      expect(mensagensDe(montagem).length, String(normal)).toBe(enviado ? 1 : 0);
      if (!enviado) expect(diffDe(montagem)).toMatchObject({ 'reducao-apos-pagina': 1 });
    }
  });

  it('★ link integrity: a link moved to another conta, naming another SKU, or gone ⇒ vinculo-mudou; the rest built', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A'), membro('SKU-B'), membro('SKU-C'), membro('SKU-D')]);
    erp(m, 'SKU-A', { contaRef: 'documents/integracao/outra-conta' });
    erp(m, 'SKU-B', { skuDoLink: 'SKU-OUTRO' });
    erp(m, 'SKU-C');
    m.fake.apagar('produtos/p-SKU-C/prodAmazon/l1');
    erp(m, 'SKU-D', { contaRef: `integracao/${CONTA}` });
    const { montagem } = await montarTudo(m, lote());
    // The bare ref form of THIS conta still binds.
    expect(mensagensDe(montagem).map((x) => x.sku)).toEqual(['SKU-D']);
    expect(diffDe(montagem)).toMatchObject({ 'vinculo-mudou': 3, mensagens: 1 });
  });

  it('a faixa NOW sem-preco or faixa-invertida is dropped; a conta with no normal tabela drops every member', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A'), membro('SKU-B'), membro('SKU-C')]);
    erp(m, 'SKU-A', { normal: null });
    erp(m, 'SKU-B', { normal: 60, promo: 60.01 });
    erp(m, 'SKU-C');
    const { montagem } = await montarTudo(m, lote());
    expect(mensagensDe(montagem).map((x) => x.sku)).toEqual(['SKU-C']);
    expect(diffDe(montagem)).toMatchObject({ 'sem-preco': 1, 'faixa-invertida': 1 });

    const n = mundo();
    n.fake.seed(caminhoConta(CONTA), {
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta sem tabela',
      ativo: true,
      padrao: false,
      selling_partner_id: SPID_A,
      tabelaNormalOuterRef: null,
      tabelaPromocionalOuterRef: null,
    });
    semearRun(n);
    await semearParte(n, 0, [membro('SKU-A'), membro('SKU-B')]);
    erp(n, 'SKU-A');
    erp(n, 'SKU-B');
    const sem = await montarTudo(n, lote());
    expect(mensagensDe(sem.montagem)).toEqual([]);
    expect(diffDe(sem.montagem)).toMatchObject({ 'conta-sem-tabela-normal': 2 });
  });

  it('the message: ONE per member, the offer merge under the part’s stored productType, all three prices and the three selectors', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A', { tipoProduto: 'SHOES' })]);
    erp(m, 'SKU-A', { normal: 80, promo: 70 });
    const [mensagem] = mensagensDe((await montarTudo(m, lote())).montagem);
    expect(mensagem).toMatchObject({ sku: 'SKU-A', productType: 'SHOES' });
    expect(mensagem?.patches).toHaveLength(1);
    expect(mensagem?.patches[0]).toMatchObject({
      op: 'merge',
      path: '/attributes/purchasable_offer',
    });
    expect(mensagem?.patches[0]?.value?.[0]).toMatchObject({
      marketplace_id: 'A2Q3Y263D00KWC',
      currency: 'BRL',
      audience: 'ALL',
    });
    expect(ofertaEnviada(mensagem ?? { patches: [] })).toEqual({
      base: 80,
      minimo: 70,
      maximo: 80,
    });
  });

  it('★ the dry-run diff: counts, closed codes and amostraDesce (the largest decreases first, ≤ 20, WHOLE entries within one log campo), never an issue’s text', async () => {
    const m = mundo();
    semearRun(m, { baixarPreco: true });
    const itens = Array.from({ length: 25 }, (_v, i) =>
      membro(`SKU-${String(i).padStart(2, '0')}`, { oferta: oferta(100), faixa: faixa(1) }),
    );
    await semearParte(m, 0, [...itens, membro('SKU-SOBE')]);
    for (const [i, item] of itens.entries()) erp(m, item.sku, { normal: 99 - i });
    erp(m, 'SKU-SOBE', { normal: 120 });
    const { montagem } = await montarTudo(m, lote());
    const diff = diffDe(montagem);
    expect(diff).toMatchObject({ membros: 26, mensagens: 26, desce: 25, sobe: 1, igualAPagina: 0 });
    const amostra = String(diff.amostraDesce).split(',');
    // The 20 largest are 20 × 13 bytes and 19 commas (279): the 18 that fit the 256-byte campo.
    expect(amostra).toHaveLength(18);
    expect(diff.amostraDesceOmitidas).toBe(2);
    expect(amostra[0]).toBe('SKU-24:100>75');
    expect(amostra.at(-1)).toBe('SKU-07:100>92');
    expect(amostra).not.toContain('SKU-SOBE:100>120');
    // Through the sink, the campo is unchanged: no entry cut in the middle.
    expect(camposSeguros(diff).amostraDesce).toBe(diff.amostraDesce);
    for (const valor of Object.values(diff)) {
      expect(['string', 'number', 'boolean'].includes(typeof valor) || valor === null).toBe(true);
    }
  });

  it('★ masks: the conta to its two refs, each link to the SKU, the conta and the price outcome, each unit to the price masks (nested precos)', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A')]);
    erp(m, 'SKU-A');
    await montarTudo(m, lote());
    const leitura = (caminho: string) =>
      m.fake.leiturasDetalhadas.find((l) => l.caminho === caminho)?.mascara;
    expect(leitura(caminhoConta(CONTA))).toEqual([
      'tabelaNormalOuterRef',
      'tabelaPromocionalOuterRef',
    ]);
    expect(leitura('produtos/p-SKU-A/prodAmazon/l1')).toEqual([
      ...CAMPOS_VINCULO_LOTE_PRECO_AMAZON,
    ]);
    expect(leitura('produtos/p-SKU-A')).toEqual(
      expect.arrayContaining(['paiId', ['precos', NORMAL], ['precos', PROMO]]),
    );
    // NEAR-MISS: the link's product payload never comes back.
    expect(leitura('produtos/p-SKU-A/prodAmazon/l1')).not.toContain('productDataJson');
  });

  it('a variation child priced by its parent’s map under propagation (the shared readers)', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-FILHO')]);
    erp(m, 'SKU-FILHO', { normal: 10 });
    m.fake.seed('produtos/p-SKU-FILHO', {
      nome: 'Filho',
      paiId: 'p-pai',
      precos: { [NORMAL]: { valor: 10 } },
    });
    m.fake.seed('produtos/p-pai', {
      nome: 'Pai',
      propagatePriceToChildren: true,
      precos: { [NORMAL]: { valor: 77 } },
    });
    const [mensagem] = mensagensDe((await montarTudo(m, lote())).montagem);
    expect(ofertaEnviada(mensagem ?? { patches: [] }).base).toBe(77);
  });

  it('a stored outcome far ahead of the clock is set aside (NEAR-MISS: 4 min ahead is a reference)', async () => {
    for (const [adiante, enviado] of [
      [10 * MIN, true],
      [4 * MIN, false],
    ] as const) {
      const m = mundo();
      semearRun(m, { baixarPreco: false });
      await semearParte(m, 0, [membro('SKU-A', { oferta: oferta(50), faixa: faixa(60) })]);
      // A forged accepted send of 70, ahead of our clock: as a reference, 55 would be a decrease.
      erp(m, 'SKU-A', { normal: 55, envio: envioPatch('aceito', 70, AGORA_MS + adiante) });
      const { montagem } = await montarTudo(m, lote());
      expect(mensagensDe(montagem).length, String(adiante)).toBe(enviado ? 1 : 0);
    }
  });

  it('★ the shared 240-s budget: a build past it ⇒ snapshot-lento with feed-preco-falhou, nothing built', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A')]);
    erp(m, 'SKU-A');
    const r = await membrosDe(m, lote());
    m.relogio += ORCAMENTO_MONTAGEM_LOTE_MS;
    expect(await m.provedor.montar(m.ctx(), lote(), r.skus, r.dados)).toEqual({
      abortado: 'snapshot-lento',
      aviso: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
    });
    // NEAR-MISS: a millisecond inside it builds.
    const n = mundo();
    semearRun(n);
    await semearParte(n, 0, [membro('SKU-A')]);
    erp(n, 'SKU-A');
    const s = await membrosDe(n, lote());
    n.relogio += ORCAMENTO_MONTAGEM_LOTE_MS - 1;
    expect(mensagensDe(await n.provedor.montar(n.ctx(), lote(), s.skus, s.dados))).toHaveLength(1);
  });

  it('★ the budget passing DURING the link reads ⇒ snapshot-lento before the units are read, nothing built (NEAR-MISS: the same reads a millisecond inside it build)', async () => {
    for (const [avanco, abortado] of [
      [ORCAMENTO_MONTAGEM_LOTE_MS, true],
      [ORCAMENTO_MONTAGEM_LOTE_MS - 1, false],
    ] as const) {
      const m = mundo();
      semearRun(m);
      await semearParte(m, 0, [membro('SKU-A')]);
      erp(m, 'SKU-A');
      const r = await membrosDe(m, lote());
      const ctx = m.ctx();
      // The clock moves while the members' link docs are read, and only then.
      const lento = new Proxy(ctx.db, {
        get(alvo, chave, receptor) {
          const valor: unknown = Reflect.get(alvo, chave, receptor);
          if (chave !== 'getAll' || typeof valor !== 'function') return valor;
          return async (...args: unknown[]) => {
            const lidos: unknown = await Reflect.apply(valor, alvo, args);
            const [primeiro] = args;
            if (
              primeiro instanceof Object &&
              String(Reflect.get(primeiro, 'path')).includes('/prodAmazon/')
            ) {
              m.relogio += avanco;
            }
            return lidos;
          };
        },
      });
      const montagem = await m.provedor.montar({ ...ctx, db: lento }, lote(), r.skus, r.dados);
      if (abortado) {
        expect(montagem).toEqual({
          abortado: 'snapshot-lento',
          aviso: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
        });
        expect(m.fake.leituras.some((p) => p === 'produtos/p-SKU-A')).toBe(false);
      } else {
        expect(mensagensDe(montagem)).toHaveLength(1);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                               the hand-off                                 */
/* -------------------------------------------------------------------------- */

describe('★ repassarParaPatches: the canary members as the run’s own tasks', () => {
  it('each task: origem execucao, the run as reference, its part, the run’s consent, this clock, no price; named like a run’s task', async () => {
    const m = mundo();
    semearRun(m, { baixarPreco: true, lotes: { '0': entradaDoLivro(0, 3, 2) } });
    await semearParte(m, 3, [membro('SKU-A')]);
    await semearParte(m, 4, [membro('SKU-B')]);
    const r = await membrosDe(m, lote({ parteInicial: 3, partes: 2 }));
    m.relogio += 5 * MIN;
    expect(
      await m.provedor.repassarParaPatches(
        m.ctx(),
        lote({ parteInicial: 3, partes: 2 }),
        ['SKU-A', 'SKU-B'],
        r.dados,
      ),
    ).toEqual({ tarefas: 2 });
    expect(m.tarefasPreco.map((x) => x.tarefa)).toEqual([
      {
        v: 1,
        tipo: 'preco-sku',
        contaId: CONTA,
        sku: 'SKU-A',
        origem: 'execucao',
        referencia: EXEC,
        parte: 3,
        baixarPreco: true,
        solicitadoEmMs: AGORA_MS + 5 * MIN,
        codigosAntes: [],
      },
      expect.objectContaining({ sku: 'SKU-B', parte: 4, referencia: EXEC }),
    ]);
    for (const x of m.tarefasPreco) {
      expect(x.nome).toBe(nomeDaTarefaPrecoAmazon(x.tarefa));
      expect(Object.keys(x.tarefa).some((k) => /preco|faixa|oferta|base/.test(k))).toBe(false);
    }
    // A retried hand-off meets its own names: nothing doubled.
    expect(
      await m.provedor.repassarParaPatches(
        m.ctx(),
        lote({ parteInicial: 3, partes: 2 }),
        ['SKU-A'],
        r.dados,
      ),
    ).toEqual({ tarefas: 1 });
    expect(m.tarefasPreco).toHaveLength(2);
  });

  it('a root with no price producer refuses the hand-off (TypeError), never the binding', async () => {
    const m = mundo();
    m.comProdutorPreco = false;
    const provedor = criarProvedorLotePrecoAmazon(m.raiz());
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A')]);
    const r = await provedor.membros(m.ctx(), lote());
    if ('abortado' in r) throw new Error('teste');
    await expect(provedor.repassarParaPatches(m.ctx(), lote(), ['SKU-A'], r.dados)).rejects.toThrow(
      TypeError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                               gravarResultado                              */
/* -------------------------------------------------------------------------- */

describe('★ gravarResultado: the report’s write-back, via feed', () => {
  async function gravar(
    m: Mundo,
    problemas: ReadonlyMap<string, readonly ProblemaSku[]>,
    issuesDosItens?: ReadonlyMap<string, readonly ProblemaItemSku[]>,
  ) {
    const relogio = await relogioAgora(m);
    await m.provedor.gravarResultado(m.ctx(), {
      problemas,
      ...(issuesDosItens === undefined ? {} : { issuesDosItens }),
      emMs: AGORA_MS - 30 * MIN,
      feedId: FEED,
      relogio,
    });
  }
  const erro19037: ProblemaItemSku = {
    code: '19037',
    message: 'abaixo do mínimo',
    severity: 'ERROR',
    attributeNames: null,
    categories: ['INVALID_PRICE'],
  };
  const erroDoRelatorio: ProblemaSku = {
    code: '90220',
    message: 'campo',
    severity: 'ERROR',
    attributeNames: ['item_name'],
    categories: null,
  };
  const envioDe = (m: Mundo, sku: string) =>
    m.fake.ler(`produtos/p-${sku}/prodAmazon/l1`)?.envioPrecoAmazon as
      | Record<string, unknown>
      | undefined;

  it('★ an item’s price ERROR with no report issue ⇒ aceito-com-avisos + the aviso; a report ERROR ⇒ recusado (no price aviso when it is not about the price)', async () => {
    const m = mundo();
    erp(m, 'SKU-ITEM');
    erp(m, 'SKU-REL');
    await gravar(
      m,
      new Map([['SKU-REL', [erroDoRelatorio]]]),
      new Map([['SKU-ITEM', [erro19037]]]),
    );
    expect(envioDe(m, 'SKU-ITEM')).toMatchObject({
      via: 'feed',
      emMs: AGORA_MS - 30 * MIN,
      oferta: null,
      resultado: 'aceito-com-avisos',
      feedId: FEED,
      submissionId: null,
      problemas: [expect.objectContaining({ code: '19037', categories: ['INVALID_PRICE'] })],
    });
    expect(envioDe(m, 'SKU-REL')).toMatchObject({ resultado: 'recusado' });
    expect(aviso(m, AVISO_RECUSA)).toMatchObject({ resolvidoEm: null });

    const n = mundo();
    erp(n, 'SKU-REL');
    await gravar(n, new Map([['SKU-REL', [erroDoRelatorio]]]), new Map());
    expect(envioDe(n, 'SKU-REL')).toMatchObject({ resultado: 'recusado' });
    expect(aviso(n, AVISO_RECUSA)).toBeUndefined();
  });

  it('only the price field is written: the stock outcome on the same link stays as it was', async () => {
    const m = mundo();
    erp(m, 'SKU-ITEM');
    const estoque = { via: 'feed', emMs: 1, quantidade: null, resultado: 'aceito', feedId: '1' };
    m.fake.seed('produtos/p-SKU-ITEM/prodAmazon/l1', {
      ...(m.fake.ler('produtos/p-SKU-ITEM/prodAmazon/l1') ?? {}),
      envioEstoqueAmazon: estoque,
    });
    await gravar(m, new Map(), new Map([['SKU-ITEM', [erro19037]]]));
    expect(m.fake.ler('produtos/p-SKU-ITEM/prodAmazon/l1')?.envioEstoqueAmazon).toEqual(estoque);
    const escrita = m.fake.escritasEm('produtos/p-SKU-ITEM/prodAmazon/l1').at(-1);
    expect(Object.keys(escrita?.dados ?? {})).toEqual(['envioPrecoAmazon']);
  });

  it('a SKU with no link of the conta is skipped; nothing to write ⇒ nothing read', async () => {
    const m = mundo();
    await gravar(m, new Map([['SKU-SEM-LINK', [erroDoRelatorio]]]), new Map());
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({ semVinculo: 1, gravados: 0 });
    const n = mundo();
    const antes = n.fake.operacoes;
    await gravar(n, new Map(), new Map());
    expect(n.fake.operacoes - antes).toBe(1);
  });

  it('a newer outcome on the link is never replaced by the report (the watermark)', async () => {
    const m = mundo();
    erp(m, 'SKU-ITEM', { envio: envioPatch('aceito', 60, AGORA_MS - MIN) });
    await gravar(m, new Map(), new Map([['SKU-ITEM', [erro19037]]]));
    expect(envioDe(m, 'SKU-ITEM')).toMatchObject({ via: 'patch', resultado: 'aceito' });
    expect(aviso(m, AVISO_RECUSA)).toBeUndefined();
  });

  it('★ an item’s NON-blocking price issue (a WARNING) is written aceito-com-avisos and raises NOTHING (NEAR-MISS: the same issue at ERROR raises the aviso)', async () => {
    const m = mundo();
    erp(m, 'SKU-ITEM');
    await gravar(m, new Map(), new Map([['SKU-ITEM', [{ ...erro19037, severity: 'WARNING' }]]]));
    expect(envioDe(m, 'SKU-ITEM')).toMatchObject({
      resultado: 'aceito-com-avisos',
      problemas: [expect.objectContaining({ code: '19037', severity: 'WARNING' })],
    });
    expect(aviso(m, AVISO_RECUSA)).toBeUndefined();
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({ gravados: 1, comIssueDePreco: 0 });

    const n = mundo();
    erp(n, 'SKU-ITEM');
    await gravar(n, new Map(), new Map([['SKU-ITEM', [erro19037]]]));
    expect(aviso(n, AVISO_RECUSA)).toMatchObject({ resolvidoEm: null });
  });

  it('★ the write-back is BOUNDED as the core bounds it: the report’s own and the items’ SKUs merged, an ERROR first, then SKU order, at most 200 (NEAR-MISS: 200 in all ⇒ every one read)', async () => {
    const skus = (prefixo: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefixo}-${String(i).padStart(3, '0')}`);
    const consultados = (m: Mundo) =>
      new Set(m.fake.consultas.flatMap((c) => c.filtros.map(([, valor]) => valor)));
    const m = mundo();
    await gravar(
      m,
      new Map(skus('SKU-REL', 150).map((s) => [s, [erroDoRelatorio]])),
      new Map(skus('SKU-ITEM', 150).map((s) => [s, [erro19037]])),
    );
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({
      skus: MAX_SKUS_COM_PROBLEMA_GRAVADOS,
      semVinculo: MAX_SKUS_COM_PROBLEMA_GRAVADOS,
    });
    // Every SKU carries an ERROR: SKU order decides, so the items' 150 and the report's first 50.
    const lidosM = consultados(m);
    expect(lidosM.has('SKU-ITEM-149')).toBe(true);
    expect(lidosM.has('SKU-REL-049')).toBe(true);
    expect(lidosM.has('SKU-REL-050')).toBe(false);

    const n = mundo();
    await gravar(
      n,
      new Map(skus('SKU-REL', 100).map((s) => [s, [erroDoRelatorio]])),
      new Map(skus('SKU-ITEM', 100).map((s) => [s, [erro19037]])),
    );
    expect(n.log.linhas.at(-1)?.meta).toMatchObject({ skus: MAX_SKUS_COM_PROBLEMA_GRAVADOS });
    expect(consultados(n).has('SKU-ITEM-099')).toBe(true);
  });

  it('★ the raise is clocked by the LAST link-doc read of a counted refusal, never the record’s older clock: a resolve that landed in between is overtaken', async () => {
    const m = mundo();
    erp(m, 'SKU-ITEM');
    const doRegistro = await relogioAgora(m);
    await sincronizarAvisoContaListingsAmazon(
      asDb(m.fake),
      { increment, nowMs: m.relogio, logger: m.log.logger },
      {
        fluxo: FLUXO_LISTING_AMAZON.preco,
        integracaoId: CONTA,
        motivo: MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon,
        acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.resolver,
        relogio: await relogioAgora(m),
      },
    );
    const resolvido = aviso(m, AVISO_RECUSA);
    expect(resolvido?.resolvidoEm).not.toBeNull();
    await m.provedor.gravarResultado(m.ctx(), {
      problemas: new Map(),
      issuesDosItens: new Map([['SKU-ITEM', [erro19037]]]),
      emMs: AGORA_MS - 30 * MIN,
      feedId: FEED,
      relogio: doRegistro,
    });
    expect(aviso(m, AVISO_RECUSA)).toMatchObject({ resolvidoEm: null });
    expect(aviso(m, AVISO_RECUSA)?.relogioEvento).toBeGreaterThan(
      resolvido?.relogioEvento ?? Infinity,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the ledger                                 */
/* -------------------------------------------------------------------------- */

describe('★ the ledger: every batch’s end on its run, once; a failure re-raised over a clean batch', () => {
  async function resolverAvisoComo(m: Mundo) {
    await sincronizarAvisoContaListingsAmazon(
      asDb(m.fake),
      { increment, nowMs: m.relogio, logger: m.log.logger },
      {
        fluxo: FLUXO_LISTING_AMAZON.preco,
        integracaoId: CONTA,
        motivo: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
        acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.resolver,
        relogio: await relogioAgora(m),
      },
    );
  }
  const recuperacao = (
    desfecho: 'concluido' | 'falhou' | 'incerto' | 'vez',
    referencia = FEED,
  ) => ({
    desfecho,
    snapshotEmMs: desfecho === 'vez' ? null : AGORA_MS - HORA,
    pendenteDesdeMs: desfecho === 'vez' ? AGORA_MS - HORA : null,
    referencia,
    janela: null,
  });
  function semearRegistro(m: Mundo, feedId: string, k: number) {
    m.fake.seed(`feedsAmazon/${idRegistroFeedAmazon(CONTA, feedId)}`, {
      execucaoId: loteId(k),
      fluxo: 'preco',
    });
  }

  it('★ batch 0 FATAL, then batch 1 concluido after the tail resolved: the recovery RE-RAISES, clocked later (NEAR-MISS: no failure recorded ⇒ the aviso stays resolved)', async () => {
    const m = mundo();
    semearRun(m, {
      lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) },
    });
    semearRegistro(m, '50000000001', 0);
    semearRegistro(m, '50000000002', 1);
    expect(await m.provedor.recuperar(m.ctx(), recuperacao('falhou', '50000000001'))).toEqual({
      nada: true,
    });
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: 'falhou', motivoSemEnvio: null });
    await resolverAvisoComo(m);
    const resolvido = aviso(m);
    expect(resolvido?.resolvidoEm).not.toBeNull();
    await m.provedor.recuperar(m.ctx(), recuperacao('concluido', '50000000002'));
    expect(lotesDoRun(m)['1']).toMatchObject({ desfecho: 'concluido' });
    expect(aviso(m)).toMatchObject({ resolvidoEm: null });
    expect(aviso(m)?.relogioEvento).toBeGreaterThan(resolvido?.relogioEvento ?? Infinity);

    const n = mundo();
    semearRun(n, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
    semearRegistro(n, '50000000001', 0);
    semearRegistro(n, '50000000002', 1);
    await n.provedor.recuperar(n.ctx(), recuperacao('concluido', '50000000001'));
    await resolverAvisoComo(n);
    await n.provedor.recuperar(n.ctx(), recuperacao('concluido', '50000000002'));
    expect(aviso(n)?.resolvidoEm).not.toBeNull();
  });

  it('★ send-side failures: batch 0 aborted (or a document failure, a definitive refusal, an expiry) is recorded, and a clean batch 1 re-raises (NEAR-MISS: simulado or sem-escrita are not failures)', async () => {
    for (const [fim, falha] of [
      [FIM_SEM_ENVIO_LOTE.abortado, true],
      [FIM_SEM_ENVIO_LOTE.documentoFalhou, true],
      [FIM_SEM_ENVIO_LOTE.recusaDefinitiva, true],
      [FIM_SEM_ENVIO_LOTE.repasseAbortado, true],
      [FIM_SEM_ENVIO_LOTE.simulado, false],
      [FIM_SEM_ENVIO_LOTE.semEscrita, false],
      [FIM_SEM_ENVIO_LOTE.soPatches, false],
    ] as const) {
      const m = mundo();
      semearRun(m, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
      semearRegistro(m, '50000000002', 1);
      await m.provedor.aoFimSemEnvio?.(m.ctx(), lote({ k: 0 }), fim);
      expect(lotesDoRun(m)['0'], fim).toEqual(
        expect.objectContaining({ desfecho: 'sem-envio', motivoSemEnvio: fim }),
      );
      await resolverAvisoComo(m);
      await m.provedor.recuperar(m.ctx(), recuperacao('concluido', '50000000002'));
      expect(aviso(m)?.resolvidoEm === null, fim).toBe(falha);
    }
  });

  it('★ lote-expirado ⇒ recorded AND feed-preco-falhou raised by the provider (the one end the core raises nothing for)', async () => {
    const m = mundo();
    semearRun(m);
    await m.provedor.aoFimSemEnvio?.(m.ctx(), lote(), FIM_SEM_ENVIO_LOTE.loteExpirado);
    expect(lotesDoRun(m)['0']).toMatchObject({
      desfecho: 'sem-envio',
      motivoSemEnvio: 'lote-expirado',
    });
    expect(aviso(m)).toMatchObject({ resolvidoEm: null });
    // NEAR-MISS: another end without a send records, and raises nothing itself.
    const n = mundo();
    semearRun(n);
    await n.provedor.aoFimSemEnvio?.(n.ctx(), lote(), FIM_SEM_ENVIO_LOTE.simulado);
    expect(lotesDoRun(n)['0']).toMatchObject({ desfecho: 'sem-envio' });
    expect(aviso(n)).toBeUndefined();
  });

  it('★ once: a recorded end is never replaced (a retried recovery or hook writes nothing twice)', async () => {
    const m = mundo();
    semearRun(m);
    semearRegistro(m, FEED, 0);
    await m.provedor.recuperar(m.ctx(), recuperacao('falhou'));
    const escritas = m.fake.escritasEm(RUN).length;
    await m.provedor.recuperar(m.ctx(), recuperacao('falhou'));
    await m.provedor.aoFimSemEnvio?.(m.ctx(), lote(), FIM_SEM_ENVIO_LOTE.simulado);
    expect(m.fake.escritasEm(RUN)).toHaveLength(escritas);
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: 'falhou', motivoSemEnvio: null });
  });

  it('★ only the CURRENT run: a batch of an older run ⇒ { nada: true }, the run untouched', async () => {
    const m = mundo();
    semearRun(m, { execucaoId: OUTRA_EXEC, lotes: { '0': entradaDoLivro(0, 0, 1, OUTRA_EXEC) } });
    semearRegistro(m, FEED, 0);
    const antes = m.fake.escritasEm(RUN).length;
    expect(await m.provedor.recuperar(m.ctx(), recuperacao('concluido'))).toEqual({ nada: true });
    await m.provedor.aoFimSemEnvio?.(m.ctx(), lote(), FIM_SEM_ENVIO_LOTE.loteExpirado);
    expect(m.fake.escritasEm(RUN)).toHaveLength(antes);
    expect(aviso(m)).toBeUndefined();
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({ livro: 'outra-execucao', levantado: false });
  });

  it('the uncertain path’s recovery names the batch itself (no feed record read); a vez recovery does nothing', async () => {
    const m = mundo();
    semearRun(m);
    await m.provedor.recuperar(m.ctx(), recuperacao('incerto', loteId(0)));
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: 'incerto' });
    expect(m.fake.leituras.some((p) => p.startsWith('feedsAmazon/'))).toBe(false);
    const antes = m.fake.operacoes;
    expect(await m.provedor.recuperar(m.ctx(), recuperacao('vez', 'vez:x'))).toEqual({
      nada: true,
    });
    expect(m.fake.operacoes).toBe(antes);
  });

  it('★ a recovery never re-sends: no enqueue of any kind, whatever the end', async () => {
    const m = mundo();
    semearRun(m);
    semearRegistro(m, FEED, 0);
    for (const desfecho of ['falhou', 'concluido'] as const) {
      expect(await m.provedor.recuperar(m.ctx(), recuperacao(desfecho))).toEqual({ nada: true });
    }
    expect(m.tarefasPreco).toEqual([]);
    expect(m.tarefasLote).toEqual([]);
  });

  it('★ a ledger write that kept losing its precondition is ONE WARNING, never a throw (rule 7 tier 1: re-read and re-decided)', async () => {
    const m = mundo();
    semearRun(m);
    // Every write attempt meets a concurrent writer first.
    for (let i = 0; i < 3; i += 1) {
      m.fake.antesDaProximaEscrita(RUN, () => {
        m.fake.seed(RUN, { ...(m.fake.ler(RUN) ?? {}) });
      });
    }
    await expect(
      m.provedor.aoFimSemEnvio?.(m.ctx(), lote(), FIM_SEM_ENVIO_LOTE.simulado),
    ).resolves.toBeUndefined();
    expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({ livro: 'em-conflito' });
    // NEAR-MISS: one lost precondition re-reads and records.
    const n = mundo();
    semearRun(n);
    n.fake.antesDaProximaEscrita(RUN, () => {
      n.fake.seed(RUN, { ...(n.fake.ler(RUN) ?? {}) });
    });
    await n.provedor.aoFimSemEnvio?.(n.ctx(), lote(), FIM_SEM_ENVIO_LOTE.simulado);
    expect(lotesDoRun(n)['0']).toMatchObject({ desfecho: 'sem-envio' });
  });

  it('★ the re-raise follows a CLEAN end only: a second FAILED batch raises nothing itself, its own tail did (NEAR-MISS: the same batch concluido re-raises)', async () => {
    for (const [desfecho, levantado] of [
      ['falhou', false],
      ['concluido', true],
    ] as const) {
      const m = mundo();
      semearRun(m, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
      semearRegistro(m, '50000000001', 0);
      semearRegistro(m, '50000000002', 1);
      await m.provedor.recuperar(m.ctx(), recuperacao('falhou', '50000000001'));
      await m.provedor.recuperar(m.ctx(), recuperacao(desfecho, '50000000002'));
      expect(m.log.linhas.at(-1)?.meta, desfecho).toMatchObject({ livro: 'registrado', levantado });
      expect(aviso(m) !== undefined, desfecho).toBe(levantado);
    }
  });

  it('★ a batch’s OWN recorded failure never re-raises over its later clean end (an uncertain batch whose feed is then adopted concluido) (NEAR-MISS: ANOTHER batch uncertain ⇒ re-raised)', async () => {
    const m = mundo();
    semearRun(m, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
    semearRegistro(m, '50000000001', 0);
    await m.provedor.recuperar(m.ctx(), recuperacao('incerto', loteId(0)));
    await m.provedor.recuperar(m.ctx(), recuperacao('concluido', '50000000001'));
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: 'incerto' });
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({ livro: 'ja-registrado', levantado: false });
    expect(aviso(m)).toBeUndefined();

    const n = mundo();
    semearRun(n, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
    semearRegistro(n, '50000000001', 0);
    await n.provedor.recuperar(n.ctx(), recuperacao('incerto', loteId(1)));
    await n.provedor.recuperar(n.ctx(), recuperacao('concluido', '50000000001'));
    expect(n.log.linhas.at(-1)?.meta).toMatchObject({ livro: 'registrado', levantado: true });
    expect(aviso(n)).toMatchObject({ resolvidoEm: null });
  });
});

/* -------------------------------------------------------------------------- */
/*                        end to end, through the send                        */
/* -------------------------------------------------------------------------- */

describe('★ through the REAL send: the binding, the preview flag, the report header, the ledger', () => {
  async function pronto(m: Mundo, skus = ['SKU-A', 'SKU-B']) {
    semearRun(m);
    await semearParte(
      m,
      0,
      skus.map((s) => membro(s)),
    );
    for (const s of skus) erp(m, s);
  }

  it('★ on + *: ONE submission; the header asks the report for each item’s issues; the batch’s end is the feed’s (no hook)', async () => {
    const m = mundo();
    await pronto(m);
    const r = await m.enviar(lote());
    expect(r).toMatchObject({ acao: 'enviado', fluxo: 'preco', fimSemEnvio: null, modoLido: null });
    expect(m.chamadas).toEqual(['POST documento', 'PUT upload', 'POST feed']);
    expect(m.documentos[0]?.header).toMatchObject({
      sellerId: SPID_A,
      report: { includedData: ['issues'], apiVersion: '2021-08-01' },
    });
    expect((m.documentos[0]?.messages as unknown[]).length).toBe(2);
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: null });
  });

  it('★ the preview flag + on + * ⇒ simulado, ZERO createFeedDocument/createFeed; the valve line effective dry-run, the dispatch line the raw on (NEAR-MISS: without the flag it submits)', async () => {
    const m = mundo();
    await pronto(m);
    m.ambiente = { ...m.ambiente, AMAZON_PRECO_SO_VALIDACAO: '1' };
    const r = await m.enviar(lote());
    expect(r).toMatchObject({ acao: 'liberado', motivo: 'simulado', modoLido: 'on' });
    expect(m.chamadas).toEqual([]);
    const valvula = m.log.linhas.find((l) => l.meta?.evento === 'valvula');
    expect(valvula?.meta).toMatchObject({ modo: 'dry-run', fluxo: 'preco' });
    expect(m.log.linhas.find((l) => l.meta?.fase === 'envio')?.meta).toMatchObject({
      modoLido: 'on',
    });
    expect(m.log.linhas.some((l) => l.meta?.veredito === 'validacao-com-todos')).toBe(true);
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: 'sem-envio', motivoSemEnvio: 'simulado' });
    expect(m.fake.ler(VEZ)).toMatchObject({ estado: 'livre' });

    const n = mundo();
    await pronto(n);
    expect((await n.enviar(lote())).acao).toBe('enviado');
  });

  it('★ the flag + on + a LIST ⇒ so-patches: the canary’s members as price tasks, nothing posted', async () => {
    const m = mundo();
    await pronto(m);
    m.ambiente = {
      ...m.ambiente,
      AMAZON_PRECO_SO_VALIDACAO: '1',
      [CANARIO_ENV_AMAZON.preco]: `${CONTA}:SKU-B`,
    };
    const r = await m.enviar(lote());
    expect(r).toMatchObject({ motivo: 'so-patches', tarefas: 1, fimSemEnvio: 'so-patches' });
    expect(m.chamadas).toEqual([]);
    expect(m.tarefasPreco.map((x) => x.tarefa)).toEqual([
      expect.objectContaining({ sku: 'SKU-B', origem: 'execucao', referencia: EXEC, parte: 0 }),
    ]);
    expect(lotesDoRun(m)['0']).toMatchObject({ motivoSemEnvio: 'so-patches' });
  });

  it('★ stand-down: a superseded or cancelled run’s batch ⇒ no member, ZERO createFeedDocument (NEAR-MISS: the current run’s batch builds and submits)', async () => {
    for (const semente of [{ execucaoId: OUTRA_EXEC }, { fase: 'cancelada' }]) {
      const m = mundo();
      semearRun(m, semente);
      await semearParte(m, 0, [membro('SKU-A')]);
      erp(m, 'SKU-A');
      const r = await m.enviar(lote());
      expect(r).toMatchObject({ acao: 'liberado', motivo: 'sem-escrita', membros: 0 });
      expect(m.chamadas).toEqual([]);
    }
  });

  it('★ every batch is named at Decide: under dry-run K = 3 all build and log, the lease released after each; batch 0 sem-escrita does not stop batch 1', async () => {
    const m = mundo();
    m.ambiente = { ...m.ambiente, [VALVULA_ENV_AMAZON.preco]: 'dry-run' };
    semearRun(m, {
      lotes: {
        '0': entradaDoLivro(0, 0, 1),
        '1': entradaDoLivro(1, 1, 1),
        '2': entradaDoLivro(2, 2, 1),
      },
    });
    for (const n of [0, 1, 2]) {
      await semearParte(m, n, [membro(`SKU-${String(n)}`)]);
      erp(m, `SKU-${String(n)}`);
    }
    for (const k of [0, 1, 2]) {
      const r = await m.enviar(lote({ k, parteInicial: k }));
      expect(r, String(k)).toMatchObject({ motivo: 'simulado', mensagens: 1 });
      expect(m.fake.ler(VEZ)).toMatchObject({ estado: 'livre' });
    }
    expect(m.chamadas).toEqual([]);
    expect(Object.values(lotesDoRun(m)).map((l) => l.motivoSemEnvio)).toEqual([
      'simulado',
      'simulado',
      'simulado',
    ]);

    // Under `on` + `*`: batch 0 converged to nothing, batch 1 still submits.
    const s = mundo();
    semearRun(s, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
    await semearParte(s, 0, [membro('SKU-0')]);
    await semearParte(s, 1, [membro('SKU-1')]);
    erp(s, 'SKU-0', { normal: null });
    erp(s, 'SKU-1');
    expect(await s.enviar(lote({ k: 0 }))).toMatchObject({ motivo: 'sem-escrita' });
    expect(await s.enviar(lote({ k: 1, parteInicial: 1 }))).toMatchObject({ acao: 'enviado' });
  });

  it('★ under *, the batches serialise through the lease: batch 1 waits while batch 0 holds it, then (300 s after batch 0’s submission) takes it', async () => {
    const m = mundo();
    semearRun(m, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
    await semearParte(m, 0, [membro('SKU-0')]);
    await semearParte(m, 1, [membro('SKU-1')]);
    erp(m, 'SKU-0');
    erp(m, 'SKU-1');
    expect((await m.enviar(lote({ k: 0 }))).acao).toBe('enviado');
    expect(await m.enviar(lote({ k: 1, parteInicial: 1 }))).toMatchObject({
      acao: 'aguardando',
      tomada: 'ocupada',
    });
    // Batch 0's feed ends (its lease released); batch 1 is held to the PRICE floor.
    m.fake.seed(VEZ, {
      ...(m.fake.ler(VEZ) ?? {}),
      estado: 'livre',
      feedId: null,
      execucaoId: null,
      ateMs: 0,
    });
    m.relogio = AGORA_MS + 299_000;
    expect(await m.enviar(lote({ k: 1, parteInicial: 1 }))).toMatchObject({
      acao: 'aguardando',
      tomada: 'aguardar-espaco',
      atrasoS: 1,
    });
    m.relogio = AGORA_MS + 300_000;
    expect((await m.enviar(lote({ k: 1, parteInicial: 1 }))).acao).toBe('enviado');
  });

  it('★ the wait: a batch at esperaAteMs − 1 s waits; at esperaAteMs it ends lote-expirado, recorded on the run, feed-preco-falhou raised', async () => {
    const m = mundo();
    semearRun(m, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
    await semearParte(m, 0, [membro('SKU-0')]);
    await semearParte(m, 1, [membro('SKU-1')]);
    erp(m, 'SKU-0');
    erp(m, 'SKU-1');
    expect((await m.enviar(lote({ k: 0 }))).acao).toBe('enviado');
    const espera = AGORA_MS + 2 * HORA;
    m.relogio = espera - 1_000;
    expect(await m.enviar(lote({ k: 1, parteInicial: 1, esperaAteMs: espera }))).toMatchObject({
      acao: 'aguardando',
    });
    expect(lotesDoRun(m)['1']).toMatchObject({ desfecho: null });
    m.relogio = espera;
    expect(await m.enviar(lote({ k: 1, parteInicial: 1, esperaAteMs: espera }))).toMatchObject({
      acao: 'lote-expirado',
      fimSemEnvio: 'lote-expirado',
    });
    expect(lotesDoRun(m)['1']).toMatchObject({
      desfecho: 'sem-envio',
      motivoSemEnvio: 'lote-expirado',
    });
    expect(aviso(m)).toMatchObject({ resolvidoEm: null });
  });

  it('★ the hook’s write failing transiently ⇒ ledgerFalhou logged, the dispatch NOT rethrown (no second createFeed)', async () => {
    const m = mundo();
    await pronto(m);
    m.rotaFeed = { status: 400, corpo: { errors: [{ code: 'InvalidInput', message: 'x' }] } };
    m.fake.falharLeitura(RUN, grpc(14, 'indisponível'));
    // `membros` reads the run first: let that one read through, then fail the ledger's.
    const original = m.provedor.membros.bind(m.provedor);
    m.provedor = {
      ...m.provedor,
      membros: async (ctx, entrada) => {
        m.fake.falharLeitura(RUN, null);
        const r = await original(ctx, entrada);
        m.fake.falharLeitura(RUN, grpc(14, 'indisponível'));
        return r;
      },
    };
    const r = await m.enviar(lote());
    expect(r).toMatchObject({
      motivo: 'recusa-definitiva',
      fimSemEnvio: 'recusa-definitiva',
      ledgerFalhou: true,
    });
    expect(m.chamadas.filter((c) => c === 'POST feed')).toHaveLength(1);
    expect(m.log.linhas.find((l) => l.meta?.fase === 'envio')).toMatchObject({ nivel: 'warn' });
  });

  it('★ a pre-context end calls nothing: the valve off, or the read switch off ⇒ the run untouched, desfecho null', async () => {
    for (const ambiente of [
      { [VALVULA_ENV_AMAZON.preco]: undefined },
      { AMAZON_CHAMADAS: undefined },
    ]) {
      const m = mundo();
      await pronto(m);
      m.ambiente = { ...m.ambiente, ...ambiente };
      const antes = m.fake.escritasEm(RUN).length;
      const r = await m.enviar(lote());
      expect(r.fimSemEnvio).toBeNull();
      expect(m.fake.escritasEm(RUN)).toHaveLength(antes);
      expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: null });
    }
  });

  it('★ the limit wait: a price createFeed 429 re-enqueues after 300 s, nothing recorded (the batch is not over)', async () => {
    const m = mundo();
    await pronto(m);
    m.rotaFeed = { status: 429, corpo: { errors: [{ code: 'QuotaExceeded', message: 'x' }] } };
    const r = await m.enviar(lote());
    expect(r).toMatchObject({ acao: 'limitado', atrasoS: 300, fimSemEnvio: null });
    expect(
      m.tarefasLote.filter((x) => x.tarefa.tipo === 'feed-enviar').map((x) => x.atrasoS),
    ).toEqual([300]);
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: null });
  });

  it('a document the package refuses deterministically ⇒ documento-falhou recorded, nothing posted', async () => {
    const m = mundo();
    await pronto(m, ['SKU-A']);
    // A message the package refuses: a product type outside its grammar.
    m.provedor = {
      ...m.provedor,
      montar: async (ctx, entrada, on, dados) => {
        const r = await criarProvedorLotePrecoAmazon(m.raiz()).montar(ctx, entrada, on, dados);
        if ('abortado' in r) return r;
        return { ...r, mensagens: r.mensagens.map((x) => ({ ...x, productType: 'invalido' })) };
      },
    };
    const r = await m.enviar(lote());
    expect(r).toMatchObject({ motivo: 'documento-falhou', fimSemEnvio: 'documento-falhou' });
    expect(lotesDoRun(m)['0']).toMatchObject({ motivoSemEnvio: 'documento-falhou' });
    expect(m.chamadas).toEqual([]);
  });

  it('the dry-run’s own line carries the provider’s diff (counts and the sample), nothing posted', async () => {
    const m = mundo();
    m.ambiente = { ...m.ambiente, [VALVULA_ENV_AMAZON.preco]: 'dry-run' };
    await pronto(m, ['SKU-A']);
    await m.enviar(lote());
    const simulacao = m.log.linhas.find(
      (l) => l.meta?.evento === 'preco' && l.meta.fase === 'feed' && l.meta.membros !== undefined,
    );
    expect(simulacao?.meta).toMatchObject({ mensagens: 1, sobe: 1, desce: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the types                                  */
/* -------------------------------------------------------------------------- */

describe('the provider’s build data', () => {
  it('a member keeps its part and its stored item; the data is opaque to the core', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A')]);
    const r = await membrosDe(m, lote());
    const dados: DadosLotePrecoAmazon = r.dados;
    expect(dados.membros.get('SKU-A')?.item).toEqual(membro('SKU-A'));
    expect(DESFECHO_LOTE_PRECO_AMAZON.semEnvio).toBe('sem-envio');
    const fins: readonly FimSemEnvioLote[] = Object.values(FIM_SEM_ENVIO_LOTE);
    expect(fins).toHaveLength(9);
  });
});

describe('★ the expiry’s raise: only when the expiry is THE end on record', () => {
  it('a retried expiry hook (the expiry already recorded) raises again; an expiry told over ANOTHER recorded end raises nothing', async () => {
    const m = mundo();
    semearRun(m);
    await m.provedor.aoFimSemEnvio?.(m.ctx(), lote(), FIM_SEM_ENVIO_LOTE.loteExpirado);
    m.fake.apagar(AVISO_FEED);
    await m.provedor.aoFimSemEnvio?.(m.ctx(), lote(), FIM_SEM_ENVIO_LOTE.loteExpirado);
    expect(aviso(m)).toMatchObject({ resolvidoEm: null });
    expect(m.log.linhas.at(-1)?.meta).toMatchObject({ livro: 'ja-registrado', levantado: true });

    const n = mundo();
    semearRun(n);
    await n.provedor.aoFimSemEnvio?.(n.ctx(), lote(), FIM_SEM_ENVIO_LOTE.simulado);
    await n.provedor.aoFimSemEnvio?.(n.ctx(), lote(), FIM_SEM_ENVIO_LOTE.loteExpirado);
    expect(aviso(n)).toBeUndefined();
    expect(lotesDoRun(n)['0']).toMatchObject({ motivoSemEnvio: 'simulado' });
  });
});

/* -------------------------------------------------------------------------- */
/*                 Decide names the batches, the send builds them              */
/* -------------------------------------------------------------------------- */

describe('★ every batch is named at Decide: the run’s REAL Decide names them, the REAL send builds each', () => {
  /**
   * The run `decidindo` with `n` parts of one SKU each (`SKU-D-<n>`, each an
   * increase 50 → 60 unless `semPreco` names it), and its ERP side.
   */
  async function decidindo(
    m: Mundo,
    n: number,
    o: { readonly semPreco?: (i: number) => boolean } = {},
  ): Promise<TarefaPaginaPrecoAmazon> {
    for (let i = 0; i < n; i += 1) {
      await semearParte(m, i, [membro(`SKU-D-${String(i)}`)]);
      erp(m, `SKU-D-${String(i)}`, o.semPreco?.(i) === true ? { normal: null } : {});
    }
    m.fake.seed(
      RUN,
      execucaoPrecoAmazonSchema.parse({
        execucaoId: EXEC,
        fase: FASE_EXECUCAO_PRECO_AMAZON.decidindo,
        baixarPreco: false,
        solicitadaPor: 'operador-teste',
        proximaPagina: 7,
        proximaParte: n,
        itensPorParte: Array.from({ length: n }, () => 1),
        contagens: { enviaveis: n, sobe: n },
        iniciadaEmMs: AGORA_MS - 2 * HORA,
        progressoEmMs: AGORA_MS - HORA,
      }) as unknown as Record<string, unknown>,
    );
    return { v: 1, tipo: 'preco-pagina', contaId: CONTA, execucaoId: EXEC, pagina: 7 };
  }

  /** Decide, in this world: the run's page dispatch, its batches onto a recording jobs queue. */
  async function decidir(m: Mundo, t: TarefaPaginaPrecoAmazon): Promise<LotePreco[]> {
    const nomes = new Set<string>();
    const r = await paginaPrecoAmazon(asDb(m.fake), t, {
      ambiente: m.ambiente,
      agora: () => m.relogio,
      logger: m.log.logger,
      increment,
      registro: { tentativa: 0, idTarefa: 'tarefa-decide-preco' },
      fetch: m.fetch,
      gerarCorrelationId: () => 'corr-decide-preco',
      carregarContexto: loadAmazonContext,
      produtorPaginas: () => {
        throw new Error('teste: um Decide não enfileira página');
      },
      produtorPreco: () => {
        const produtor = m.raiz().produtorPreco;
        if (produtor === undefined) throw new Error('teste: sem produtor de preço');
        return produtor();
      },
      agendadorLotes: () =>
        criarAgendadorLotesAmazon({
          desligado: false,
          fila: (): FilaLotesAmazon => ({
            enqueue: (tarefa, opcoes) => {
              const id = opcoes?.id;
              if (id !== undefined && nomes.has(id)) {
                return Promise.reject(falhaDeTarefaJaExistente(id));
              }
              if (id !== undefined) nomes.add(id);
              m.tarefasLote.push({
                tarefa,
                nome: id ?? null,
                atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
              });
              return Promise.resolve();
            },
          }),
        }),
      soValidacao: false,
      esperar: () => Promise.reject(new Error('teste: um Decide não espera')),
    });
    expect(r.acao).toBe('concluida');
    const lotes = m.tarefasLote
      .map((x) => x.tarefa)
      .filter(
        (x): x is LotePreco => x.tipo === 'feed-enviar' && x.fluxo === FLUXO_FEED_AMAZON.preco,
      );
    m.tarefasLote.length = 0;
    return lotes;
  }

  it('★ under dry-run, K = 3 (101 parts): Decide names THREE batches at once; each builds and logs, nothing is posted, and the lease is released after each', async () => {
    const m = mundo();
    m.ambiente = { ...m.ambiente, [VALVULA_ENV_AMAZON.preco]: 'dry-run' };
    const lotes = await decidir(m, await decidindo(m, 101));
    expect(lotes.map((x) => [x.execucaoId, x.lote])).toEqual([
      [loteId(0), expect.objectContaining({ parteInicial: 0, partes: 50 })],
      [loteId(1), expect.objectContaining({ parteInicial: 50, partes: 50 })],
      [loteId(2), expect.objectContaining({ parteInicial: 100, partes: 1 })],
    ]);
    const mensagens: unknown[] = [];
    for (const t of lotes) {
      const r = await m.enviar(t);
      expect(r, t.execucaoId).toMatchObject({ acao: 'liberado', motivo: 'simulado' });
      mensagens.push((r as { mensagens?: unknown }).mensagens);
      expect(m.fake.ler(VEZ)).toMatchObject({ estado: 'livre' });
    }
    expect(mensagens).toEqual([50, 50, 1]);
    // Each batch's dry-run wrote its document's size.
    const simulacoes = m.log.linhas.filter(
      (l) => l.meta?.fase === 'feed' && typeof l.meta.bytes === 'number',
    );
    expect(simulacoes.length).toBeGreaterThanOrEqual(3);
    expect(m.chamadas).toEqual([]);
    expect(Object.values(lotesDoRun(m)).map((l) => [l.desfecho, l.motivoSemEnvio])).toEqual([
      ['sem-envio', 'simulado'],
      ['sem-envio', 'simulado'],
      ['sem-envio', 'simulado'],
    ]);
  });

  it('★ under a canary LIST: Decide hands the canary’s hits of ALL parts to tasks (parte 0 and 100), and names NO batch', async () => {
    const m = mundo();
    m.ambiente = {
      ...m.ambiente,
      [CANARIO_ENV_AMAZON.preco]: `${CONTA}:SKU-D-0,${CONTA}:SKU-D-100`,
    };
    const lotes = await decidir(m, await decidindo(m, 101));
    expect(lotes).toEqual([]);
    expect(m.tarefasPreco.map((x) => [x.tarefa.sku, x.tarefa.parte])).toEqual([
      ['SKU-D-0', 0],
      ['SKU-D-100', 100],
    ]);
    expect(m.fake.ler(RUN)).toMatchObject({ decisao: 'canario', lotes: {} });
  });

  it('★ under *: three named batches serialise through the lease — batch 0 submits, batch 1 and batch 2 wait while it holds', async () => {
    const m = mundo();
    const lotes = await decidir(m, await decidindo(m, 101));
    expect(lotes).toHaveLength(3);
    expect((await m.enviar(lotes[0] as LotePreco)).acao).toBe('enviado');
    for (const t of lotes.slice(1)) {
      expect(await m.enviar(t), t.execucaoId).toMatchObject({
        acao: 'aguardando',
        tomada: 'ocupada',
      });
    }
    expect(m.chamadas.filter((c) => c === 'POST feed')).toHaveLength(1);
  });

  it('★ NEAR-MISS against a chain: batch 0 ending sem-escrita (every member dropped) does not stop batch 1, which submits', async () => {
    const m = mundo();
    const lotes = await decidir(m, await decidindo(m, 51, { semPreco: (i) => i < 50 }));
    expect(lotes.map((x) => (x.lote.tipo === 'blocos' ? x.lote.partes : null))).toEqual([50, 1]);
    expect(await m.enviar(lotes[0] as LotePreco)).toMatchObject({
      acao: 'liberado',
      motivo: 'sem-escrita',
    });
    expect(await m.enviar(lotes[1] as LotePreco)).toMatchObject({ acao: 'enviado' });
    expect(Object.values(lotesDoRun(m)).map((l) => l.motivoSemEnvio)).toEqual([
      'sem-escrita',
      null,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 an ended batch, the ledger's other orders                  */
/* -------------------------------------------------------------------------- */

describe('★ an ended batch never sends again; the ledger in every order', () => {
  type DesfechoRecuperacao = 'concluido' | 'falhou' | 'cancelado' | 'abandonado' | 'incerto';
  const recuperacao = (desfecho: DesfechoRecuperacao | 'vez', referencia = FEED) => ({
    desfecho,
    snapshotEmMs: desfecho === 'vez' ? null : AGORA_MS - HORA,
    pendenteDesdeMs: desfecho === 'vez' ? AGORA_MS - HORA : null,
    referencia,
    janela: null,
  });
  function semearRegistro(m: Mundo, feedId: string, k: number) {
    m.fake.seed(`feedsAmazon/${idRegistroFeedAmazon(CONTA, feedId)}`, {
      execucaoId: loteId(k),
      fluxo: 'preco',
    });
  }
  /** A ledger entry whose end is already recorded (the schema holds the pair). */
  function encerrada(
    k: number,
    desfecho: string,
    motivoSemEnvio: string | null = null,
  ): ReturnType<typeof entradaDoLivro> {
    return { ...entradaDoLivro(k, k, 1), desfecho, motivoSemEnvio } as unknown as ReturnType<
      typeof entradaDoLivro
    >;
  }
  async function resolverAviso(m: Mundo) {
    await sincronizarAvisoContaListingsAmazon(
      asDb(m.fake),
      { increment, nowMs: m.relogio, logger: m.log.logger },
      {
        fluxo: FLUXO_LISTING_AMAZON.preco,
        integracaoId: CONTA,
        motivo: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
        acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.resolver,
        relogio: await relogioAgora(m),
      },
    );
    expect(aviso(m)?.resolvidoEm).not.toBeNull();
  }

  it('★ membros: a batch whose end the ledger holds, or that the ledger never named ⇒ lote-encerrado, NO member, no part read (NEAR-MISS: desfecho null ⇒ its members)', async () => {
    const casos: [string, Record<string, ReturnType<typeof entradaDoLivro>>][] = [
      ['falhou', { '0': encerrada(0, 'falhou') }],
      ['concluido', { '0': encerrada(0, 'concluido') }],
      ['simulado', { '0': encerrada(0, 'sem-envio', 'simulado') }],
      ['not named', { '0': entradaDoLivro(0, 5, 1, OUTRA_EXEC) }],
    ];
    for (const [caso, lotes] of casos) {
      const m = mundo();
      semearRun(m, { lotes });
      await semearParte(m, 0, [membro('SKU-A')]);
      const lidasAntes = m.fake.leituras.length;
      const r = await membrosDe(m, lote());
      expect(r.skus, caso).toEqual([]);
      expect(r.dados.parada, caso).toBe(LOTE_ENCERRADO_PRECO_AMAZON);
      expect(m.fake.leituras.slice(lidasAntes), caso).toEqual([RUN]);
      expect(m.log.linhas.at(-1)?.meta, caso).toMatchObject({ motivo: 'lote-encerrado' });
      expect(diffDe((await montarTudo(m, lote())).montagem), caso).toMatchObject({
        parada: 'lote-encerrado',
        mensagens: 0,
      });
    }
    const n = mundo();
    semearRun(n);
    await semearParte(n, 0, [membro('SKU-A')]);
    expect((await membrosDe(n, lote())).skus).toEqual(['SKU-A']);
  });

  it('★ through the REAL send: a batch that ended simulado, dispatched again once the valve is on + *, builds and posts NOTHING; its end on record unchanged (NEAR-MISS: a batch with no end recorded submits)', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A')]);
    erp(m, 'SKU-A');
    m.ambiente = { ...m.ambiente, [VALVULA_ENV_AMAZON.preco]: 'dry-run' };
    expect(await m.enviar(lote())).toMatchObject({ motivo: 'simulado' });
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: 'sem-envio', motivoSemEnvio: 'simulado' });
    // The same batch again (a duplicate delivery, or a decision step run again), now on + *.
    m.ambiente = { ...m.ambiente, [VALVULA_ENV_AMAZON.preco]: 'on' };
    m.relogio += HORA;
    expect(await m.enviar(lote())).toMatchObject({ acao: 'liberado', motivo: 'sem-escrita' });
    expect(m.chamadas).toEqual([]);
    expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: 'sem-envio', motivoSemEnvio: 'simulado' });

    const f = mundo();
    semearRun(f, { lotes: { '0': encerrada(0, 'falhou') } });
    await semearParte(f, 0, [membro('SKU-A')]);
    erp(f, 'SKU-A');
    expect(await f.enviar(lote())).toMatchObject({ motivo: 'sem-escrita', membros: 0 });
    expect(f.chamadas).toEqual([]);
    expect(lotesDoRun(f)['0']).toMatchObject({ desfecho: 'falhou' });

    const n = mundo();
    semearRun(n);
    await semearParte(n, 0, [membro('SKU-A')]);
    erp(n, 'SKU-A');
    expect(await n.enviar(lote())).toMatchObject({ acao: 'enviado' });
  });

  it('★ the hand-off under a canary LIST: a cancelled or superseded run’s batch hands NOTHING to tasks and posts nothing (NEAR-MISS: the current run’s batch under the same list hands off)', async () => {
    const casos: [string, Parameters<typeof semearRun>[1], number][] = [
      ['cancelled', { fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada }, 0],
      ['superseded', { execucaoId: OUTRA_EXEC }, 0],
      ['current', {}, 1],
    ];
    for (const [caso, semente, tarefas] of casos) {
      const m = mundo();
      semearRun(m, semente);
      await semearParte(m, 0, [membro('SKU-A'), membro('SKU-B')]);
      erp(m, 'SKU-A');
      erp(m, 'SKU-B');
      m.ambiente = { ...m.ambiente, [CANARIO_ENV_AMAZON.preco]: `${CONTA}:SKU-B` };
      const r = await m.enviar(lote());
      expect(m.tarefasPreco, caso).toHaveLength(tarefas);
      expect(m.chamadas, caso).toEqual([]);
      expect(r, caso).toMatchObject(
        tarefas === 0
          ? { motivo: 'so-patches', membros: 0, tarefas: 0 }
          : { motivo: 'so-patches', tarefas: 1 },
      );
    }
  });

  it('★ the other order: a FAILED end recorded once another batch is recorded concluido re-raises (its tail may have resolved the aviso after this one’s raised it) (NEAR-MISS: no batch concluido ⇒ nothing raised by the failure’s record)', async () => {
    for (const [concluido, levantado] of [
      [true, true],
      [false, false],
    ] as const) {
      const m = mundo();
      semearRun(m, {
        lotes: {
          '0': entradaDoLivro(0, 0, 1),
          '1': concluido ? encerrada(1, 'concluido') : entradaDoLivro(1, 1, 1),
        },
      });
      semearRegistro(m, '50000000001', 0);
      const r = await m.provedor.recuperar(m.ctx(), recuperacao('falhou', '50000000001'));
      expect(r).toEqual({ nada: true });
      expect(lotesDoRun(m)['0']).toMatchObject({ desfecho: 'falhou' });
      expect(m.log.linhas.at(-1)?.meta, String(concluido)).toMatchObject({
        livro: 'registrado',
        levantado,
      });
      expect(aviso(m) !== undefined, String(concluido)).toBe(levantado);
    }
  });

  it('★ a retried failure recovery whose record already landed re-raises again (the end on record is its own); one over ANOTHER recorded end raises nothing', async () => {
    for (const [armazenado, levantado] of [
      ['falhou', true],
      ['incerto', false],
    ] as const) {
      const m = mundo();
      semearRun(m, { lotes: { '0': encerrada(0, armazenado), '1': encerrada(1, 'concluido') } });
      semearRegistro(m, '50000000001', 0);
      await m.provedor.recuperar(m.ctx(), recuperacao('falhou', '50000000001'));
      expect(m.log.linhas.at(-1)?.meta, armazenado).toMatchObject({
        livro: 'ja-registrado',
        levantado,
      });
      expect(aviso(m) !== undefined, armazenado).toBe(levantado);
    }
  });

  it('★ a RETRIED clean recovery (its record landed, its raise did not) still re-raises over a failed batch: ja-registrado counts (NEAR-MISS: no failure recorded ⇒ nothing)', async () => {
    for (const [falhou, levantado] of [
      [true, true],
      [false, false],
    ] as const) {
      const m = mundo();
      semearRun(m, {
        lotes: {
          '0': falhou ? encerrada(0, 'falhou') : encerrada(0, 'concluido'),
          '1': encerrada(1, 'concluido'),
        },
      });
      semearRegistro(m, '50000000002', 1);
      if (falhou) {
        await levantarAvisoAntes(m);
        await resolverAviso(m);
      }
      await m.provedor.recuperar(m.ctx(), recuperacao('concluido', '50000000002'));
      expect(m.log.linhas.at(-1)?.meta, String(falhou)).toMatchObject({
        livro: 'ja-registrado',
        levantado,
      });
      if (falhou) expect(aviso(m)).toMatchObject({ resolvidoEm: null });
      else expect(aviso(m)).toBeUndefined();
    }
  });

  it('★ every failed SUBMITTED end survives a later clean batch — falhou, abandonado, incerto, cancelado (the core’s tail raised each one) (NEAR-MISS: concluido is no failure)', async () => {
    expect([...DESFECHOS_QUE_FALHAM_PRECO_AMAZON].sort()).toEqual(
      ['abandonado', 'cancelado', 'falhou', 'incerto'].sort(),
    );
    for (const [desfecho, levantado] of [
      ['abandonado', true],
      ['cancelado', true],
      ['falhou', true],
      ['concluido', false],
    ] as const) {
      const m = mundo();
      semearRun(m, { lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) } });
      semearRegistro(m, '50000000001', 0);
      semearRegistro(m, '50000000002', 1);
      await m.provedor.recuperar(m.ctx(), recuperacao(desfecho, '50000000001'));
      expect(lotesDoRun(m)['0'], desfecho).toMatchObject({ desfecho, motivoSemEnvio: null });
      await levantarAvisoAntes(m);
      await resolverAviso(m);
      await m.provedor.recuperar(m.ctx(), recuperacao('concluido', '50000000002'));
      expect(aviso(m)?.resolvidoEm === null, desfecho).toBe(levantado);
    }
  });

  it('★ a recovery never re-sends, whatever its end: concluido, falhou, cancelado, abandonado, incerto — no enqueue of any kind', async () => {
    for (const desfecho of ['concluido', 'falhou', 'cancelado', 'abandonado', 'incerto'] as const) {
      const m = mundo();
      semearRun(m);
      semearRegistro(m, FEED, 0);
      const referencia = desfecho === 'incerto' ? loteId(0) : FEED;
      expect(
        await m.provedor.recuperar(m.ctx(), recuperacao(desfecho, referencia)),
        desfecho,
      ).toEqual({ nada: true });
      expect(lotesDoRun(m)['0'], desfecho).toMatchObject({ desfecho });
      expect(m.tarefasPreco, desfecho).toEqual([]);
      expect(m.tarefasLote, desfecho).toEqual([]);
    }
  });

  it('★ a CANCELLED run’s expiry is recorded and raises nothing, now or under a later clean batch (NEAR-MISS: a live run’s expiry raises, and a clean batch re-raises over it)', async () => {
    for (const [fase, levantado] of [
      [FASE_EXECUCAO_PRECO_AMAZON.cancelada, false],
      [FASE_EXECUCAO_PRECO_AMAZON.decidindo, true],
    ] as const) {
      const m = mundo();
      semearRun(m, {
        fase,
        lotes: { '0': entradaDoLivro(0, 0, 1), '1': entradaDoLivro(1, 1, 1) },
      });
      await m.provedor.aoFimSemEnvio?.(m.ctx(), lote(), FIM_SEM_ENVIO_LOTE.loteExpirado);
      expect(lotesDoRun(m)['0'], fase).toMatchObject({
        desfecho: 'sem-envio',
        motivoSemEnvio: 'lote-expirado',
      });
      expect(aviso(m) !== undefined, fase).toBe(levantado);
      await levantarAvisoAntes(m);
      await resolverAviso(m);
      semearRegistro(m, '50000000002', 1);
      await m.provedor.recuperar(m.ctx(), recuperacao('concluido', '50000000002'));
      expect(aviso(m)?.resolvidoEm === null, fase).toBe(levantado);
    }
  });

  it('a recovery whose feed record is gone, or names no batch ⇒ ONE WARNING sem-registro, { nada: true }, the run untouched', async () => {
    for (const registro of [null, { fluxo: 'preco' }, { execucaoId: 42 }]) {
      const m = mundo();
      semearRun(m);
      if (registro !== null) {
        m.fake.seed(`feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`, registro);
      }
      const antes = m.fake.escritasEm(RUN).length;
      expect(await m.provedor.recuperar(m.ctx(), recuperacao('concluido'))).toEqual({
        nada: true,
      });
      expect(m.fake.escritasEm(RUN)).toHaveLength(antes);
      expect(m.log.linhas.at(-1)).toMatchObject({
        nivel: 'warn',
        meta: expect.objectContaining({ livro: 'sem-registro' }),
      });
    }
  });

  it('★ the ledger’s reads are masked: the run to its id, phase and batches; the feed record to its batch id', async () => {
    const m = mundo();
    semearRun(m);
    semearRegistro(m, FEED, 0);
    await m.provedor.recuperar(m.ctx(), recuperacao('falhou'));
    const registro = `feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`;
    expect(m.fake.leiturasDetalhadas.find((l) => l.caminho === RUN)?.mascara).toEqual([
      'execucaoId',
      'fase',
      'lotes',
    ]);
    expect(m.fake.leiturasDetalhadas.find((l) => l.caminho === registro)?.mascara).toEqual([
      'execucaoId',
    ]);
    const n = mundo();
    semearRun(n);
    await n.provedor.aoFimSemEnvio?.(n.ctx(), lote(), FIM_SEM_ENVIO_LOTE.simulado);
    expect(n.fake.leiturasDetalhadas.find((l) => l.caminho === RUN)?.mascara).toEqual([
      'execucaoId',
      'fase',
      'lotes',
    ]);
  });
});

/** The feed aviso raised now, as the core's tail raises it (so a later resolve has a row). */
async function levantarAvisoAntes(m: Mundo) {
  await sincronizarAvisoContaListingsAmazon(
    asDb(m.fake),
    { increment, nowMs: m.relogio, logger: m.log.logger },
    {
      fluxo: FLUXO_LISTING_AMAZON.preco,
      integracaoId: CONTA,
      motivo: MOTIVO_CONTA_AMAZON.feedPrecoFalhou,
      acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.levantar,
      relogio: await relogioAgora(m),
    },
  );
}

describe('★ montar and gravarResultado: the bounds and the boundaries', () => {
  const erro19037: ProblemaItemSku = {
    code: '19037',
    message: 'abaixo do mínimo',
    severity: 'ERROR',
    attributeNames: null,
    categories: ['INVALID_PRICE'],
  };
  const doRelatorio = (severity: string, code = '90220'): ProblemaSku => ({
    code,
    message: 'campo',
    severity,
    attributeNames: ['item_name'],
    categories: null,
  });
  const envioDe = (m: Mundo, sku: string) =>
    m.fake.ler(`produtos/p-${sku}/prodAmazon/l1`)?.envioPrecoAmazon as
      | { resultado: string; problemas: { code: string; severity: string }[] }
      | undefined;
  async function gravar(
    m: Mundo,
    problemas: ReadonlyMap<string, readonly ProblemaSku[]>,
    issuesDosItens: ReadonlyMap<string, readonly ProblemaItemSku[]>,
  ) {
    await m.provedor.gravarResultado(m.ctx(), {
      problemas,
      issuesDosItens,
      emMs: AGORA_MS - 30 * MIN,
      feedId: FEED,
      relogio: await relogioAgora(m),
    });
  }

  it('★ the dry-run diff counts the parts gone and the SKUs repeated (NEAR-MISS: neither ⇒ both 0)', async () => {
    const m = mundo();
    semearRun(m, { lotes: { '0': entradaDoLivro(0, 0, 3) } });
    await semearParte(m, 0, [membro('SKU-A')]);
    await semearParte(m, 2, [membro('SKU-A'), membro('SKU-B')]);
    erp(m, 'SKU-A');
    erp(m, 'SKU-B');
    const { montagem } = await montarTudo(m, lote({ partes: 3 }));
    expect(diffDe(montagem)).toMatchObject({ parteAusente: 1, repetidos: 1, mensagens: 2 });

    const n = mundo();
    semearRun(n);
    await semearParte(n, 0, [membro('SKU-A')]);
    erp(n, 'SKU-A');
    expect(diffDe((await montarTudo(n, lote())).montagem)).toMatchObject({
      parteAusente: 0,
      repetidos: 0,
    });
  });

  it('★ a short decrease sample fits whole: nothing omitted', async () => {
    const m = mundo();
    semearRun(m, { baixarPreco: true });
    await semearParte(m, 0, [membro('SKU-A', { oferta: oferta(100), faixa: faixa(1) })]);
    erp(m, 'SKU-A', { normal: 90 });
    const diff = diffDe((await montarTudo(m, lote())).montagem);
    expect(diff).toMatchObject({ amostraDesce: 'SKU-A:100>90', amostraDesceOmitidas: 0 });
  });

  it('★ the sample is measured in UTF-8 BYTES, as the sink cuts: 12 two-byte-letter entries of 18 characters fit by length but only 9 by bytes (NEAR-MISS: the same SKUs in ASCII all fit)', async () => {
    for (const [letra, cabem] of [
      ['Ç', 9],
      ['C', 12],
    ] as const) {
      const m = mundo();
      semearRun(m, { baixarPreco: true });
      const itens = Array.from({ length: 12 }, (_v, i) =>
        membro(`${letra.repeat(8)}-${String(i).padStart(2, '0')}`, {
          oferta: oferta(100),
          faixa: faixa(1),
        }),
      );
      await semearParte(m, 0, itens);
      for (const [i, item] of itens.entries()) erp(m, item.sku, { normal: 99 - i });
      const diff = diffDe((await montarTudo(m, lote())).montagem);
      const amostra = String(diff.amostraDesce);
      expect(amostra.split(','), letra).toHaveLength(cabem);
      expect(diff.amostraDesceOmitidas, letra).toBe(12 - cabem);
      expect(new TextEncoder().encode(amostra).byteLength, letra).toBeLessThanOrEqual(256);
      expect(camposSeguros(diff).amostraDesce, letra).toBe(diff.amostraDesce);
    }
  });

  it('★ the sample is a PREFIX of the largest decreases: an entry too long to fit ends it, even when a smaller decrease after it would fit (NEAR-MISS: a short SKU in its place is kept)', async () => {
    for (const [skuLongo, cabem] of [
      [`SKU-LONGO-${'X'.repeat(20)}`, 17],
      ['SKU-Y', 18],
    ] as const) {
      const m = mundo();
      semearRun(m, { baixarPreco: true });
      // 17 entries of 13 bytes (237 with their commas), the largest decreases (2 … 18).
      const curtos = Array.from({ length: 17 }, (_v, i) =>
        membro(`SKU-${String(i).padStart(2, '0')}`, { oferta: oferta(100), faixa: faixa(1) }),
      );
      const itens = [
        ...curtos,
        membro(skuLongo, { oferta: oferta(100), faixa: faixa(1) }),
        membro('SKU-Z', { oferta: oferta(100), faixa: faixa(1) }),
      ];
      await semearParte(m, 0, itens);
      for (const [i, item] of curtos.entries()) erp(m, item.sku, { normal: 98 - i });
      erp(m, skuLongo, { normal: 98.5 });
      erp(m, 'SKU-Z', { normal: 99 });
      const diff = diffDe((await montarTudo(m, lote())).montagem);
      const amostra = String(diff.amostraDesce).split(',');
      expect(amostra, skuLongo).toHaveLength(cabem);
      expect(diff.amostraDesceOmitidas, skuLongo).toBe(19 - cabem);
      // The long entry (39 bytes) does not fit after the 237; SKU-Z's 12 would, and never joins.
      expect(amostra.at(-1), skuLongo).toBe(cabem === 17 ? 'SKU-00:100>98' : 'SKU-Y:100>98.5');
    }
  });

  it('★ the future tolerance’s boundary is the shared watermark’s: a stored outcome EXACTLY the tolerance ahead is a reference, one millisecond more is set aside', async () => {
    expect(FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS).toBe(5 * MIN);
    for (const [adiante, enviado] of [
      [FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS, false],
      [FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS + 1, true],
    ] as const) {
      const m = mundo();
      semearRun(m, { baixarPreco: false });
      await semearParte(m, 0, [membro('SKU-A', { oferta: oferta(50), faixa: faixa(60) })]);
      erp(m, 'SKU-A', { normal: 55, envio: envioPatch('aceito', 70, AGORA_MS + adiante) });
      const { montagem } = await montarTudo(m, lote());
      expect(mensagensDe(montagem).length, String(adiante)).toBe(enviado ? 1 : 0);
    }
  });

  it('★ link integrity: a conta ref that only ENDS with this conta’s id is another conta ⇒ vinculo-mudou (NEAR-MISS: this conta’s own ref binds)', async () => {
    const m = mundo();
    semearRun(m);
    await semearParte(m, 0, [membro('SKU-A'), membro('SKU-B')]);
    erp(m, 'SKU-A', { contaRef: `documents/integracao/x${CONTA}` });
    erp(m, 'SKU-B');
    const { montagem } = await montarTudo(m, lote());
    expect(mensagensDe(montagem).map((x) => x.sku)).toEqual(['SKU-B']);
    expect(diffDe(montagem)).toMatchObject({ 'vinculo-mudou': 1 });
  });

  it('★ 200 SKUs with the report’s own WARNINGS never crowd out an item’s blocking price ERROR: that SKU is written and the aviso raised (NEAR-MISS: the same item at WARNING is left out)', async () => {
    const proprios = new Map(
      Array.from({ length: MAX_SKUS_COM_PROBLEMA_GRAVADOS }, (_v, i) => [
        `SKU-AVISO-${String(i).padStart(3, '0')}`,
        [doRelatorio('WARNING')],
      ]),
    );
    for (const [severity, escrito] of [
      ['ERROR', true],
      ['WARNING', false],
    ] as const) {
      const m = mundo();
      erp(m, 'SKU-ZZ-PRECO');
      await gravar(m, proprios, new Map([['SKU-ZZ-PRECO', [{ ...erro19037, severity }]]]));
      expect(envioDe(m, 'SKU-ZZ-PRECO') !== undefined, severity).toBe(escrito);
      expect(aviso(m, AVISO_RECUSA) !== undefined, severity).toBe(escrito);
    }
  });

  it('★ only an ERROR among the report’s OWN issues is our refusal: an own WARNING is aceito-com-avisos, kept, no aviso (NEAR-MISS: the same issue at ERROR ⇒ recusado)', async () => {
    for (const [severity, resultado] of [
      ['WARNING', 'aceito-com-avisos'],
      ['ERROR', 'recusado'],
    ] as const) {
      const m = mundo();
      erp(m, 'SKU-REL');
      await gravar(m, new Map([['SKU-REL', [doRelatorio(severity)]]]), new Map());
      expect(envioDe(m, 'SKU-REL'), severity).toMatchObject({
        resultado,
        problemas: [expect.objectContaining({ code: '90220', severity })],
      });
      expect(aviso(m, AVISO_RECUSA), severity).toBeUndefined();
    }
  });

  it('★ an own issue that is neither ERROR nor WARNING (INFO) is no refusal either: aceito-com-avisos, kept (NEAR-MISS: ERROR ⇒ recusado)', async () => {
    for (const [severity, resultado] of [
      ['INFO', 'aceito-com-avisos'],
      ['ERROR', 'recusado'],
    ] as const) {
      const m = mundo();
      erp(m, 'SKU-INFO');
      await gravar(m, new Map([['SKU-INFO', [doRelatorio(severity)]]]), new Map());
      expect(envioDe(m, 'SKU-INFO'), severity).toMatchObject({
        resultado,
        problemas: [expect.objectContaining({ code: '90220', severity })],
      });
    }
  });

  it('★ one SKU’s stored issues: an ERROR first, at most the cap, whichever source (NEAR-MISS: 5 own and 5 of the items ⇒ all ten kept)', async () => {
    const m = mundo();
    erp(m, 'SKU-MISTO');
    const avisos = Array.from({ length: 10 }, (_v, i) => doRelatorio('WARNING', `9${String(i)}`));
    await gravar(m, new Map([['SKU-MISTO', avisos]]), new Map([['SKU-MISTO', [erro19037]]]));
    const guardados = envioDe(m, 'SKU-MISTO')?.problemas ?? [];
    expect(guardados).toHaveLength(MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON);
    expect(guardados[0]).toMatchObject({ code: '19037', severity: 'ERROR' });

    const n = mundo();
    erp(n, 'SKU-MISTO');
    await gravar(
      n,
      new Map([['SKU-MISTO', avisos.slice(0, 5)]]),
      new Map([
        ['SKU-MISTO', Array.from({ length: 5 }, () => ({ ...erro19037, severity: 'WARNING' }))],
      ]),
    );
    expect(envioDe(n, 'SKU-MISTO')?.problemas).toHaveLength(10);
  });

  it('★ the raise is clocked by the LAST counted link-doc read: a resolve landing between two SKUs’ write-backs is overtaken', async () => {
    const m = mundo();
    erp(m, 'SKU-A');
    erp(m, 'SKU-B');
    let resolvidoEm: number | null = null;
    // After SKU-A's link read, before its write: a concurrent resolve of the same aviso.
    m.fake.antesDaProximaEscrita('produtos/p-SKU-A/prodAmazon/l1', async () => {
      await sincronizarAvisoContaListingsAmazon(
        asDb(m.fake),
        { increment, nowMs: m.relogio, logger: m.log.logger },
        {
          fluxo: FLUXO_LISTING_AMAZON.preco,
          integracaoId: CONTA,
          motivo: MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon,
          acao: ACAO_AVISO_CONTA_LISTINGS_AMAZON.resolver,
          relogio: await relogioAgora(m),
        },
      );
      resolvidoEm = aviso(m, AVISO_RECUSA)?.relogioEvento ?? null;
    });
    await gravar(
      m,
      new Map(),
      new Map([
        ['SKU-A', [erro19037]],
        ['SKU-B', [erro19037]],
      ]),
    );
    expect(resolvidoEm).not.toBeNull();
    expect(aviso(m, AVISO_RECUSA)).toMatchObject({ resolvidoEm: null });
    expect(aviso(m, AVISO_RECUSA)?.relogioEvento).toBeGreaterThan(resolvidoEm ?? Infinity);
  });
});
