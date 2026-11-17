/**
 * The NF-e queue's body (step 14, PR 14-c), P0–P12, end to end against the fake
 * Firestore: the REAL context, the REAL write engine, the REAL status reader and
 * decision tables, a scripted `fetch` serving Amazon's model shapes (getOrder,
 * getInvoiceStatus, submitInvoice — routed by path and method), and the REAL
 * NF-e producer over a RECORDING queue (so every re-enqueue is re-validated
 * against the payload schema, and none is named).
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one is the only network. The
 * read switch is `on` ONLY in the object literal handed in as `ambiente`.
 * PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireRegion } from '@delfrance/core/region';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ESTADO_FRETE, ESTADO_NFE, MOTIVO_PEDIDO_AMAZON } from '@delfrance/schemas';

import { enfileirarAgendamentoDoAceiteAmazon } from '../agendamento/entradasAgendamento';
import { idDaTarefaDeAgendamentoAmazon } from '../agendamento/tarefaAgendamento';
import { chavePedidoPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { FLUXO_AMAZON } from '../core/valvulas';
import { FalhaTarefaAmazonError } from '../notificacoes/notificacao';
import { ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON } from '../pedidos/incidentesPedidoAmazon';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  type FilaAgendamentoDeTeste,
  filaAgendamentoDeTeste,
} from '../testing/produtorAgendamento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  caminhoAviso,
  caminhoCredencial,
  loggerEspiao,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import {
  ATUALIZADO_US,
  ORDER_ID_TESTE,
  linhaAmazon,
  pedidoAmazon,
  type OpcoesPedidoTeste,
} from '../testing/pedidoWireAmazon';
import { caminhoDaFilaNfeAmazon, criarAgendadorNfeAmazon } from './agendadorNfe';
import { chaveAvisoNfeAmazon } from './avisoNfe';
import { conteudoDaNfeAmazon } from './conteudoNfe';
import type { DestinoAceiteNfeAmazon } from './destinoAceite';
import {
  type DepsProcessarNfeAmazon,
  type ResultadoNfeAmazon,
  processarNfeAmazon,
  registrarDespachoNfeAmazon,
} from './processarNfe';
import {
  ESCADA_VERIFICACAO_NFE_AMAZON_S,
  PAUSAS_NFE_AMAZON_S,
  TENTATIVAS_NFE_AMAZON,
  type TarefaNfeAmazon,
  aposEnvioNfeAmazon,
  tarefaInicialNfeAmazon,
} from './tarefaNfe';

/**
 * The step-15 seam and the content, swappable per test. The seam is a SPY (null
 * unless a test installs one — the REAL E1 included, `enfileirarAgendamentoDoAceiteAmazon`);
 * the content stays real by default.
 */
const h = vi.hoisted(() => ({
  destino: { agendar: null as DestinoAceiteNfeAmazon['agendar'] },
  md5Hex: false,
}));
vi.mock('./destinoAceite', () => ({ DESTINO_ACEITE_NFE_AMAZON: h.destino }));
vi.mock('./conteudoNfe', async (original) => {
  const real = await original<typeof import('./conteudoNfe')>();
  return {
    ...real,
    conteudoDaNfeAmazon: (xml: string) =>
      h.md5Hex
        ? { ...real.conteudoDaNfeAmazon(xml), contentMD5Value: '900150983cd24fb0d6963f7d28e17f72' }
        : real.conteudoDaNfeAmazon(xml),
  };
});

const CONTA = 'conta-amz-nfe';
const ORDER = ORDER_ID_TESTE;
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const NFE_ID = 's1';
const CAMINHO = `pedidos/${PEDIDO_ID}`;
const CAMINHO_NFE = `${CAMINHO}/nfev4/${NFE_ID}`;
const CHAVE_AVISO = chaveAvisoNfeAmazon(CONTA, PEDIDO_ID);
const RELOGIO_PEDIDO_US = ATUALIZADO_US;

/** A synthetic approved SALE proc (tpAmb 1) — no party; a fake 44-digit run, never a real key. */
const XML =
  '<nfeProc><NFe><infNFe><ide><tpAmb>1</tpAmb><tpNF>1</tpNF><finNFe>1</finNFe></ide>' +
  `<emit>Emitente Ficticio</emit></infNFe></NFe><protNFe><chNFe>${'3'.repeat(44)}</chNFe>` +
  '</protNFe></nfeProc>';
const CONTEUDO = conteudoDaNfeAmazon(XML);

/** The status bodies, PascalCase (the Delivery API's own). */
const STATUS = {
  semNota: { invoiceStatus: 'NotFound' },
  processando: { orderInvoicingStatus: 'Processing' },
  aceita: {
    orderInvoicingStatus: 'Accepted',
    invoiceStatus: 'Accepted',
    invoices: [{ id: 'inv-sintetico-1', status: 'Accepted' }],
  },
  recusada: { orderInvoicingStatus: 'Rejected' },
} as const;

const erro = (code: string) => ({ errors: [{ code, message: 'x' }] });

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  /** Reject the fetch itself (a dropped connection). */
  readonly rede?: true;
}

type Rota = 'getOrder' | 'status' | 'envio';

/** The approved DBA order, as getOrder sends it. */
function ordem(opcoes: OpcoesPedidoTeste = {}): Roteiro {
  return {
    status: 200,
    corpo: {
      order: JSON.parse(
        JSON.stringify(
          pedidoAmazon({ status: 'UNSHIPPED', programs: ['DELIVERY_BY_AMAZON'], ...opcoes }),
        ),
      ) as unknown,
    },
  };
}

/** The pedido as the importer wrote it: proved, paid, its freight `amz` at aguardandoNFe. */
function pedidoRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: 'pago',
    ultimaModificacao: RELOGIO_PEDIDO_US + 10,
    lastMarketplaceUpdate: RELOGIO_PEDIDO_US,
    marketplace: { tipo: 'amazon', fulfilledBy: 'MERCHANT', programs: ['DELIVERY_BY_AMAZON'] },
    freteInicial: {
      externalOptionIntegracao: 'amz',
      modalidade: '1',
      estado: ESTADO_FRETE.aguardandoNFe,
      ultimaModificacao: RELOGIO_PEDIDO_US,
    },
    ...extra,
  };
}

function nfeRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { estado: ESTADO_NFE.aprovada, xml_nfe_proc: XML, data_autorizacao: AGORA_MS, ...extra };
}

interface Cenario {
  readonly fake: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  readonly rotas: Record<Rota, Roteiro[]>;
  /** Every call that reached the scripted fetch: `<METHOD> <path>`. */
  readonly chamadas: string[];
  /** Every enqueue the recording queue accepted (payload, options). */
  readonly enfileiradas: { readonly tarefa: TarefaNfeAmazon; readonly atrasoS: number }[];
  /** The Easy Ship scheduling queue (step 15): the REAL producer over a recording, name-keeping queue. */
  readonly agendamentos: FilaAgendamentoDeTeste;
  /** Make the queue reject the NEXT enqueues. */
  falhaDaFila: (() => unknown) | null;
  filaDesligada: boolean;
  ambiente: Record<string, string | undefined>;
  tentativa: number;
  /** Lines in order, with how many Firestore reads had happened when each was written. */
  readonly ordem: { readonly evento: unknown; readonly leituras: number }[];
  deps(): DepsProcessarNfeAmazon;
  rodar(tarefa?: TarefaNfeAmazon): Promise<ResultadoNfeAmazon>;
}

function cenario(rotas: Partial<Record<Rota, Roteiro[]>> = {}): Cenario {
  const fake = new FakeDb();
  seedConta(fake, CONTA, { nome: 'Conta NF-e', selling_partner_id: SPID_A });
  seedCredencial(fake, CONTA);
  fake.seed(CAMINHO, pedidoRaw());
  fake.seed(CAMINHO_NFE, nfeRaw());
  const log = loggerEspiao();
  const ordemDasLinhas: { evento: unknown; leituras: number }[] = [];
  const logger = {
    info: (m: string, meta?: Record<string, unknown>) => {
      ordemDasLinhas.push({ evento: meta?.evento, leituras: fake.leituras.length });
      log.logger.info(m, meta as never);
    },
    warn: (m: string, meta?: Record<string, unknown>) => {
      ordemDasLinhas.push({ evento: meta?.evento, leituras: fake.leituras.length });
      log.logger.warn(m, meta as never);
    },
    error: (m: string, meta?: Record<string, unknown>) => {
      ordemDasLinhas.push({ evento: meta?.evento, leituras: fake.leituras.length });
      log.logger.error(m, meta as never);
    },
  };
  const c: Cenario = {
    fake,
    log,
    rotas: {
      getOrder: rotas.getOrder ?? [ordem()],
      status: rotas.status ?? [{ status: 200, corpo: STATUS.semNota }],
      envio: rotas.envio ?? [{ status: 200, corpo: {} }],
    },
    chamadas: [],
    enfileiradas: [],
    agendamentos: filaAgendamentoDeTeste(),
    falhaDaFila: null,
    filaDesligada: false,
    ambiente: { ...AMBIENTE_LIGADO, AMAZON_MODO_NFE: 'on', AMAZON_CANARIO_NFE: '*' },
    tentativa: 0,
    ordem: ordemDasLinhas,
    deps: () => ({
      ambiente: c.ambiente,
      agora: () => AGORA_MS,
      logger,
      increment,
      agendador: () =>
        criarAgendadorNfeAmazon({
          desligado: c.filaDesligada,
          fila: () => ({
            enqueue: (tarefa, opcoes) => {
              if (c.falhaDaFila !== null) return Promise.reject(c.falhaDaFila());
              // The handler NEVER names a task: only the trigger does.
              expect(opcoes?.id).toBeUndefined();
              c.enfileiradas.push({ tarefa, atrasoS: opcoes?.scheduleDelaySeconds ?? 0 });
              return Promise.resolve();
            },
          }),
        }),
      agendamento: c.agendamentos.produtor,
      registro: { tentativa: c.tentativa, idTarefa: 'tarefa-nfe-teste-1' },
      fetch: (input, init) => {
        const url = new URL(String(input));
        const metodo = init?.method ?? 'GET';
        if (url.pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          return Promise.resolve(tokenDeAcesso());
        }
        c.chamadas.push(`${metodo} ${url.pathname}`);
        const rota: Rota | null = url.pathname.startsWith('/orders/2026-01-01/orders/')
          ? 'getOrder'
          : url.pathname === '/delivery/2022-07-01/invoice/status'
            ? 'status'
            : url.pathname === '/delivery/2022-07-01/invoice' && metodo === 'POST'
              ? 'envio'
              : null;
        if (rota === null)
          return Promise.reject(new Error(`rota não roteirizada: ${url.pathname}`));
        const fila = c.rotas[rota];
        const r = fila.length > 1 ? fila.shift() : fila[0];
        if (r === undefined) return Promise.reject(new Error(`sem resposta para ${rota}`));
        if (r.rede === true) return Promise.reject(new TypeError('fetch failed'));
        return Promise.resolve(respostaJson(r.status ?? 200, r.corpo ?? {}));
      },
      gerarCorrelationId: () => 'corr-nfe-teste',
    }),
    rodar: (tarefa = tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID)) =>
      processarNfeAmazon(asDb(fake), tarefa, c.deps()),
  };
  return c;
}

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  h.destino.agendar = null;
  h.md5Hex = false;
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

const POST = 'POST /delivery/2022-07-01/invoice';
const GET_STATUS = 'GET /delivery/2022-07-01/invoice/status';
const posts = (c: Cenario) => c.chamadas.filter((x) => x === POST);
const aviso = (c: Cenario) => c.fake.ler(caminhoAviso(CHAVE_AVISO));
const frete = (c: Cenario) => c.fake.ler(CAMINHO)?.freteInicial as Record<string, unknown>;
/** A verification payload at rung `degrau`, after a submit planned on `leituraAntes`. */
function verificacao(
  degrau: number,
  o: { leituraAntes?: 'sem-nota' | 'recusada' | null; incerto?: boolean; reenvios?: 0 | 1 } = {},
): TarefaNfeAmazon {
  const envio = { ...tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID), reenvios: o.reenvios ?? 0 };
  const t = aposEnvioNfeAmazon(
    envio,
    o.leituraAntes === undefined ? 'sem-nota' : o.leituraAntes,
    o.incerto ?? false,
  );
  return { ...t, degrau };
}

/* -------------------------------------------------------------------------- */

describe('P0 — the payload', () => {
  it('an invalid payload is DROPPED (WARNING), nothing read, nothing called', async () => {
    const c = cenario();
    const r = await processarNfeAmazon(asDb(c.fake), { pedidoId: 'x' }, c.deps());
    expect(r.acao).toBe('payload-invalido');
    expect(c.fake.operacoes).toBe(0);
    expect(c.chamadas).toEqual([]);
    registrarDespachoNfeAmazon(c.log.logger, r, { tentativa: 0, idTarefa: null });
    expect(c.log.linhas.at(-1)).toMatchObject({
      nivel: 'warn',
      meta: { acao: 'payload-invalido' },
    });
  });
});

describe('P1 / P2 — the valve first, then the LEVEL predicate', () => {
  it('★ P1 before P2: the valve line is written with ZERO Firestore reads behind it', async () => {
    const c = cenario();
    await c.rodar();
    expect(c.ordem[0]).toEqual({ evento: 'valvula', leituras: 0 });
  });

  it('★ (mutation 3) a document ALREADY ready is processed — the task reads a LEVEL, never an edge', async () => {
    const c = cenario();
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enfileirado', envio: 'aceito' });
    expect(posts(c)).toHaveLength(1);
  });

  it.each<[string, Record<string, unknown> | null]>([
    ['not yet approved', nfeRaw({ estado: ESTADO_NFE.enviando })],
    ['cancelled', nfeRaw({ estado: ESTADO_NFE.cancelada })],
    ['a homologação proc', nfeRaw({ xml_nfe_proc: XML.replace('<tpAmb>1', '<tpAmb>2') })],
    ['deleted', null],
  ])('fase envio, an NF-e %s ⇒ nfe-nao-pronta, log only, no pedido read', async (_c, doc) => {
    const c = cenario();
    if (doc === null) c.fake.apagar(CAMINHO_NFE);
    else c.fake.seed(CAMINHO_NFE, doc);
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'nfe-nao-pronta' });
    expect(c.fake.leituras).toEqual([CAMINHO_NFE]);
    expect(c.chamadas).toEqual([]);
  });

  it('★ fase verificacao, the NF-e now CANCELLED ⇒ the aviso nfe-cancelada, clocked by P3’s read, no Amazon call', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_NFE, nfeRaw({ estado: ESTADO_NFE.cancelada }));
    const r = await c.rodar(verificacao(3));
    expect(r).toMatchObject({ acao: 'avisado', motivo: 'nfe-cancelada' });
    expect(aviso(c)).toMatchObject({ motivo: 'nfe-cancelada', resolvidoEm: null });
    expect(c.chamadas).toEqual([]);
    // NEAR-MISS: the same on a stored cancelled SALE ⇒ log only (the incidente path's).
    const d = cenario();
    d.fake.seed(CAMINHO_NFE, nfeRaw({ estado: ESTADO_NFE.cancelada }));
    d.fake.seed(CAMINHO, pedidoRaw({ estado: 'estornadoIntegralmente' }));
    expect(await d.rodar(verificacao(3))).toMatchObject({
      acao: 'descartado',
      motivo: 'pedido-cancelado',
    });
    expect(aviso(d)).toBeUndefined();
  });

  it('fase verificacao, any other not-ready ⇒ log only', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_NFE, nfeRaw({ estado: ESTADO_NFE.enviando }));
    expect(await c.rodar(verificacao(2))).toMatchObject({
      acao: 'descartado',
      motivo: 'nfe-nao-pronta',
    });
    expect(aviso(c)).toBeUndefined();
  });
});

describe('P3 / P4 / P5 — the pedido, the sale gate, the siblings (before any Amazon call)', () => {
  it('another channel’s pedido ⇒ nao-amazon; the emission block ⇒ emissao-bloqueada (WARNING)', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO, pedidoRaw({ numero: '240901ABCDEFGH' }));
    expect(await c.rodar()).toMatchObject({ acao: 'descartado', motivo: 'nao-amazon' });
    const d = cenario();
    d.fake.seed(CAMINHO, pedidoRaw({ bloquearEmissaoNFe: true }));
    const r = await d.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'emissao-bloqueada' });
    registrarDespachoNfeAmazon(d.log.logger, r, { tentativa: 0, idTarefa: null });
    expect(d.log.linhas.at(-1)?.nivel).toBe('warn');
    expect([...c.chamadas, ...d.chamadas]).toEqual([]);
  });

  it('★ the task never applies the trigger’s stored pre-filter: a stored fulfilledBy AMAZON still reads the order LIVE', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO, pedidoRaw({ marketplace: { tipo: 'amazon', fulfilledBy: 'AMAZON' } }));
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enfileirado', envio: 'aceito' });
  });

  it.each(['cancelado', 'estornadoIntegralmente'])(
    '★ a STORED cancelled sale (%s) ⇒ the incidente + the resolve, ZERO Amazon calls',
    async (estado) => {
      const c = cenario();
      c.fake.seed(caminhoAviso(CHAVE_AVISO), {
        tipo: 'nfeUploadRejeitado',
        conta: CONTA,
        entidade: PEDIDO_ID,
        severidade: 'atencao',
        canal: 'amazon',
        params: { pedido: ORDER, erro: 'x' },
        motivo: 'nfe-recusada',
        urlInterna: { rota: '/pedidos/x', campo: null },
        relogioEvento: 1,
        criadoEm: 1,
        atualizadoEm: 1,
        ocorrencias: 1,
        resolvidoEm: null,
        resolucaoMotivo: null,
      });
      c.fake.seed(CAMINHO, pedidoRaw({ estado }));
      const r = await c.rodar();
      expect(r).toMatchObject({ acao: 'descartado', motivo: 'pedido-cancelado' });
      expect(c.chamadas).toEqual([]);
      expect(
        c.fake.ler(`${CAMINHO}/incidentes/${ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON}`),
      ).toMatchObject({
        subtipo: ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON,
      });
      expect(aviso(c)).toMatchObject({ resolucaoMotivo: 'pedido-cancelado' });
      expect(aviso(c)?.resolvidoEm).not.toBeNull();
    },
  );

  it('★ P4: a legible NON-sale note ⇒ log; an ILLEGIBLE one ⇒ aviso + stamp xml-invalido — before any Amazon call', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO_NFE, nfeRaw({ xml_nfe_proc: XML.replace('<tpNF>1', '<tpNF>0') }));
    expect(await c.rodar()).toMatchObject({ acao: 'descartado', motivo: 'nfe-nao-e-de-venda' });
    const d = cenario();
    d.fake.seed(CAMINHO_NFE, nfeRaw({ xml_nfe_proc: XML.replace('<finNFe>1</finNFe>', '') }));
    expect(await d.rodar()).toMatchObject({
      acao: 'avisado',
      motivo: 'xml-invalido',
      carimbo: 'carimbado',
    });
    expect(frete(d).estado).toBe('error');
    expect([...c.chamadas, ...d.chamadas]).toEqual([]);
  });

  it('★ P5: another eligible sale note ⇒ nfe-ambigua, in BOTH fases, before any Amazon call (ONE unfiltered listing)', async () => {
    for (const tarefa of [tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID), verificacao(4)]) {
      const c = cenario();
      c.fake.seed(`${CAMINHO}/nfev4/s9`, nfeRaw());
      expect(await c.rodar(tarefa)).toMatchObject({ acao: 'avisado', motivo: 'nfe-ambigua' });
      expect(c.chamadas).toEqual([]);
      expect(c.fake.consultas).toEqual([
        { colecao: `${CAMINHO}/nfev4`, filtros: [], ordens: [], limite: null, apos: null },
      ]);
      expect(frete(c).estado).toBe('aguardandoNFe');
    }
  });
});

describe('P6 / P7 — the valve (envio only), then the context', () => {
  it('★ (mutation 4) fase envio + valve off ⇒ the aviso envio-nao-ligado, ZERO fetch and NO conta read', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_NFE: undefined };
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'avisado', motivo: 'envio-nao-ligado' });
    expect(c.chamadas).toEqual([]);
    expect(c.fake.leituras.filter((p) => p.startsWith('integracao/'))).toEqual([]);
    expect(aviso(c)).toMatchObject({ motivo: 'envio-nao-ligado' });
    expect(frete(c).estado).toBe('aguardandoNFe');
  });

  it('★ dry-run ⇒ getOrder + the status read, ZERO POST, the engine’s diff line, the aviso', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_MODO_NFE: 'dry-run' };
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'avisado',
      motivo: 'envio-nao-ligado',
      statusAmazon: 'sem-nota',
    });
    expect(c.chamadas.filter((x) => x !== 'LWA')).toEqual([
      `GET /orders/2026-01-01/orders/${ORDER}`,
      GET_STATUS,
    ]);
    const diff = c.log.linhas.find((l) => l.meta?.evento === 'nfe' && l.meta.modo === 'dry-run');
    expect(diff?.meta).toMatchObject({ acao: 'enviaria', statusAmazon: 'sem-nota' });
  });

  it('on outside the canary ⇒ the same dry-run (fora-do-canario)', async () => {
    const c = cenario();
    c.ambiente = { ...c.ambiente, AMAZON_CANARIO_NFE: `${CONTA}:000-0000000-0000000` };
    expect(await c.rodar()).toMatchObject({ acao: 'avisado', motivo: 'envio-nao-ligado' });
    expect(posts(c)).toEqual([]);
  });

  it.each<[string, Record<string, string | undefined>]>([
    ['off', { AMAZON_MODO_NFE: undefined }],
    ['dry-run', { AMAZON_MODO_NFE: 'dry-run' }],
    ['outside the canary', { AMAZON_CANARIO_NFE: `${CONTA}:000-0000000-0000000` }],
  ])(
    '★ (mutation 18) fase verificacao under %s ⇒ the status read still runs and the chain goes on',
    async (_c, valvula) => {
      const c = cenario({ status: [{ status: 200, corpo: STATUS.processando }] });
      c.ambiente = { ...c.ambiente, ...valvula };
      const r = await c.rodar(verificacao(1));
      expect(r).toMatchObject({ acao: 'enfileirado', statusAmazon: 'processando' });
      expect(c.chamadas).toContain(GET_STATUS);
      expect(c.enfileiradas).toHaveLength(1);
      expect(aviso(c)).toBeUndefined();
    },
  );

  it('★ the read switch off ⇒ chamadas-desligadas (verificacao too), nothing called', async () => {
    for (const tarefa of [tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID), verificacao(2)]) {
      const c = cenario();
      c.ambiente = { ...c.ambiente, AMAZON_CHAMADAS: 'off' };
      expect(await c.rodar(tarefa)).toMatchObject({
        acao: 'avisado',
        motivo: 'chamadas-desligadas',
      });
      expect(c.chamadas).toEqual([]);
    }
  });

  it('an inactive conta ⇒ conta-inativa (log, WARNING); an unconnected one ⇒ conta-indisponivel', async () => {
    const c = cenario();
    seedConta(c.fake, CONTA, { ativo: false, selling_partner_id: SPID_A });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'conta-inativa' });
    registrarDespachoNfeAmazon(c.log.logger, r, { tentativa: 0, idTarefa: null });
    expect(c.log.linhas.at(-1)?.nivel).toBe('warn');
    const d = cenario();
    seedConta(d.fake, CONTA, { selling_partner_id: null });
    expect(await d.rodar()).toMatchObject({ acao: 'avisado', motivo: 'conta-indisponivel' });
    expect([...c.chamadas, ...d.chamadas]).toEqual([]);
  });
});

describe('P8 — the LIVE order, on every dispatch', () => {
  it('★ (mutation 22) the floor is the stored watermark: a read OLDER than it throws the retryable class (never trusted)', async () => {
    const c = cenario();
    c.fake.seed(CAMINHO, pedidoRaw({ lastMarketplaceUpdate: ATUALIZADO_US + 1 }));
    await expect(c.rodar()).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && e.name === 'AmazonLeituraDefasadaError',
    );
    expect(posts(c)).toEqual([]);
    // NEAR-MISS: a read at the floor goes on.
    const d = cenario();
    d.fake.seed(CAMINHO, pedidoRaw({ lastMarketplaceUpdate: ATUALIZADO_US }));
    expect(await d.rodar()).toMatchObject({ envio: 'aceito' });
  });

  it('… and on the LAST attempt the lag ends envio with amazon-indisponivel, a verification with its next rung', async () => {
    const c = cenario();
    c.tentativa = TENTATIVAS_NFE_AMAZON - 1;
    c.fake.seed(CAMINHO, pedidoRaw({ lastMarketplaceUpdate: ATUALIZADO_US + 1 }));
    expect(await c.rodar()).toMatchObject({ acao: 'avisado', motivo: 'amazon-indisponivel' });
    const d = cenario();
    d.tentativa = TENTATIVAS_NFE_AMAZON - 1;
    d.fake.seed(CAMINHO, pedidoRaw({ lastMarketplaceUpdate: ATUALIZADO_US + 1 }));
    expect(await d.rodar(verificacao(3))).toMatchObject({ acao: 'enfileirado' });
    expect(d.enfileiradas[0]?.tarefa.degrau).toBe(4);
  });

  it('★ marketplace-estrangeiro ⇒ log WARNING, no aviso, no submit', async () => {
    const c = cenario({
      getOrder: [ordem({ extra: { salesChannel: { marketplaceId: 'ATVPDKIKX0DER' } } })],
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'marketplace-estrangeiro' });
    registrarDespachoNfeAmazon(c.log.logger, r, { tentativa: 0, idTarefa: null });
    expect(c.log.linhas.at(-1)?.nivel).toBe('warn');
    expect(aviso(c)).toBeUndefined();
    expect(posts(c)).toEqual([]);
  });

  it('fase envio: a CANCELLED order ⇒ the incidente + the resolve, no submit; PENDING ⇒ aviso; an unknown status ⇒ aviso; not DBA ⇒ log', async () => {
    const cancelado = cenario({ getOrder: [ordem({ status: 'CANCELLED' })] });
    expect(await cancelado.rodar()).toMatchObject({
      acao: 'descartado',
      motivo: 'pedido-cancelado',
    });
    expect(
      cancelado.fake.ler(`${CAMINHO}/incidentes/${ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON}`),
    ).toBeDefined();
    const pendente = cenario({ getOrder: [ordem({ status: 'PENDING' })] });
    expect(await pendente.rodar()).toMatchObject({ acao: 'avisado', motivo: 'pedido-pendente' });
    const desconhecido = cenario({ getOrder: [ordem({ status: 'UNFULFILLABLE' })] });
    expect(await desconhecido.rodar()).toMatchObject({
      acao: 'avisado',
      motivo: 'status-pedido-desconhecido',
    });
    const naoDba = cenario({ getOrder: [ordem({ programs: ['PRIME'] })] });
    expect(await naoDba.rodar()).toMatchObject({ acao: 'descartado', motivo: 'nao-dba' });
    for (const c of [cancelado, pendente, desconhecido, naoDba]) {
      expect(posts(c)).toEqual([]);
      expect(c.chamadas).not.toContain(GET_STATUS);
    }
  });

  it('★ fase envio: an OPEN cancellation request ⇒ its aviso + amazonPedidoPrecisaAtencao aceitar-cancelamento, no submit', async () => {
    const c = cenario({
      getOrder: [
        ordem({ linhas: [linhaAmazon('L1', { qtd: 1, preco: '10.00', solicitacao: true })] }),
      ],
    });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'avisado', motivo: 'cancelamento-solicitado' });
    expect(aviso(c)).toMatchObject({ motivo: 'cancelamento-solicitado' });
    expect(
      c.fake.ler(
        caminhoAviso(
          chavePedidoPrecisaAtencao(CONTA, ORDER, MOTIVO_PEDIDO_AMAZON.aceitarCancelamento),
        ),
      ),
    ).toMatchObject({ severidade: 'critico', resolvidoEm: null });
    expect(posts(c)).toEqual([]);
  });

  it('★ (mutation 19) P8 runs on a VERIFICATION too: a CANCELLED read ends the chain with the incidente — NO clear, NO seam, no status read', async () => {
    const agendar = vi.fn(() => Promise.resolve());
    h.destino.agendar = agendar;
    const c = cenario({
      getOrder: [ordem({ status: 'CANCELLED' })],
      status: [{ status: 200, corpo: STATUS.aceita }],
    });
    c.fake.seed(CAMINHO, {
      ...pedidoRaw(),
      freteInicial: { ...(pedidoRaw().freteInicial as Record<string, unknown>), estado: 'error' },
    });
    const r = await c.rodar(verificacao(2));
    expect(r).toMatchObject({ acao: 'descartado', motivo: 'pedido-cancelado' });
    expect(c.chamadas).toContain(`GET /orders/2026-01-01/orders/${ORDER}`);
    expect(c.chamadas).not.toContain(GET_STATUS);
    expect(frete(c).estado).toBe('error');
    expect(agendar).not.toHaveBeenCalled();
    expect(
      c.fake.ler(`${CAMINHO}/incidentes/${ID_INCIDENTE_NFE_PEDIDO_CANCELADO_AMAZON}`),
    ).toBeDefined();
  });

  it('fase verificacao: any other gate is LOGGED and the read goes on (portao)', async () => {
    const c = cenario({
      getOrder: [ordem({ programs: ['PRIME'] })],
      status: [{ status: 200, corpo: STATUS.processando }],
    });
    const r = await c.rodar(verificacao(1));
    expect(r).toMatchObject({ acao: 'enfileirado', portao: 'nao-dba' });
    expect(c.chamadas).toContain(GET_STATUS);
  });

  it.each<[string, string]>([
    ['UNFULFILLABLE', 'status-pedido-desconhecido'],
    ['PENDING', 'pedido-pendente'],
  ])(
    '★ fase verificacao: %s is LOGGED and the read goes on (14-b departure 1) — no aviso, the next rung',
    async (status, portao) => {
      const c = cenario({
        getOrder: [ordem({ status })],
        status: [{ status: 200, corpo: STATUS.processando }],
      });
      const r = await c.rodar(verificacao(1));
      expect(r).toMatchObject({ acao: 'enfileirado', portao, motivo: null, aviso: null });
      expect(c.chamadas).toContain(GET_STATUS);
      expect(c.enfileiradas).toHaveLength(1);
      expect(aviso(c)).toBeUndefined();
    },
  );

  /** The approved order with an OPEN buyer cancellation request on its one line. */
  const ordemComSolicitacao = () =>
    ordem({ linhas: [linhaAmazon('L1', { qtd: 1, preco: '10.00', solicitacao: true })] });
  const atencaoDoCancelamento = (c: Cenario) =>
    c.fake.ler(
      caminhoAviso(
        chavePedidoPrecisaAtencao(CONTA, ORDER, MOTIVO_PEDIDO_AMAZON.aceitarCancelamento),
      ),
    );

  it('★ fase verificacao: an OPEN cancellation request raises its two rows and the read goes on (the next rung)', async () => {
    const c = cenario({
      getOrder: [ordemComSolicitacao()],
      status: [{ status: 200, corpo: STATUS.processando }],
    });
    const r = await c.rodar(verificacao(1));
    expect(r).toMatchObject({
      acao: 'enfileirado',
      portao: 'cancelamento-solicitado',
      aviso: 'criado',
    });
    expect(c.chamadas).toContain(GET_STATUS);
    expect(c.enfileiradas).toHaveLength(1);
    expect(aviso(c)).toMatchObject({ motivo: 'cancelamento-solicitado', resolvidoEm: null });
    expect(atencaoDoCancelamento(c)).toMatchObject({ resolvidoEm: null });
  });

  it('★ fase verificacao, an open request + Rejected ⇒ the row says nfe-recusada (written ONCE per dispatch: never hidden behind the request by an equal clock), the stamp lands', async () => {
    const c = cenario({
      getOrder: [ordemComSolicitacao()],
      status: [{ status: 200, corpo: STATUS.recusada }],
    });
    const r = await c.rodar(verificacao(2));
    expect(r).toMatchObject({
      acao: 'avisado',
      motivo: 'nfe-recusada',
      aviso: 'criado',
      carimbo: 'carimbado',
      portao: 'cancelamento-solicitado',
    });
    expect(aviso(c)).toMatchObject({ motivo: 'nfe-recusada', resolvidoEm: null });
    expect(c.fake.escritasEm(caminhoAviso(CHAVE_AVISO))).toHaveLength(1);
    expect(frete(c).estado).toBe('error');
    expect(atencaoDoCancelamento(c)).toMatchObject({ resolvidoEm: null });
  });

  it('★ fase verificacao, an open request whose deferred NF-e row is LOST after the next rung was enqueued ⇒ NO throw, one pos-envio-falhou WARNING (acao enfileirado)', async () => {
    const c = cenario({
      getOrder: [ordemComSolicitacao()],
      status: [{ status: 200, corpo: STATUS.processando }],
    });
    c.fake.falharEscrita(caminhoAviso(CHAVE_AVISO), grpc(14, 'UNAVAILABLE'));
    const r = await c.rodar(verificacao(1));
    expect(r).toMatchObject({
      acao: 'enfileirado',
      motivo: null,
      aviso: null,
      posEnvio: { escrita: 'aviso', erro: 'Firestore/14' },
    });
    expect(c.enfileiradas).toHaveLength(1);
    registrarDespachoNfeAmazon(c.log.logger, r, { tentativa: 0, idTarefa: 'x' });
    expect(c.log.linhas.at(-1)).toMatchObject({
      nivel: 'warn',
      meta: { motivo: 'pos-envio-falhou', escritaPerdida: 'aviso', acao: 'enfileirado' },
    });
  });

  it.each<[string, Roteiro[], string]>([
    [
      'a second 403 (after the forced refresh)',
      [
        { status: 403, corpo: erro('Unauthorized') },
        { status: 403, corpo: erro('Unauthorized') },
      ],
      'sem-permissao',
    ],
    [
      'a 2xx off its schema',
      [{ status: 200, corpo: { order: { orderId: 42 } } }],
      'status-pedido-desconhecido',
    ],
    [
      'a 400 InvalidInput',
      [{ status: 400, corpo: erro('InvalidInput') }],
      'status-pedido-desconhecido',
    ],
  ])(
    '★ getOrder answering %s ⇒ aviso %s on the FIRST attempt — no POST, no stamp',
    async (_c, getOrder, motivo) => {
      const c = cenario({ getOrder });
      expect(await c.rodar()).toMatchObject({ acao: 'avisado', motivo });
      expect(posts(c)).toEqual([]);
      expect(c.chamadas).not.toContain(GET_STATUS);
      expect(frete(c).estado).toBe('aguardandoNFe');
    },
  );

  it.each<[string, (c: Cenario) => void]>([
    [
      'the credential gone',
      (c) => {
        c.fake.apagar(caminhoCredencial(CONTA));
      },
    ],
    [
      'the credential parked',
      (c) => {
        seedCredencial(c.fake, CONTA, {
          reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: 'r' },
        });
      },
    ],
  ])(
    '★ the context refusing (%s) ⇒ aviso conta-indisponivel, nothing called',
    async (_c, preparar) => {
      const c = cenario();
      preparar(c);
      expect(await c.rodar()).toMatchObject({ acao: 'avisado', motivo: 'conta-indisponivel' });
      expect(c.chamadas).toEqual([]);
      expect(frete(c).estado).toBe('aguardandoNFe');
    },
  );

  it('★ LWA refusing the refresh of a STALE token before getOrder (invalid_grant) ⇒ aviso conta-indisponivel — the conta’s authorization, never sem-permissao — no SP-API call, no stamp', async () => {
    const c = cenario();
    seedCredencial(c.fake, CONTA, { expirationDate: AGORA_MS - 1 });
    const base = c.deps();
    const deps: DepsProcessarNfeAmazon = {
      ...base,
      fetch: (input, init) => {
        if (new URL(String(input)).pathname === '/auth/o2/token') {
          c.chamadas.push('LWA');
          return Promise.resolve(respostaJson(400, { error: 'invalid_grant' }));
        }
        return (base.fetch ?? fetch)(input, init);
      },
    };
    const r = await processarNfeAmazon(
      asDb(c.fake),
      tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID),
      deps,
    );
    expect(r).toMatchObject({ acao: 'avisado', motivo: 'conta-indisponivel' });
    expect(c.chamadas).toEqual(['LWA']);
    expect(frete(c).estado).toBe('aguardandoNFe');
  });

  it('an illegible order (PedidoAmazonIlegivelError) ⇒ aviso status-nfe-desconhecido; a 404 ⇒ pedido-nao-encontrado-na-amazon', async () => {
    const c = cenario({ getOrder: [ordem({ extra: { orderId: '171-9876543-0000000' } })] });
    expect(await c.rodar()).toMatchObject({ acao: 'avisado', motivo: 'status-nfe-desconhecido' });
    const d = cenario({ getOrder: [{ status: 404, corpo: erro('NotFound') }] });
    expect(await d.rodar()).toMatchObject({
      acao: 'avisado',
      motivo: 'pedido-nao-encontrado-na-amazon',
    });
    expect(frete(d).estado).toBe('aguardandoNFe');
  });
});

describe('P9 — status FIRST (idempotency)', () => {
  it('★ aceita ⇒ ZERO POST, the aceita path (no stored stamp ⇒ ZERO writes)', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    const escritas = c.fake.escritas.length;
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'aceita', motivo: 'ja-aceita', carimbo: 'sem-carimbo' });
    expect(posts(c)).toEqual([]);
    expect(c.fake.escritas.length - escritas).toBe(0);
  });

  it('★ processando ⇒ ZERO POST + ONE re-enqueue at 60 s (a verification of a submit someone else made: leituraAntes null)', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.processando }] });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enfileirado', statusAmazon: 'processando' });
    expect(posts(c)).toEqual([]);
    expect(c.enfileiradas).toEqual([
      {
        tarefa: expect.objectContaining({
          fase: 'verificacao',
          degrau: 0,
          leituraAntes: null,
          envioIncerto: false,
        }),
        atrasoS: 60,
      },
    ]);
  });

  it('★ sem-nota ⇒ ONE POST of the stored bytes + ONE re-enqueue (verification rung 0, leituraAntes sem-nota)', async () => {
    const c = cenario();
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'enfileirado', envio: 'aceito' });
    expect(posts(c)).toHaveLength(1);
    expect(c.enfileiradas).toEqual([
      {
        tarefa: expect.objectContaining({
          fase: 'verificacao',
          degrau: 0,
          leituraAntes: 'sem-nota',
          envioIncerto: false,
          reenvios: 0,
        }),
        atrasoS: ESCADA_VERIFICACAO_NFE_AMAZON_S[0],
      },
    ]);
    expect(c.fake.escritas).toEqual([]);
  });

  it('a recusada at an envio dispatch DOES submit (leituraAntes recusada)', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.recusada }] });
    await c.rodar();
    expect(posts(c)).toHaveLength(1);
    expect(c.enfileiradas[0]?.tarefa.leituraAntes).toBe('recusada');
  });

  it('★ (mutation 14) a cancelled sibling + aceita ⇒ nfe-substituta: ZERO POST, NO clear, the seam NOT called', async () => {
    const agendar = vi.fn(() => Promise.resolve());
    h.destino.agendar = agendar;
    for (const tarefa of [tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID), verificacao(2)]) {
      const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
      c.fake.seed(CAMINHO, {
        ...pedidoRaw(),
        freteInicial: {
          ...(pedidoRaw().freteInicial as Record<string, unknown>),
          estado: 'error',
        },
      });
      c.fake.seed(`${CAMINHO}/nfev4/s9`, nfeRaw({ estado: ESTADO_NFE.cancelada }));
      expect(await c.rodar(tarefa)).toMatchObject({ acao: 'avisado', motivo: 'nfe-substituta' });
      expect(posts(c)).toEqual([]);
      expect(frete(c).estado).toBe('error');
    }
    expect(agendar).not.toHaveBeenCalled();
  });

  it('★ aceita with a stored error ⇒ aguardandoAgendamento + nfe-validada resolved (the same write shape), then the seam', async () => {
    const agendar = vi.fn(() => Promise.resolve());
    h.destino.agendar = agendar;
    const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    c.fake.seed(CAMINHO, {
      ...pedidoRaw(),
      freteInicial: { ...(pedidoRaw().freteInicial as Record<string, unknown>), estado: 'error' },
    });
    c.fake.seed(caminhoAviso(CHAVE_AVISO), {
      tipo: 'nfeUploadRejeitado',
      conta: CONTA,
      entidade: PEDIDO_ID,
      severidade: 'atencao',
      canal: 'amazon',
      params: { pedido: ORDER, erro: 'x' },
      motivo: 'nfe-recusada',
      urlInterna: { rota: '/pedidos/x', campo: null },
      relogioEvento: 1,
      criadoEm: 1,
      atualizadoEm: 1,
      ocorrencias: 1,
      resolvidoEm: null,
      resolucaoMotivo: null,
    });
    const r = await c.rodar(verificacao(1));
    expect(r).toMatchObject({ acao: 'aceita', carimbo: 'limpo' });
    expect(frete(c)).toMatchObject({
      estado: 'aguardandoAgendamento',
      ultimaModificacao: RELOGIO_PEDIDO_US,
    });
    // (mutation 10) the TOP-LEVEL clock the update monitor reads, bumped in µs.
    expect(c.fake.ler(CAMINHO)?.ultimaModificacao).toBe(AGORA_MS * 1000);
    expect(aviso(c)).toMatchObject({ resolucaoMotivo: 'nfe-validada' });
    expect(aviso(c)?.resolvidoEm).not.toBeNull();
    expect(agendar).toHaveBeenCalledExactlyOnceWith(
      { contaId: CONTA, pedidoId: PEDIDO_ID, nfeId: NFE_ID, orderId: ORDER },
      {
        agendamento: c.agendamentos.produtor,
        logger: expect.any(Object) as unknown,
        idTarefa: 'tarefa-nfe-teste-1',
        ultimaTentativa: false,
      },
    );
  });

  it('★ the step-15 seam is FILLED (step 15, PR 15-c): the real table’s agendar IS E1, enqueue-only', async () => {
    const real = await vi.importActual<typeof import('./destinoAceite')>('./destinoAceite');
    expect(real.DESTINO_ACEITE_NFE_AMAZON.agendar).toBe(enfileirarAgendamentoDoAceiteAmazon);
    expect(Object.keys(real.DESTINO_ACEITE_NFE_AMAZON)).toEqual(['agendar']);
  });
});

describe('★ step 15 (PR 15-c) — E1 through the seam: the REAL entry, ONE enqueue, never an Amazon call', () => {
  const NOME_E1 = idDaTarefaDeAgendamentoAmazon({
    origem: 'aceite-nfe',
    idTarefaNfe: 'tarefa-nfe-teste-1',
  });
  const linhasDoAgendamento = (c: Cenario) =>
    c.log.linhas.filter((l) => l.meta?.evento === 'agendamento');

  beforeEach(() => {
    h.destino.agendar = enfileirarAgendamentoDoAceiteAmazon;
  });

  it('★ aceita ⇒ the producer’s enfileirarEntrada ONCE: origem aceite-nfe, delay 60, named after the dispatch’s registro.idTarefa — and ZERO extra fetch calls', async () => {
    const semSeam = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    h.destino.agendar = null;
    await semSeam.rodar();
    h.destino.agendar = enfileirarAgendamentoDoAceiteAmazon;

    const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'aceita', motivo: 'ja-aceita', posEnvio: null });
    expect(c.agendamentos.enfileiradas).toEqual([
      {
        tarefa: {
          pedidoId: PEDIDO_ID,
          contaId: CONTA,
          orderId: ORDER,
          origem: 'aceite-nfe',
          espera: 0,
          pausas: 0,
        },
        id: NOME_E1,
        atrasoS: 60,
      },
    ]);
    // (mutation 1) The seam made NO call: the dispatch's fetch list is the same without it.
    expect(c.chamadas).toEqual(semSeam.chamadas);
    expect(posts(c)).toEqual([]);
    // The NF-e queue's own producer was never asked for a scheduling task.
    expect(c.enfileiradas).toEqual([]);
  });

  it('★ NEAR-MISS: a queue retry of the SAME NF-e task enqueues under the SAME name (ja-enfileirada, ONE INFO line); a re-drive’s new NF-e task under a new one', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    await c.rodar();
    c.tentativa = 1;
    expect(await c.rodar()).toMatchObject({ acao: 'aceita' });
    expect(c.agendamentos.tentativas.map((t) => t.id)).toEqual([NOME_E1, NOME_E1]);
    expect(c.agendamentos.enfileiradas).toHaveLength(1);
    expect(linhasDoAgendamento(c)).toEqual([
      expect.objectContaining({
        nivel: 'info',
        meta: expect.objectContaining({ motivo: 'ja-enfileirada' }) as unknown,
      }),
    ]);

    const redrive = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    const deps = { ...redrive.deps(), registro: { tentativa: 0, idTarefa: 'tarefa-nfe-redrive' } };
    await processarNfeAmazon(asDb(redrive.fake), tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID), deps);
    expect(redrive.agendamentos.enfileiradas.map((t) => t.id)).toEqual([
      idDaTarefaDeAgendamentoAmazon({ origem: 'aceite-nfe', idTarefaNfe: 'tarefa-nfe-redrive' }),
    ]);
  });

  it('★ (mutation 2) the tasks valve closed ⇒ ONE WARNING and NO throw on attempt 0: the NF-e result is still aceita', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    c.agendamentos.desligado = true;
    expect(await c.rodar()).toMatchObject({ acao: 'aceita', motivo: 'ja-aceita', posEnvio: null });
    expect(c.agendamentos.tentativas).toEqual([]);
    expect(linhasDoAgendamento(c)).toEqual([
      expect.objectContaining({
        nivel: 'warn',
        meta: expect.objectContaining({
          motivo: 'agendamento-nao-enfileirado',
          erro: 'AmazonAgendamentoTarefasDesligadasError',
        }) as unknown,
      }),
    ]);
  });

  it('★ (mutation 17) a TRANSIENT RETHROWS out of aceita on attempt 0 — the retry makes ZERO submit POSTs and enqueues under the SAME name; on the LAST attempt it is the WARNING, no throw', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    c.agendamentos.falha = () => falhaDoFunctions('unknown-error', 503);
    await expect(c.rodar()).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
    expect(linhasDoAgendamento(c)).toEqual([]);

    // The queue's retry of the SAME dispatch: status first (Accepted), no submit.
    c.agendamentos.falha = null;
    c.tentativa = 1;
    expect(await c.rodar()).toMatchObject({ acao: 'aceita' });
    expect(posts(c)).toEqual([]);
    expect(c.agendamentos.tentativas.map((t) => t.id)).toEqual([NOME_E1, NOME_E1]);
    expect(c.agendamentos.enfileiradas.map((t) => t.id)).toEqual([NOME_E1]);

    // The LAST attempt: the edge is answered by the WARNING, never a throw.
    const ultima = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    ultima.agendamentos.falha = () => falhaDoFunctions('unknown-error', 503);
    ultima.tentativa = TENTATIVAS_NFE_AMAZON - 1;
    expect(await ultima.rodar()).toMatchObject({ acao: 'aceita', posEnvio: null });
    expect(linhasDoAgendamento(ultima)).toEqual([
      expect.objectContaining({
        nivel: 'warn',
        meta: expect.objectContaining({
          motivo: 'agendamento-nao-enfileirado',
          erro: 'AmazonTarefasTransitoriasError',
        }) as unknown,
      }),
    ]);
  });

  it('★ a transient that had in fact LANDED: the retry’s enqueue answers ja-enfileirada (one INFO line), nothing duplicated', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    // Cloud Tasks already holds the name the first attempt sent before its answer was lost.
    c.agendamentos.nomes.add(NOME_E1);
    c.tentativa = 1;
    expect(await c.rodar()).toMatchObject({ acao: 'aceita' });
    expect(c.agendamentos.enfileiradas).toEqual([]);
    expect(linhasDoAgendamento(c)).toHaveLength(1);
    expect(linhasDoAgendamento(c)[0]).toMatchObject({ nivel: 'info' });
  });

  it('★ an unnamed TypeError from the producer PROPAGATES out of the dispatch', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    const bug = new TypeError('teste: um bug no produtor');
    const deps: DepsProcessarNfeAmazon = {
      ...c.deps(),
      agendamento: () => ({
        enfileirarEntrada: () => Promise.reject(bug),
        enfileirar: () => Promise.reject(bug),
      }),
    };
    await expect(
      processarNfeAmazon(asDb(c.fake), tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID), deps),
    ).rejects.toBe(bug);
  });

  it('★ E1 is never called with a cancelled sibling (nfe-substituta), an ambiguous pedido (nfe-ambigua), a partial acceptance or on a cancelled read: nothing reaches the scheduling queue', async () => {
    const substituta = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    substituta.fake.seed(`${CAMINHO}/nfev4/s9`, nfeRaw({ estado: ESTADO_NFE.cancelada }));
    expect(await substituta.rodar()).toMatchObject({ motivo: 'nfe-substituta' });

    const ambigua = cenario({ status: [{ status: 200, corpo: STATUS.aceita }] });
    ambigua.fake.seed(`${CAMINHO}/nfev4/s9`, nfeRaw());
    expect(await ambigua.rodar()).toMatchObject({ motivo: 'nfe-ambigua' });

    const parcial = cenario({
      status: [{ status: 200, corpo: { orderInvoicingStatus: 'PartiallyAccepted' } }],
    });
    expect(await parcial.rodar()).toMatchObject({ motivo: 'nfe-parcialmente-aceita' });

    const cancelada = cenario({ getOrder: [ordem({ status: 'CANCELLED' })] });
    await cancelada.rodar(verificacao(2));

    for (const c of [substituta, ambigua, parcial, cancelada]) {
      expect(c.agendamentos.tentativas).toEqual([]);
      expect(c.agendamentos.construcoes).toBe(0);
    }
  });
});

describe('P10 — the submit and everything after it: a NO-THROW boundary', () => {
  it.each<[string, Roteiro, Record<string, unknown>, boolean]>([
    [
      '★ (mutation 5) a 5xx',
      { status: 503, corpo: erro('ServiceUnavailable') },
      { envio: 'incerto' },
      true,
    ],
    ['a 2xx off its schema', { status: 200, corpo: { errors: 'x' } }, { envio: 'incerto' }, true],
    ['a dropped connection', { rede: true }, { envio: 'incerto' }, true],
  ])(
    '%s ⇒ NO throw, ONE POST, the verification with envioIncerto true',
    async (_c, resposta, esperado) => {
      const c = cenario({ envio: [resposta] });
      const r = await c.rodar();
      expect(r).toMatchObject({ acao: 'enfileirado', ...esperado });
      expect(posts(c)).toHaveLength(1);
      expect(c.enfileiradas[0]?.tarefa).toMatchObject({
        fase: 'verificacao',
        envioIncerto: true,
        leituraAntes: 'sem-nota',
        reenvios: 0,
      });
      expect(c.fake.escritas).toEqual([]);
    },
  );

  it.each<[string, Roteiro, string, boolean]>([
    ['a 2xx errors list', { status: 200, corpo: erro('InvalidInput') }, 'envio-recusado', true],
    [
      '★ NEAR-MISS a 400 InvalidInput',
      { status: 400, corpo: erro('InvalidInput') },
      'envio-recusado',
      true,
    ],
    ['a 415', { status: 415, corpo: erro('UnsupportedMediaType') }, 'envio-recusado', true],
    [
      'a 413 (a BARE array body)',
      { status: 413, corpo: [{ code: 'RequestEntityTooLarge' }] },
      'nfe-grande-demais',
      true,
    ],
    [
      '★ a 400 EntityNotFound',
      { status: 400, corpo: erro('EntityNotFound') },
      'pedido-nao-encontrado-na-amazon',
      false,
    ],
    ['a 404', { status: 404, corpo: erro('NotFound') }, 'pedido-nao-encontrado-na-amazon', false],
  ])('%s ⇒ aviso %s, stamp %s, no throw, ONE POST', async (_c, resposta, motivo, carimba) => {
    const c = cenario({ envio: [resposta] });
    const r = await c.rodar();
    expect(r).toMatchObject({ acao: 'avisado', motivo });
    expect(posts(c)).toHaveLength(1);
    expect(aviso(c)).toMatchObject({ motivo });
    expect(frete(c).estado).toBe(carimba ? 'error' : 'aguardandoNFe');
    expect(c.enfileiradas).toEqual([]);
  });

  it('a second 401 on the submit ⇒ sem-permissao (one forced refresh, TWO POSTs, no stamp)', async () => {
    const c = cenario({
      envio: [
        { status: 401, corpo: erro('Unauthorized') },
        { status: 401, corpo: erro('Unauthorized') },
      ],
    });
    expect(await c.rodar()).toMatchObject({ acao: 'avisado', motivo: 'sem-permissao' });
    expect(posts(c)).toHaveLength(2);
    expect(c.chamadas.filter((x) => x === 'LWA')).toHaveLength(1);
    expect(frete(c).estado).toBe('aguardandoNFe');
  });

  it('an AmazonConfigError (nothing was sent) is a BUG: rethrown, sanitized, zero POST', async () => {
    h.md5Hex = true;
    const c = cenario();
    await expect(c.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    expect(posts(c)).toEqual([]);
  });

  it('★ (mutation 6) the aviso write fails with a Firestore error ⇒ NO throw, the stamp still made, ONE pos-envio-falhou WARNING', async () => {
    const c = cenario({ envio: [{ status: 400, corpo: erro('InvalidInput') }] });
    c.fake.falharEscrita(caminhoAviso(CHAVE_AVISO), grpc(14, 'UNAVAILABLE'));
    const r = await c.rodar();
    expect(r).toMatchObject({
      acao: 'avisado',
      motivo: 'envio-recusado',
      posEnvio: { escrita: 'aviso', erro: 'Firestore/14' },
    });
    expect(frete(c).estado).toBe('error');
    registrarDespachoNfeAmazon(c.log.logger, r, { tentativa: 0, idTarefa: 'x' });
    const linhas = c.log.linhas.filter((l) => l.meta?.fila === 'processAmazonNfeUpload');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      nivel: 'warn',
      meta: {
        motivo: 'pos-envio-falhou',
        desfecho: 'envio-recusado',
        escritaPerdida: 'aviso',
        erro: 'Firestore/14',
      },
    });
  });

  it('★ (mutation 6) the stamp loses its precondition three times ⇒ NO throw, pos-envio-falhou (carimbo)', async () => {
    const c = cenario({ envio: [{ status: 400, corpo: erro('InvalidInput') }] });
    for (let i = 0; i < 3; i += 1) {
      c.fake.antesDaProximaEscrita(CAMINHO, () => {
        c.fake.seed(CAMINHO, pedidoRaw());
      });
    }
    const r = await c.rodar();
    expect(r.posEnvio).toEqual({ escrita: 'carimbo', erro: 'AmazonNfeCarimboEmConflitoError' });
    expect(aviso(c)).toMatchObject({ motivo: 'envio-recusado' });
  });

  it.each<[string, () => unknown, boolean]>([
    ['a transient (503)', () => falhaDoFunctions('functions/unknown-error', 503), false],
    ['the queue valve', () => null, true],
  ])(
    '★ (mutation 6) the verification enqueue lost to %s after an ACCEPTED submit ⇒ NO throw, aceite-nao-confirmado',
    async (_c, falha, valvula) => {
      const c = cenario();
      if (valvula) c.filaDesligada = true;
      else c.falhaDaFila = falha;
      const r = await c.rodar();
      expect(r).toMatchObject({
        acao: 'avisado',
        motivo: 'aceite-nao-confirmado',
        envio: 'aceito',
        posEnvio: {
          escrita: 'enfileiramento',
          erro: valvula ? 'AmazonNfeTarefasDesligadasError' : 'AmazonTarefasTransitoriasError',
        },
      });
      expect(posts(c)).toHaveLength(1);
      expect(aviso(c)).toMatchObject({ motivo: 'aceite-nao-confirmado' });
      expect(frete(c).estado).toBe('aguardandoNFe');
    },
  );

  it('the verification enqueue lost after an UNCERTAIN submit ⇒ envio-nao-confirmado', async () => {
    const c = cenario({ envio: [{ status: 500, corpo: {} }] });
    c.falhaDaFila = () => falhaDoFunctions('functions/unknown-error', 503);
    expect(await c.rodar()).toMatchObject({ motivo: 'envio-nao-confirmado', envio: 'incerto' });
  });

  it('★ (mutation 6) a RAW SDK failure the producer rethrew (403 permission-denied: a queue without the IAM grant) on the verification enqueue after an ACCEPTED submit ⇒ NO throw, ONE POST, aceite-nao-confirmado', async () => {
    const c = cenario();
    c.falhaDaFila = () => falhaDoFunctions('permission-denied', 403);
    expect(await c.rodar()).toMatchObject({
      acao: 'avisado',
      motivo: 'aceite-nao-confirmado',
      envio: 'aceito',
      posEnvio: {
        escrita: 'enfileiramento',
        erro: 'FirebaseFunctionsError/functions/permission-denied',
      },
    });
    expect(posts(c)).toHaveLength(1);
  });

  it.each<[string, () => string, string]>([
    [
      'no region (MissingRegionError)',
      () => requireRegion({ AMAZON_TASKS_REGION: undefined, FUNCTIONS_REGION: '' }),
      'MissingRegionError',
    ],
    [
      'a region outside the queue-path grammar',
      () => caminhoDaFilaNfeAmazon('regiao/invalida'),
      'AmazonNfeRegiaoDaFilaInvalidaError',
    ],
  ])(
    '★ (mutation 6) the root resolving the queue per enqueue refuses after an ACCEPTED submit — %s ⇒ NO throw, ONE POST (the retry would resubmit), aceite-nao-confirmado',
    async (_c, resolverFila, classe) => {
      const c = cenario();
      const deps: DepsProcessarNfeAmazon = {
        ...c.deps(),
        agendador: () =>
          criarAgendadorNfeAmazon({
            desligado: false,
            // As `functions/src/agendadorNfe.ts` binds it: the region resolved PER enqueue.
            fila: () => {
              resolverFila();
              throw new RangeError('teste: a raiz deveria ter recusado antes');
            },
          }),
      };
      const r = await processarNfeAmazon(
        asDb(c.fake),
        tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID),
        deps,
      );
      expect(r).toMatchObject({
        acao: 'avisado',
        motivo: 'aceite-nao-confirmado',
        posEnvio: { escrita: 'enfileiramento', erro: classe },
      });
      expect(posts(c)).toHaveLength(1);
    },
  );

  it('(nit) only the FIRST lost write names the line: the verification enqueue AND its aceite-nao-confirmado aviso both lost ⇒ escrita enfileiramento', async () => {
    const c = cenario();
    c.falhaDaFila = () => falhaDoFunctions('unknown-error', 503);
    c.fake.falharEscrita(caminhoAviso(CHAVE_AVISO), grpc(14, 'UNAVAILABLE'));
    expect(await c.rodar()).toMatchObject({
      acao: 'avisado',
      motivo: 'aceite-nao-confirmado',
      aviso: null,
      posEnvio: { escrita: 'enfileiramento', erro: 'AmazonTarefasTransitoriasError' },
    });
    expect(aviso(c)).toBeUndefined();
  });

  it.each<[string, (c: Cenario) => void, string, string]>([
    [
      'a transient',
      (c) => {
        c.falhaDaFila = () => falhaDoFunctions('unknown-error', 503);
      },
      'amazon-indisponivel',
      'AmazonTarefasTransitoriasError',
    ],
    [
      'the queue valve',
      (c) => {
        c.filaDesligada = true;
      },
      'tarefas-desligadas',
      'AmazonNfeTarefasDesligadasError',
    ],
  ])(
    '★ a 429 on the SUBMIT (not processed: the NF-e is NOT at Amazon) whose pause enqueue is lost to %s ⇒ NO throw, ONE POST, the aviso %s, one pos-envio-falhou WARNING',
    async (_c, perder, motivo, classe) => {
      const c = cenario({ envio: [{ status: 429, corpo: erro('QuotaExceeded') }] });
      perder(c);
      const r = await c.rodar();
      expect(r).toMatchObject({
        acao: 'avisado',
        motivo,
        envio: 'nao-processado',
        proxima: null,
        posEnvio: { escrita: 'enfileiramento', erro: classe },
      });
      expect(posts(c)).toHaveLength(1);
      expect(aviso(c)).toMatchObject({ motivo, resolvidoEm: null });
      expect(frete(c).estado).toBe('aguardandoNFe');
      registrarDespachoNfeAmazon(c.log.logger, r, { tentativa: 0, idTarefa: 'x' });
      const linhas = c.log.linhas.filter((l) => l.meta?.fila === 'processAmazonNfeUpload');
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({
        nivel: 'warn',
        meta: { motivo: 'pos-envio-falhou', desfecho: motivo, escritaPerdida: 'enfileiramento' },
      });
    },
  );

  it('★ (nit) a 3xx on the submit (a redirect, never followed: not processed) ⇒ aviso status-nfe-desconhecido, NO stamp — the status read reads a 3xx the same way', async () => {
    const c = cenario({ envio: [{ status: 302, corpo: {} }] });
    expect(await c.rodar()).toMatchObject({
      acao: 'avisado',
      motivo: 'status-nfe-desconhecido',
      envio: 'nao-processado',
      carimbo: null,
    });
    expect(posts(c)).toHaveLength(1);
    expect(aviso(c)).toMatchObject({ motivo: 'status-nfe-desconhecido' });
    expect(frete(c).estado).toBe('aguardandoNFe');
    expect(c.enfileiradas).toEqual([]);
  });

  it.each<[string, (c: Cenario) => (url: URL, metodo: string) => Response | null]>([
    [
      'the credential deleted while the POST was out',
      (c) => (url, metodo) => {
        if (url.pathname === '/delivery/2022-07-01/invoice' && metodo === 'POST') {
          c.fake.apagar(caminhoCredencial(CONTA));
        }
        return null;
      },
    ],
    [
      'LWA refusing the forced refresh (invalid_grant)',
      () => {
        let postou = false;
        return (url, metodo) => {
          if (url.pathname === '/delivery/2022-07-01/invoice' && metodo === 'POST') postou = true;
          if (url.pathname === '/auth/o2/token' && postou) {
            return respostaJson(400, { error: 'invalid_grant' });
          }
          return null;
        };
      },
    ],
  ])(
    '★ a 401 on the submit, then %s at the forced refresh ⇒ conta-indisponivel, NO throw, ONE POST, no stamp',
    async (_c, montarDesvio) => {
      const c = cenario({ envio: [{ status: 401, corpo: erro('Unauthorized') }] });
      const base = c.deps();
      const desvio = montarDesvio(c);
      const deps: DepsProcessarNfeAmazon = {
        ...base,
        fetch: (input, init) => {
          const r = desvio(new URL(String(input)), init?.method ?? 'GET');
          return r === null ? (base.fetch ?? fetch)(input, init) : Promise.resolve(r);
        },
      };
      const r = await processarNfeAmazon(
        asDb(c.fake),
        tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID),
        deps,
      );
      expect(r).toMatchObject({
        acao: 'avisado',
        motivo: 'conta-indisponivel',
        envio: 'nao-processado',
      });
      expect(posts(c)).toHaveLength(1);
      expect(frete(c).estado).toBe('aguardandoNFe');
    },
  );

  it('an UNNAMED failure after the submit crosses the boundary (a bug)', async () => {
    const c = cenario();
    c.falhaDaFila = () => new RangeError('bug');
    await expect(c.rodar()).rejects.toBeInstanceOf(RangeError);
    expect(posts(c)).toHaveLength(1);
  });
});

describe('P11 — 429 pauses, transients retry, the last attempt answers', () => {
  it.each<[string, Partial<Record<Rota, Roteiro[]>>]>([
    ['the status read', { status: [{ status: 429, corpo: erro('QuotaExceeded') }] }],
    ['the submit', { envio: [{ status: 429, corpo: erro('QuotaExceeded') }] }],
    ['getOrder', { getOrder: [{ status: 429, corpo: erro('QuotaExceeded') }] }],
  ])(
    '★ (mutation 20) a 429 on %s ⇒ ONE delayed re-enqueue with pausas + 1, NO throw',
    async (_c, rotas) => {
      const c = cenario(rotas);
      const r = await c.rodar();
      expect(r).toMatchObject({ acao: 'pausado', motivo: 'taxa-limitada' });
      expect(c.enfileiradas).toEqual([
        {
          tarefa: { ...tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID), pausas: 1 },
          atrasoS: PAUSAS_NFE_AMAZON_S[0],
        },
      ]);
    },
  );

  it('★ at the pause bound ⇒ amazon-indisponivel (envio); the next rung (verificacao)', async () => {
    const c = cenario({ status: [{ status: 429, corpo: {} }] });
    const r = await c.rodar({
      ...tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID),
      pausas: PAUSAS_NFE_AMAZON_S.length,
    });
    expect(r).toMatchObject({ acao: 'avisado', motivo: 'amazon-indisponivel' });
    expect(c.enfileiradas).toEqual([]);
    const d = cenario({ status: [{ status: 429, corpo: {} }] });
    const v = { ...verificacao(2), pausas: PAUSAS_NFE_AMAZON_S.length };
    expect(await d.rodar(v)).toMatchObject({ acao: 'enfileirado' });
    expect(d.enfileiradas[0]).toEqual({
      tarefa: { ...verificacao(3), pausas: 0 },
      atrasoS: ESCADA_VERIFICACAO_NFE_AMAZON_S[3],
    });
  });

  it('a 5xx on the status read THROWS for the queue (no submit); on the LAST attempt: envio ⇒ amazon-indisponivel', async () => {
    const c = cenario({ status: [{ status: 503, corpo: {} }] });
    await expect(c.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    expect(posts(c)).toEqual([]);
    const d = cenario({ status: [{ status: 503, corpo: {} }] });
    d.tentativa = TENTATIVAS_NFE_AMAZON - 1;
    expect(await d.rodar()).toMatchObject({ acao: 'avisado', motivo: 'amazon-indisponivel' });
    // NEAR-MISS: the attempt BEFORE the last still throws — the queue's last attempt is not skipped.
    const n = cenario({ status: [{ status: 503, corpo: {} }] });
    n.tentativa = TENTATIVAS_NFE_AMAZON - 2;
    await expect(n.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
  });

  it('★ a cut connection on the status read is a transient too: it throws, and on the LAST attempt envio ⇒ amazon-indisponivel', async () => {
    const c = cenario({ status: [{ rede: true }] });
    await expect(c.rodar()).rejects.toBeInstanceOf(FalhaTarefaAmazonError);
    expect(posts(c)).toEqual([]);
    const d = cenario({ status: [{ rede: true }] });
    d.tentativa = TENTATIVAS_NFE_AMAZON - 1;
    expect(await d.rodar()).toMatchObject({ acao: 'avisado', motivo: 'amazon-indisponivel' });
    expect(posts(d)).toEqual([]);
  });

  /** Every chain step a dispatch enqueues BEFORE any submit of its own, one case each. */
  const ANTES_DO_ENVIO: [
    string,
    Partial<Record<Rota, Roteiro[]>>,
    () => TarefaNfeAmazon,
    string,
  ][] = [
    [
      'a verification’s next rung',
      { status: [{ status: 200, corpo: STATUS.processando }] },
      () => verificacao(1),
      'aceite-nao-confirmado',
    ],
    [
      'the read-back of an envio reading processando',
      { status: [{ status: 200, corpo: STATUS.processando }] },
      () => tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID),
      'aceite-nao-confirmado',
    ],
    [
      'the 429 pause (envio)',
      { getOrder: [{ status: 429, corpo: erro('QuotaExceeded') }] },
      () => tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID),
      'amazon-indisponivel',
    ],
    [
      'the 429 pause (verificacao)',
      { status: [{ status: 429, corpo: erro('QuotaExceeded') }] },
      () => verificacao(1),
      'aceite-nao-confirmado',
    ],
    [
      'the one resubmit',
      { status: [{ status: 200, corpo: STATUS.semNota }] },
      () => verificacao(2, { incerto: true }),
      'envio-nao-confirmado',
    ],
  ];

  it.each(ANTES_DO_ENVIO)(
    '★ the queue valve closed before any submit — %s ⇒ NO throw on ANY attempt, the aviso tarefas-desligadas (the worklist), zero POST',
    async (_c, rotas, tarefa) => {
      const c = cenario(rotas);
      c.filaDesligada = true;
      const r = await c.rodar(tarefa());
      expect(r).toMatchObject({
        acao: 'avisado',
        motivo: 'tarefas-desligadas',
        carimbo: null,
        posEnvio: null,
      });
      expect(aviso(c)).toMatchObject({ motivo: 'tarefas-desligadas', resolvidoEm: null });
      expect(c.enfileiradas).toEqual([]);
      expect(posts(c)).toEqual([]);
      expect(frete(c).estado).toBe('aguardandoNFe');
    },
  );

  it.each(ANTES_DO_ENVIO)(
    '★ a transient enqueue failure before any submit — %s ⇒ THROWS for the retry, and on the LAST attempt the aviso %s (never a silent drop)',
    async (_c, rotas, tarefa, motivo) => {
      const c = cenario(rotas);
      c.falhaDaFila = () => falhaDoFunctions('unknown-error', 503);
      c.tentativa = TENTATIVAS_NFE_AMAZON - 2;
      await expect(c.rodar(tarefa())).rejects.toBeInstanceOf(AmazonTarefasTransitoriasError);
      expect(aviso(c)).toBeUndefined();
      const d = cenario(rotas);
      d.falhaDaFila = () => falhaDoFunctions('unknown-error', 503);
      d.tentativa = TENTATIVAS_NFE_AMAZON - 1;
      expect(await d.rodar(tarefa())).toMatchObject({ acao: 'avisado', motivo, posEnvio: null });
      expect(aviso(d)).toMatchObject({ motivo });
      expect(posts(d)).toEqual([]);
    },
  );

  it('a Firestore error before the submit rethrows on every attempt (the last one included)', async () => {
    const c = cenario();
    c.tentativa = TENTATIVAS_NFE_AMAZON - 1;
    c.fake.falharLeitura(CAMINHO, grpc(14, 'UNAVAILABLE'));
    await expect(c.rodar()).rejects.toMatchObject({ code: 14 });
  });
});

describe('the verification ladder', () => {
  it('★ each rung waits ESCADA_VERIFICACAO_NFE_AMAZON_S[degrau] (scheduleDelaySeconds)', async () => {
    for (let degrau = 0; degrau < 9; degrau += 1) {
      const c = cenario({ status: [{ status: 200, corpo: STATUS.processando }] });
      await c.rodar(verificacao(degrau));
      expect(c.enfileiradas, String(degrau)).toEqual([
        {
          tarefa: expect.objectContaining({ degrau: degrau + 1, pausas: 0 }),
          atrasoS: ESCADA_VERIFICACAO_NFE_AMAZON_S[degrau + 1],
        },
      ]);
    }
  });

  it('★ rung 9 still processing ⇒ aviso aceite-nao-confirmado, NO stamp, NO re-enqueue', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.processando }] });
    expect(await c.rodar(verificacao(9))).toMatchObject({
      acao: 'avisado',
      motivo: 'aceite-nao-confirmado',
      carimbo: null,
    });
    expect(c.enfileiradas).toEqual([]);
    expect(frete(c).estado).toBe('aguardandoNFe');
  });

  it('★ recusada after OUR confirmed submit ⇒ aviso + stamp nfe-recusada (over aguardandoNFe: error, the top-level µs bumped, the nested clock carried)', async () => {
    const c = cenario({ status: [{ status: 200, corpo: STATUS.recusada }] });
    // A LATER stamp than the pedido's own: P3's read time is this marker's, never the pedido's updateTime.
    const marcador = c.fake.seed('marcador/relogio', { x: 1 });
    const r = await c.rodar(verificacao(2));
    expect(r).toMatchObject({ acao: 'avisado', motivo: 'nfe-recusada', carimbo: 'carimbado' });
    const doc = c.fake.ler(CAMINHO) ?? {};
    expect(frete(c)).toMatchObject({ estado: 'error', ultimaModificacao: RELOGIO_PEDIDO_US });
    expect(doc.ultimaModificacao).toBe(AGORA_MS * 1000);
    expect(doc.lastMarketplaceUpdate).toBe(RELOGIO_PEDIDO_US);
    // The aviso is clocked by P3's pedido read time (the Firestore timeline), EXACTLY.
    expect(aviso(c)?.relogioEvento).toBe(relogioDoDocumentoUs(marcador));
  });

  it('★ INTEGRATION — the one-resubmit bound end to end: 5xx ⇒ … ⇒ sem-nota@2 ⇒ resubmit ⇒ 5xx ⇒ … ⇒ sem-nota@2 ⇒ envio-nao-confirmado, EXACTLY two POSTs', async () => {
    const c = cenario({ envio: [{ status: 503, corpo: {} }] });
    let tarefa: TarefaNfeAmazon | undefined = tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID);
    const fases: string[] = [];
    let ultimo: ResultadoNfeAmazon | null = null;
    for (let passo = 0; passo < 20 && tarefa !== undefined; passo += 1) {
      fases.push(`${tarefa.fase}@${String(tarefa.degrau)}/r${String(tarefa.reenvios)}`);
      const antes = c.enfileiradas.length;
      ultimo = await c.rodar(tarefa);
      tarefa = c.enfileiradas.length > antes ? c.enfileiradas.at(-1)?.tarefa : undefined;
    }
    expect(posts(c)).toHaveLength(2);
    expect(ultimo).toMatchObject({ acao: 'avisado', motivo: 'envio-nao-confirmado' });
    expect(fases).toEqual([
      'envio@0/r0',
      'verificacao@0/r0',
      'verificacao@1/r0',
      'verificacao@2/r0',
      'envio@0/r1',
      'verificacao@0/r1',
      'verificacao@1/r1',
      'verificacao@2/r1',
    ]);
    expect(frete(c).estado).toBe('aguardandoNFe');
  });
});

describe('the logs', () => {
  it('★ no line carries the XML, its base64, the digest, a 44-digit run or a base64 run of 32+ (only the 64-hex ids)', async () => {
    const cenarios = [
      cenario(),
      cenario({ envio: [{ status: 400, corpo: erro('InvalidInput') }] }),
      cenario({ envio: [{ status: 503, corpo: {} }] }),
    ];
    cenarios[1]?.fake.falharEscrita(caminhoAviso(CHAVE_AVISO), grpc(14, 'UNAVAILABLE'));
    for (const c of cenarios) {
      const r = await c.rodar();
      registrarDespachoNfeAmazon(c.log.logger, r, { tentativa: 0, idTarefa: 'tarefa-1' });
      for (const linha of c.log.linhas) {
        const texto = JSON.stringify(linha);
        expect(texto).not.toContain('nfeProc');
        expect(texto).not.toContain(CONTEUDO.invoiceContent.slice(0, 32));
        expect(texto).not.toContain(CONTEUDO.contentMD5Value);
        expect(texto).not.toContain('contentMD5Value');
        expect(texto).not.toMatch(/\d{44}/);
        for (const run of texto.match(/[A-Za-z0-9+/=]{32,}/g) ?? []) {
          expect(run, run).toMatch(/^[0-9a-f]{64}$/);
        }
      }
      // ÂNCORA: the dispatch line was written and names the flow.
      expect(c.log.linhas.at(-1)?.meta).toMatchObject({ evento: 'nfe', fluxo: FLUXO_AMAZON.nfe });
    }
  });
});
