/**
 * Step 15b's automatic arrange (#1744): the ladder, the valve, the narrow catch
 * measured against the arm's own disposition table, and the aviso seam.
 *
 * The Shopee client is a fake that COUNTS calls (and runs the package's own
 * `assertShipOrderParams` on every ship body — RT3, everywhere); the aviso
 * producer is a fake `avisar`. The default producer is mocked at its module, so
 * this suite never depends on `avisos/despachoAutomatico.ts`'s behaviour —
 * only on the hook calling it.
 *
 * Mutants (reconcile §4): 7–10, 12–15, 24/25 at the hook's level, 26 (a TYPE
 * test — `pnpm typecheck` kills it; the runtime half pins the key set), 27–31,
 * 37–47; round trips RT3 and RT5.
 */
import { readFileSync } from 'node:fs';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { ESTADO_FRETE, type EstadoFrete } from '@delfrance/schemas';
import * as pacoteShopee from '@delfrance/integrations-shopee';
import {
  assertShipOrderParams,
  SHOPEE_SURFACE,
  ShopeeApiPartialError,
  ShopeeArquivoVazioError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeSchemaError,
  shopeeErrorFromEnvelope,
  shopeeOrderDetailPayloadSchema,
  shopeePackageDetailRowSchema,
  shopeeShippingParameterPayloadSchema,
  type GetOrderDetailParams,
  type GetShippingParameterParams,
  type ShipOrderParams,
  type ShopeeApiError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { avisarArranjoAutomatico } from '../avisos/despachoAutomatico';
import * as credentialStore from '../core/credentialStore';
import * as coreShopee from '../core/shopee';
import * as tokenStore from '../core/tokenStore';
import { SHOPEE_ETIQUETA_DETALHE_CAMPOS } from '../etiqueta/constantesEtiqueta';
import type { FasePacote } from '../etiqueta/faseEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from '../etiqueta/motivosEtiqueta';
import { disposicaoDaFalhaDeRastreio } from '../notificacoes/notificacao';
import {
  DESFECHO_DO_MOTIVO,
  SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV,
  arranjarPacoteAutomatico,
  arranjoAutomaticoDesligado,
  type ArranjadorDePacote,
  type AvisadorDeArranjo,
  type DesfechoArranjoAutomatico,
  type EntradaArranjoAutomatico,
  type ResultadoArranjoAutomatico,
} from './arranjoAutomatico';

// The DEFAULT producer, replaced at its module: a test that omits `deps.avisar`
// must see the hook reach exactly this function, and nothing else of that module.
vi.mock('../avisos/despachoAutomatico', () => ({
  avisarArranjoAutomatico: vi.fn(async () => {}),
}));

/* --------------------------------- fixtures --------------------------------- */

const ORDER_SN = '260910KJBHUJDM';
/** A second, obviously synthetic order — never a real `order_sn`. */
const OUTRO_ORDER_SN = '260910OUTRO000';
const P1 = 'OFG000000000001';
const P2 = 'OFG000000000002';
const INTEGRACAO = 'int-1';
const PEDIDO_ID = 'pedido-de-teste';
const AGORA = Date.UTC(2026, 9, 1, 12, 0, 0);
const TURBO = 90011;
/** A channel 1573 does not oblige (SPI-gated, out of the set). */
const FORA = 90021;
const VALVULA_LIGADA = { [SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV]: '1' } as const;

/** The hook hands `db` to the producer only; a sentinel proves it is passed through. */
const DB = { sentinela: 'firestore' } as unknown as Firestore;

/** A raw `get_package_detail` row through the REAL package schema: a Turbo candidate. */
function linhaDePacote(extra: Record<string, unknown> = {}) {
  return shopeePackageDetailRowSchema.parse({
    order_sn: ORDER_SN,
    package_number: P1,
    fulfillment_status: 'LOGISTICS_READY',
    logistics_channel_id: TURBO,
    is_shipment_arranged: false,
    ...extra,
  });
}

/** A raw `get_order_detail` row: a READY local-seller order holding P1 alone. */
function linhaDeOrdem(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_sn: ORDER_SN,
    order_status: 'READY_TO_SHIP',
    package_list: [{ package_number: P1 }],
    fulfillment_flag: 'fulfilled_by_local_seller',
    ...extra,
  };
}

function entrada(
  linha: Record<string, unknown> = {},
  estadoFreteConfirmado: EstadoFrete | null = null,
): EntradaArranjoAutomatico {
  return {
    integracaoId: INTEGRACAO,
    pedidoId: PEDIDO_ID,
    orderSn: ORDER_SN,
    packageNumber: P1,
    linha: linhaDePacote(linha),
    nowMs: AGORA,
    estadoFreteConfirmado,
  };
}

const RUA = 'Rua do Vendedor, 100';

function endereco(id: number, flags: string[], slots: unknown[]) {
  return {
    address_id: id,
    region: 'BR',
    state: 'SP',
    city: 'Cidade do Vendedor',
    district: 'Centro',
    town: '',
    address: RUA,
    zipcode: '00000-000',
    address_flag: flags,
    time_slot_list: slots,
  };
}

function horario(id: string, flags: string[] | null = null) {
  return { date: 1_790_000_000, time_text: '09:00-12:00', pickup_time_id: id, flags };
}

/** One pickup address, one slot: decided with no question. */
const UM_ENDERECO = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: { address_list: [endereco(2001, ['pickup_address'], [horario('slot-1')])] },
};

/** Two pickup addresses, no principal: the automatic rules cannot pick. */
const DOIS_ENDERECOS = {
  info_needed: { pickup: ['address_id', 'pickup_time_id'] },
  pickup: {
    address_list: [
      endereco(2001, ['pickup_address'], [horario('slot-1')]),
      endereco(2002, ['pickup_address'], [horario('slot-2')]),
    ],
  },
};

function envelope(error: string, message: string | null = null): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: null, warning: null },
    { path: '/api/v2/logistics/ship_order', httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function grpc(code: number): Error {
  return Object.assign(new Error(`gRPC ${String(code)}`), { code });
}

interface OpcoesDoCliente {
  /** Raw `order_list` rows. Default: `[linhaDeOrdem()]`. */
  readonly ordens?: readonly Record<string, unknown>[];
  readonly ordemErro?: unknown;
  /** Raw shipping parameter. Default: {@link UM_ENDERECO}. */
  readonly parametro?: unknown;
  readonly parametroErro?: unknown;
  /** One entry per `shipOrder` call: `undefined` ⇒ success, else thrown. */
  readonly ship?: readonly unknown[];
}

function fakeClient(o: OpcoesDoCliente = {}) {
  const chamadas: string[] = [];
  const corpos: ShipOrderParams[] = [];
  const getOrderDetail = vi.fn(async (_p: GetOrderDetailParams) => {
    chamadas.push('getOrderDetail');
    if (o.ordemErro !== undefined) throw o.ordemErro;
    return shopeeOrderDetailPayloadSchema.parse({ order_list: o.ordens ?? [linhaDeOrdem()] });
  });
  const getShippingParameter = vi.fn(async (_p: GetShippingParameterParams) => {
    chamadas.push('getShippingParameter');
    if (o.parametroErro !== undefined) throw o.parametroErro;
    return shopeeShippingParameterPayloadSchema.parse(o.parametro ?? UM_ENDERECO);
  });
  const respostas = [...(o.ship ?? [])];
  const shipOrder = vi.fn(async (p: ShipOrderParams) => {
    chamadas.push('shipOrder');
    // RT3: every body the hook ever sends passes the client's own guard — a
    // body it refuses would surface here as a rethrown ShopeeConfigError.
    assertShipOrderParams(p);
    corpos.push(p);
    const erro = respostas.shift();
    if (erro !== undefined) throw erro;
    return { error: '', message: null, request_id: null, warning: null };
  });
  // `satisfies` BEFORE the cast, so a renamed op or param is a type error; any
  // OTHER client method the hook reached would be a TypeError and fail the test.
  const client = { getOrderDetail, getShippingParameter, shipOrder } satisfies Pick<
    ShopeeClient,
    'getOrderDetail' | 'getShippingParameter' | 'shipOrder'
  > as unknown as ShopeeClient;
  return { client, chamadas, corpos, getOrderDetail, getShippingParameter, shipOrder };
}

interface Rodada {
  readonly linha?: Record<string, unknown>;
  readonly cliente?: OpcoesDoCliente;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** One hook run with an isolated env (valve OFF unless given) and a fake `avisar`. */
async function rodar(o: Rodada = {}) {
  const f = fakeClient(o.cliente);
  const avisar = vi.fn<AvisadorDeArranjo>(async () => {});
  const e = entrada(o.linha);
  const r = await arranjarPacoteAutomatico(DB, f.client, e, { env: o.env ?? {}, avisar });
  return { r, f, avisar, e };
}

/** The seven keys of the result, and nothing else (no address, no slot, no `rotulo`). */
const CHAVES_DO_RESULTADO = [
  'canalId',
  'desfecho',
  'fase',
  'motivo',
  'operacao',
  'semPacote',
  'shopeeCode',
];

const TODOS_OS_MOTIVOS = Object.values(MOTIVO_ETIQUETA_SHOPEE) as readonly MotivoEtiquetaShopee[];

const CHAMADAS_DO_ARRANJO = ['getOrderDetail', 'getShippingParameter', 'shipOrder'];

beforeEach(() => {
  vi.mocked(avisarArranjoAutomatico).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ---------------------------------- the valve -------------------------------- */

describe('arranjoAutomaticoDesligado — a válvula (só o literal "1" desliga)', () => {
  it('o nome da variável é o que DEPLOY.md e .env.example documentam', () => {
    expect(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV).toBe('SHOPEE_ARRANJO_AUTOMATICO_DISABLED');
  });

  it('"1" ⇒ desligado', () => {
    expect(arranjoAutomaticoDesligado(VALVULA_LIGADA)).toBe(true);
  });

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['"0"', '0'],
    ['"true" (o quase-acerto)', 'true'],
    ['" 1" (espaço antes)', ' 1'],
    ['"1 " (espaço depois)', '1 '],
    ['"01"', '01'],
    ['"yes"', 'yes'],
  ])('mutante 37: %s ⇒ LIGADO (o arranjo roda)', (_nome, valor) => {
    expect(arranjoAutomaticoDesligado({ [SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV]: valor })).toBe(
      false,
    );
  });

  it('outra variável com "1" não desliga nada', () => {
    expect(arranjoAutomaticoDesligado({ SHOPEE_TASKS_DISABLED: '1' })).toBe(false);
  });

  it('mutante 38: lida A CADA chamada (process.env alterado depois do import vale)', () => {
    vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, '1');
    expect(arranjoAutomaticoDesligado()).toBe(true);
    vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, '0');
    expect(arranjoAutomaticoDesligado()).toBe(false);
    vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, '1');
    expect(arranjoAutomaticoDesligado()).toBe(true);
  });

  it('mutante 38: o hook SEM deps.env lê process.env a cada entrega', async () => {
    const avisar = vi.fn<AvisadorDeArranjo>(async () => {});
    vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, '1');
    const f1 = fakeClient();
    const r1 = await arranjarPacoteAutomatico(DB, f1.client, entrada(), { avisar });
    expect(r1.desfecho).toBe('desligado');
    expect(f1.chamadas).toStrictEqual([]);

    vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, '');
    const f2 = fakeClient();
    const r2 = await arranjarPacoteAutomatico(DB, f2.client, entrada(), { avisar });
    expect(r2.desfecho).toBe('programado');
    expect(f2.chamadas).toStrictEqual(CHAMADAS_DO_ARRANJO);
  });
});

/* ------------------------------ off the channels ------------------------------ */

describe('arranjarPacoteAutomatico — fora do canal (nada acontece)', () => {
  it.each([
    ['um candidato fora de 1573', {}],
    ['NF-e pendente fora de 1573', { invoice_pending: { status: 'pending' } }],
    ['já arranjado fora de 1573', { is_shipment_arranged: true }],
    ['retido fora de 1573', { pending_terms: ['SYSTEM_PENDING'] }],
  ])('%s ⇒ fora-do-canal, ZERO chamadas e NENHUM aviso (mutante 47)', async (_nome, extra) => {
    const { r, f, avisar } = await rodar({ linha: { logistics_channel_id: FORA, ...extra } });
    expect(r.desfecho).toBe('fora-do-canal');
    expect(r.canalId).toBe(FORA);
    expect(f.chamadas).toStrictEqual([]);
    expect(avisar).not.toHaveBeenCalled();
  });

  it('canal null ⇒ fora-do-canal (nunca "no conjunto")', async () => {
    const { r, f, avisar } = await rodar({ linha: { logistics_channel_id: null } });
    expect(r.desfecho).toBe('fora-do-canal');
    expect(r.canalId).toBeNull();
    expect(f.chamadas).toStrictEqual([]);
    expect(avisar).not.toHaveBeenCalled();
  });

  it('a fase é calculada mesmo fora do canal (o log a lê)', async () => {
    const { r } = await rodar({
      linha: { logistics_channel_id: FORA, invoice_pending: { status: 'pending' } },
    });
    expect(r.fase).toBe('nfe-pendente');
  });

  it.each([90012, 90026])('quase-acerto: o canal %i É de 1573 ⇒ arranja', async (canal) => {
    const { r } = await rodar({ linha: { logistics_channel_id: canal } });
    expect(r.desfecho).toBe('programado');
    expect(r.canalId).toBe(canal);
  });
});

/* -------------------- the pre-gate: zero calls, BEFORE the valve -------------------- */

interface CasoDoPortao {
  readonly nome: string;
  readonly linha: Record<string, unknown>;
  readonly desfecho: DesfechoArranjoAutomatico;
  readonly fase: FasePacote;
  readonly motivo: MotivoEtiquetaShopee | null;
}

const PRE_PORTAO: readonly CasoDoPortao[] = [
  {
    nome: 'NF-e pendente num READY não arranjado (mutante 41)',
    linha: { invoice_pending: { status: 'pending' } },
    desfecho: 'nfe-pendente',
    fase: 'nfe-pendente',
    motivo: null,
  },
  {
    nome: 'NF-e pendente num NOT_START',
    linha: { fulfillment_status: 'LOGISTICS_NOT_START', invoice_pending: { status: ' Pending' } },
    desfecho: 'nfe-pendente',
    fase: 'nfe-pendente',
    motivo: null,
  },
  {
    nome: 'READY já arranjado',
    linha: { is_shipment_arranged: true },
    desfecho: 'ja-programado',
    fase: 'arranjado',
    motivo: null,
  },
  {
    nome: 'REQUEST_CREATED (com uma NF-e pendente OBSOLETA)',
    linha: {
      fulfillment_status: 'LOGISTICS_REQUEST_CREATED',
      invoice_pending: { status: 'pending' },
    },
    desfecho: 'ja-programado',
    fase: 'arranjado',
    motivo: null,
  },
  {
    nome: 'PICKUP_RETRY é arranjado, nunca re-arranjado (mutante 8)',
    linha: { fulfillment_status: 'LOGISTICS_PICKUP_RETRY', is_shipment_arranged: false },
    desfecho: 'ja-programado',
    fase: 'arranjado',
    motivo: null,
  },
  {
    nome: 'retido por um termo real',
    linha: { pending_terms: ['SYSTEM_PENDING'] },
    desfecho: 'retido',
    fase: 'retido',
    motivo: MOTIVO_ETIQUETA_SHOPEE.retidoPelaShopee,
  },
  {
    nome: 'NOT_START',
    linha: { fulfillment_status: 'LOGISTICS_NOT_START' },
    desfecho: 'nao-elegivel',
    fase: 'nao-pronto',
    motivo: null,
  },
  {
    nome: 'PICKUP_DONE (janela fechada)',
    linha: { fulfillment_status: 'LOGISTICS_PICKUP_DONE' },
    desfecho: 'nao-elegivel',
    fase: 'janela-fechada',
    motivo: null,
  },
  {
    nome: 'REQUEST_CANCELED (inelegível)',
    linha: { fulfillment_status: 'LOGISTICS_REQUEST_CANCELED' },
    desfecho: 'nao-elegivel',
    fase: 'inelegivel',
    motivo: null,
  },
  {
    nome: 'token desconhecido',
    linha: { fulfillment_status: 'LOGISTICS_PENDING_ARRANGE' },
    desfecho: 'nao-elegivel',
    fase: 'desconhecido',
    motivo: null,
  },
  {
    nome: 'sem token',
    linha: { fulfillment_status: null },
    desfecho: 'nao-elegivel',
    fase: 'desconhecido',
    motivo: null,
  },
];

describe('arranjarPacoteAutomatico — o pré-portão (zero chamadas, ANTES da válvula)', () => {
  describe.each([
    ['válvula desligada', {}],
    ['válvula LIGADA (mutante 40)', VALVULA_LIGADA],
  ])('%s', (_valvula, env) => {
    it.each(PRE_PORTAO.map((c) => [c.nome, c] as const))('%s', async (_nome, c) => {
      const { r, f, avisar, e } = await rodar({ linha: c.linha, env });
      expect(r).toStrictEqual({
        desfecho: c.desfecho,
        canalId: TURBO,
        fase: c.fase,
        motivo: c.motivo,
        shopeeCode: null,
        operacao: null,
        semPacote: false,
      });
      expect(f.chamadas).toStrictEqual([]);
      // Mutant 47's other half: every desfecho but fora-do-canal reaches the producer.
      expect(avisar).toHaveBeenCalledTimes(1);
      expect(avisar).toHaveBeenCalledWith(DB, e, r);
    });
  });
});

describe('arranjarPacoteAutomatico — o que É candidato', () => {
  it('mutante 7 (S22): is_shipment_arranged null ⇒ candidato, e arranja', async () => {
    const { r, f } = await rodar({ linha: { is_shipment_arranged: null } });
    expect(r.desfecho).toBe('programado');
    expect(r.fase).toBe('programar');
    expect(f.chamadas).toStrictEqual(CHAMADAS_DO_ARRANJO);
  });

  it.each([
    ['["-"]', ['-']],
    ['[""]', ['']],
    ['["-", " "]', ['-', ' ']],
  ])('mutante 9: pending_terms %s é preenchimento, não retenção ⇒ arranja', async (_n, termos) => {
    const { r } = await rodar({ linha: { pending_terms: termos } });
    expect(r.desfecho).toBe('programado');
  });

  it('mutante 10: lê a LINHA fresca — a mesma entrada com a linha arranjada custa zero', async () => {
    const fresca = await rodar({ linha: { is_shipment_arranged: true } });
    expect(fresca.r.desfecho).toBe('ja-programado');
    expect(fresca.f.chamadas).toStrictEqual([]);
  });
});

/* ----------------------------- the valve on a candidate ----------------------------- */

describe('arranjarPacoteAutomatico — a válvula num candidato', () => {
  it('mutante 39: "1" ⇒ desligado com ZERO chamadas, e o produtor é avisado', async () => {
    const { r, f, avisar, e } = await rodar({ env: VALVULA_LIGADA });
    expect(r).toStrictEqual({
      desfecho: 'desligado',
      canalId: TURBO,
      fase: 'programar',
      motivo: null,
      shopeeCode: null,
      operacao: null,
      semPacote: false,
    });
    expect(f.chamadas).toStrictEqual([]);
    expect(avisar).toHaveBeenCalledWith(DB, e, r);
  });

  it('quase-acerto: "true" NÃO desliga — arranja', async () => {
    const { r, f } = await rodar({ env: { [SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV]: 'true' } });
    expect(r.desfecho).toBe('programado');
    expect(f.chamadas).toStrictEqual(CHAMADAS_DO_ARRANJO);
  });
});

/* ---------------------------------- the order read ---------------------------------- */

describe('arranjarPacoteAutomatico — a leitura do pedido (R-f)', () => {
  it('UMA get_order_detail com SHOPEE_ETIQUETA_DETALHE_CAMPOS, nomeando só este pedido', async () => {
    const { f } = await rodar();
    expect(f.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(f.getOrderDetail.mock.calls[0]?.[0]).toStrictEqual({
      orderSnList: [ORDER_SN],
      responseOptionalFields: SHOPEE_ETIQUETA_DETALHE_CAMPOS,
    });
    expect(f.getShippingParameter).toHaveBeenCalledWith({ orderSn: ORDER_SN, packageNumber: P1 });
  });

  it('mutante 15: a linha do pedido é casada por order_sn, nunca por posição', async () => {
    const outra = linhaDeOrdem({ order_sn: OUTRO_ORDER_SN, order_status: 'CANCELLED' });
    for (const ordens of [
      [outra, linhaDeOrdem()],
      [linhaDeOrdem(), outra],
    ]) {
      const { r } = await rodar({ cliente: { ordens } });
      expect(r.desfecho).toBe('programado');
    }
  });

  it('mutante 15 (quase-acerto): só a linha de OUTRO pedido ⇒ sem-pacotes, sem arranjar', async () => {
    const { r, f } = await rodar({
      cliente: { ordens: [linhaDeOrdem({ order_sn: OUTRO_ORDER_SN })] },
    });
    expect(r.desfecho).toBe('aguardando');
    expect(r.motivo).toBe(MOTIVO_ETIQUETA_SHOPEE.semPacotes);
    expect(f.chamadas).toStrictEqual(['getOrderDetail']);
  });

  it('nenhuma linha ⇒ aguardando (sem-pacotes)', async () => {
    const { r, f } = await rodar({ cliente: { ordens: [] } });
    expect(r.desfecho).toBe('aguardando');
    expect(r.motivo).toBe(MOTIVO_ETIQUETA_SHOPEE.semPacotes);
    expect(f.chamadas).toStrictEqual(['getOrderDetail']);
  });

  it.each([
    [
      'FBS (mutante 13)',
      { fulfillment_flag: 'fulfilled_by_shopee' },
      'nao-elegivel',
      MOTIVO_ETIQUETA_SHOPEE.pedidoFbs,
    ],
    [
      'CANCELLED (mutante 13)',
      { order_status: 'CANCELLED' },
      'nao-elegivel',
      MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado,
    ],
    [
      'IN_CANCEL (mutante 12) — recusado ANTES do parâmetro',
      { order_status: 'IN_CANCEL' },
      'recusado',
      MOTIVO_ETIQUETA_SHOPEE.pedidoEmCancelamento,
    ],
    [
      'o pedido não lista o pacote',
      { package_list: [{ package_number: P2 }] },
      'aguardando',
      MOTIVO_ETIQUETA_SHOPEE.pacoteInexistente,
    ],
  ] as const)('%s', async (_nome, extra, desfecho, motivo) => {
    const { r, f } = await rodar({ cliente: { ordens: [linhaDeOrdem(extra)] } });
    expect(r.desfecho).toBe(desfecho);
    expect(r.motivo).toBe(motivo);
    expect(r.fase).toBe('programar');
    expect(f.chamadas).toStrictEqual(['getOrderDetail']);
  });

  it('mutante 14: pedido com DOIS pacotes ⇒ o ship NOMEIA o pacote (semPacote false)', async () => {
    const { r, f } = await rodar({
      cliente: {
        ordens: [linhaDeOrdem({ package_list: [{ package_number: P1 }, { package_number: P2 }] })],
      },
    });
    expect(r).toMatchObject({ desfecho: 'programado', semPacote: false });
    expect(f.corpos[0]?.packageNumber).toBe(P1);
  });

  it('mutante 14 (quase-acerto): UM pacote ⇒ o ship não leva a chave (semPacote true)', async () => {
    const { r, f } = await rodar();
    expect(r).toMatchObject({ desfecho: 'programado', semPacote: true });
    expect(f.corpos).toHaveLength(1);
    expect('packageNumber' in (f.corpos[0] ?? {})).toBe(false);
  });
});

interface CasoDeFalha {
  readonly nome: string;
  readonly erro: unknown;
  readonly desfecho: DesfechoArranjoAutomatico;
  readonly motivo?: MotivoEtiquetaShopee | null;
  readonly shopeeCode?: string | null;
  readonly operacao?: string | null;
}

const FALHAS_DA_LEITURA_DO_PEDIDO: readonly CasoDeFalha[] = [
  { nome: 'burst (mutante 45)', erro: envelope('error_rate_limit'), desfecho: 'aguardando' },
  { nome: 'rede', erro: new ShopeeNetworkError('caiu'), desfecho: 'aguardando' },
  {
    nome: 'lease do token',
    erro: new tokenStore.ShopeeRefreshEmAndamentoError('lease', AGORA + 30_000),
    desfecho: 'aguardando',
  },
  {
    nome: 'cota diária (mutante 30)',
    erro: envelope('error_limit', 'You have reached the daily API call limit'),
    desfecho: 'recusado',
    motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
  },
  {
    nome: 'order_finalized (mutante 28)',
    erro: envelope('order.order_finalized', 'The order has been finalized.'),
    desfecho: 'nao-elegivel',
    motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado,
  },
  {
    nome: 'o pacote sumiu (mutante 29)',
    erro: envelope('logistics.package_number_not_exist'),
    desfecho: 'aguardando',
    motivo: MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram,
  },
  {
    nome: 'NF-e',
    erro: envelope('logistics.lack_of_invoice_data', 'Invoice data is required.'),
    desfecho: 'nfe-pendente',
  },
  {
    nome: 'já enviado',
    erro: envelope(' logistics.package_already_shipped'),
    desfecho: 'ja-programado',
  },
  {
    nome: 'um código novo (mutante 31)',
    erro: envelope('order.codigo_inedito_da_shopee', 'Something new.'),
    desfecho: 'recusado',
    motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
    shopeeCode: 'codigo_inedito_da_shopee',
    operacao: 'detalhe-pedido',
  },
  {
    nome: 'um veredito de documento numa leitura',
    erro: envelope('logistics.tracking_number_invalid'),
    desfecho: 'recusado',
    motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
    shopeeCode: null,
    operacao: 'detalhe-pedido',
  },
  {
    nome: 'a resposta ilegível',
    erro: new ShopeeSchemaError('ilegível', { httpStatus: 200, path: '/p', campos: ['x'] }),
    desfecho: 'resposta-ilegivel',
  },
];

describe('arranjarPacoteAutomatico — a leitura do pedido FALHA (um valor, nunca um throw)', () => {
  it.each(FALHAS_DA_LEITURA_DO_PEDIDO.map((c) => [c.nome, c] as const))('%s', async (_nome, c) => {
    const { r, f, avisar } = await rodar({ cliente: { ordemErro: c.erro } });
    expect(r).toStrictEqual({
      desfecho: c.desfecho,
      canalId: TURBO,
      fase: 'programar',
      motivo: c.motivo ?? null,
      shopeeCode: c.shopeeCode ?? null,
      operacao: c.operacao ?? null,
      semPacote: false,
    });
    expect(f.chamadas).toStrictEqual(['getOrderDetail']);
    expect(avisar).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------- the arrange itself ------------------------------- */

describe('arranjarPacoteAutomatico — o arranjo (programarPacoteShopee sob ENVIO_AUTOMATICO)', () => {
  it('o caminho feliz: pedido → parâmetro → ship, UMA vez cada, com o corpo decidido', async () => {
    const { r, f } = await rodar();
    expect(r).toStrictEqual({
      desfecho: 'programado',
      canalId: TURBO,
      fase: 'programar',
      motivo: null,
      shopeeCode: null,
      operacao: null,
      semPacote: true,
    });
    expect(f.chamadas).toStrictEqual(CHAMADAS_DO_ARRANJO);
    expect(f.corpos).toStrictEqual([
      { orderSn: ORDER_SN, modo: 'pickup', pickup: { addressId: 2001, pickupTimeId: 'slot-1' } },
    ]);
  });

  it('mutante 24 (no hook): passa o SENTINELA — dois horários, um recomendado ⇒ arranja nele', async () => {
    // With `null` (the operator's "no answer yet") this read is a QUESTION.
    const { r, f } = await rodar({
      cliente: {
        parametro: {
          info_needed: { pickup: ['address_id', 'pickup_time_id'] },
          pickup: {
            address_list: [
              endereco(2001, ['pickup_address'], [horario('h1'), horario('h2', ['recommended'])]),
            ],
          },
        },
      },
    });
    expect(r.desfecho).toBe('programado');
    expect(f.corpos[0]).toMatchObject({ pickup: { addressId: 2001, pickupTimeId: 'h2' } });
  });

  it('mutante 49 (no hook): pergunta ⇒ precisa-escolha, SEM ship, e nada do endereço sai', async () => {
    const { r, f, avisar } = await rodar({ cliente: { parametro: DOIS_ENDERECOS } });
    expect(r.desfecho).toBe('precisa-escolha');
    expect(f.chamadas).toStrictEqual(['getOrderDetail', 'getShippingParameter']);
    expect(Object.keys(r).sort()).toStrictEqual(CHAVES_DO_RESULTADO);
    expect(JSON.stringify(r)).not.toContain(RUA);
    expect(JSON.stringify(avisar.mock.calls[0]?.[2])).not.toContain('Cidade do Vendedor');
  });

  it('modo não suportado (só non_integrated, o 90026 sem o app SPI) ⇒ recusado', async () => {
    const { r, f } = await rodar({
      linha: { logistics_channel_id: 90026 },
      cliente: { parametro: { info_needed: { non_integrated: [] } } },
    });
    expect(r.desfecho).toBe('recusado');
    expect(r.motivo).toBe(MOTIVO_ETIQUETA_SHOPEE.semEtiquetaShopee);
    expect(f.shipOrder).not.toHaveBeenCalled();
  });

  const FALHAS_DO_SHIP: readonly CasoDeFalha[] = [
    {
      nome: 'package_already_shipped (mutante 27)',
      erro: envelope(' logistics.package_already_shipped', 'Package has been shipped.'),
      desfecho: 'ja-programado',
    },
    {
      nome: 'order_finalized (mutante 28)',
      erro: envelope('logistics.order_finalized'),
      desfecho: 'nao-elegivel',
      motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado,
    },
    {
      nome: 'o pacote sumiu (mutante 29)',
      erro: envelope('logistics.package_number_not_exist'),
      desfecho: 'aguardando',
      motivo: MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram,
    },
    {
      nome: 'cota diária (mutante 30)',
      erro: envelope('error_limit'),
      desfecho: 'recusado',
      motivo: MOTIVO_ETIQUETA_SHOPEE.limiteDiario,
    },
    {
      nome: 'um código novo (mutante 31)',
      erro: envelope('logistics.codigo_inedito_da_shopee', 'Something new.'),
      desfecho: 'recusado',
      motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
      shopeeCode: 'codigo_inedito_da_shopee',
      operacao: 'programar',
    },
    {
      nome: 'rede depois do ship — desfecho DESCONHECIDO (mutante 45)',
      erro: new ShopeeNetworkError('caiu'),
      desfecho: 'verificar',
    },
    { nome: 'error_server', erro: envelope('error_server'), desfecho: 'verificar' },
    { nome: 'burst', erro: envelope('error_rate_limit'), desfecho: 'aguardando' },
    {
      nome: 'NF-e',
      erro: envelope('logistics.lack_of_invoice_data'),
      desfecho: 'nfe-pendente',
    },
    {
      nome: 'sem horário nem agência',
      erro: envelope('logistics.no_available_time_slot'),
      desfecho: 'recusado',
      motivo: MOTIVO_ETIQUETA_SHOPEE.semHorarioOuAgencia,
    },
    {
      nome: 'um 2xx ilegível — o ship pode ter acontecido',
      erro: new ShopeeSchemaError('ilegível', { httpStatus: 200, path: '/s' }),
      desfecho: 'verificar',
    },
    {
      nome: 'um não-2xx ilegível',
      erro: new ShopeeSchemaError('ilegível', { httpStatus: 502, path: '/s' }),
      desfecho: 'resposta-ilegivel',
    },
  ];

  it.each(FALHAS_DO_SHIP.map((c) => [c.nome, c] as const))('ship: %s', async (_nome, c) => {
    const { r, f } = await rodar({ cliente: { ship: [c.erro] } });
    expect(r).toStrictEqual({
      desfecho: c.desfecho,
      canalId: TURBO,
      fase: 'programar',
      motivo: c.motivo ?? null,
      shopeeCode: c.shopeeCode ?? null,
      operacao: c.operacao ?? null,
      semPacote: false,
    });
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
  });

  it('mutante 25 (no hook): horário recusado sob o sentinela ⇒ aguardando, ship UMA vez', async () => {
    for (const codigo of [
      'logistics.error_cutoff_time',
      'logistics.ship_order_pickup_time_invalid',
    ]) {
      const { r, f } = await rodar({ cliente: { ship: [envelope(codigo)] } });
      expect(r.desfecho).toBe('aguardando');
      expect(f.shipOrder).toHaveBeenCalledTimes(1);
    }
  });

  it('o UM reenvio documentado (not_need) ⇒ programado sem o número, dois ships', async () => {
    const { r, f } = await rodar({
      cliente: {
        ordens: [linhaDeOrdem({ package_list: [{ package_number: P1 }, { package_number: P2 }] })],
        ship: [envelope('logistics.ship_order_not_need_pacakge_number')],
      },
    });
    expect(r).toMatchObject({ desfecho: 'programado', semPacote: true });
    expect(f.corpos.map((c) => 'packageNumber' in c)).toStrictEqual([true, false]);
  });

  it.each([
    ['um código novo', envelope('logistics.codigo_inedito_da_shopee'), 'recusado'],
    ['rede (uma leitura — repetível)', new ShopeeNetworkError('caiu'), 'aguardando'],
    [
      'ilegível',
      new ShopeeSchemaError('ilegível', { httpStatus: 200, path: '/p' }),
      'resposta-ilegivel',
    ],
  ] as const)('a leitura do parâmetro falha: %s ⇒ %s, sem ship', async (_n, erro, desfecho) => {
    const { r, f } = await rodar({ cliente: { parametroErro: erro } });
    expect(r.desfecho).toBe(desfecho);
    if (desfecho === 'recusado') {
      expect(r).toMatchObject({
        motivo: MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida,
        operacao: 'parametro-envio',
        shopeeCode: 'codigo_inedito_da_shopee',
      });
    }
    expect(f.shipOrder).not.toHaveBeenCalled();
  });
});

/* ------------------------- RT3: every automatic ship body ------------------------- */

describe('RT3 — todo corpo automático passa no assertShipOrderParams do pacote', () => {
  const agencia = (id: number) => ({ branch_id: id, city: 'Cidade', address: 'Agência' });
  it.each([
    ['coleta com horário', UM_ENDERECO, { addressId: 2001, pickupTimeId: 'slot-1' }],
    [
      'coleta SEM horário (a chave pickupTimeId AUSENTE)',
      {
        info_needed: { pickup: ['address_id'] },
        pickup: { address_list: [endereco(2001, ['pickup_address'], [])] },
      },
      { addressId: 2001 },
    ],
    [
      'coleta: o principal entre vários',
      {
        info_needed: { pickup: ['address_id', 'pickup_time_id'] },
        pickup: {
          address_list: [
            endereco(2001, ['pickup_address'], [horario('slot-1')]),
            endereco(2002, ['pickup_address', 'default_address'], [horario('slot-2')]),
          ],
        },
      },
      { addressId: 2002, pickupTimeId: 'slot-2' },
    ],
  ] as const)('%s', async (_n, parametro, pickup) => {
    for (const pacotes of [[P1], [P1, P2]]) {
      const { r, f } = await rodar({
        cliente: {
          parametro,
          ordens: [linhaDeOrdem({ package_list: pacotes.map((p) => ({ package_number: p })) })],
        },
      });
      expect(r.desfecho).toBe('programado');
      expect(f.corpos).toHaveLength(1);
      const corpo = f.corpos[0];
      expect(() => {
        if (corpo !== undefined) assertShipOrderParams(corpo);
      }).not.toThrow();
      expect(corpo).toStrictEqual(
        pacotes.length > 1
          ? { orderSn: ORDER_SN, packageNumber: P1, modo: 'pickup', pickup }
          : { orderSn: ORDER_SN, modo: 'pickup', pickup },
      );
    }
  });

  it.each([
    ['postagem []', { info_needed: { dropoff: [] } }, {}],
    [
      'postagem com UMA agência',
      { info_needed: { dropoff: ['branch_id'] }, dropoff: { branch_list: [agencia(31)] } },
      { branchId: 31 },
    ],
  ] as const)('%s', async (_n, parametro, dropoff) => {
    const { r, f } = await rodar({ cliente: { parametro } });
    expect(r.desfecho).toBe('programado');
    expect(f.corpos).toStrictEqual([{ orderSn: ORDER_SN, modo: 'dropoff', dropoff }]);
  });
});

/* ------------------- the narrow catch × the arm's disposition (RT5) ------------------- */

type Ponto = 'pedido' | 'parametro' | 'ship';
const PONTOS: readonly Ponto[] = ['pedido', 'parametro', 'ship'];
type Esperado = DesfechoArranjoAutomatico | 'escapa';

interface Classe {
  readonly nome: string;
  readonly fabricar: () => unknown;
  readonly esperado: Readonly<Record<Ponto, Esperado>>;
}

function igual(d: Esperado): Readonly<Record<Ponto, Esperado>> {
  return { pedido: d, parametro: d, ship: d };
}

/**
 * Every error class a call site can raise — the package's, the token store's,
 * the credential store's, the context loader's — plus the three non-Shopee
 * shapes the arm also classifies (gRPC, a coding bug, a `ZodError`).
 */
const CATALOGO: readonly Classe[] = [
  {
    nome: 'ShopeeNetworkError',
    fabricar: () => new ShopeeNetworkError('caiu'),
    esperado: { pedido: 'aguardando', parametro: 'aguardando', ship: 'verificar' },
  },
  {
    nome: 'ShopeeHttpError',
    fabricar: () => new ShopeeHttpError('borda', { httpStatus: 403, path: '/p' }),
    esperado: { pedido: 'aguardando', parametro: 'aguardando', ship: 'verificar' },
  },
  {
    nome: 'ShopeeApiError (transient)',
    fabricar: () => envelope('error_server'),
    esperado: { pedido: 'aguardando', parametro: 'aguardando', ship: 'verificar' },
  },
  {
    nome: 'ShopeeApiError (other)',
    fabricar: () => envelope('logistics.codigo_inedito_da_shopee'),
    esperado: igual('recusado'),
  },
  {
    nome: 'ShopeeRateLimitError (burst)',
    fabricar: () => envelope('error_rate_limit'),
    esperado: igual('aguardando'),
  },
  {
    nome: 'ShopeeRateLimitError (daily)',
    fabricar: () => envelope('error_limit'),
    esperado: igual('recusado'),
  },
  {
    nome: 'ShopeeApiPartialError (other)',
    fabricar: () =>
      new ShopeeApiPartialError('parcial', {
        code: 'error_busi',
        kind: 'other',
        httpStatus: 200,
        path: '/p',
        parsed: {},
      }),
    esperado: igual('recusado'),
  },
  {
    nome: 'ShopeeReauthRequiredError',
    fabricar: () => envelope('shop_access_expired'),
    esperado: igual('credencial'),
  },
  {
    nome: 'ShopeeSchemaError (2xx)',
    fabricar: () => new ShopeeSchemaError('ilegível', { httpStatus: 200, path: '/p' }),
    esperado: { pedido: 'resposta-ilegivel', parametro: 'resposta-ilegivel', ship: 'verificar' },
  },
  {
    nome: 'ShopeeSchemaError (não-2xx)',
    fabricar: () => new ShopeeSchemaError('ilegível', { httpStatus: 502, path: '/p' }),
    esperado: igual('resposta-ilegivel'),
  },
  {
    nome: 'ShopeeArquivoVazioError',
    fabricar: () => new ShopeeArquivoVazioError('vazio', { httpStatus: 200, path: '/p' }),
    esperado: igual('aguardando'),
  },
  {
    nome: 'ShopeeSemCredencialError',
    fabricar: () => new tokenStore.ShopeeSemCredencialError('sem credencial'),
    esperado: igual('credencial'),
  },
  {
    nome: 'ShopeeContaSemShopIdError',
    fabricar: () => new tokenStore.ShopeeContaSemShopIdError('sem shop_id'),
    esperado: igual('credencial'),
  },
  {
    nome: 'ShopeeCredencialInvalidaError',
    fabricar: () => new credentialStore.ShopeeCredencialInvalidaError('ilegível', ['campo']),
    esperado: igual('credencial'),
  },
  {
    nome: 'ShopeeContaNotConfiguredError',
    fabricar: () => new coreShopee.ShopeeContaNotConfiguredError('sumiu'),
    esperado: igual('credencial'),
  },
  {
    nome: 'ShopeeRefreshEmAndamentoError',
    fabricar: () => new tokenStore.ShopeeRefreshEmAndamentoError('lease', AGORA + 30_000),
    esperado: igual('aguardando'),
  },
  {
    nome: 'ShopeeConfigError (mutante 43)',
    fabricar: () => new ShopeeConfigError('nosso erro'),
    esperado: igual('escapa'),
  },
  {
    nome: 'ShopeeError (a base)',
    fabricar: () => new ShopeeError('base'),
    esperado: igual('escapa'),
  },
  { nome: 'gRPC 14', fabricar: () => grpc(14), esperado: igual('escapa') },
  {
    nome: 'TypeError (mutante 44)',
    fabricar: () => new TypeError('bug'),
    esperado: igual('escapa'),
  },
  { nome: 'ZodError', fabricar: () => new z.ZodError([]), esperado: igual('escapa') },
];

/** Raise `erro` at ONE of the three call sites; the other two answer normally. */
async function noPonto(ponto: Ponto, erro: unknown) {
  const cliente: OpcoesDoCliente =
    ponto === 'pedido'
      ? { ordemErro: erro }
      : ponto === 'parametro'
        ? { parametroErro: erro }
        : { ship: [erro] };
  const f = fakeClient(cliente);
  const avisar = vi.fn<AvisadorDeArranjo>(async () => {});
  try {
    const r = await arranjarPacoteAutomatico(DB, f.client, entrada(), { env: {}, avisar });
    return { r, escapou: undefined, avisar, f };
  } catch (err: unknown) {
    if (err === erro) return { r: undefined, escapou: err, avisar, f };
    throw err;
  }
}

/** The arm's verdict for an escaped error — the ONE table the hook is measured against. */
function disposicao(err: unknown): 'throw' | 'defer' | 'park' {
  return disposicaoDaFalhaDeRastreio(err).tipo;
}

function ehClasseDeErro(v: unknown): v is abstract new (...args: never[]) => Error {
  return typeof v === 'function' && v.prototype instanceof Error;
}

describe('o catch estreito (R-b) — cada classe × os três pontos de chamada', () => {
  describe.each(PONTOS)('no ponto "%s"', (ponto) => {
    it.each(CATALOGO.map((c) => [c.nome, c] as const))('%s', async (_nome, c) => {
      const erro = c.fabricar();
      const { r, escapou, avisar, f } = await noPonto(ponto, erro);
      const esperado = c.esperado[ponto];
      if (esperado === 'escapa') {
        expect(escapou).toBe(erro);
        // Rethrown untouched, and the producer never ran (it sits after the catch).
        expect(avisar).not.toHaveBeenCalled();
      } else {
        expect(escapou).toBeUndefined();
        expect(r?.desfecho).toBe(esperado);
        expect(avisar).toHaveBeenCalledTimes(1);
      }
      // No retry inside the hook: at most one call of each read, the ship at most once.
      expect(f.getOrderDetail).toHaveBeenCalledTimes(1);
      expect(f.shipOrder.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  it('RT5 / mutante 42: o que ESCAPA do hook o braço só pode `throw` — o ZodError é a exceção NOMEADA (park)', async () => {
    for (const c of CATALOGO) {
      for (const ponto of PONTOS) {
        const { escapou } = await noPonto(ponto, c.fabricar());
        if (escapou === undefined) continue;
        expect(
          { classe: c.nome, ponto, disposicao: disposicao(escapou) },
          `${c.nome} escapou em "${ponto}"`,
        ).toStrictEqual({
          classe: c.nome,
          ponto,
          disposicao: escapou instanceof z.ZodError ? 'park' : 'throw',
        });
      }
    }
  });

  it('mutante 42: nenhuma classe que o braço adia ou estaciona escapa — em nenhum dos três pontos', async () => {
    let adiadasOuParadas = 0;
    for (const c of CATALOGO) {
      const d = disposicao(c.fabricar());
      if (d === 'throw' || c.fabricar() instanceof z.ZodError) continue;
      adiadasOuParadas += 1;
      for (const ponto of PONTOS) {
        const { escapou } = await noPonto(ponto, c.fabricar());
        expect(escapou, `${c.nome} (${d}) escapou em "${ponto}"`).toBeUndefined();
      }
    }
    // Not vacuous: both lanes are represented (11 classes today).
    expect(adiadasOuParadas).toBeGreaterThanOrEqual(10);
    expect(CATALOGO.some((c) => disposicao(c.fabricar()) === 'defer')).toBe(true);
    expect(CATALOGO.some((c) => disposicao(c.fabricar()) === 'park')).toBe(true);
  });

  it('o catálogo cobre TODA classe de erro exportada pelo pacote e pelo grafo do token', () => {
    const exportadas = new Set<unknown>(
      [pacoteShopee, tokenStore, credentialStore, coreShopee].flatMap((m) =>
        Object.values(m).filter(ehClasseDeErro),
      ),
    );
    const cobertas = new Set<unknown>(CATALOGO.map((c) => (c.fabricar() as object).constructor));
    const faltando = [...exportadas]
      .filter((k) => !cobertas.has(k))
      .map((k) => (k as { name: string }).name);
    expect(faltando).toStrictEqual([]);
  });
});

/* ------------------------- the producer: OUTSIDE the catch ------------------------- */

describe('o avisador — fora do try (mutantes 46 e 47)', () => {
  it('recebe (db, e, r) com o MESMO r que o hook devolve', async () => {
    const { r, avisar, e } = await rodar();
    expect(avisar).toHaveBeenCalledTimes(1);
    const [db, entradaRecebida, resultado] = avisar.mock.calls[0] ?? [];
    expect(db).toBe(DB);
    expect(entradaRecebida).toBe(e);
    expect(resultado).toBe(r);
  });

  it.each([
    null,
    ESTADO_FRETE.despachoAutorizado,
    ESTADO_FRETE.aguardandoPostagem,
    ESTADO_FRETE.postado,
    ESTADO_FRETE.cancelado,
  ])(
    '⚠️ Q2-F1 / mutante 35: o estado CONFIRMADO (%s) nunca segura o ARRANJO — só o produtor o lê',
    async (estado) => {
      // A linha velha de um `ignorado-obsoleto` ainda arranja: a Shopee absorve
      // um ship duplicado, e um arranjo perdido é um pedido que ela cancela.
      const f = fakeClient();
      const avisar = vi.fn<AvisadorDeArranjo>(async () => {});
      const e = entrada({}, estado);

      const r = await arranjarPacoteAutomatico(DB, f.client, e, { env: {}, avisar });

      expect(r.desfecho).toBe('programado');
      expect(f.chamadas).toStrictEqual(CHAMADAS_DO_ARRANJO);
      // …e o produtor recebe a entrada INTEIRA, o estado confirmado incluído.
      expect(avisar.mock.calls[0]?.[1]).toBe(e);
      expect(avisar.mock.calls[0]?.[1].estadoFreteConfirmado).toBe(estado);
    },
  );

  it.each([
    ['gRPC 14 (R-b: a redelivery re-levanta o aviso)', () => grpc(14)],
    [
      'uma classe de CREDENCIAL (dentro do try viraria `credencial`)',
      () => new tokenStore.ShopeeSemCredencialError('x'),
    ],
    [
      'um ShopeeSchemaError (dentro do try viraria `resposta-ilegivel`)',
      () => new ShopeeSchemaError('x', { httpStatus: 200, path: '/p' }),
    ],
    ['um ZodError do mapeador', () => new z.ZodError([])],
  ] as const)('mutante 46: a falha do avisador PROPAGA — %s', async (_n, fabricar) => {
    const erro = fabricar();
    const f = fakeClient();
    const avisar = vi.fn<AvisadorDeArranjo>(async () => {
      throw erro;
    });
    await expect(
      arranjarPacoteAutomatico(DB, f.client, entrada(), { env: {}, avisar }),
    ).rejects.toBe(erro);
    // The ship happened ONCE; the failure is the producer's, never a re-ship.
    expect(f.shipOrder).toHaveBeenCalledTimes(1);
    expect(avisar).toHaveBeenCalledTimes(1);
  });

  it('RT5: o que o AVISADOR deixa escapar o braço só pode `throw` — ou estacionar o ZodError', () => {
    expect(disposicao(grpc(14))).toBe('throw');
    expect(disposicao(grpc(10))).toBe('throw');
    expect(disposicao(new z.ZodError([]))).toBe('park');
  });

  it('sem deps.avisar ⇒ o produtor PADRÃO (avisarArranjoAutomatico) é chamado', async () => {
    const f = fakeClient();
    const e = entrada();
    const r = await arranjarPacoteAutomatico(DB, f.client, e, { env: VALVULA_LIGADA });
    expect(r.desfecho).toBe('desligado');
    expect(vi.mocked(avisarArranjoAutomatico)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(avisarArranjoAutomatico)).toHaveBeenCalledWith(DB, e, r);
  });

  it('a forma ArranjadorDePacote (3 argumentos) usa process.env e o produtor padrão', async () => {
    const arranjar: ArranjadorDePacote = arranjarPacoteAutomatico;
    vi.stubEnv(SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV, '1');
    const f = fakeClient();
    const r = await arranjar(DB, f.client, entrada());
    expect(r.desfecho).toBe('desligado');
    expect(f.chamadas).toStrictEqual([]);
    expect(vi.mocked(avisarArranjoAutomatico)).toHaveBeenCalledTimes(1);
  });

  it('mutante 47: o produtor padrão também NÃO é chamado fora do canal', async () => {
    const f = fakeClient();
    await arranjarPacoteAutomatico(DB, f.client, entrada({ logistics_channel_id: FORA }));
    expect(vi.mocked(avisarArranjoAutomatico)).not.toHaveBeenCalled();
  });
});

/* ----------------------------------- the table ----------------------------------- */

describe('DESFECHO_DO_MOTIVO — total, e com os grupos do reconcile', () => {
  it('mutante 26 (TIPO): Record total sobre MotivoEtiquetaShopee — o typecheck mata um Partial', () => {
    expectTypeOf(DESFECHO_DO_MOTIVO).toEqualTypeOf<
      Readonly<Record<MotivoEtiquetaShopee, DesfechoArranjoAutomatico>>
    >();
    const total = DESFECHO_DO_MOTIVO satisfies {
      readonly [M in MotivoEtiquetaShopee]-?: DesfechoArranjoAutomatico;
    };
    expect(Object.keys(total).sort()).toStrictEqual([...TODOS_OS_MOTIVOS].sort());
  });

  it('cada motivo decide um desfecho, e só os cinco que um motivo pode significar', () => {
    for (const m of TODOS_OS_MOTIVOS) {
      expect(['nao-elegivel', 'retido', 'nfe-pendente', 'aguardando', 'recusado']).toContain(
        DESFECHO_DO_MOTIVO[m],
      );
    }
  });

  it('os grupos, exatos (mutantes 27–30 na tabela)', () => {
    const grupo = (d: DesfechoArranjoAutomatico) =>
      TODOS_OS_MOTIVOS.filter((m) => DESFECHO_DO_MOTIVO[m] === d).sort();
    expect(grupo('nao-elegivel')).toStrictEqual(
      [
        'janela-fechada',
        'pacote-inelegivel',
        'pedido-cancelado',
        'pedido-fbs',
        'status-desconhecido',
      ].sort(),
    );
    expect(grupo('retido')).toStrictEqual(['retido-pela-shopee']);
    expect(grupo('nfe-pendente')).toStrictEqual(['nfe-pendente']);
    expect(grupo('aguardando')).toStrictEqual(
      ['pacote-inexistente', 'pacote-nao-pronto', 'pacotes-mudaram', 'sem-pacotes'].sort(),
    );
    const recusados = grupo('recusado');
    expect(recusados).toContain('limite-diario');
    expect(recusados).toContain('recusa-desconhecida');
    expect(recusados).toContain('pedido-em-cancelamento');
    expect(recusados).toHaveLength(TODOS_OS_MOTIVOS.length - 11);
  });
});

/* ------------------------------- module discipline ------------------------------- */

describe('o módulo — disciplina', () => {
  const FONTE = readFileSync(new URL('./arranjoAutomatico.ts', import.meta.url), 'utf8');
  /** Comments stripped: the docblock NAMES what the code must not do. */
  const CODIGO = FONTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('não loga nada (nem no texto do código)', () => {
    expect(CODIGO).not.toMatch(/\bconsole\./);
  });

  it('não loga nada (em execução, sobre todos os ramos)', async () => {
    const espioes = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await rodar();
    await rodar({ linha: { logistics_channel_id: FORA } });
    await rodar({ env: VALVULA_LIGADA });
    await rodar({ cliente: { parametro: DOIS_ENDERECOS } });
    await rodar({ cliente: { ship: [new ShopeeNetworkError('x')] } });
    await rodar({ cliente: { ordemErro: envelope('shop_access_expired') } });
    for (const s of espioes) expect(s).not.toHaveBeenCalled();
  });

  it('nunca NOMEIA a API de escrita atômica (a guarda do inventário lê texto cru)', () => {
    expect(FONTE).not.toContain(['run', 'Transaction'].join(''));
  });

  it('sem relógio próprio, sem escrita própria e sem re-envio de NF-e (R-g)', () => {
    expect(CODIGO).not.toMatch(/Date\.now|new Date\(/);
    expect(CODIGO).not.toMatch(/@delfrance\/data/);
    expect(CODIGO).not.toMatch(/reenvioNfe/);
  });
});

/* ------------------------------ ResultadoArranjoAutomatico ------------------------------ */

describe('ResultadoArranjoAutomatico — a forma', () => {
  it('as sete chaves do seam, em TODO desfecho (nenhum endereço, nenhum horário)', async () => {
    const rodadas = await Promise.all([
      rodar(),
      rodar({ linha: { logistics_channel_id: FORA } }),
      rodar({ env: VALVULA_LIGADA }),
      rodar({ cliente: { parametro: DOIS_ENDERECOS } }),
      rodar({ cliente: { ship: [envelope('logistics.codigo_inedito_da_shopee')] } }),
      rodar({ cliente: { ordemErro: envelope('shop_access_expired') } }),
    ]);
    const vistos = new Set<string>();
    for (const { r } of rodadas) {
      expect(Object.keys(r).sort()).toStrictEqual(CHAVES_DO_RESULTADO);
      vistos.add(r.desfecho);
    }
    expect(vistos.size).toBe(rodadas.length);
  });

  it('o resultado não é um ResultadoArranjoAutomatico qualquer: o tipo é o do seam', () => {
    expectTypeOf(
      arranjarPacoteAutomatico,
    ).returns.resolves.toEqualTypeOf<ResultadoArranjoAutomatico>();
  });
});
