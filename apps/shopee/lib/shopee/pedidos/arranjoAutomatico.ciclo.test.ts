/**
 * Step 15b's Entrega Turbo lifecycle END TO END (#1744, review Q3-3): the REAL
 * handler (`rastrearPedidoShopee`) → the real frete transaction → the real
 * despacho resolver → the real hook (`arranjarPacoteAutomatico`) → the real aviso
 * table and executor → the real `escreverAviso` / `resolverAviso`, over
 * `testing/fakeDb`. ONLY the Shopee client is fake, and even it answers through
 * the package's own payload schemas and runs `assertShipOrderParams` on every
 * ship body (RT3).
 *
 * Why it exists: each neighbouring suite mocks one side of the hook → table
 * contract — `arranjoAutomatico.test.ts` the producer, `rastrearPedido.test.ts`
 * the arrange, `despachoAutomatico.test.ts` the hook, `notificacao.test.ts` the
 * handler — so a SEMANTIC drift stays green in all four: `fase` reported
 * post-arrange (rule N silently off), `motivo` dropped on `nao-elegivel` (a
 * cancelled order never closes the print row), the confirmed frete estado not
 * handed to the table (a stale row reopens what a newer delivery closed). Only
 * the TS type held that contract.
 *
 * ⚠️ The ONE substitution is the arm's wiring: the hook's `avisar` is the
 * default's own body (`acoesDeAvisoDoDespacho`, then the executor) with
 * fakeDb's `increment` sentinel in place of `FieldValue.increment`, and the
 * valve reads an EMPTY env, so a stray `SHOPEE_ARRANJO_AUTOMATICO_DISABLED` on
 * the runner cannot turn every case into `desligado`.
 *
 * Fixtures are the wave's synthetic ids only: conta `int-1`, shop 987654, order
 * `260910KJBHUJDM`, packages `OFG000000000001` / `OFG000000000002`, and 90011 —
 * announcement 1573's own example channel, never an account's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertShipOrderParams,
  shopeeOrderDetailPayloadSchema,
  shopeePackageDetailPayloadSchema,
  shopeeShippingParameterPayloadSchema,
  type GetOrderDetailParams,
  type GetPackageDetailParams,
  type GetShippingParameterParams,
  type ShipOrderParams,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  SEVERIDADE_AVISO,
  avisoSchema,
  freteDoPedidoSchema,
  seedFreteInicial,
} from '@delfrance/schemas';

import {
  CLASSE_DESPACHO_PENDENTE,
  RESOLUCAO_AVISO_DESPACHO,
  acoesDeAvisoDoDespacho,
  chaveAvisoDespachoPendente,
  chaveAvisoEtiquetaComPrazo,
  executarAcoesDeAvisoDoDespacho,
  resolverAvisosDeDespachoSeEncerrado,
  type ClasseDespachoPendente,
} from '../avisos/despachoAutomatico';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  arranjarPacoteAutomatico,
  type ArranjadorDePacote,
  type AvisadorDeArranjo,
  type EntradaArranjoAutomatico,
} from './arranjoAutomatico';
import { observadosDoDetalheDoPedido, type CodigoPushFrete } from './fretePushShopee';
import { makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import { SHOPEE_ORDER_STATUS } from './orderStatusMaps';
import { rastrearPedidoShopee, type AlvoDeRastreioShopee } from './rastrearPedido';

/* --------------------------------- fixtures --------------------------------- */

const CONTA = 'int-1';
const SHOP_ID = 987654;
const ORDER_SN = '260910KJBHUJDM';
const P1 = 'OFG000000000001';
const P2 = 'OFG000000000002';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
/** An Entrega Turbo channel — on 1573's list AND a print-deadline one. */
const TURBO = 90011;
/** A channel 1573 does not oblige (SPI-gated, out of the set). */
const FORA_DO_CANAL = 90021;
/** The pedido's own ORDER clock, SECONDS. Every package stamp sits after it. */
const T0_S = 1_788_973_354;
/** The task clock of the first delivery, ms — after every package stamp. */
const AGORA_MS = 1_789_000_000_000;

/**
 * A package clock `n` ticks after the order's, SECONDS. Each case names its
 * stamps explicitly, so "this row is OLDER than the stored one" is written in
 * the fixture instead of falling out of a call order.
 */
function t(n: number): number {
  return T0_S + 10 * n;
}

/** A raw `get_package_detail` row: a READY, un-arranged Turbo package at clock `n`. */
function linha(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_sn: ORDER_SN,
    package_number: P1,
    fulfillment_status: 'LOGISTICS_READY',
    logistics_channel_id: TURBO,
    is_shipment_arranged: false,
    update_time: t(n),
    ...extra,
  };
}

const ARRANJADO = { is_shipment_arranged: true } as const;
const REQUEST_CREATED = { fulfillment_status: 'LOGISTICS_REQUEST_CREATED', ...ARRANJADO } as const;
const PICKUP_DONE = { fulfillment_status: 'LOGISTICS_PICKUP_DONE', ...ARRANJADO } as const;
const DELIVERY_DONE = { fulfillment_status: 'LOGISTICS_DELIVERY_DONE', ...ARRANJADO } as const;
const NFE_PENDENTE = { invoice_pending: { status: 'pending' } } as const;
const NFE_VALIDA = { invoice_pending: { status: 'valid' } } as const;

/** A raw `get_order_detail` row: a READY local-seller order holding `pacotes`. */
function ordem(
  pacotes: readonly string[] = [P1],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    order_sn: ORDER_SN,
    order_status: 'READY_TO_SHIP',
    package_list: pacotes.map((package_number) => ({ package_number })),
    fulfillment_flag: 'fulfilled_by_local_seller',
    ...extra,
  };
}

function endereco(id: number) {
  return {
    address_id: id,
    region: 'BR',
    state: 'SP',
    city: 'Cidade do Vendedor',
    district: 'Centro',
    town: '',
    address: 'Rua do Vendedor, 100',
    zipcode: '00000-000',
    address_flag: ['pickup_address'],
    time_slot_list: [
      { date: 1_790_000_000, time_text: '09:00-12:00', pickup_time_id: `slot-${id}`, flags: null },
    ],
  };
}

/** One pickup address, one slot: the automatic rules decide with no question. */
const UM_ENDERECO = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: { address_list: [endereco(2001)] },
};

/** Two pickup addresses, no principal: the automatic rules cannot pick. */
const DOIS_ENDERECOS = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: { address_list: [endereco(2001), endereco(2002)] },
};

/* ------------------------------ the fake client ----------------------------- */

interface RespostasDaShopee {
  /** Raw `get_package_detail` rows — parsed by the package's own payload schema. */
  readonly linhas: readonly Record<string, unknown>[];
  /** Raw `get_order_detail` row. Default: READY, local seller, P1 alone. */
  readonly ordem?: Record<string, unknown>;
  /** Raw `get_shipping_parameter`. Default: {@link UM_ENDERECO}. */
  readonly parametro?: unknown;
}

function clienteFake(o: RespostasDaShopee) {
  const chamadas: string[] = [];
  const corpos: ShipOrderParams[] = [];
  const client = {
    getPackageDetail: async (_p: GetPackageDetailParams) => {
      chamadas.push('getPackageDetail');
      return shopeePackageDetailPayloadSchema.parse({ package_list: o.linhas });
    },
    getOrderDetail: async (_p: GetOrderDetailParams) => {
      chamadas.push('getOrderDetail');
      return shopeeOrderDetailPayloadSchema.parse({ order_list: [o.ordem ?? ordem()] });
    },
    getShippingParameter: async (_p: GetShippingParameterParams) => {
      chamadas.push('getShippingParameter');
      return shopeeShippingParameterPayloadSchema.parse(o.parametro ?? UM_ENDERECO);
    },
    shipOrder: async (p: ShipOrderParams) => {
      chamadas.push('shipOrder');
      // RT3: a body the client's own guard refuses would surface as a rethrow.
      assertShipOrderParams(p);
      corpos.push(p);
      return { error: '', message: null, request_id: null, warning: null };
    },
  } satisfies Pick<
    ShopeeClient,
    'getPackageDetail' | 'getOrderDetail' | 'getShippingParameter' | 'shipOrder'
  >;
  // Any OTHER client method the path reached would be a TypeError, and red.
  return { client: client as unknown as ShopeeClient, chamadas, corpos };
}

/* --------------------------------- the world -------------------------------- */

/** The arm's `avisar`: `avisarArranjoAutomatico`'s own body, fakeDb's sentinel. */
const avisar: AvisadorDeArranjo = async (db, e, r) => {
  await executarAcoesDeAvisoDoDespacho(db, e, acoesDeAvisoDoDespacho(e, r), {
    increment,
    nowMs: e.nowMs,
  });
};

interface Entrega extends RespostasDaShopee {
  /** The package the push names. Default P1. */
  readonly pacote?: string;
  /** The push code. Default 30. */
  readonly code?: CodigoPushFrete;
}

/** One pedido on the Turbo channel, seeded as step 5 imports it, and its deliveries. */
function novoCenario() {
  const db = new FakeDb();
  db.seed(`pedidos/${PEDIDO_ID}`, {
    estado: ESTADO_PEDIDO.pago,
    numero: ORDER_SN,
    itens: {},
    itensIds: [],
    valorCobrado: 31.99,
    lastMarketplaceUpdate: microsDeSegundosShopee(T0_S),
    ultimaModificacao: microsDeSegundosShopee(T0_S),
    freteInicial: freteDoPedidoSchema.parse({
      ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
      externalOptionIntegracao: 'shopee',
    }),
  });

  let agoraMs = AGORA_MS;
  /** Every entrada the HANDLER built for the hook, in order — never a hand-built one. */
  const entradas: EntradaArranjoAutomatico[] = [];
  const arranjar: ArranjadorDePacote = (d, client, e) => {
    entradas.push(e);
    return arranjarPacoteAutomatico(d, client, e, { env: {}, avisar });
  };

  /** One code-4/30/47 delivery through the handler, as the arm runs it. */
  async function entrega(o: Entrega) {
    agoraMs += 60_000;
    const code = o.code ?? 30;
    const f = clienteFake(o);
    const alvo: AlvoDeRastreioShopee = {
      integracaoId: CONTA,
      shopId: SHOP_ID,
      orderSn: ORDER_SN,
      packageNumber: o.pacote ?? P1,
      code,
      nowMs: agoraMs,
      diagnostico: {
        code,
        grafiaDoPedido: 'ordersn',
        trackingNoDoPush: null,
        statusDoPush: null,
        camposMudados: null,
        shipByDateAntigaS: null,
        shipByDateNovaS: null,
        canalAntigo: null,
        canalNovo: null,
        relogioDoPushS: null,
      },
    };
    const r = await rastrearPedidoShopee(asDb(db), alvo, {
      clientFor: async () => f.client,
      // The pedido exists in every case: a synthetic code 3 would be a bug here.
      scheduler: {
        enqueue: async () => {
          throw new Error('code 3 sintético inesperado: o pedido existe');
        },
      },
      arranjar,
    });
    return { r, chamadas: f.chamadas, corpos: f.corpos };
  }

  /** Open the print row the way the hook does — through the executor, on a REAL entrada. */
  async function abrirEtiquetaComEntrada(e: EntradaArranjoAutomatico) {
    agoraMs += 60_000;
    await executarAcoesDeAvisoDoDespacho(asDb(db), e, [{ tipo: 'abrir-etiqueta' }], {
      increment,
      nowMs: agoraMs,
    });
  }

  return { db, entrega, entradas, abrirEtiquetaComEntrada, agora: () => agoraMs };
}

/* --------------------------------- readers ---------------------------------- */

function caminhoDespacho(classe: ClasseDespachoPendente, pacote = P1): string {
  return `avisos/${chaveAvisoDespachoPendente(CONTA, PEDIDO_ID, pacote, classe)}`;
}
const NFE = (pacote = P1) => caminhoDespacho(CLASSE_DESPACHO_PENDENTE.nfe, pacote);
const MANUAL = (pacote = P1) => caminhoDespacho(CLASSE_DESPACHO_PENDENTE.manual, pacote);
const ETIQUETA = `avisos/${chaveAvisoEtiquetaComPrazo(CONTA, PEDIDO_ID)}`;

function lido(db: FakeDb, caminho: string): Record<string, unknown> | undefined {
  return db.store[caminho]?.data;
}
function aberto(db: FakeDb, caminho: string): boolean {
  const d = lido(db, caminho);
  return d !== undefined && d.resolvidoEm == null;
}
/** The stored row through the REAL aviso schema — what the web reads back. */
function aviso(db: FakeDb, caminho: string) {
  const d = lido(db, caminho);
  if (d === undefined) throw new Error(`aviso ausente: ${caminho}`);
  return avisoSchema.parse(d);
}

beforeEach(() => {
  // The handler's one line per delivery and the merge's own — expected, and noise here.
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------- the cycle -------------------------------- */

describe('ciclo Turbo 90011 — handler → frete → resolvedor → hook → avisos, tudo real', () => {
  it('0→3: dois endereços de coleta ⇒ A manual crítico; um endereço ⇒ despacha, A resolve `arranjado`, B abre; REQUEST_CREATED ⇒ B repete; PICKUP_DONE ⇒ B `coletado`', async () => {
    const c = novoCenario();

    // 0 — the automation cannot decide (two pickup addresses) ⇒ A `manual`, CRITICO.
    const d0 = await c.entrega({ linhas: [linha(1)], parametro: DOIS_ENDERECOS });
    expect(d0.r.arranjo?.desfecho).toBe('precisa-escolha');
    // ⚠️ `fase` is the PRE-arrange phase — what rule N keys on.
    expect(d0.r.arranjo?.fase).toBe('programar');
    expect(d0.corpos).toEqual([]);
    expect(aberto(c.db, MANUAL())).toBe(true);
    const manual = aviso(c.db, MANUAL());
    expect(manual.severidade).toBe(SEVERIDADE_AVISO.critico);
    expect(manual.params).toEqual({ pedido: ORDER_SN, situacao: expect.any(String) });
    expect(lido(c.db, ETIQUETA)).toBeUndefined();

    // 1 — READY, not arranged, invoice clear, one address ⇒ the four calls, ONE ship.
    const d1 = await c.entrega({ linhas: [linha(2)] });
    expect(d1.r.arranjo?.desfecho).toBe('programado');
    expect(d1.chamadas).toEqual([
      'getPackageDetail',
      'getOrderDetail',
      'getShippingParameter',
      'shipOrder',
    ]);
    // (A one-package order ships WITHOUT the number — step 15's `comPacote` rule;
    // the two-package case below pins the number.)
    expect(d1.corpos).toHaveLength(1);
    expect(d1.corpos[0]).toMatchObject({ orderSn: ORDER_SN });
    expect(aberto(c.db, MANUAL())).toBe(false);
    expect(lido(c.db, MANUAL())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.arranjado);
    expect(aberto(c.db, ETIQUETA)).toBe(true);
    expect(aviso(c.db, ETIQUETA).params).toEqual({ pedido: ORDER_SN });

    // 2 — REQUEST_CREATED ⇒ `ja-programado` on the ONE pull, B repeats (no second row).
    const d2 = await c.entrega({ linhas: [linha(3, REQUEST_CREATED)] });
    expect(d2.r.arranjo?.desfecho).toBe('ja-programado');
    expect(d2.chamadas).toEqual(['getPackageDetail']);
    expect(aberto(c.db, ETIQUETA)).toBe(true);
    expect(lido(c.db, ETIQUETA)?.ocorrencias).toBe(2);

    // 3 — PICKUP_DONE ⇒ the confirmed estado is pós-coleta ⇒ the RESOLVER closes B;
    // the hook answers `nao-elegivel` (window closed) and opens nothing.
    const d3 = await c.entrega({ linhas: [linha(4, PICKUP_DONE)] });
    expect(d3.r.arranjo?.desfecho).toBe('nao-elegivel');
    expect(d3.chamadas).toEqual(['getPackageDetail']);
    expect(aberto(c.db, ETIQUETA)).toBe(false);
    expect(lido(c.db, ETIQUETA)?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.coletado);

    // 3' — a late code 4 after collection with a FRESH pull reopens nothing.
    await c.entrega({ linhas: [linha(5, PICKUP_DONE)], code: 4 });
    expect(aberto(c.db, ETIQUETA)).toBe(false);
  });

  it('4: NF-e pendente ⇒ A `nfe` (atenção) sem chamada extra; nota validada + dois endereços ⇒ regra N `nfe-validada` + A manual; então despacha', async () => {
    const c = novoCenario();

    const d1 = await c.entrega({ linhas: [linha(1, NFE_PENDENTE)] });
    expect(d1.r.arranjo?.desfecho).toBe('nfe-pendente');
    expect(d1.chamadas).toEqual(['getPackageDetail']);
    expect(aberto(c.db, NFE())).toBe(true);
    expect(aviso(c.db, NFE()).severidade).toBe(SEVERIDADE_AVISO.atencao);

    const d2 = await c.entrega({ linhas: [linha(2, NFE_VALIDA)], parametro: DOIS_ENDERECOS });
    expect(d2.r.arranjo?.desfecho).toBe('precisa-escolha');
    expect(aberto(c.db, NFE())).toBe(false);
    expect(lido(c.db, NFE())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.nfeValidada);
    expect(aberto(c.db, MANUAL())).toBe(true);

    const d3 = await c.entrega({ linhas: [linha(3, NFE_VALIDA)] });
    expect(d3.r.arranjo?.desfecho).toBe('programado');
    expect(aberto(c.db, MANUAL())).toBe(false);
    expect(lido(c.db, MANUAL())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.arranjado);
    expect(aberto(c.db, ETIQUETA)).toBe(true);
  });

  it('4b: NF-e pendente, depois validada e despachada direto ⇒ A `nfe` resolve `arranjado`', async () => {
    const c = novoCenario();
    await c.entrega({ linhas: [linha(1, NFE_PENDENTE)] });
    expect(aberto(c.db, NFE())).toBe(true);

    const d = await c.entrega({ linhas: [linha(2, NFE_VALIDA)] });

    expect(d.r.arranjo?.desfecho).toBe('programado');
    expect(aberto(c.db, NFE())).toBe(false);
    expect(lido(c.db, NFE())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.arranjado);
  });

  it('5a: pedido CANCELLED visto pelo hook (pacote ainda READY) ⇒ A (as duas classes) e B resolvem `pedido-cancelado`', async () => {
    const c = novoCenario();
    await c.entrega({ linhas: [linha(1, NFE_PENDENTE)] }); // A nfe
    await c.entrega({ linhas: [linha(2)], parametro: DOIS_ENDERECOS }); // A manual; rule N closes nfe
    // B open too — through the executor, on the entrada the HANDLER built.
    await c.abrirEtiquetaComEntrada(c.entradas.at(-1)!);
    expect(aberto(c.db, MANUAL())).toBe(true);
    expect(aberto(c.db, ETIQUETA)).toBe(true);

    const d = await c.entrega({
      linhas: [linha(3)],
      ordem: ordem([P1], { order_status: 'CANCELLED' }),
    });

    // ⚠️ The MOTIVO is what closes B — a `nao-elegivel` without it opens and closes nothing.
    expect(d.r.arranjo).toMatchObject({ desfecho: 'nao-elegivel', motivo: 'pedido-cancelado' });
    expect(d.corpos).toEqual([]);
    expect(lido(c.db, MANUAL())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.pedidoCancelado);
    expect(aberto(c.db, ETIQUETA)).toBe(false);
    expect(lido(c.db, ETIQUETA)?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.pedidoCancelado);
    // The nfe row had already closed on rule N; it keeps THAT reason.
    expect(lido(c.db, NFE())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.nfeValidada);
  });

  it('5b: push com o token do pacote LOGISTICS_INVALID ⇒ A `envio-encerrado` (o token vence), B `pedido-cancelado`', async () => {
    const c = novoCenario();
    await c.entrega({ linhas: [linha(1)], parametro: DOIS_ENDERECOS }); // A manual
    await c.abrirEtiquetaComEntrada(c.entradas.at(-1)!);

    const d = await c.entrega({ linhas: [linha(2, { fulfillment_status: 'LOGISTICS_INVALID' })] });

    expect(d.r.arranjo?.desfecho).toBe('nao-elegivel');
    expect(d.chamadas).toEqual(['getPackageDetail']);
    expect(lido(c.db, MANUAL())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.envioEncerrado);
    expect(aberto(c.db, ETIQUETA)).toBe(false);
    expect(lido(c.db, ETIQUETA)?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.pedidoCancelado);
  });

  it('5c: pedido CANCELLED pelo caminho da IMPORTAÇÃO ⇒ o resolvedor cruzado fecha A e B', async () => {
    const c = novoCenario();
    await c.entrega({ linhas: [linha(1)], parametro: DOIS_ENDERECOS }); // A manual
    await c.abrirEtiquetaComEntrada(c.entradas.at(-1)!);
    const linhaDaOrdem = shopeeOrderDetailPayloadSchema.parse({
      order_list: [
        {
          order_sn: ORDER_SN,
          order_status: 'CANCELLED',
          update_time: t(9),
          package_list: [
            {
              package_number: P1,
              logistics_status: 'LOGISTICS_READY',
              logistics_channel_id: TURBO,
            },
          ],
        },
      ],
    }).order_list[0]!;
    const { observados } = observadosDoDetalheDoPedido(linhaDaOrdem, { relogioDoPedidoS: t(9) });

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(c.db),
      {
        integracaoId: CONTA,
        pedidoId: PEDIDO_ID,
        estadoConfirmado: null,
        orderStatus: SHOPEE_ORDER_STATUS.cancelled,
        pacotes: observados,
      },
      { nowMs: c.agora() + 1 },
    );

    expect(r).toEqual({ despachoResolvidos: 1, etiquetaResolvida: true });
    expect(lido(c.db, MANUAL())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.pedidoCancelado);
    expect(lido(c.db, ETIQUETA)?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.pedidoCancelado);
  });

  it('6: pacote fora dos canais de 1573 ⇒ `fora-do-canal`, UMA chamada à Shopee, nenhum caminho de aviso tocado', async () => {
    const c = novoCenario();
    c.db.opLog.length = 0;

    const d = await c.entrega({ linhas: [linha(1, { logistics_channel_id: FORA_DO_CANAL })] });

    expect(d.r.arranjo?.desfecho).toBe('fora-do-canal');
    expect(d.chamadas).toEqual(['getPackageDetail']);
    expect(c.db.opLog.filter((o) => o.path.startsWith('avisos'))).toEqual([]);
    expect(c.db.caminhos.filter((p) => p.startsWith('avisos'))).toEqual([]);
    // ANCHOR: the delivery DID run — the merge read the pedido, so the negatives are not vacuous.
    expect(c.db.caminhos).toContain(`pedidos/${PEDIDO_ID}`);
  });
});

/* -------------------------- the stale row (Q2-F1) --------------------------- */

describe('linha ATRASADA (`ignorado-obsoleto`) — o arranjo roda, as aberturas obedecem ao estado confirmado', () => {
  it('⚠️ B coletado + um REQUEST_CREATED mais VELHO ⇒ o hook roda (`ja-programado`), mas B CONTINUA resolvido `coletado`', async () => {
    const c = novoCenario();
    await c.entrega({ linhas: [linha(1)] }); // ships ⇒ B open
    await c.entrega({ linhas: [linha(3, PICKUP_DONE)] }); // B coletado
    const fechado = lido(c.db, ETIQUETA)!;
    expect(fechado.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.coletado);

    // A lagging replica answers the pre-collection row (clock 2 < the stored 3).
    const d = await c.entrega({ linhas: [linha(2, REQUEST_CREATED)] });

    // ANCHORS: the transaction proved the row stale, and the hook STILL ran on it.
    expect(d.r.acao).toBe('ignorado-obsoleto');
    expect(d.r.arranjo?.desfecho).toBe('ja-programado');
    // …and the print row stays exactly as the newer delivery left it.
    expect(aberto(c.db, ETIQUETA)).toBe(false);
    expect(lido(c.db, ETIQUETA)?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.coletado);
    expect(lido(c.db, ETIQUETA)?.resolvidoEm).toEqual(fechado.resolvidoEm);
    expect(lido(c.db, ETIQUETA)?.ocorrencias).toEqual(fechado.ocorrencias);

    // The next FRESH post-collection delivery leaves it closed too.
    await c.entrega({ linhas: [linha(4, DELIVERY_DONE)], code: 4 });
    expect(aberto(c.db, ETIQUETA)).toBe(false);
  });

  it('⚠️ variante A: despachado + uma linha READY com NF-e pendente mais VELHA ⇒ A `nfe` NÃO abre', async () => {
    const c = novoCenario();
    await c.entrega({ linhas: [linha(1, NFE_PENDENTE)] }); // A nfe open
    await c.entrega({ linhas: [linha(3, REQUEST_CREATED)] }); // arranged ⇒ A nfe `arranjado`
    expect(lido(c.db, NFE())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.arranjado);
    const fechado = lido(c.db, NFE())!;

    const d = await c.entrega({ linhas: [linha(2, NFE_PENDENTE)] });

    expect(d.r.acao).toBe('ignorado-obsoleto');
    expect(d.r.arranjo?.desfecho).toBe('nfe-pendente');
    expect(aberto(c.db, NFE())).toBe(false);
    expect(lido(c.db, NFE())?.resolvidoEm).toEqual(fechado.resolvidoEm);
  });

  it('quase-falha: uma linha VELHA com estado confirmado PRÉ-arranjo ainda DESPACHA e abre B (mutante 35)', async () => {
    const c = novoCenario();
    // The newer read could not decide (two addresses): stored READY at clock 2, A manual open.
    await c.entrega({ linhas: [linha(2)], parametro: DOIS_ENDERECOS });
    expect(aberto(c.db, MANUAL())).toBe(true);

    // An OLDER READY row (clock 1) on a delivery whose parameter read decides.
    const d = await c.entrega({ linhas: [linha(1)] });

    expect(d.r.acao).toBe('ignorado-obsoleto');
    // ⚠️ Never gate the arrange on `ignorado-obsoleto`: a lost arrange is an order Shopee cancels.
    expect(d.r.arranjo?.desfecho).toBe('programado');
    expect(d.corpos).toHaveLength(1);
    expect(lido(c.db, MANUAL())?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.arranjado);
    expect(aberto(c.db, ETIQUETA)).toBe(true);
  });
});

/* ---------------------------- two packages, one order ----------------------- */

describe('pedido com DOIS pacotes no canal Turbo — um aviso de despacho POR PACOTE, uma etiqueta POR PEDIDO', () => {
  it('B só fecha quando o ÚLTIMO pacote é coletado; o A manual do 2º abre mesmo com o 1º já coletado', async () => {
    const c = novoCenario();
    const dois = ordem([P1, P2]);

    // a — P1 ships WITH its package number ⇒ B open.
    const a = await c.entrega({ linhas: [linha(1)], ordem: dois });
    expect(a.r.arranjo?.desfecho).toBe('programado');
    expect(a.corpos[0]).toMatchObject({ packageNumber: P1 });
    expect(aberto(c.db, ETIQUETA)).toBe(true);

    // b — P2 cannot be decided ⇒ ITS OWN A manual (the chave is per package).
    const b = await c.entrega({
      pacote: P2,
      linhas: [linha(2, { package_number: P2 })],
      ordem: dois,
      parametro: DOIS_ENDERECOS,
    });
    expect(b.r.arranjo?.desfecho).toBe('precisa-escolha');
    expect(aberto(c.db, MANUAL(P2))).toBe(true);
    expect(lido(c.db, MANUAL(P1))).toBeUndefined();

    // c — P1 collected while P2 is still READY: the fold is the least-advanced LIVE
    // package, so B stays open (no flap) and P2's row is untouched.
    const cc = await c.entrega({ linhas: [linha(3, PICKUP_DONE)], ordem: dois });
    expect(cc.r.arranjo?.desfecho).toBe('nao-elegivel');
    expect(aberto(c.db, ETIQUETA)).toBe(true);
    expect(aberto(c.db, MANUAL(P2))).toBe(true);

    // d — near-miss for the stale-row suppression: P2 still undecidable AFTER P1's
    // collection ⇒ its A manual REPEATS — the confirmed estado is P2's, not P1's.
    const d = await c.entrega({
      pacote: P2,
      linhas: [linha(4, { package_number: P2 })],
      ordem: dois,
      parametro: DOIS_ENDERECOS,
    });
    expect(d.r.arranjo?.desfecho).toBe('precisa-escolha');
    expect(aberto(c.db, MANUAL(P2))).toBe(true);
    expect(lido(c.db, MANUAL(P2))?.ocorrencias).toBe(2);

    // e — P2 ships ⇒ its A manual `arranjado`, B still open.
    const e = await c.entrega({
      pacote: P2,
      linhas: [linha(5, { package_number: P2 })],
      ordem: dois,
    });
    expect(e.r.arranjo?.desfecho).toBe('programado');
    expect(e.corpos[0]).toMatchObject({ packageNumber: P2 });
    expect(lido(c.db, MANUAL(P2))?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.arranjado);
    expect(aberto(c.db, ETIQUETA)).toBe(true);

    // f — P2 REQUEST_CREATED ⇒ B still open.
    await c.entrega({
      pacote: P2,
      linhas: [linha(6, { package_number: P2, ...REQUEST_CREATED })],
      ordem: dois,
    });
    expect(aberto(c.db, ETIQUETA)).toBe(true);

    // g — P2 collected ⇒ every package left ⇒ B `coletado`.
    await c.entrega({
      pacote: P2,
      linhas: [linha(7, { package_number: P2, ...PICKUP_DONE })],
      ordem: dois,
    });
    expect(aberto(c.db, ETIQUETA)).toBe(false);
    expect(lido(c.db, ETIQUETA)?.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.coletado);
  });
});
