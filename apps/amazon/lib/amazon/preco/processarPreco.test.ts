/**
 * The price task (step 13, PR 13-d), P0–P11, end to end against the fake
 * Firestore: the REAL context, the REAL write engine, the REAL link resolver
 * with the price masks, verdict, gate, faixa, plan and outcome write-back, the
 * REAL listing read and offer PATCH over a scripted `fetch` routed by path and
 * method (and REFUSING anything unscripted), and the REAL price producer over
 * a recording, name-keeping queue (so every enqueue is re-validated against
 * the payload schema).
 *
 * After EVERY test: no network call left the scripted `fetch`, and no
 * scenario wrote anything but link-doc outcomes, avisos and the context's own
 * credential patch — never a produto, a run, a part or a lease.
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one is the only network. The
 * read switch is `on` ONLY in the object literal handed in as `ambiente`.
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { CAMINHO_LISTINGS, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioPrecoAmazon,
  type FaixaPrecoAmazon,
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { loadAmazonContext } from '../core/contexto';
import { AmazonLotesTarefasDesligadasError } from '../feeds/agendadorLotes';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  loggerEspiao,
  respostaJson,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import {
  ACAO_TAREFA_PRECO_AMAZON,
  AmazonPrecoPrazoDaTarefaError,
  CAMPOS_CONTA_PRECO_AMAZON,
  CAMPOS_EXECUCAO_TAREFA_PRECO_AMAZON,
  CAMPO_DO_ENVIO_PRECO_AMAZON,
  type DepsProcessarPrecoAmazon,
  FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS,
  ORCAMENTO_ANTES_DO_PATCH_PRECO_MS,
  REGRA_VINCULO_PRECO_AMAZON,
  type ResultadoTarefaPrecoAmazon,
  instanteDoRegistroPrevio,
  processarPrecoSkuAmazon,
  severidadeDoDespachoPrecoAmazon,
  soValidacaoDoDespachoPrecoAmazon,
} from './processarPreco';
import {
  ATRASO_ESPERA_FEED_PRECO_S,
  ATRASO_PAUSA_PRECO_S,
  ATRASO_VERIFICACAO_PRECO_S,
  type FilaPrecoAmazon,
  type ProdutorPrecoAmazon,
  criarProdutorPrecoAmazon,
} from './produtorPreco';
import { type TarefaPrecoSkuAmazon, nomeDaTarefaPrecoAmazon } from './tarefaPreco';

const CONTA = 'conta-amz-preco';
const SKU = 'SKU-PRECO-1';
const ASIN = 'B0PRECO0001';
const PRODUTO = 'prod-preco-1';
const LINK = 'link-1';
const NORMAL = 'tab-normal';
const PROMO = 'tab-promo';
const EXEC = 'exec-preco-1';
const CAMINHO_PRODUTO = `produtos/${PRODUTO}`;
const CAMINHO_LINK = `produtos/${PRODUTO}/prodAmazon/${LINK}`;
const CAMINHO_ITEM = `${CAMINHO_LISTINGS}/${SPID_A}/${SKU}`;
const CAMINHO_VEZ_PRECO = `feedsAmazonEmCurso/preco-${CONTA}`;
const CAMINHO_VEZ_ESTOQUE = `feedsAmazonEmCurso/estoque-${CONTA}`;
const CAMINHO_EXECUCAO = `precosAmazon/${CONTA}`;
const caminhoParte = (n: number) => `precosAmazon/${CONTA}/divergenciasPrecoAmazon/${EXEC}-${n}`;
const AVISO_RECUSADO = caminhoAviso(
  chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.precoRecusadoPelaAmazon),
);
const AVISO_INVERTIDA = caminhoAviso(
  chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.precoFaixaInvertida),
);
const SUBMISSAO = 'sub-preco-0001';
const SUBMISSAO_2 = 'sub-preco-0002';
const MINUTO_MS = 60_000;

/** The ERP faixa every scenario starts from: normal 60, promotional 55. */
const FAIXA_ERP: FaixaPrecoAmazon = { base: 60, minimo: 55, maximo: 60 };
/** Amazon's live offer every scenario starts from. */
const OFERTA_VIVA: FaixaPrecoAmazon = { base: 50, minimo: 45, maximo: 50 };

/* -------------------------------------------------------------------------- */
/*                               the recording queue                          */
/* -------------------------------------------------------------------------- */

interface EnfileiradaPreco {
  readonly tarefa: TarefaPrecoSkuAmazon;
  readonly id: string | null;
  readonly atrasoS: number;
}

interface FilaPrecoDeTeste {
  readonly enfileiradas: EnfileiradaPreco[];
  readonly nomes: Set<string>;
  falha: (() => unknown) | null;
  desligado: boolean;
  produtor(): ProdutorPrecoAmazon;
}

/** The REAL producer over a queue that records, keeps every name, and refuses a held one with the SDK's 409. */
function filaPrecoDeTeste(): FilaPrecoDeTeste {
  const f: FilaPrecoDeTeste = {
    enfileiradas: [],
    nomes: new Set(),
    falha: null,
    desligado: false,
    produtor: () =>
      criarProdutorPrecoAmazon({
        desligado: f.desligado,
        fila: (): FilaPrecoAmazon => ({
          enqueue: (tarefa, opcoes) => {
            if (f.falha !== null) return Promise.reject(f.falha());
            const id = opcoes?.id ?? null;
            if (id !== null) {
              if (f.nomes.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
              f.nomes.add(id);
            }
            f.enfileiradas.push({ tarefa, id, atrasoS: opcoes?.scheduleDelaySeconds ?? 0 });
            return Promise.resolve();
          },
        }),
      }),
  };
  return f;
}

/* -------------------------------------------------------------------------- */
/*                                 the scenario                               */
/* -------------------------------------------------------------------------- */

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  /** `x-amzn-RateLimit-Limit` of the answer, when given. */
  readonly taxa?: number;
  /** The connection drops instead of an answer (`fetch` rejects). */
  readonly rede?: true;
}

/** Our offer element as Amazon's purchasable-offer guide writes it (synthetic prices). */
function elemento(o: FaixaPrecoAmazon): Record<string, unknown> {
  return {
    marketplace_id: MARKETPLACE_ID_BR,
    currency: 'BRL',
    audience: 'ALL',
    our_price: [{ schedule: [{ value_with_tax: o.base }] }],
    minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: o.minimo }] }],
    maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: o.maximo }] }],
  };
}

interface OpcoesListing {
  readonly oferta?: FaixaPrecoAmazon | null;
  readonly tipoProduto?: string | null;
  readonly status?: readonly string[];
  readonly issues?: readonly unknown[];
  readonly relacoes?: readonly unknown[];
  readonly asin?: string;
  readonly taxa?: number;
}

/** A listing as the model shapes it: a BR summary, our offer, the issues asked. */
function listing(o: OpcoesListing = {}): Roteiro {
  const oferta = o.oferta === undefined ? OFERTA_VIVA : o.oferta;
  return {
    status: 200,
    taxa: o.taxa,
    corpo: {
      sku: SKU,
      summaries: [
        {
          marketplaceId: MARKETPLACE_ID_BR,
          asin: o.asin ?? ASIN,
          ...(o.tipoProduto === null ? {} : { productType: o.tipoProduto ?? 'LUGGAGE' }),
          status: o.status ?? ['BUYABLE'],
        },
      ],
      attributes: oferta === null ? {} : { purchasable_offer: [elemento(oferta)] },
      issues: o.issues ?? [],
      relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: o.relacoes ?? [] }],
    },
  };
}

/** A price issue as the model shapes one (synthetic text). */
const issue = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: 'texto da Amazon',
  severity: 'ERROR',
  attributeNames: ['purchasable_offer'],
  categories: ['INVALID_PRICE'],
  ...extra,
});
const NAO_DE_PRECO = issue('90220', { attributeNames: ['item_name'], categories: [] });

/** Amazon's submission answer. */
function submissao(
  status: string,
  issues: unknown[] = [],
  submissionId = SUBMISSAO,
  taxa?: number,
): Roteiro {
  return { status: 200, taxa, corpo: { sku: SKU, status, submissionId, issues } };
}

const ACEITO = submissao('ACCEPTED');
const erroHttp = (status: number, codigo = 'InvalidInput'): Roteiro => ({
  status,
  corpo: { errors: [{ code: codigo, message: 'texto da Amazon' }] },
});

/** What one PATCH carried. */
interface PatchVisto {
  readonly tipoProduto: string;
  readonly op: string;
  readonly caminho: string;
  readonly oferta: FaixaPrecoAmazon;
  readonly seletores: readonly unknown[];
  readonly modo: string | null;
  /** The link's stored price outcome at the instant the PATCH left. */
  readonly guardado: unknown;
}

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  readonly fila: FilaPrecoDeTeste;
  get: Roteiro[];
  patch: Roteiro[];
  /** Every request that reached the scripted fetch: `GET`, `PATCH` or `LWA`. */
  readonly chamadas: string[];
  readonly patches: PatchVisto[];
  /** The `includedData` of every GET. */
  readonly incluidos: (string | null)[];
  ambiente: Record<string, string | undefined>;
  soValidacao: boolean;
  relogio: number;
  agora: (() => number) | null;
  /** Runs once, right after the GET is answered (before the plan). */
  depoisDoGet: (() => void) | null;
  /** How many times the context loader ran. */
  contextos: number;
  tentativa: number;
  deps(): DepsProcessarPrecoAmazon;
  rodar(t?: unknown): Promise<ResultadoTarefaPrecoAmazon>;
}

const cenarios: Cenario[] = [];

function proxima(fila: Roteiro[]): Roteiro {
  const r = fila.length > 1 ? fila.shift() : fila[0];
  if (r === undefined) throw new Error('sem resposta roteirizada');
  return r;
}

function resposta(r: Roteiro): Response {
  return new Response(JSON.stringify(r.corpo ?? {}), {
    status: r.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(r.taxa === undefined ? {} : { 'x-amzn-ratelimit-limit': String(r.taxa) }),
    },
  });
}

/** The offer a PATCH body carries (the package's merge). */
function lerPatch(corpo: unknown, url: URL, guardado: unknown): PatchVisto {
  const lido = JSON.parse(String(corpo)) as {
    productType: string;
    patches: { op: string; path: string; value: Record<string, unknown>[] }[];
  };
  const p = lido.patches[0];
  const v = p?.value[0] ?? {};
  const preco = (chave: string) =>
    (v[chave] as { schedule: { value_with_tax: number }[] }[])[0]?.schedule[0]?.value_with_tax ??
    NaN;
  return {
    tipoProduto: lido.productType,
    op: p?.op ?? '',
    caminho: p?.path ?? '',
    oferta: {
      base: preco('our_price'),
      minimo: preco('minimum_seller_allowed_price'),
      maximo: preco('maximum_seller_allowed_price'),
    },
    seletores: [v.marketplace_id, v.currency, v.audience],
    modo: url.searchParams.get('mode'),
    guardado,
  };
}

/** The ERP's two price lists for the unit (`promo` null ⇒ no promotional entry). */
function precosErp(c: Cenario, normal: number, promo: number | null = null): void {
  c.fake.seed(CAMINHO_PRODUTO, {
    nome: 'Produto preço',
    precos: {
      [NORMAL]: { valor: normal },
      ...(promo === null ? {} : { [PROMO]: { valor: promo } }),
    },
  });
}

/** A conta with both tabelas, connected; a simple produto linked to the SKU; ERP = {@link FAIXA_ERP}. */
function cenario(opcoes: { readonly tabelaNormal?: string | null } = {}): Cenario {
  const fake = new FakeDb();
  // A link doc, a produto, the run, its parts and the lease: no read of one may be unmasked.
  for (const colecao of [
    'prodAmazon',
    'produtos',
    'precosAmazon',
    'divergenciasPrecoAmazon',
    'feedsAmazonEmCurso',
  ]) {
    fake.exigirMascaraEm(colecao);
  }
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta preço',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    tabelaNormalOuterRef:
      opcoes.tabelaNormal === undefined ? `documents/listaDePrecos/${NORMAL}` : opcoes.tabelaNormal,
    tabelaPromocionalOuterRef: `documents/listaDePrecos/${PROMO}`,
  });
  seedCredencial(fake, CONTA);
  fake.seed(CAMINHO_LINK, {
    contaAmazonOuterRef: `documents/integracao/${CONTA}`,
    sku: SKU,
    asin: ASIN,
    productDataJson: { pesado: 'x'.repeat(64) },
  });
  const log = loggerEspiao();
  const fila = filaPrecoDeTeste();
  const c: Cenario = {
    fake,
    log,
    fila,
    get: [listing()],
    patch: [ACEITO],
    chamadas: [],
    patches: [],
    incluidos: [],
    ambiente: {
      ...AMBIENTE_LIGADO,
      AMAZON_MODO_PRECO: 'on',
      AMAZON_CANARIO_PRECO: '*',
    },
    soValidacao: false,
    relogio: AGORA_MS,
    agora: null,
    depoisDoGet: null,
    contextos: 0,
    tentativa: 0,
    deps: () => ({
      db: asDb(fake),
      ambiente: c.ambiente,
      agora: () => (c.agora === null ? c.relogio : c.agora()),
      logger: log.logger,
      increment,
      carregarContexto: (db, integracaoId, depsDoContexto) => {
        c.contextos += 1;
        return loadAmazonContext(db, integracaoId, depsDoContexto);
      },
      produtor: () => fila.produtor(),
      soValidacao: c.soValidacao,
      registro: { tentativa: c.tentativa, idTarefa: 'tarefa-preco-teste' },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const metodo = init?.method ?? 'GET';
        if (url.pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          return tokenDeAcesso();
        }
        if (url.pathname !== CAMINHO_ITEM || (metodo !== 'GET' && metodo !== 'PATCH')) {
          throw new Error(`rota não roteirizada: ${metodo} ${url.pathname}`);
        }
        c.chamadas.push(metodo);
        if (metodo === 'GET') {
          c.incluidos.push(url.searchParams.get('includedData'));
          const r = proxima(c.get);
          if (r.rede === true) throw new TypeError('fetch failed');
          const gancho = c.depoisDoGet;
          c.depoisDoGet = null;
          gancho?.();
          return resposta(r);
        }
        c.patches.push(lerPatch(init?.body, url, envioDoLink(c) ?? null));
        const r = proxima(c.patch);
        if (r.rede === true) throw new TypeError('fetch failed');
        return resposta(r);
      },
      gerarCorrelationId: () => 'corr-preco-teste',
    }),
    rodar: (t = tarefa()) => processarPrecoSkuAmazon(t, c.deps()),
  };
  precosErp(c, FAIXA_ERP.base, FAIXA_ERP.minimo);
  cenarios.push(c);
  return c;
}

/** A payload: a manual push, consent off, requested now, unless said otherwise. */
function tarefa(over: Partial<TarefaPrecoSkuAmazon> = {}): TarefaPrecoSkuAmazon {
  return {
    v: 1,
    tipo: 'preco-sku',
    contaId: CONTA,
    sku: SKU,
    origem: 'manual',
    referencia: 'req-preco-1',
    parte: null,
    baixarPreco: false,
    solicitadoEmMs: AGORA_MS,
    codigosAntes: [],
    ...over,
  };
}

/** The check of the send {@link SUBMISSAO}, its original request 15 min ago. */
const verificacao = (over: Partial<TarefaPrecoSkuAmazon> = {}) =>
  tarefa({
    origem: 'verificacao',
    referencia: SUBMISSAO,
    solicitadoEmMs: AGORA_MS - 15 * MINUTO_MS,
    ...over,
  });

/** A run's task, of part 0. */
const daExecucao = (over: Partial<TarefaPrecoSkuAmazon> = {}) =>
  tarefa({ origem: 'execucao', referencia: EXEC, parte: 0, baixarPreco: true, ...over });

/** The link's stored price outcome, as an earlier dispatch left it. */
function envioArmazenado(c: Cenario, envio: EnvioPrecoAmazon): void {
  c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), envioPrecoAmazon: envio });
}

function envioPatch(
  oferta: FaixaPrecoAmazon,
  emMs: number,
  resultado: EnvioPrecoAmazon['resultado'] = RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
  submissionId: string | null = SUBMISSAO,
): EnvioPrecoAmazon {
  return {
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs,
    oferta,
    resultado,
    submissionId: resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto ? null : submissionId,
    feedId: null,
    problemas: [],
  };
}

/** The price run's document, as far as a run's task reads it. */
function execucao(c: Cenario, fase: string, execucaoId = EXEC): void {
  c.fake.seed(CAMINHO_EXECUCAO, { execucaoId, fase, baixarPreco: true, outro: 'x'.repeat(64) });
}

/** Part 0 of the run: this SKU's member (unless `semEste`), its page-time faixa's base `base`, read at `lidoEmMs`. */
function parte(c: Cenario, base: number, semEste = false, lidoEmMs = AGORA_MS - MINUTO_MS): void {
  c.fake.seed(caminhoParte(0), {
    execucaoId: EXEC,
    itens: [
      {
        sku: 'OUTRO-SKU',
        vinculo: 'produtos/p-outro/prodAmazon/l-outro',
        unidadeId: 'p-outro',
        oferta: { tipo: 'lida', base: 10, minimo: 10, maximo: 10 },
        faixa: { base: 1, minimo: 1, maximo: 1 },
        tipoProduto: 'PRODUCT',
        lidoEmMs: AGORA_MS - MINUTO_MS,
      },
      ...(semEste
        ? []
        : [
            {
              sku: SKU,
              vinculo: CAMINHO_LINK,
              unidadeId: PRODUTO,
              oferta: { tipo: 'lida', ...OFERTA_VIVA },
              faixa: { base, minimo: base, maximo: base },
              tipoProduto: 'LUGGAGE',
              lidoEmMs,
            },
          ]),
    ],
  });
}

/** The price lease as a feed of the conta left it. */
function vezPreco(c: Cenario, antesDoEnvioMs: number, caminho = CAMINHO_VEZ_PRECO): void {
  c.fake.seed(caminho, {
    estado: 'enviado',
    execucaoId: 'lote-preco-em-curso',
    feedId: '50001',
    antesDoEnvioMs,
    ateMs: AGORA_MS + 60 * MINUTO_MS,
    atualizadoEmMs: antesDoEnvioMs,
    ultimoEnvioMs: antesDoEnvioMs,
    ultimoFeedConcluidoEmMs: null,
  });
}

/** The ONE dispatch line (the `fila` campo tells it from the engine's diff line). */
function despachos(c: Cenario) {
  return c.log.linhas.filter((l) => l.meta?.evento === 'preco' && l.meta.fila !== undefined);
}

const envioDoLink = (c: Cenario) =>
  c.fake.ler(CAMINHO_LINK)?.envioPrecoAmazon as EnvioPrecoAmazon | undefined;
const leiturasDaCredencial = (c: Cenario) =>
  c.fake.leituras.filter((p) => p === caminhoCredencial(CONTA)).length;
const avisosTocados = (c: Cenario) =>
  c.fake.leiturasDetalhadas.filter((l) => l.caminho.startsWith('avisos/')).length +
  c.fake.escritas.filter((w) => w.caminho.startsWith('avisos/')).length;

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
  // The task writes ONLY link outcomes, avisos and the context's credential
  // patch: never a produto, a run, a part or a lease.
  for (const c of cenarios) {
    const outras = c.fake.escritas
      .map((w) => w.caminho)
      .filter(
        (p) =>
          !p.startsWith('avisos/') &&
          p !== caminhoCredencial(CONTA) &&
          !/^produtos\/[^/]+\/prodAmazon\/[^/]+$/.test(p),
      );
    expect(outras).toEqual([]);
    // …and only ever the price field of a link doc.
    for (const w of c.fake.escritas.filter((e) => e.caminho.includes('/prodAmazon/'))) {
      expect(Object.keys(w.dados ?? {})).toEqual(['envioPrecoAmazon']);
    }
  }
  cenarios.length = 0;
});

/* -------------------------------------------------------------------------- */

describe('P0 — the payload', () => {
  it('an invalid payload is DROPPED (payload-invalido, WARNING): nothing read, nothing called', async () => {
    const c = cenario();
    const r = await c.rodar({ contaId: CONTA });
    expect(r).toMatchObject({ acao: ACAO_TAREFA_PRECO_AMAZON.payloadInvalido, motivo: null });
    expect(severidadeDoDespachoPrecoAmazon(r)).toBe('WARNING');
    expect(c.fake.operacoes).toBe(0);
    expect(c.chamadas).toEqual([]);
    expect(despachos(c)).toHaveLength(1);
  });

  it('★ (mutation 1) a payload carrying a price is refused whole: a price is never baked in', async () => {
    const c = cenario();
    for (const extra of [{ preco: 60 }, { faixa: FAIXA_ERP }, { base: 60 }]) {
      const r = await c.rodar({ ...tarefa(), ...extra });
      expect(r.acao).toBe(ACAO_TAREFA_PRECO_AMAZON.payloadInvalido);
    }
    expect(c.fake.operacoes).toBe(0);
    expect(c.patches).toEqual([]);
  });
});

describe('★ the prices are read at SEND time, from fresh reads', () => {
  it('two tasks enqueued before and after a normal-tabela edit, both dispatched after it ⇒ both PATCH the NEW faixa', async () => {
    const c = cenario();
    await c.fila.produtor().enfileirar(tarefa({ referencia: 'req-a' }));
    precosErp(c, 70, 65);
    await c.fila.produtor().enfileirar(tarefa({ referencia: 'req-b' }));
    const enfileiradas = c.fila.enfileiradas.map((x) => x.tarefa);
    expect(enfileiradas).toHaveLength(2);
    // The payloads carry identities only.
    for (const t of enfileiradas) {
      expect(Object.keys(t).sort()).toEqual(
        [
          'v',
          'tipo',
          'contaId',
          'sku',
          'origem',
          'referencia',
          'parte',
          'baixarPreco',
          'solicitadoEmMs',
          'codigosAntes',
        ].sort(),
      );
    }
    c.patch = [ACEITO, submissao('ACCEPTED', [], SUBMISSAO_2)];
    for (const t of enfileiradas) await c.rodar(t);
    expect(c.patches.map((p) => p.oferta)).toEqual([
      { base: 70, minimo: 65, maximo: 70 },
      { base: 70, minimo: 65, maximo: 70 },
    ]);
  });

  it('★ a tabela-REF switch on the conta is seen by the very next task (the conta read raw, never the cached one)', async () => {
    const c = cenario();
    await c.rodar(tarefa({ referencia: 'req-a' }));
    // The conta now names another normal list; the context's cache still holds the old conta.
    c.fake.seed(caminhoConta(CONTA), {
      ...(c.fake.ler(caminhoConta(CONTA)) ?? {}),
      tabelaNormalOuterRef: 'documents/listaDePrecos/tab-outra',
      tabelaPromocionalOuterRef: null,
    });
    c.fake.seed(CAMINHO_PRODUTO, {
      nome: 'Produto preço',
      precos: { [NORMAL]: { valor: 60 }, [PROMO]: { valor: 55 }, 'tab-outra': { valor: 80 } },
    });
    c.patch = [submissao('ACCEPTED', [], SUBMISSAO_2)];
    await c.rodar(tarefa({ referencia: 'req-b' }));
    expect(c.patches.map((p) => p.oferta.base)).toEqual([60, 80]);
    expect(c.patches[1]?.oferta).toEqual({ base: 80, minimo: 80, maximo: 80 });
  });
});

describe('P1 — the valve, before any read', () => {
  it('★ off ⇒ ZERO Firestore operations and zero Amazon calls; the valve line, then the dispatch line', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_PRECO: undefined };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'desligado' });
    expect(c.fake.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 0, escritas: 0 });
    expect(c.chamadas).toEqual([]);
    expect(c.contextos).toBe(0);
    expect(c.log.linhas.map((l) => l.meta?.evento)).toEqual(['valvula', 'preco']);
  });

  it('★ dry-run ⇒ the live read and ONE diff line under evento preco; no PATCH, no write', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_PRECO: 'dry-run' };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'simulado', motivo: 'simulado', dryRun: 'valvula' });
    expect(c.chamadas).toEqual(['GET']);
    const diff = c.log.linhas.filter(
      (l) => l.meta?.evento === 'preco' && l.meta.fila === undefined,
    );
    expect(diff).toHaveLength(1);
    expect(diff[0]?.meta).toMatchObject({
      faixaBase: 60,
      ofertaBase: 50,
      direcao: 'sobe',
      escreveria: true,
    });
    expect(envioDoLink(c)).toBeUndefined();
    expect(c.fake.escritas).toEqual([]);
  });

  it('★ on OUTSIDE the canary ⇒ the same: one GET, one diff line, no PATCH (fora-do-canario)', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_PRECO: `${CONTA}:OUTRO-SKU` };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'simulado', motivo: 'fora-do-canario' });
    expect(c.chamadas).toEqual(['GET']);
    expect(envioDoLink(c)).toBeUndefined();
    const diff = c.log.linhas.filter(
      (l) => l.meta?.evento === 'preco' && l.meta.fila === undefined,
    );
    expect(diff).toHaveLength(1);
    expect(diff[0]?.meta).toMatchObject({ faixaBase: 60, ofertaBase: 50, escreveria: true });
  });

  it('NEAR-MISS: on INSIDE the canary list ⇒ one PATCH', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_PRECO: `${CONTA}:${SKU}` };
    await c.rodar();
    expect(c.patches.map((p) => p.oferta)).toEqual([FAIXA_ERP]);
  });
});

describe('★ P2 — the wait behind a price feed, and a run’s bond: before the context', () => {
  it('★ (mutation 2) a price lease enviado 10 min ago ⇒ an UNNAMED 300-s re-enqueue, zero Amazon calls and NO context load', async () => {
    const c = cenario();
    vezPreco(c, AGORA_MS - 10 * MINUTO_MS);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'aguardando', motivo: 'aguardando-feed', vez: 'ocupada' });
    expect(c.chamadas).toEqual([]);
    expect(c.contextos).toBe(0);
    expect(leiturasDaCredencial(c)).toBe(0);
    expect(c.fila.enfileiradas).toEqual([
      { tarefa: tarefa(), id: null, atrasoS: ATRASO_ESPERA_FEED_PRECO_S },
    ]);
    expect(ATRASO_ESPERA_FEED_PRECO_S).toBe(300);
    // ONE masked by-id read of the PRICE lease.
    expect(c.fake.leiturasDetalhadas.map((l) => l.caminho)).toEqual([CAMINHO_VEZ_PRECO]);
  });

  it('NEAR-MISS: the same feed 31 min old (past the healthy wait) ⇒ the task proceeds and sends', async () => {
    const c = cenario();
    vezPreco(c, AGORA_MS - 31 * MINUTO_MS);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', vez: 'ocupada-lenta' });
    expect(c.patches).toHaveLength(1);
  });

  it('★ NEAR-MISS: the same feed 29 min old (still inside the healthy wait) ⇒ the unnamed 300-s wait, zero Amazon calls', async () => {
    const c = cenario();
    vezPreco(c, AGORA_MS - 29 * MINUTO_MS);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'aguardando', motivo: 'aguardando-feed', vez: 'ocupada' });
    expect(c.chamadas).toEqual([]);
    expect(c.fila.enfileiradas.map((x) => [x.id, x.atrasoS])).toEqual([[null, 300]]);
  });

  it('★ a price lease that does not parse ⇒ the task proceeds (vez ilegivel), and sends', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_VEZ_PRECO, { estado: 'quebrado', ultimoFeedConcluidoEmMs: null });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', vez: 'ilegivel' });
    expect(c.patches).toHaveLength(1);
    expect(c.fila.enfileiradas.map((x) => x.atrasoS)).toEqual([ATRASO_VERIFICACAO_PRECO_S]);
  });

  /** A RELEASED price lease whose last feed ended `fimMs`. */
  function vezLiberada(c: Cenario, fimMs: number): void {
    c.fake.seed(CAMINHO_VEZ_PRECO, {
      estado: 'livre',
      execucaoId: 'lote-preco-anterior',
      feedId: null,
      antesDoEnvioMs: fimMs - 30 * MINUTO_MS,
      ateMs: fimMs,
      atualizadoEmMs: fimMs,
      ultimoEnvioMs: fimMs - 30 * MINUTO_MS,
      ultimoFeedConcluidoEmMs: fimMs,
    });
  }

  it('★ the feed-recent rule reads the lease P2 read: a price feed ended 4 min ago and Amazon already showing the ERP faixa ⇒ ONE PATCH (feed-recente)', async () => {
    const c = cenario();
    vezLiberada(c, AGORA_MS - 4 * MINUTO_MS);
    c.get = [listing({ oferta: FAIXA_ERP })];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', regra: 'feed-recente', vez: 'tomar' });
    expect(c.patches.map((p) => p.oferta)).toEqual([FAIXA_ERP]);
  });

  it('★ NEAR-MISS: the same feed ended 16 min ago (past the lag) ⇒ igual, no PATCH', async () => {
    const c = cenario();
    vezLiberada(c, AGORA_MS - 16 * MINUTO_MS);
    c.get = [listing({ oferta: FAIXA_ERP })];
    expect(await c.rodar()).toMatchObject({ acao: 'encerrado', motivo: 'igual' });
    expect(c.patches).toEqual([]);
  });

  it('★ (mutation 2) NEAR-MISS: the STOCK lease held 10 min ago ⇒ the price task proceeds (it never waits behind stock)', async () => {
    const c = cenario();
    vezPreco(c, AGORA_MS - 10 * MINUTO_MS, CAMINHO_VEZ_ESTOQUE);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', vez: 'tomar' });
    expect(c.patches).toHaveLength(1);
    expect(c.fake.leiturasDetalhadas.map((l) => l.caminho)).not.toContain(CAMINHO_VEZ_ESTOQUE);
  });

  it('the wait’s re-enqueue refused by the queue valve ⇒ the queue’s own retry: the line first, then the class thrown', async () => {
    const c = cenario();
    vezPreco(c, AGORA_MS - 10 * MINUTO_MS);
    c.fila.desligado = true;
    await expect(c.rodar()).rejects.toBeInstanceOf(AmazonLotesTarefasDesligadasError);
    expect(despachos(c).map((l) => l.meta)).toEqual([
      expect.objectContaining({
        acao: 'retentar',
        motivo: 'aguardando-feed',
        perda: 'espera',
        erroPerda: 'AmazonLotesTarefasDesligadasError',
      }),
    ]);
  });

  it.each([
    ['cancelada', EXEC, 'execucao-cancelada'],
    ['paginando', EXEC, 'execucao-cancelada'],
    ['truncada', EXEC, 'execucao-cancelada'],
    ['falhou', EXEC, 'execucao-cancelada'],
    ['concluida', 'exec-outra', 'execucao-substituida'],
  ])(
    '★ (mutation 15) a run’s task whose run is %s (id %s) stands down: %s, zero Amazon calls, NO context load',
    async (fase, execucaoId, motivo) => {
      const c = cenario();
      execucao(c, fase, execucaoId);
      parte(c, 60);
      const r = await c.rodar(daExecucao());
      expect(r).toMatchObject({ acao: 'encerrado', motivo });
      expect(c.chamadas).toEqual([]);
      expect(c.contextos).toBe(0);
      expect(c.fake.leiturasDetalhadas).toEqual([
        {
          caminho: CAMINHO_EXECUCAO,
          via: 'getAll',
          chamada: 1,
          mascara: [...CAMPOS_EXECUCAO_TAREFA_PRECO_AMAZON],
        },
      ]);
    },
  );

  it('no run at all ⇒ execucao-substituida, nothing more read', async () => {
    const c = cenario();
    const r = await c.rodar(daExecucao());
    expect(r).toMatchObject({ motivo: 'execucao-substituida' });
    expect(c.chamadas).toEqual([]);
  });

  it.each(['decidindo', 'concluida'])(
    'NEAR-MISS: the SAME run %s ⇒ the task proceeds and sends',
    async (fase) => {
      const c = cenario();
      execucao(c, fase);
      parte(c, 60);
      const r = await c.rodar(daExecucao());
      expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado' });
      expect(c.patches).toHaveLength(1);
    },
  );
});

describe('P3–P6 — the conta’s tabelas, the link, the faixa, the path', () => {
  it('a conta with no normal tabela ⇒ conta-sem-tabela-normal, nothing more read, no Amazon call', async () => {
    const c = cenario({ tabelaNormal: null });
    const r = await c.rodar();
    expect(r).toMatchObject({ motivo: 'conta-sem-tabela-normal' });
    expect(c.chamadas).toEqual([]);
    expect(c.fake.consultas).toEqual([]);
  });

  it('★ NEAR-MISS: a normal tabela ref to ANOTHER collection names no tabela (the one strict parse)', async () => {
    const c = cenario({ tabelaNormal: `documents/depositos/${NORMAL}` });
    expect(await c.rodar()).toMatchObject({ motivo: 'conta-sem-tabela-normal' });
    expect(c.chamadas).toEqual([]);
  });

  it('★ a link refusal (no produto behind the link) ⇒ one line with its motivo, zero Amazon calls, no aviso', async () => {
    const c = cenario();
    c.fake.apagar(CAMINHO_PRODUTO);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'produto-ausente' });
    expect(c.chamadas).toEqual([]);
    expect(avisosTocados(c)).toBe(0);
  });

  it.each<[string, (c: Cenario) => void]>([
    [
      'vinculo-ambiguo',
      (c) => {
        c.fake.seed('produtos/prod-outro', { nome: 'Outro' });
        c.fake.seed('produtos/prod-outro/prodAmazon/l2', {
          contaAmazonOuterRef: `documents/integracao/${CONTA}`,
          sku: SKU,
        });
      },
    ],
    ['produto-ausente', (c) => c.fake.apagar(CAMINHO_PRODUTO)],
    [
      'filho-com-sku-do-pai',
      (c) => {
        c.fake.seed('produtos/prod-pai/prodAmazon/lp', { sku: SKU, asin: 'ASIN-PAI-TESTE' });
        c.fake.seed(CAMINHO_LINK, {
          ...(c.fake.ler(CAMINHO_LINK) ?? {}),
          produtoAmazonPaiOuterRef: 'documents/produtos/prod-pai/prodAmazon/lp',
        });
      },
    ],
    [
      'pai-do-vinculo-ilegivel',
      (c) =>
        c.fake.seed(CAMINHO_LINK, {
          ...(c.fake.ler(CAMINHO_LINK) ?? {}),
          produtoAmazonPaiOuterRef: 'nao-e-um-caminho',
        }),
    ],
    [
      'unidade-com-variacoes',
      (c) => c.fake.seed('produtos/prod-filho', { nome: 'Filho', paiId: PRODUTO }),
    ],
  ])(
    '★ every link refusal the price verdict answers: %s ⇒ one line, zero Amazon calls, no aviso, no write',
    async (motivo, preparar) => {
      const c = cenario();
      preparar(c);
      const r = await c.rodar();
      expect(r).toMatchObject({ acao: 'encerrado', motivo });
      expect(c.chamadas).toEqual([]);
      expect(avisosTocados(c)).toBe(0);
      expect(c.fake.escritas.filter((w) => w.caminho !== caminhoCredencial(CONTA))).toEqual([]);
      expect(despachos(c)).toHaveLength(1);
    },
  );

  it('★ a variation child is priced from its PARENT’s map under propagation, never its own; NEAR-MISS: propagatePriceToChildren false ⇒ the child’s own', async () => {
    const PAI = 'prod-pai-preco';
    const preparar = (c: Cenario, propaga: boolean | undefined) => {
      c.fake.seed(`produtos/${PAI}`, {
        nome: 'Pai preço',
        precos: { [NORMAL]: { valor: 70 }, [PROMO]: { valor: 65 } },
        ...(propaga === undefined ? {} : { propagatePriceToChildren: propaga }),
      });
      c.fake.seed(CAMINHO_PRODUTO, {
        nome: 'Filho preço',
        paiId: PAI,
        precos: { [NORMAL]: { valor: 60 } },
      });
    };
    const propagado = cenario();
    preparar(propagado, undefined);
    expect(await propagado.rodar()).toMatchObject({ acao: 'enviado' });
    expect(propagado.patches.map((p) => p.oferta)).toEqual([{ base: 70, minimo: 65, maximo: 70 }]);
    // The parent read masked: its two tabela entries and the propagation flag, never its whole map.
    const doPai = propagado.fake.leiturasDetalhadas.filter((l) => l.caminho === `produtos/${PAI}`);
    expect(doPai.map((l) => l.mascara)).toEqual([
      expect.arrayContaining([['precos', NORMAL], ['precos', PROMO], 'propagatePriceToChildren']),
    ]);
    expect(doPai[0]?.mascara).not.toContain('precos');

    const proprio = cenario();
    preparar(proprio, false);
    await proprio.rodar();
    expect(proprio.patches.map((p) => p.oferta)).toEqual([{ base: 60, minimo: 60, maximo: 60 }]);
  });

  it('★ (mutation 4) a link whose dono opted OUT of stock (enviarEstoque: false) is still PRICED: refusal 5 is stock’s', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_PRODUTO, {
      ...(c.fake.ler(CAMINHO_PRODUTO) ?? {}),
      statusProdutosMarketplace: { [`${CONTA}_${ASIN}`]: { enviarEstoque: false } },
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado' });
    expect(c.patches).toHaveLength(1);
    expect(REGRA_VINCULO_PRECO_AMAZON.fluxo).toBe('preco');
  });

  it('★ faixa-invertida (promotional above normal) ⇒ zero Amazon calls and ONE aviso raised', async () => {
    const c = cenario();
    precosErp(c, 60, 60.01);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'faixa-invertida', avisoLevantado: true });
    expect(c.chamadas).toEqual([]);
    expect(c.fake.ler(AVISO_INVERTIDA)).toMatchObject({
      motivo: MOTIVO_CONTA_AMAZON.precoFaixaInvertida,
      resolvidoEm: null,
    });
    expect(severidadeDoDespachoPrecoAmazon(r)).toBe('WARNING');
  });

  it('★ NEAR-MISS: a promotional 60.004 rounds to the normal 60 ⇒ a valid faixa, sent', async () => {
    const c = cenario();
    precosErp(c, 60, 60.004);
    await c.rodar();
    expect(c.patches.map((p) => p.oferta)).toEqual([{ base: 60, minimo: 60, maximo: 60 }]);
    expect(c.fake.ler(AVISO_INVERTIDA)).toBeUndefined();
  });

  it('★ sem-preco (no normal entry) ⇒ zero Amazon calls and NO aviso', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_PRODUTO, { nome: 'Produto preço', precos: { [PROMO]: { valor: 50 } } });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'sem-preco', avisoLevantado: false });
    expect(c.chamadas).toEqual([]);
    expect(avisosTocados(c)).toBe(0);
  });

  it('sem-caminho: a SKU no listings path can carry ⇒ no Amazon call', async () => {
    const c = cenario();
    const outro = 'SKU com/barra';
    c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), sku: outro });
    const r = await c.rodar(tarefa({ sku: outro }));
    expect(r).toMatchObject({ motivo: 'sem-caminho' });
    expect(c.chamadas).toEqual([]);
  });
});

describe('★ P7 — the gate, the body, the consent', () => {
  it.each<[string, Roteiro, string]>([
    [
      'a BR variation parent',
      listing({ relacoes: [{ type: 'VARIATION', childSkus: ['F1'] }] }),
      'pai',
    ],
    ['another ASIN on Amazon', listing({ asin: 'B0OUTRO0001' }), 'asin-divergente'],
    ['Amazon’s own 404', erroHttp(404, 'NOT_FOUND'), 'nao-listado'],
  ])('%s ⇒ ONE GET, no PATCH (%s)', async (_c, roteiro, motivo) => {
    const c = cenario();
    c.get = [roteiro];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo });
    expect(c.chamadas).toEqual(['GET']);
  });

  it.each<[string, OpcoesListing]>([
    ['a DISCOVERABLE (not buyable) listing', { status: ['DISCOVERABLE'] }],
    ['a listing with no status at all', { status: [] }],
  ])('★ (mutation 3) %s is PRICED', async (_c, o) => {
    const c = cenario();
    c.get = [listing(o)];
    await c.rodar();
    expect(c.patches).toHaveLength(1);
  });

  it('★ NO offer on a BUYABLE listing is an unreadable price: without consent ⇒ preco-atual-ilegivel, zero PATCH; NEAR-MISS: no offer on a DISCOVERABLE listing ⇒ PATCH, no consent needed', async () => {
    const compravel = cenario();
    compravel.get = [listing({ oferta: null, status: ['BUYABLE'] })];
    expect(await compravel.rodar()).toMatchObject({
      acao: 'encerrado',
      motivo: 'preco-atual-ilegivel',
    });
    expect(compravel.chamadas).toEqual(['GET']);
    expect(compravel.patches).toEqual([]);

    const vitrine = cenario();
    vitrine.get = [listing({ oferta: null, status: ['DISCOVERABLE'] })];
    expect(await vitrine.rodar()).toMatchObject({ acao: 'enviado', motivo: 'enviado' });
    expect(vitrine.patches.map((p) => p.oferta)).toEqual([FAIXA_ERP]);
  });

  it('★ an AFN listing is PRICED (fulfilment is stock’s gate, never price’s)', async () => {
    const c = cenario();
    c.get = [
      {
        ...listing(),
        corpo: {
          ...(listing().corpo as Record<string, unknown>),
          fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_NA', quantity: 4 }],
        },
      },
    ];
    await c.rodar();
    expect(c.patches).toHaveLength(1);
  });

  it('★ the WHOLE offer: equal our and max, a different min ⇒ ONE merge PATCH of all three prices, the three selectors, the LIVE product type', async () => {
    const c = cenario();
    c.get = [listing({ oferta: { base: 60, minimo: 50, maximo: 60 } })];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado', regra: 'diferente' });
    expect(c.patches).toEqual([
      expect.objectContaining({
        tipoProduto: 'LUGGAGE',
        op: 'merge',
        caminho: '/attributes/purchasable_offer',
        oferta: FAIXA_ERP,
        seletores: [MARKETPLACE_ID_BR, 'BRL', 'ALL'],
        modo: null,
      }),
    ]);
  });

  it('NEAR-MISS: the same offer to the centavo ⇒ igual, no PATCH', async () => {
    const c = cenario();
    c.get = [listing({ oferta: { base: 60.004, minimo: 55, maximo: 60 } })];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'igual' });
    expect(c.patches).toEqual([]);
  });

  it('★ NEAR-MISS: a lower-case summaries type ⇒ tipo-produto-ilegivel, no PATCH; no type ⇒ PRODUCT', async () => {
    const ilegivel = cenario();
    ilegivel.get = [listing({ tipoProduto: 'luggage' })];
    expect(await ilegivel.rodar()).toMatchObject({ motivo: 'tipo-produto-ilegivel' });
    expect(ilegivel.patches).toEqual([]);

    const semTipo = cenario();
    semTipo.get = [listing({ tipoProduto: null })];
    await semTipo.rodar();
    expect(semTipo.patches.map((p) => p.tipoProduto)).toEqual(['PRODUCT']);
  });

  it('★ a decrease of our_price WITHOUT consent ⇒ no PATCH, reducao-sem-consentimento (WARNING)', async () => {
    const c = cenario();
    precosErp(c, 40);
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'encerrado',
      motivo: 'reducao-sem-consentimento',
      direcao: 'desce',
    });
    expect(severidadeDoDespachoPrecoAmazon(r)).toBe('WARNING');
    expect(c.patches).toEqual([]);
  });

  it('★ NEAR-MISS: the same decrease WITH consent inside its window ⇒ PATCH', async () => {
    const c = cenario();
    precosErp(c, 40);
    await c.rodar(tarefa({ baixarPreco: true }));
    expect(c.patches.map((p) => p.oferta.base)).toEqual([40]);
  });

  it('★ (mutation 14) consent 61 min after the request has LAPSED ⇒ no PATCH; NEAR-MISS: 59 min ⇒ PATCH', async () => {
    const tarde = cenario();
    precosErp(tarde, 40);
    const r = await tarde.rodar(
      tarefa({ baixarPreco: true, solicitadoEmMs: AGORA_MS - 61 * MINUTO_MS }),
    );
    expect(r).toMatchObject({ motivo: 'reducao-sem-consentimento' });
    expect(tarde.patches).toEqual([]);

    const cedo = cenario();
    precosErp(cedo, 40);
    await cedo.rodar(tarefa({ baixarPreco: true, solicitadoEmMs: AGORA_MS - 59 * MINUTO_MS }));
    expect(cedo.patches).toHaveLength(1);
  });

  it('only the floor going down needs no consent (our_price unchanged)', async () => {
    const c = cenario();
    c.get = [listing({ oferta: { base: 60, minimo: 58, maximo: 60 } })];
    await c.rodar();
    expect(c.patches.map((p) => p.oferta)).toEqual([FAIXA_ERP]);
  });
});

describe('★ P7 — the write-ahead record and the clock', () => {
  it('★ (mutation 12) the incerto record LANDS before the PATCH: the PATCH sees it stored', async () => {
    const c = cenario();
    await c.rodar();
    expect(c.patches).toHaveLength(1);
    expect(c.patches[0]?.guardado).toEqual(
      envioPatch(FAIXA_ERP, AGORA_MS, RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto),
    );
    // Two writes on the link: the write-ahead, then the answer.
    expect(c.fake.escritasEm(CAMINHO_LINK).map((w) => w.dados?.envioPrecoAmazon)).toEqual([
      envioPatch(FAIXA_ERP, AGORA_MS, RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto),
      envioPatch(FAIXA_ERP, AGORA_MS + 1),
    ]);
  });

  it('★ NEAR-MISS: the answered outcome is strictly newer than its own write-ahead even on the SAME clock millisecond', async () => {
    const c = cenario();
    await c.rodar();
    const [previo, resposta] = c.fake
      .escritasEm(CAMINHO_LINK)
      .map((w) => (w.dados?.envioPrecoAmazon as EnvioPrecoAmazon).emMs);
    expect(previo).toBe(AGORA_MS);
    expect(resposta).toBe(AGORA_MS + 1);
    expect(envioDoLink(c)).toMatchObject({ resultado: 'aceito', submissionId: SUBMISSAO });
  });

  it('★ a getter clock LATER than the write-ahead + 1 is the outcome’s emMs (max, never the write-ahead + 1 alone)', async () => {
    const c = cenario();
    // The clock moves between the write-ahead (placed at AGORA_MS) and the write's credential getter.
    c.agora = () => AGORA_MS + (leiturasDaCredencial(c) >= 3 ? 5_000 : 0);
    await c.rodar();
    expect(c.patches[0]?.guardado).toMatchObject({ emMs: AGORA_MS, resultado: 'incerto' });
    expect(envioDoLink(c)?.emMs).toBe(AGORA_MS + 5_000);
  });

  it('★ the write-ahead failing ⇒ ZERO PATCH, and a throw for the retry (nothing was sent)', async () => {
    const c = cenario();
    const indisponivel = grpc(14, 'UNAVAILABLE');
    c.fake.falharEscrita(CAMINHO_LINK, indisponivel);
    await expect(c.rodar()).rejects.toBe(indisponivel);
    expect(c.chamadas).toEqual(['GET']);
    expect(c.patches).toEqual([]);
  });

  it('★ a NEWER outcome landing between the link read and the write-ahead keeps the record out ⇒ ZERO PATCH and a throw', async () => {
    const c = cenario();
    c.depoisDoGet = () => {
      envioArmazenado(c, envioPatch(OFERTA_VIVA, AGORA_MS + MINUTO_MS, 'aceito', 'sub-outra'));
    };
    await expect(c.rodar()).rejects.toMatchObject({
      name: 'AmazonPrecoRegistroPrevioPerdidoError',
    });
    expect(c.patches).toEqual([]);
    expect(envioDoLink(c)).toMatchObject({ submissionId: 'sub-outra' });
  });

  it('★ the link doc gone between the link read and the write-ahead ⇒ ZERO PATCH and a throw', async () => {
    const c = cenario();
    c.depoisDoGet = () => {
      c.fake.apagar(CAMINHO_LINK);
    };
    await expect(c.rodar()).rejects.toMatchObject({
      name: 'AmazonPrecoRegistroPrevioPerdidoError',
    });
    expect(c.patches).toEqual([]);
  });

  it('★ the write-ahead losing its precondition on every attempt ⇒ ZERO PATCH and a throw', async () => {
    const c = cenario();
    for (let i = 0; i < 3; i += 1) {
      c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => {
        c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), outro: i });
      });
    }
    await expect(c.rodar()).rejects.toMatchObject({
      name: 'AmazonPrecoRegistroPrevioPerdidoError',
    });
    expect(c.patches).toEqual([]);
  });

  it.each<[string, (c: Cenario) => void, number, number]>([
    [
      'a NEWER outcome kept it out',
      (c) => {
        c.depoisDoGet = () => {
          envioArmazenado(c, envioPatch(OFERTA_VIVA, AGORA_MS + MINUTO_MS, 'aceito', 'sub-outra'));
        };
      },
      0,
      0,
    ],
    [
      'the link doc is gone',
      (c) => {
        c.depoisDoGet = () => {
          c.fake.apagar(CAMINHO_LINK);
        };
      },
      0,
      0,
    ],
    [
      'every attempt lost its precondition',
      (c) => {
        for (let i = 0; i < 3; i += 1) {
          c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => {
            c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), outro: i });
          });
        }
      },
      0,
      1,
    ],
  ])(
    '★ the write-ahead not landing (%s) writes ONE WARNING dispatch line BEFORE the throw: vinculo-mudou, the write-back’s counts',
    async (_c, preparar, gravados, emConflito) => {
      const c = cenario();
      preparar(c);
      await expect(c.rodar()).rejects.toMatchObject({
        name: 'AmazonPrecoRegistroPrevioPerdidoError',
      });
      expect(c.patches).toEqual([]);
      const linhas = despachos(c);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({
        nivel: 'warn',
        meta: expect.objectContaining({
          acao: 'retentar',
          motivo: 'vinculo-mudou',
          erro: 'AmazonPrecoRegistroPrevioPerdidoError',
          gravados,
          emConflito,
        }),
      });
    },
  );

  it('★ a SKU on TWO link docs: one write-ahead landing while the other stays in conflict ⇒ ZERO PATCH, vinculo-mudou, a throw', async () => {
    const c = cenario();
    const caminhoLink2 = `produtos/${PRODUTO}/prodAmazon/link-2`;
    c.fake.seed(caminhoLink2, {
      contaAmazonOuterRef: `documents/integracao/${CONTA}`,
      sku: SKU,
      asin: ASIN,
    });
    for (let i = 0; i < 3; i += 1) {
      c.fake.antesDaProximaEscrita(caminhoLink2, () => {
        c.fake.seed(caminhoLink2, { ...(c.fake.ler(caminhoLink2) ?? {}), outro: i });
      });
    }
    await expect(c.rodar()).rejects.toMatchObject({
      name: 'AmazonPrecoRegistroPrevioPerdidoError',
    });
    expect(c.patches).toEqual([]);
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto' });
    expect(despachos(c)[0]?.meta).toMatchObject({
      motivo: 'vinculo-mudou',
      gravados: 1,
      emConflito: 1,
    });
  });

  it('NEAR-MISS: the same two link docs, both landing ⇒ ONE PATCH, the outcome on both', async () => {
    const c = cenario();
    const caminhoLink2 = `produtos/${PRODUTO}/prodAmazon/link-2`;
    c.fake.seed(caminhoLink2, {
      contaAmazonOuterRef: `documents/integracao/${CONTA}`,
      sku: SKU,
      asin: ASIN,
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', gravados: 2 });
    expect(c.patches).toHaveLength(1);
    expect(c.fake.ler(caminhoLink2)?.envioPrecoAmazon).toMatchObject({ resultado: 'aceito' });
  });

  it('★ the lost answer: Amazon 50, ERP 60, the PATCH of 60 cut; the tabela back to 50, the retry still reads 50 ⇒ ONE PATCH of 50 (the write-ahead makes it a recent send)', async () => {
    const c = cenario();
    c.patch = [{ rede: true }];
    await expect(c.rodar(tarefa({ baixarPreco: true }))).rejects.toMatchObject({
      name: 'AmazonNetworkError',
    });
    expect(despachos(c).at(-1)?.meta).toMatchObject({
      acao: 'retentar',
      motivo: 'escrita-incerta',
    });
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto', oferta: FAIXA_ERP });

    precosErp(c, 50, 45);
    c.get = [listing()];
    c.patch = [ACEITO];
    c.relogio = AGORA_MS + 2 * MINUTO_MS;
    c.tentativa = 1;
    await c.rodar(tarefa({ baixarPreco: true }));
    expect(c.patches.map((p) => p.oferta.base)).toEqual([60, 50]);
  });

  it('★ NEAR-MISS: the same retry 16 min later (past the lag, no write-ahead left inside it) ⇒ igual, no second PATCH', async () => {
    const c = cenario();
    c.patch = [{ rede: true }];
    await expect(c.rodar(tarefa({ baixarPreco: true }))).rejects.toBeDefined();
    precosErp(c, 50, 45);
    c.get = [listing()];
    c.relogio = AGORA_MS + 16 * MINUTO_MS;
    const r = await c.rodar(tarefa({ baixarPreco: true }));
    expect(r).toMatchObject({ motivo: 'igual' });
    expect(c.patches).toHaveLength(1);
  });

  /** A dispatch that dies right after its PATCH was ANSWERED: the answer's write-back never lands. */
  async function morreAposOPatch(c: Cenario): Promise<void> {
    // The write-ahead lands (its hook arms the failure for the NEXT write); the
    // answer's write-back then dies with no failure the task names.
    c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => {
      c.fake.falharEscrita(CAMINHO_LINK, new TypeError('instância encerrada'));
    });
    await expect(c.rodar(tarefa({ baixarPreco: true }))).rejects.toBeInstanceOf(TypeError);
    c.fake.falharEscrita(CAMINHO_LINK, null);
  }

  it('★ the SAME lost answer with the instance killed right after the PATCH left (no failure observed): the write-ahead still makes the retry send ONE PATCH of 50', async () => {
    const c = cenario();
    await morreAposOPatch(c);
    expect(c.patches.map((p) => p.oferta.base)).toEqual([60]);
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto', oferta: FAIXA_ERP });

    precosErp(c, 50, 45);
    c.get = [listing()];
    c.patch = [submissao('ACCEPTED', [], SUBMISSAO_2)];
    c.relogio = AGORA_MS + 2 * MINUTO_MS;
    c.tentativa = 1;
    expect(await c.rodar(tarefa({ baixarPreco: true }))).toMatchObject({ motivo: 'enviado' });
    expect(c.patches.map((p) => p.oferta.base)).toEqual([60, 50]);
  });

  it('★ NEAR-MISS: the same retry with NO record of the dead dispatch left ⇒ igual, and the late 60 would stand', async () => {
    const c = cenario();
    await morreAposOPatch(c);
    c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), envioPrecoAmazon: null });

    precosErp(c, 50, 45);
    c.get = [listing()];
    c.relogio = AGORA_MS + 2 * MINUTO_MS;
    c.tentativa = 1;
    expect(await c.rodar(tarefa({ baixarPreco: true }))).toMatchObject({ motivo: 'igual' });
    expect(c.patches.map((p) => p.oferta.base)).toEqual([60]);
  });
});

describe('★ the write-ahead’s clock: always the link’s newest record', () => {
  it('our clock, raised one past the stored outcome and past this dispatch’s own earlier record', () => {
    const em = (emMs: number) => [{ emMs }];
    expect(instanteDoRegistroPrevio(AGORA_MS, null, [])).toBe(AGORA_MS);
    expect(instanteDoRegistroPrevio(AGORA_MS, null, [null, undefined])).toBe(AGORA_MS);
    expect(instanteDoRegistroPrevio(AGORA_MS, null, em(AGORA_MS - 5))).toBe(AGORA_MS);
    expect(instanteDoRegistroPrevio(AGORA_MS, null, em(AGORA_MS))).toBe(AGORA_MS + 1);
    expect(instanteDoRegistroPrevio(AGORA_MS, null, em(AGORA_MS + 4 * MINUTO_MS))).toBe(
      AGORA_MS + 4 * MINUTO_MS + 1,
    );
    expect(instanteDoRegistroPrevio(AGORA_MS, AGORA_MS + 7, em(AGORA_MS))).toBe(AGORA_MS + 8);
    // Every link doc counts: the newest watermark among them wins.
    expect(
      instanteDoRegistroPrevio(AGORA_MS, null, [{ emMs: AGORA_MS + 3 }, { emMs: AGORA_MS + 9 }]),
    ).toBe(AGORA_MS + 10);
  });

  it('★ the stored emMs is read RAW, as the write-back compares it: an entry the price schema refuses still counts by its emMs', () => {
    // No `via`, no `oferta`, no `resultado`: `envioPrecoAmazonSchema` refuses it, the write-back does not.
    expect(instanteDoRegistroPrevio(AGORA_MS, null, [{ emMs: AGORA_MS + 2 * MINUTO_MS }])).toBe(
      AGORA_MS + 2 * MINUTO_MS + 1,
    );
    // NEAR-MISS: an `emMs` the write-back cannot read either (a string, µs-sized negative) counts for nothing.
    expect(instanteDoRegistroPrevio(AGORA_MS, null, [{ emMs: String(AGORA_MS + 5) }])).toBe(
      AGORA_MS,
    );
    expect(instanteDoRegistroPrevio(AGORA_MS, null, [{ emMs: -1 }])).toBe(AGORA_MS);
  });

  it('NEAR-MISS: a stored value further ahead than the tolerance raises nothing (the write-back sets it aside)', () => {
    const longe = AGORA_MS + FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS + 1;
    expect(instanteDoRegistroPrevio(AGORA_MS, null, [{ emMs: longe }])).toBe(AGORA_MS);
    const bordo = AGORA_MS + FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS;
    expect(instanteDoRegistroPrevio(AGORA_MS, null, [{ emMs: bordo }])).toBe(bordo + 1);
    // A set-aside value on one link doc never hides a watermark on another.
    expect(
      instanteDoRegistroPrevio(AGORA_MS, null, [{ emMs: longe }, { emMs: AGORA_MS + 2 }]),
    ).toBe(AGORA_MS + 3);
  });

  it('★ an UNPARSEABLE stored outcome 2 min ahead: the write-ahead lands just past it and the PATCH goes out', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_LINK, {
      ...(c.fake.ler(CAMINHO_LINK) ?? {}),
      envioPrecoAmazon: { emMs: AGORA_MS + 2 * MINUTO_MS, resultado: 'desconhecido' },
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado' });
    expect((c.patches[0]?.guardado as EnvioPrecoAmazon).emMs).toBe(AGORA_MS + 2 * MINUTO_MS + 1);
    expect(envioDoLink(c)).toMatchObject({
      resultado: 'aceito',
      emMs: AGORA_MS + 2 * MINUTO_MS + 2,
    });
  });

  it('★ the write-ahead’s tolerance is judged at the SAME instant the write-back is handed: a stored value one past the bound when placed is never kept against it', async () => {
    /** A clock one millisecond further on every read after the GET (the same sequence every run). */
    const relogioQueAnda = (c: Cenario) => {
      let passo = 0;
      c.agora = () => AGORA_MS + (c.chamadas.includes('GET') ? passo++ : 0);
    };
    // The probe: with nothing stored, the write-ahead's emMs IS the instant it is placed at.
    const sonda = cenario();
    relogioQueAnda(sonda);
    await sonda.rodar();
    const colocadoEm = (sonda.patches[0]?.guardado as EnvioPrecoAmazon).emMs;
    expect(colocadoEm).toBeGreaterThan(AGORA_MS);

    // The same run with a stored value exactly one past the tolerance at that
    // instant, and so INSIDE it one millisecond later.
    const c = cenario();
    relogioQueAnda(c);
    const naBorda = colocadoEm + FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS + 1;
    envioArmazenado(c, envioPatch(OFERTA_VIVA, naBorda, 'aceito', 'sub-na-borda'));
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado' });
    expect(c.patches.map((p) => (p.guardado as EnvioPrecoAmazon).emMs)).toEqual([colocadoEm]);
    expect(c.log.linhas.map((l) => l.meta?.motivo)).toContain('envio-futuro-ignorado');
  });

  it('★ a forged outcome 10 min in the future is overwritten by the write-ahead, with the write-back’s WARNING; the PATCH goes out', async () => {
    const c = cenario();
    envioArmazenado(c, envioPatch(OFERTA_VIVA, AGORA_MS + 10 * MINUTO_MS, 'aceito', 'sub-forjado'));
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado' });
    expect(c.patches[0]?.guardado).toEqual(
      envioPatch(FAIXA_ERP, AGORA_MS, RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto),
    );
    expect(c.log.linhas.map((l) => l.meta?.motivo)).toContain('envio-futuro-ignorado');
    expect(envioDoLink(c)).toMatchObject({ resultado: 'aceito', submissionId: SUBMISSAO });
  });

  it('NEAR-MISS: one 4 min ahead (inside the tolerance) is a watermark: the write-ahead lands just past it', async () => {
    const c = cenario();
    envioArmazenado(c, envioPatch(FAIXA_ERP, AGORA_MS + 4 * MINUTO_MS, 'aceito', 'sub-adiante'));
    c.get = [listing({ oferta: OFERTA_VIVA })];
    await c.rodar();
    expect((c.patches[0]?.guardado as EnvioPrecoAmazon).emMs).toBe(AGORA_MS + 4 * MINUTO_MS + 1);
    expect(c.log.linhas.map((l) => l.meta?.motivo)).not.toContain('envio-futuro-ignorado');
  });
});

describe('★ P8–P9 — after Amazon answered: the write-back, the aviso, the check', () => {
  it('★ ACCEPTED ⇒ aceito written back and ONE check, named after the submission, 900 s later, carrying the original consent and the codes read before', async () => {
    const c = cenario();
    c.get = [listing({ issues: [issue('19038', { severity: 'WARNING' })] })];
    const r = await c.rodar(tarefa({ baixarPreco: true, solicitadoEmMs: AGORA_MS - MINUTO_MS }));
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado', verificacao: 'enfileirada' });
    const [check] = c.fila.enfileiradas;
    expect(c.fila.enfileiradas).toHaveLength(1);
    expect(check?.atrasoS).toBe(ATRASO_VERIFICACAO_PRECO_S);
    expect(ATRASO_VERIFICACAO_PRECO_S).toBe(900);
    expect(check?.tarefa).toEqual(
      tarefa({
        origem: 'verificacao',
        referencia: SUBMISSAO,
        baixarPreco: true,
        solicitadoEmMs: AGORA_MS - MINUTO_MS,
        codigosAntes: ['19038'],
      }),
    );
    expect(check?.id).toBe(nomeDaTarefaPrecoAmazon(check?.tarefa as TarefaPrecoSkuAmazon));
  });

  it('★ (mutation 13) INVALID with a 19037 ⇒ recusado written back AND the price aviso, no check', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [issue('19037')])];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', avisoLevantado: true, verificacao: null });
    expect(envioDoLink(c)).toMatchObject({ resultado: 'recusado', submissionId: SUBMISSAO });
    expect(c.fake.ler(AVISO_RECUSADO)).toMatchObject({ resolvidoEm: null });
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('★ (mutation 13) NEAR-MISS: INVALID with only a non-price 90220 ⇒ recusado, NO price aviso', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [NAO_DE_PRECO])];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', avisoLevantado: false });
    expect(envioDoLink(c)).toMatchObject({ resultado: 'recusado' });
    expect(avisosTocados(c)).toBe(0);
  });

  it('NEAR-MISS: INVALID with a price WARNING only ⇒ no price aviso (a warning refuses nothing)', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [issue('19038', { severity: 'WARNING' })])];
    expect(await c.rodar()).toMatchObject({ avisoLevantado: false });
  });

  it('★ (mutation 18) a lost write-back (every attempt losing its precondition) ⇒ no throw, the incerto record still stored, ZERO checks', async () => {
    const c = cenario();
    // The write-ahead lands; the answer's write-back then loses all three attempts.
    c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => undefined);
    for (let i = 0; i < 3; i += 1) {
      c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => {
        c.fake.seed(CAMINHO_LINK, { ...(c.fake.ler(CAMINHO_LINK) ?? {}), outro: i });
      });
    }
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', gravacao: 'perdida', verificacao: null });
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto', oferta: FAIXA_ERP });
    expect(c.fila.enfileiradas).toEqual([]);
    expect(c.log.linhas.map((l) => l.meta?.motivo)).toContain('gravacao-em-conflito');
    expect(severidadeDoDespachoPrecoAmazon(r)).toBe('WARNING');
  });

  it('★ (mutation 18) NEAR-MISS: a write-back that LANDED ⇒ exactly one check', async () => {
    const c = cenario();
    await c.rodar();
    expect(c.fila.enfileiradas).toHaveLength(1);
  });

  it('a Firestore failure of the answer’s write-back is contained: no throw, perda named, no check', async () => {
    const c = cenario();
    c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => {
      c.fake.falharEscrita(CAMINHO_LINK, grpc(14, 'UNAVAILABLE'));
    });
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'enviado',
      gravacao: 'perdida',
      perda: { efeito: 'gravacao', erro: 'Firestore/14' },
      verificacao: null,
    });
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('the check’s enqueue refused by the queue valve is contained: no throw, perda named', async () => {
    const c = cenario();
    c.fila.desligado = true;
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'enviado',
      verificacao: 'perdida',
      perda: { efeito: 'verificacao', erro: 'AmazonLotesTarefasDesligadasError' },
    });
  });

  it.each<[string, string]>([
    ['outside the task-name grammar (a colon)', 'sub:1'],
    ['too long for it', 's'.repeat(129)],
    ['absent', ''],
  ])(
    '★ ACCEPTED with a submissionId %s ⇒ NO check (sem-submissao), no throw, the outcome written back',
    async (_c, submissionId) => {
      const c = cenario();
      c.patch = [submissao('ACCEPTED', [], submissionId)];
      const r = await c.rodar();
      expect(r).toMatchObject({ acao: 'enviado', verificacao: 'sem-submissao', perda: null });
      expect(c.fila.enfileiradas).toEqual([]);
      expect(envioDoLink(c)).toMatchObject({
        resultado: 'aceito',
        submissionId: submissionId === '' ? null : submissionId,
      });
    },
  );

  it('★ ACCEPTED carrying an issue (a WARNING) ⇒ stored aceito-com-avisos, and its check enqueued', async () => {
    const c = cenario();
    c.patch = [submissao('ACCEPTED', [issue('19038', { severity: 'WARNING' })])];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado', verificacao: 'enfileirada' });
    expect(envioDoLink(c)).toMatchObject({
      resultado: 'aceito-com-avisos',
      problemas: [expect.objectContaining({ code: '19038' })],
    });
  });

  it('★ a 2xx whose status is neither ACCEPTED nor INVALID ⇒ stored incerto (never aceito), escrita-incerta, NO check', async () => {
    const c = cenario();
    c.patch = [submissao('PENDING')];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'escrita-incerta', verificacao: null });
    expect(envioDoLink(c)).toMatchObject({
      resultado: 'incerto',
      submissionId: null,
      emMs: AGORA_MS + 1,
    });
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('★ an INVALID with a 19037 whose outcome is KEPT (a newer send landed first) raises NO aviso: a stale refusal is never the link’s latest', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [issue('19037')])];
    // The write-ahead lands; a NEWER send's outcome lands before the answer's write-back.
    c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => undefined);
    c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => {
      envioArmazenado(c, envioPatch(OFERTA_VIVA, AGORA_MS + MINUTO_MS, 'aceito', 'sub-nova'));
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', gravacao: 'mantida', avisoLevantado: false });
    expect(avisosTocados(c)).toBe(0);
    expect(envioDoLink(c)).toMatchObject({ submissionId: 'sub-nova' });
  });
});

describe('★ the check after a send (origem verificacao)', () => {
  /** The send this check is about: the ERP faixa, accepted 15 min ago. */
  function enviado(c: Cenario, oferta = FAIXA_ERP): EnvioPrecoAmazon {
    const envio = envioPatch(oferta, AGORA_MS - 15 * MINUTO_MS);
    envioArmazenado(c, envio);
    return envio;
  }

  it('★ (mutation 5) a newer send owns the field (another submissionId) ⇒ superado, zero Amazon calls', async () => {
    const c = cenario();
    envioArmazenado(c, envioPatch(FAIXA_ERP, AGORA_MS - MINUTO_MS, 'aceito', SUBMISSAO_2));
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'superado' });
    expect(c.chamadas).toEqual([]);
  });

  it('★ the ERP faixa no longer the offer sent ⇒ erp-mudou, zero Amazon calls; NEAR-MISS: 60.004 vs 60 is the same faixa', async () => {
    const c = cenario();
    enviado(c);
    precosErp(c, 60.01, 55);
    expect(await c.rodar(verificacao())).toMatchObject({ motivo: 'erp-mudou' });
    expect(c.chamadas).toEqual([]);

    const mesmo = cenario();
    enviado(mesmo);
    precosErp(mesmo, 60.004, 55);
    mesmo.get = [listing({ oferta: FAIXA_ERP })];
    expect(await mesmo.rodar(verificacao())).toMatchObject({ motivo: 'aceito' });
  });

  it('★ (mutation 5) a NEW 19037 ⇒ recusado refined onto the SAME entry (same emMs), the aviso, NO PATCH', async () => {
    const c = cenario();
    const envio = enviado(c);
    c.get = [listing({ oferta: FAIXA_ERP, issues: [issue('19037')] })];
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'recusado', avisoLevantado: true });
    expect(c.patches).toEqual([]);
    expect(envioDoLink(c)).toMatchObject({
      emMs: envio.emMs,
      submissionId: SUBMISSAO,
      resultado: 'recusado',
      problemas: [expect.objectContaining({ code: '19037' })],
    });
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('★ a 19037 that was in codigosAntes, the offer applied ⇒ aceito-com-avisos refined + the aviso, NO PATCH', async () => {
    const c = cenario();
    enviado(c);
    c.get = [listing({ oferta: FAIXA_ERP, issues: [issue('19037')] })];
    const r = await c.rodar(verificacao({ codigosAntes: ['19037'] }));
    expect(r).toMatchObject({ motivo: 'aceito-com-avisos', avisoLevantado: true });
    expect(c.patches).toEqual([]);
    expect(envioDoLink(c)?.resultado).toBe('aceito-com-avisos');
  });

  it('the offer applied and no issue ⇒ aceito refined, no aviso, no PATCH', async () => {
    const c = cenario();
    enviado(c);
    c.get = [listing({ oferta: FAIXA_ERP })];
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({ motivo: 'aceito', avisoLevantado: false });
    expect(c.patches).toEqual([]);
    expect(avisosTocados(c)).toBe(0);
  });

  it('★ (mutations 5, 17) no issue and the OLD offer ⇒ ONE PATCH of the STORED offer, its OWN write-ahead first, a NEW entry, and NO further check', async () => {
    const c = cenario();
    const envio = enviado(c);
    c.patch = [submissao('ACCEPTED', [], SUBMISSAO_2)];
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'enviado', verificacao: null });
    expect(c.patches.map((p) => p.oferta)).toEqual([envio.oferta]);
    expect(c.patches[0]?.guardado).toEqual(
      envioPatch(FAIXA_ERP, AGORA_MS, RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto),
    );
    expect(envioDoLink(c)).toMatchObject({
      resultado: 'aceito',
      submissionId: SUBMISSAO_2,
      emMs: AGORA_MS + 1,
    });
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('★ (mutation 5) the re-send sends the STORED offer, never a recomputed one', async () => {
    const c = cenario();
    // The ERP computes the same faixa to the centavo, spelled differently.
    enviado(c, { base: 60, minimo: 55, maximo: 60 });
    precosErp(c, 60.004, 54.996);
    await c.rodar(verificacao());
    expect(c.patches.map((p) => p.oferta)).toEqual([FAIXA_ERP]);
  });

  it('★ a re-send that lowers our_price with the original consent at 15 min ⇒ PATCH; NEAR-MISS: baixarPreco false ⇒ no PATCH', async () => {
    const baixa: FaixaPrecoAmazon = { base: 40, minimo: 40, maximo: 40 };
    const com = cenario();
    enviado(com, baixa);
    precosErp(com, 40);
    await com.rodar(verificacao({ baixarPreco: true }));
    expect(com.patches.map((p) => p.oferta)).toEqual([baixa]);

    const sem = cenario();
    enviado(sem, baixa);
    precosErp(sem, 40);
    expect(await sem.rodar(verificacao({ baixarPreco: false }))).toMatchObject({
      motivo: 'reducao-sem-consentimento',
    });
    expect(sem.patches).toEqual([]);
  });

  it('★ NEAR-MISS: the same re-send with the ORIGINAL consent lapsed (requested 61 min ago) ⇒ no PATCH, reducao-sem-consentimento', async () => {
    const baixa: FaixaPrecoAmazon = { base: 40, minimo: 40, maximo: 40 };
    const c = cenario();
    enviado(c, baixa);
    precosErp(c, 40);
    const r = await c.rodar(
      verificacao({ baixarPreco: true, solicitadoEmMs: AGORA_MS - 61 * MINUTO_MS }),
    );
    expect(r).toMatchObject({ motivo: 'reducao-sem-consentimento' });
    expect(c.patches).toEqual([]);
  });

  it('★ a superseded check stops BEFORE the faixa: an inverted ERP faixa then raises nothing (superado, zero Amazon calls)', async () => {
    const c = cenario();
    envioArmazenado(c, envioPatch(FAIXA_ERP, AGORA_MS - MINUTO_MS, 'aceito', SUBMISSAO_2));
    precosErp(c, 60, 60.01);
    expect(await c.rodar(verificacao())).toMatchObject({
      motivo: 'superado',
      avisoLevantado: false,
    });
    expect(c.chamadas).toEqual([]);
    expect(avisosTocados(c)).toBe(0);
  });

  it('★ a refusal refined onto an entry a NEWER send replaced first is KEPT, and raises NO aviso', async () => {
    const c = cenario();
    enviado(c);
    c.get = [listing({ oferta: FAIXA_ERP, issues: [issue('19037')] })];
    c.fake.antesDaProximaEscrita(CAMINHO_LINK, () => {
      envioArmazenado(c, envioPatch(OFERTA_VIVA, AGORA_MS - MINUTO_MS, 'aceito', SUBMISSAO_2));
    });
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({ motivo: 'recusado', gravacao: 'mantida', avisoLevantado: false });
    expect(avisosTocados(c)).toBe(0);
    expect(envioDoLink(c)).toMatchObject({ submissionId: SUBMISSAO_2 });
  });

  it('★ the re-send’s budget: a slow credential getter past 200 s ⇒ no PATCH, and the check is NOT handed back (its retry could only stand down): one WARNING line, reenvioPerdido', async () => {
    const c = cenario();
    enviado(c);
    c.agora = () =>
      AGORA_MS + (leiturasDaCredencial(c) >= 3 ? ORCAMENTO_ANTES_DO_PATCH_PRECO_MS + 1 : 0);
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({
      acao: 'encerrado',
      motivo: 'prazo-da-tarefa',
      reenvioPerdido: true,
      erro: 'AmazonPrecoPrazoDaTarefaError',
    });
    expect(c.patches).toEqual([]);
    expect(c.fila.enfileiradas).toEqual([]);
    expect(despachos(c)).toEqual([
      expect.objectContaining({
        nivel: 'warn',
        meta: expect.objectContaining({ reenvioPerdido: true }),
      }),
    ]);
    // The re-send's own record stays: the SKU's next push reads it as a recent send.
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto', oferta: FAIXA_ERP });
  });

  it('★ why the check is not handed back: the SAME check payload dispatched again after the re-send’s write-ahead can only end superado, zero Amazon calls', async () => {
    const c = cenario();
    enviado(c);
    c.patch = [erroHttp(429, 'QuotaExceeded')];
    await c.rodar(verificacao());
    expect(c.patches).toHaveLength(1);
    c.chamadas.length = 0;
    c.patch = [ACEITO];
    expect(await c.rodar(verificacao())).toMatchObject({ motivo: 'superado' });
    expect(c.chamadas).toEqual([]);
    expect(c.patches).toHaveLength(1);
  });

  it('★ a 429 on the re-send’s PATCH ⇒ NO pause enqueued, no throw: ONE WARNING line (pausado, reenvioPerdido); NEAR-MISS: a 429 on a MANUAL send’s PATCH pauses, and the paused copy sends', async () => {
    const c = cenario();
    enviado(c);
    c.patch = [{ ...erroHttp(429, 'QuotaExceeded'), taxa: 3 }];
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({
      acao: 'encerrado',
      motivo: 'pausado',
      reenvioPerdido: true,
      limiteTaxa: 3,
    });
    expect(severidadeDoDespachoPrecoAmazon(r)).toBe('WARNING');
    expect(c.patches).toHaveLength(1);
    expect(c.fila.enfileiradas).toEqual([]);

    const manual = cenario();
    manual.patch = [erroHttp(429, 'QuotaExceeded'), ACEITO];
    expect(await manual.rodar()).toMatchObject({ acao: 'pausado', reenvioPerdido: false });
    const [pausa] = manual.fila.enfileiradas;
    expect(pausa?.tarefa).toEqual(tarefa());
    expect(await manual.rodar(pausa?.tarefa)).toMatchObject({ acao: 'enviado' });
    expect(manual.patches).toHaveLength(2);
  });

  it('★ a cut PATCH of the re-send ⇒ escrita-incerta, NO throw (a retry could only stand down), reenvioPerdido; the incerto record stays', async () => {
    const c = cenario();
    enviado(c);
    c.patch = [{ rede: true }];
    const r = await c.rodar(verificacao());
    expect(r).toMatchObject({
      acao: 'encerrado',
      motivo: 'escrita-incerta',
      reenvioPerdido: true,
      erro: 'AmazonNetworkError',
    });
    expect(c.patches).toHaveLength(1);
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto', oferta: FAIXA_ERP });
    expect(c.fila.enfileiradas).toEqual([]);
  });

  it('NEAR-MISS: a 429 on the CHECK’s own GET (before any record) still pauses the check: its paused copy refines', async () => {
    const c = cenario();
    enviado(c);
    c.get = [erroHttp(429, 'QuotaExceeded'), listing({ oferta: FAIXA_ERP })];
    expect(await c.rodar(verificacao())).toMatchObject({ acao: 'pausado', reenvioPerdido: false });
    const [pausa] = c.fila.enfileiradas;
    expect(await c.rodar(pausa?.tarefa)).toMatchObject({ motivo: 'aceito' });
  });

  it('★ (mutation 6) an 18701 (a person must confirm) is NEVER re-sent: recusado, no PATCH; NEAR-MISS: without it ⇒ one PATCH', async () => {
    const c = cenario();
    enviado(c);
    c.get = [listing({ issues: [issue('18701')] })];
    const r = await c.rodar(verificacao({ codigosAntes: ['18701'] }));
    expect(r).toMatchObject({ motivo: 'recusado' });
    expect(c.patches).toEqual([]);

    const sem = cenario();
    enviado(sem);
    await sem.rodar(verificacao());
    expect(sem.patches).toHaveLength(1);
  });
});

describe('★ a run’s task: the consent floor of its page', () => {
  it('★ (mutation 16) part base 45, ERP now 40, consent, live 50 ⇒ no PATCH, reducao-apos-pagina; NEAR-MISS: ERP 45 ⇒ PATCH', async () => {
    const abaixo = cenario();
    execucao(abaixo, 'concluida');
    parte(abaixo, 45);
    precosErp(abaixo, 40);
    expect(await abaixo.rodar(daExecucao())).toMatchObject({ motivo: 'reducao-apos-pagina' });
    expect(abaixo.patches).toEqual([]);

    const no = cenario();
    execucao(no, 'concluida');
    parte(no, 45);
    precosErp(no, 45);
    await no.rodar(daExecucao());
    expect(no.patches.map((p) => p.oferta.base)).toEqual([45]);
  });

  it('★ the ERP lowered again after a DAY-old page, under a FRESH consent clock (a Decide re-kicked now), is refused the same way: the floor is the page’s, whatever solicitadoEmMs says', async () => {
    const c = cenario();
    execucao(c, 'concluida');
    parte(c, 45, false, AGORA_MS - 24 * 60 * MINUTO_MS);
    precosErp(c, 40);
    const r = await c.rodar(daExecucao({ solicitadoEmMs: AGORA_MS - MINUTO_MS }));
    expect(r).toMatchObject({ motivo: 'reducao-apos-pagina', parteAusente: false });
    expect(c.patches).toEqual([]);
  });

  it('★ a part whose members are not a list is the unknown floor too: a decrease refused (parte-ausente)', async () => {
    const c = cenario();
    execucao(c, 'concluida');
    c.fake.seed(caminhoParte(0), { execucaoId: EXEC, itens: 'x' });
    precosErp(c, 40);
    expect(await c.rodar(daExecucao())).toMatchObject({
      motivo: 'reducao-apos-pagina',
      parteAusente: true,
    });
    expect(c.patches).toEqual([]);
  });

  it('★ the reads of a run’s task carry EXACTLY their listed masks: the run, the lease, the conta, the part', async () => {
    const c = cenario();
    execucao(c, 'concluida');
    parte(c, 60);
    await c.rodar(daExecucao());
    const mascaraDe = (caminho: string) =>
      c.fake.leiturasDetalhadas.filter((l) => l.caminho === caminho).map((l) => l.mascara);
    expect(mascaraDe(CAMINHO_EXECUCAO)).toEqual([['execucaoId', 'fase']]);
    expect(mascaraDe(caminhoParte(0))).toEqual([['itens']]);
    expect(mascaraDe(caminhoConta(CONTA)).filter((m) => m !== null)).toContainEqual([
      'tabelaNormalOuterRef',
      'tabelaPromocionalOuterRef',
    ]);
    expect(mascaraDe(CAMINHO_VEZ_PRECO)).toEqual([
      [
        'estado',
        'execucaoId',
        'feedId',
        'antesDoEnvioMs',
        'ateMs',
        'atualizadoEmMs',
        'ultimoEnvioMs',
        'ultimoFeedConcluidoEmMs',
      ],
    ]);
  });

  it('★ (mutation 16) the part gone (TTL) ⇒ a decrease refused (parte-ausente on the line); NEAR-MISS: an increase is sent', async () => {
    const baixa = cenario();
    execucao(baixa, 'concluida');
    precosErp(baixa, 40);
    const r = await baixa.rodar(daExecucao());
    expect(r).toMatchObject({ motivo: 'reducao-apos-pagina', parteAusente: true });
    expect(despachos(baixa)[0]?.meta).toMatchObject({ parteAusente: true });
    expect(baixa.patches).toEqual([]);

    const sobe = cenario();
    execucao(sobe, 'concluida');
    const r2 = await sobe.rodar(daExecucao());
    expect(r2).toMatchObject({ acao: 'enviado', parteAusente: true });
    expect(sobe.patches.map((p) => p.oferta.base)).toEqual([60]);
  });

  it('★ (mutation 16) the part present but WITHOUT this SKU’s member ⇒ the floor unknown too: a decrease refused', async () => {
    const c = cenario();
    execucao(c, 'concluida');
    parte(c, 45, true);
    precosErp(c, 40);
    expect(await c.rodar(daExecucao())).toMatchObject({
      motivo: 'reducao-apos-pagina',
      parteAusente: true,
    });
    expect(c.patches).toEqual([]);
  });

  it('NEAR-MISS: another part index (gone) is the same unknown floor', async () => {
    const c = cenario();
    execucao(c, 'concluida');
    parte(c, 45);
    precosErp(c, 40);
    expect(await c.rodar(daExecucao({ parte: 1 }))).toMatchObject({ parteAusente: true });
  });

  it('NEAR-MISS: a MANUAL push has no floor: the same decrease with consent is sent', async () => {
    const c = cenario();
    parte(c, 45);
    precosErp(c, 40);
    await c.rodar(tarefa({ baixarPreco: true }));
    expect(c.patches.map((p) => p.oferta.base)).toEqual([40]);
  });
});

describe('★ P10 — the failures, by class, and the budget', () => {
  it('★ (mutation 7) a 429 on the GET ⇒ the payload re-enqueued UNNAMED 60 s later, NO throw (no attempt spent)', async () => {
    const c = cenario();
    c.get = [{ ...erroHttp(429, 'QuotaExceeded'), taxa: 5 }];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'pausado', motivo: 'pausado', limiteTaxa: 5 });
    expect(c.fila.enfileiradas).toEqual([
      { tarefa: tarefa(), id: null, atrasoS: ATRASO_PAUSA_PRECO_S },
    ]);
    expect(ATRASO_PAUSA_PRECO_S).toBe(60);
  });

  it('★ (mutation 7) a 429 on the PATCH ⇒ the same pause, NO throw', async () => {
    const c = cenario();
    c.patch = [{ ...erroHttp(429, 'QuotaExceeded'), taxa: 4 }];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'pausado', limiteTaxa: 4 });
    expect(c.patches).toHaveLength(1);
    expect(c.fila.enfileiradas.map((x) => x.atrasoS)).toEqual([60]);
  });

  it('★ the PATCH refused 401, then the forced refresh’s LWA exchange refused (invalid_grant) ⇒ conta-indisponivel, never escrita-falhou: that failure is not the PATCH’s own answer', async () => {
    const c = cenario();
    c.patch = [erroHttp(401, 'Unauthorized')];
    const base = c.deps();
    const r = await processarPrecoSkuAmazon(tarefa(), {
      ...base,
      fetch: (input, init) => {
        if (new URL(String(input)).pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          return Promise.resolve(respostaJson(400, { error: 'invalid_grant' }));
        }
        return (base.fetch ?? fetch)(input, init);
      },
    });
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'conta-indisponivel', falha: 'auth-lwa' });
    expect(c.chamadas).toEqual(['GET', 'PATCH', 'LWA']);
    expect(c.patches).toHaveLength(1);
  });

  it('★ the budget counts from the DISPATCH’s start: 150 s in the context and 60 s more at the write’s credential ⇒ ZERO PATCH; NEAR-MISS: 150 + 40 s ⇒ PATCH', async () => {
    const lento = (adiante: number) => {
      const c = cenario();
      c.agora = () =>
        AGORA_MS + (c.contextos > 0 ? 150_000 : 0) + (leiturasDaCredencial(c) >= 3 ? adiante : 0);
      return c;
    };
    const tarde = lento(60_000);
    await expect(tarde.rodar()).rejects.toBeInstanceOf(AmazonPrecoPrazoDaTarefaError);
    expect(tarde.patches).toEqual([]);

    const cedo = lento(40_000);
    expect(await cedo.rodar()).toMatchObject({ acao: 'enviado' });
    expect(cedo.patches).toHaveLength(1);
  });

  it('a cut or 5xx PATCH ⇒ escrita-incerta and a throw: the write-ahead already says incerto', async () => {
    const c = cenario();
    c.patch = [erroHttp(503, 'ServiceUnavailable')];
    await expect(c.rodar()).rejects.toBeDefined();
    expect(despachos(c)[0]?.meta).toMatchObject({ acao: 'retentar', motivo: 'escrita-incerta' });
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto' });
  });

  it('a definite 4xx of the PATCH ⇒ escrita-falhou, ERROR, NO throw; the write-ahead stays', async () => {
    const c = cenario();
    c.patch = [erroHttp(400, 'InvalidInput')];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'encerrado', motivo: 'escrita-falhou' });
    expect(severidadeDoDespachoPrecoAmazon(r)).toBe('ERROR');
    expect(envioDoLink(c)).toMatchObject({ resultado: 'incerto' });
  });

  it('★ (mutation 8) the budget is checked with the write’s credential IN HAND: that read crossing it ⇒ ZERO PATCH calls, prazo-da-tarefa, a throw', async () => {
    const c = cenario();
    c.agora = () =>
      AGORA_MS + (leiturasDaCredencial(c) >= 3 ? ORCAMENTO_ANTES_DO_PATCH_PRECO_MS + 1 : 0);
    await expect(c.rodar()).rejects.toBeInstanceOf(AmazonPrecoPrazoDaTarefaError);
    expect(leiturasDaCredencial(c)).toBe(3);
    expect(c.patches).toEqual([]);
    expect(despachos(c).map((l) => l.meta?.motivo)).toEqual(['prazo-da-tarefa']);
    expect(ORCAMENTO_ANTES_DO_PATCH_PRECO_MS).toBe(200_000);
  });

  it('★ (mutation 8) NEAR-MISS: a slow Firestore read BEFORE the getter, under budget at the getter ⇒ PATCH', async () => {
    const c = cenario();
    c.depoisDoGet = () => {
      c.relogio = AGORA_MS + ORCAMENTO_ANTES_DO_PATCH_PRECO_MS;
    };
    await c.rodar();
    expect(c.patches).toHaveLength(1);
  });
});

describe('★ the preview flag (AMAZON_PRECO_SO_VALIDACAO=1)', () => {
  it('★ (mutation 11) the PATCH carries mode=VALIDATION_PREVIEW; no write-ahead, nothing written back, no check', async () => {
    const c = cenario();
    c.soValidacao = true;
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_PRECO: `${CONTA}:${SKU}` };
    c.patch = [submissao('VALID', [issue('19038', { severity: 'WARNING' })])];
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enviado', motivo: 'previa', previa: true, status: 'VALID' });
    expect(c.patches.map((p) => [p.modo, p.guardado])).toEqual([['VALIDATION_PREVIEW', null]]);
    expect(c.fake.escritas).toEqual([]);
    expect(c.fila.enfileiradas).toEqual([]);
    expect(despachos(c)[0]?.meta).toMatchObject({ status: 'VALID', problemas: '19038' });
  });

  it('★ NEAR-MISS: without the flag, no mode at all', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_PRECO: `${CONTA}:${SKU}` };
    await c.rodar();
    expect(c.patches.map((p) => p.modo)).toEqual([null]);
  });

  it('★ the flag with on + * reads as dry-run: the GET, no PATCH, an ERROR line (validacao-com-todos)', async () => {
    const c = cenario();
    c.soValidacao = true;
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'simulado', veredito: 'validacao-com-todos' });
    expect(c.chamadas).toEqual(['GET']);
    expect(severidadeDoDespachoPrecoAmazon(r)).toBe('ERROR');
  });
});

describe('★ P11 — ONE dispatch line', () => {
  it('★ limiteTaxa is the lowest x-amzn-RateLimit-Limit of the GET and the PATCH', async () => {
    const c = cenario();
    c.get = [listing({ taxa: 5 })];
    c.patch = [submissao('ACCEPTED', [], SUBMISSAO, 2)];
    const r = await c.rodar();
    expect(r.limiteTaxa).toBe(2);
    expect(despachos(c)).toHaveLength(1);
    expect(despachos(c)[0]?.meta).toMatchObject({
      limiteTaxa: 2,
      origem: 'manual',
      sku: SKU,
      motivo: 'enviado',
      faixaBase: 60,
      faixaMinimo: 55,
      faixaMaximo: 60,
      ofertaBase: 50,
      ofertaMinimo: 45,
      ofertaMaximo: 50,
      direcao: 'sobe',
      tipoProduto: 'LUGGAGE',
      status: 'ACCEPTED',
      temPrecoComDesconto: false,
      temOfertaB2B: false,
      fechada: false,
    });
  });

  it('★ NEAR-MISS: the LOWER rate on the GET (2) and the higher on the PATCH (5) ⇒ 2: the lowest, never the last', async () => {
    const c = cenario();
    c.get = [listing({ taxa: 2 })];
    c.patch = [submissao('ACCEPTED', [], SUBMISSAO, 5)];
    expect((await c.rodar()).limiteTaxa).toBe(2);
  });

  it('★ NEAR-MISS: no header on either answer ⇒ null, never 0', async () => {
    const c = cenario();
    const r = await c.rodar();
    expect(r.limiteTaxa).toBeNull();
    expect(despachos(c)[0]?.meta?.limiteTaxa).toBeNull();
  });

  it('never an issue message, a seller id or a body on the line', async () => {
    const c = cenario();
    c.patch = [submissao('INVALID', [issue('19037')])];
    await c.rodar();
    const linha = JSON.stringify(despachos(c));
    expect(linha).not.toContain('texto da Amazon');
    expect(linha).not.toContain(SPID_A);
  });
});

describe('★ every read is masked to its listed fields', () => {
  it('★ (mutation 10) the lease, the conta, the link, the dono, the unit (its two precos entries only) and the write-back', async () => {
    const c = cenario();
    await c.rodar();
    const mascaras = c.fake.leiturasDetalhadas
      .filter((l) => l.via === 'getAll')
      .map((l) => [l.caminho, l.mascara]);
    expect(mascaras).toContainEqual([
      CAMINHO_VEZ_PRECO,
      expect.arrayContaining(['ultimoFeedConcluidoEmMs', 'estado']),
    ]);
    expect(mascaras).toContainEqual([caminhoConta(CONTA), [...CAMPOS_CONTA_PRECO_AMAZON]]);
    // The unit: refusal 4's fields and ONE entry per tabela, never the whole price map.
    const unidade = c.fake.leiturasDetalhadas.filter(
      (l) =>
        l.caminho === CAMINHO_PRODUTO &&
        (l.mascara ?? []).some((m) => Array.isArray(m) && m[0] === 'precos'),
    );
    expect(unidade).toHaveLength(1);
    expect(unidade[0]?.mascara).toEqual(
      expect.arrayContaining([
        ['precos', NORMAL],
        ['precos', PROMO],
      ]),
    );
    expect(unidade[0]?.mascara).not.toContain('precos');
    // The write-back: the price field alone, twice (the write-ahead, then the answer).
    expect(
      c.fake.leiturasDetalhadas.filter((l) => l.caminho === CAMINHO_LINK).map((l) => l.mascara),
    ).toEqual([['envioPrecoAmazon'], ['envioPrecoAmazon']]);
    // The link query is projected (a classic select): never the product payload.
    const consulta = c.fake.consultas.find((q) => q.colecao === 'prodAmazon');
    expect(consulta?.selecao).toEqual(expect.arrayContaining(['envioPrecoAmazon', 'sku']));
    expect(consulta?.selecao).not.toContain('productDataJson');
  });

  it('the write-back binding is the price field’s, named by its module, with the two price parameters', () => {
    expect(CAMPO_DO_ENVIO_PRECO_AMAZON).toMatchObject({
      fluxo: 'preco',
      rotulo: 'processarPreco.ts',
      refinaMesmoEnvio: true,
      futuroToleradoMs: FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS,
    });
    expect(FUTURO_TOLERADO_ENVIO_PRECO_AMAZON_MS).toBe(5 * MINUTO_MS);
  });
});

describe('★ the preview flag of ONE dispatch, as the jobs root binds it', () => {
  const registro = { tentativa: 1, idTarefa: 'tarefa-preco-flag' };

  it('★ exactly `1` ⇒ on, and nothing logged', () => {
    const log = loggerEspiao();
    expect(
      soValidacaoDoDespachoPrecoAmazon({ AMAZON_PRECO_SO_VALIDACAO: '1' }, log.logger, registro),
    ).toBe(true);
    expect(log.linhas).toEqual([]);
  });

  it.each([['true'], ['0'], [' 1'], ['   ']])(
    '★ NEAR-MISS %j ⇒ OFF, and ONE WARNING naming the flag and the token, never the value',
    (valor) => {
      const log = loggerEspiao();
      expect(
        soValidacaoDoDespachoPrecoAmazon(
          { AMAZON_PRECO_SO_VALIDACAO: valor },
          log.logger,
          registro,
        ),
      ).toBe(false);
      expect(log.linhas).toHaveLength(1);
      expect(log.linhas[0]).toMatchObject({
        nivel: 'warn',
        meta: expect.objectContaining({
          evento: 'preco',
          etapa: 'previa',
          previa: false,
          leitura: 'ignorado',
          fluxo: 'preco',
          tentativa: 1,
          idTarefa: 'tarefa-preco-flag',
        }),
      });
      expect(log.linhas[0]?.mensagem).toContain('AMAZON_PRECO_SO_VALIDACAO');
      if (valor.trim() !== '') {
        expect(JSON.stringify(log.linhas[0])).not.toContain(`"${valor}"`);
      }
    },
  );

  it('unset or exactly empty ⇒ off, and nothing logged (the root template ships it blank)', () => {
    const log = loggerEspiao();
    expect(soValidacaoDoDespachoPrecoAmazon({}, log.logger, registro)).toBe(false);
    expect(
      soValidacaoDoDespachoPrecoAmazon({ AMAZON_PRECO_SO_VALIDACAO: '' }, log.logger, registro),
    ).toBe(false);
    expect(log.linhas).toEqual([]);
  });
});
