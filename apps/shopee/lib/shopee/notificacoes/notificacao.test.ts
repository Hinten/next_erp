import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';
import { z } from 'zod';

// Type-only — erased at compile time, so it does not defeat the mocks below.
import type { ShopeeNotificationPayload } from './notificacao';
import type {
  AlvoDeImportacaoShopee,
  ResultadoImportacaoPedidoShopee,
} from '../pedidos/importarPedido';
import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError } from '../core/shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '../core/tokenStore';
// The shared fake Firestore — `persistNotificationParked` writes through the
// REAL store, so the terminal status has to be read back off a document.
import { FakeDb, asDb } from '../testing/fakeDb';

/**
 * Mocked: the three modules the conta arms lean on — the shop→integração
 * resolver and the conta reader (`core/contaCache`), the avisos producer
 * (`avisos/autorizacao`) and the expiry sweep (`conta/expiracaoSweep`). Each
 * one has its own suite; here they are seams, so this file can pin the ROUTING
 * (which arm runs, and how often) without a Firestore.
 */
const h = vi.hoisted(() => ({
  find: vi.fn(async (_db: unknown, _shopId: number) => null as string | null),
  readConta: vi.fn(async (_db: unknown, _id: string) => null as Record<string, unknown> | null),
  avisarDesautorizacao: vi.fn(async () => ({ chave: 'k', resultado: 'criado' })),
  resolverAvisos: vi.fn(async () => ({ expiracao: true, desautorizacao: false })),
  sweep: vi.fn(async () => ({
    lojasEnumeradas: 0,
    paginasLidas: 1,
    truncado: false,
    semIntegracao: 0,
    avisados: 0,
    resolvidos: 0,
    resultados: {},
    erros: [],
  })),
}));

vi.mock('../core/contaCache', () => ({
  findIntegracaoByShopId: (db: unknown, shopId: number) => h.find(db, shopId),
  readConta: (db: unknown, id: string) => h.readConta(db, id),
}));

vi.mock('../avisos/autorizacao', () => ({
  avisarDesautorizacao: (...args: unknown[]) => h.avisarDesautorizacao(...(args as [])),
  resolverAvisosDeAutorizacao: (...args: unknown[]) => h.resolverAvisos(...(args as [])),
}));

vi.mock('../conta/expiracaoSweep', () => ({
  runShopeeAuthorizationExpirySweep: (...args: unknown[]) => h.sweep(...(args as [])),
}));

const {
  asDocId,
  CODIGO_AUSENTE,
  dedupKeyOf,
  defaultProcessDeps,
  destinoDoCodigo,
  disposicaoDaFalhaDeImportacao,
  docIdOf,
  handleNotificationTask,
  identidadeDoPush,
  lojasDoPushDeConta,
  lojasExpirandoDoPush12,
  mensagemDoErro,
  motivoDoParque,
  MOTIVO_SEM_AUTHORIZE_TYPE,
  parseNotificationBody,
  payloadDeDocumento,
  persistNotificationParked,
  processNotificationPayload,
  sanitizarData,
  SHOPEE_NOTIFICATION_QUEUE,
  toDisposition,
} = await import('./notificacao');

const db = {} as unknown as Firestore;

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real shop id, partner id or order.     */
/* -------------------------------------------------------------------------- */

const SHOP_ID = 987654;
const INTEGRACAO_ID = 'int-1';
/** Shopee's own doc-sample shape for an `order_sn` — not a real order. */
const ORDER_SN = '220810QSK8S7BX';
const AGORA_MS = 1_700_000_000_000;

function resultadoDeImportacao(
  over: Partial<ResultadoImportacaoPedidoShopee> = {},
): ResultadoImportacaoPedidoShopee {
  return {
    kind: 'pedido',
    acao: 'criado',
    orderSn: ORDER_SN,
    pedidoId: 'ped-abc',
    orderStatus: 'READY_TO_SHIP',
    itensSemProduto: 0,
    // Step 6 (#1514): the default is the ordinary happy path — the pagamento
    // transaction ran and created the payment. `null` is the "it did not run"
    // case and every test that wants it says so.
    acaoPagamentos: 'criado',
    pagamentosGravados: 1,
    detail: 'criado',
    ...over,
  };
}

/**
 * The code-3 seam. Injected on EVERY call in this file — including the arms
 * that have nothing to do with it — so a routing bug that reaches the importer
 * from another code is caught here instead of dynamically importing the real
 * pedido tree (which would open a Firestore and a Shopee client).
 */
const importarPedido = vi.fn(
  async (_db: Firestore, _alvo: AlvoDeImportacaoShopee): Promise<ResultadoImportacaoPedidoShopee> =>
    resultadoDeImportacao(),
);

const deps = {
  partnerClient: () => ({ getShopsByPartner: async () => ({}) }) as never,
  increment: (by: number) => by,
  nowMs: () => AGORA_MS,
  importarPedido,
};

function payload(over: Partial<ShopeeNotificationPayload> = {}): ShopeeNotificationPayload {
  return { code: 1, shopId: null, timestamp: 1000, data: null, ...over };
}

/**
 * The REAL parser, for the rows whose identity depends on what it LIFTS: a
 * hand-built `payload({ shopId: null, data })` cannot show that a shop id at
 * the top level of the envelope reaches the doc id.
 */
function parsed(body: Record<string, unknown>): ShopeeNotificationPayload {
  const p = parseNotificationBody(body);
  if (p == null) throw new Error('parseNotificationBody devolveu null para um envelope válido');
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  importarPedido.mockReset();
  importarPedido.mockImplementation(async () => resultadoDeImportacao());
  h.find.mockResolvedValue(null);
  h.readConta.mockResolvedValue(null);
  h.resolverAvisos.mockResolvedValue({ expiracao: true, desautorizacao: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── parseNotificationBody ───────────────────────────────────────────────────

describe('parseNotificationBody', () => {
  it('devolve null para o que não é um envelope de push', () => {
    expect(parseNotificationBody(null)).toBeNull();
    expect(parseNotificationBody('{"code":1}')).toBeNull();
    expect(parseNotificationBody([{ code: 1 }])).toBeNull();
    expect(parseNotificationBody({})).toBeNull();
    expect(parseNotificationBody({ code: 'um' })).toBeNull();
    expect(parseNotificationBody({ code: null })).toBeNull();
    expect(parseNotificationBody({ code: '' })).toBeNull();
  });

  it('aceita um code em string numérica (o coercer compartilhado)', () => {
    expect(parseNotificationBody({ code: '12' })?.code).toBe(12);
  });

  // `asInt` TRUNCA qualquer número finito, então um code fracionário — que a
  // Shopee nunca envia — roteia pelo inteiro. Fixado para que a tolerância seja
  // uma escolha registrada e não uma surpresa na próxima leitura.
  it('trunca um code fracionário em vez de recusá-lo', () => {
    expect(parseNotificationBody({ code: 1.9 })?.code).toBe(1);
  });

  // ⚠️ QUATRO colocações: `shop_id` e `shopid`, no topo e dentro de `data`.
  // Três dos cinco exemplos do push 16 usam a grafia sem underscore.
  it.each([
    ['shop_id no topo', { code: 3, shop_id: 987654 }],
    ['shopid no topo', { code: 3, shopid: 987654 }],
    ['shop_id dentro de data', { code: 1, data: { shop_id: 987654 } }],
    ['shopid dentro de data', { code: 2, data: { shopid: 987654 } }],
  ])('levanta o shop id de %s', (_nome, body) => {
    expect(parseNotificationBody(body)?.shopId).toBe(987654);
  });

  it('devolve shopId null quando nenhuma das quatro colocações traz um', () => {
    expect(parseNotificationBody({ code: 12, data: { page_no: 1 } })?.shopId).toBeNull();
  });

  // ⚠️ A Shopee manda o MESMO campo em dois TIPOS: uma das amostras de code 1
  // do teste de sandbox de 2026-09-09 trouxe `data.shop_id` como NÚMERO e a
  // outra como STRING (com `success` também em string). O coercer compartilhado
  // aceita a string numérica, e o campo levantado é sempre um `number` — se
  // fosse a string, `findIntegracaoByShopId` não acharia loja nenhuma.
  it('levanta um data.shop_id em STRING como número', () => {
    const p = parseNotificationBody({ code: 1, data: { shop_id: '987654', success: '1' } });
    expect(p?.shopId).toBe(987654);
    expect(typeof p?.shopId).toBe('number');
  });

  // ⚠️ O envelope traz SEGUNDOS; deste lado tudo é MILLIS. `asMillis` trunca
  // qualquer número finito COMO millis, então o ×1000 tem de vir antes dele.
  it('converte o timestamp de SEGUNDOS para MILLIS', () => {
    expect(parseNotificationBody({ code: 12, timestamp: 1568606634 })?.timestamp).toBe(
      1568606634000,
    );
  });

  // NEAR-MISS: sem o ×1000 o valor seria 1568606634 — dezembro de 1970. Este
  // par é o que impede a conversão de sumir sem ninguém notar.
  it('NÃO trata o timestamp do envelope como se já fosse millis', () => {
    expect(parseNotificationBody({ code: 12, timestamp: 1568606634 })?.timestamp).not.toBe(
      1568606634,
    );
  });

  it('mantém o clamp superior: um timestamp absurdo vira null, não NaN', () => {
    // 1e16 s × 1000 estoura MILLIS_UPPER_BOUND — um valor não clampado chegaria
    // a `millisSinceEpoch()` como NaN e lançaria DENTRO de `persistFailure`.
    expect(parseNotificationBody({ code: 1, timestamp: 1e16 })?.timestamp).toBeNull();
  });

  it('timestamp ausente vira null', () => {
    expect(parseNotificationBody({ code: 1 })?.timestamp).toBeNull();
  });

  it('preserva `data` e ignora o resto do envelope', () => {
    const p = parseNotificationBody({
      code: 1,
      partner_id: 1000001,
      data: { authorize_type: 'expiry', shop_id: 987654 },
    });
    expect(p?.data).toEqual({ authorize_type: 'expiry', shop_id: 987654 });
  });
});

// ── sanitizarData ───────────────────────────────────────────────────────────

describe('sanitizarData — os três ramos', () => {
  it('1. o que não é um objeto vira null', () => {
    expect(sanitizarData(undefined)).toBeNull();
    expect(sanitizarData(null)).toBeNull();
    expect(sanitizarData('texto')).toBeNull();
    expect(sanitizarData(42)).toBeNull();
    expect(sanitizarData([1, 2])).toBeNull();
  });

  it('2. arrays DIRETAMENTE dentro de arrays viram texto (o Firestore os recusa)', () => {
    const out = sanitizarData({ matriz: [[1, 2], 3] });
    expect(out).toEqual({ matriz: ['[1,2]', 3] });
  });

  // NEAR-MISS do mesmo ramo: um array dentro de um OBJETO dentro de um array é
  // LEGAL no Firestore, e achatá-lo perderia dados sem motivo.
  it('2b. um array dentro de um objeto dentro de um array é PRESERVADO', () => {
    const out = sanitizarData({ itens: [{ ids: [1, 2] }] });
    expect(out).toEqual({ itens: [{ ids: [1, 2] }] });
  });

  it('3. acima do orçamento vira { _truncado, _bytes }', () => {
    const grande = { texto: 'x'.repeat(70 * 1024) };
    const out = sanitizarData(grande) as Record<string, unknown>;
    expect(out._truncado).toBe(true);
    expect(out._bytes).toBeGreaterThan(64 * 1024);
    expect(out.texto).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['_bytes', '_truncado']);
  });

  // NEAR-MISS do orçamento: logo abaixo do limite o conteúdo passa inteiro.
  it('3b. logo abaixo do orçamento o conteúdo é preservado', () => {
    const out = sanitizarData({ texto: 'x'.repeat(1024) }) as { texto?: string };
    expect(out.texto).toHaveLength(1024);
  });

  it('descarta nomes de campo que o Firestore recusa', () => {
    expect(sanitizarData({ '': 1, __x__: 2, ok: 3 })).toEqual({ ok: 3 });
  });
});

// ── the doc id table ────────────────────────────────────────────────────────

describe('asDocId — as cinco recusas', () => {
  it.each([
    ['.', '.'],
    ['..', '..'],
    ['com barra', 'a/b'],
    ['nome reservado', '__x__'],
    ['acima de 1500 caracteres', 'a'.repeat(1501)],
  ])('recusa %s devolvendo null (⇒ id automático)', (_nome, valor) => {
    expect(asDocId(valor)).toBeNull();
  });

  it('aceita um id normal e o limite exato de 1500', () => {
    expect(asDocId('3:111:ORD1:2222')).toBe('3:111:ORD1:2222');
    expect(asDocId('a'.repeat(1500))).toHaveLength(1500);
  });

  it('um ordersn com barra degrada o docId inteiro para null', () => {
    expect(docIdOf(payload({ code: 3, shopId: 111, data: { ordersn: 'A/B' } }))).toBeNull();
  });
});

describe('docIdOf — uma linha por push_code', () => {
  it.each([
    [
      '3 status do pedido (update_time é o relógio)',
      3,
      { ordersn: 'ORD1', update_time: 2222 },
      '3:111:ORD1:2222',
    ],
    // ⚠️ O par do de cima: sem `update_time` o code 3 cai para o carimbo do
    // ENVELOPE, exatamente como o 4/30/47/29. Antes ele caía para `-`, e duas
    // entregas sem relógio sobre o MESMO pedido dividiam uma única linha de
    // dead-letter — a segunda sobrescrevendo a primeira, em silêncio.
    ['3 status do pedido (cai para o timestamp)', 3, { ordersn: 'ORD1' }, '3:111:ORD1:1000'],
    // ⚠️ push 2 não documenta `update_time` e SEMPRE traz `package_number`: o
    // pacote é o recurso, então entra na identidade.
    [
      '4 rastreio (pedido + pacote, cai para o timestamp)',
      4,
      { ordersn: 'ORD1', package_number: 'PKG1' },
      '4:111:ORD1:PKG1:1000',
    ],
    ['4 rastreio (sem pacote)', 4, { ordersn: 'ORD1' }, '4:111:ORD1:-:1000'],
    [
      '30 fulfillment do pacote (update_time é o relógio)',
      30,
      { package_number: 'PKG1', update_time: 2222 },
      '30:111:PKG1:2222',
    ],
    [
      '30 fulfillment do pacote (cai para o timestamp)',
      30,
      { package_number: 'PKG1' },
      '30:111:PKG1:1000',
    ],
    [
      '47 informação do pacote (update_time é o relógio)',
      47,
      { package_number: 'PKG1', update_time: 2222 },
      '47:111:PKG1:2222',
    ],
    [
      '47 informação do pacote (cai para o timestamp)',
      47,
      { package_number: 'PKG1' },
      '47:111:PKG1:1000',
    ],
    // ⚠️ Um documento de envio é do PACOTE (`create_shipping_document` recebe um
    // `package_number` por entrada); o pedido é só o fallback, nas duas grafias.
    [
      '15 documento de envio (pacote primeiro)',
      15,
      { ordersn: 'ORD1', package_number: 'PKG1' },
      '15:111:PKG1:1000',
    ],
    ['15 documento de envio (só ordersn)', 15, { ordersn: 'ORD1' }, '15:111:ORD1:1000'],
    ['15 documento de envio (só order_sn)', 15, { order_sn: 'ORD1' }, '15:111:ORD1:1000'],
    ['29 devolução', 29, { return_sn: 'RET1' }, '29:111:RET1:1000'],
    ['16 violação de anúncio', 16, { item_id: 55 }, '16:111:55:1000'],
    ['22 eco de preço', 22, { item_id: 55 }, '22:111:55:1000'],
    ['27 publicação agendada', 27, { item_id: 55 }, '27:111:55:1000'],
    ['7 promoção', 7, { item_id: 55 }, '7:111:55:1000'],
    ['8 estoque reservado', 8, { item_id: 55 }, '8:111:55:1000'],
    ['9 promoção/estoque', 9, { item_id: 55 }, '9:111:55:1000'],
    // ⚠️ push 10 aninha os ids em `data.content`; `data` só traz `type`, `region`
    // e `content`. A MENSAGEM lidera (a conversa repete em toda mensagem do
    // fio), e o `msg_id: 0` da amostra de notificação NÃO é um id.
    [
      '10 chat (type=message: message_id)',
      10,
      { type: 'message', content: { message_id: 'M1', conversation_id: 'C1' } },
      '10:111:M1:1000',
    ],
    [
      '10 chat (type=notification: msg_id)',
      10,
      { type: 'notification', content: { msg_id: 77, conversation_id: 'C1' } },
      '10:111:77:1000',
    ],
    [
      '10 chat (type=notification, msg_id 0 cai para a conversa)',
      10,
      { type: 'notification', content: { msg_id: 0, conversation_id: 'C1' } },
      '10:111:C1:1000',
    ],
    ['10 chat (ids no nível ERRADO não contam)', 10, { conversation_id: 'C1' }, '10:111:-:1000'],
    ['5 shopee updates', 5, { video_id: 'V1' }, '5:111:V1:1000'],
    ['11 vídeo', 11, { video_id: 'V1' }, '11:111:V1:1000'],
    ['13 marca', 13, { brand_id: 9 }, '13:111:9:1000'],
    // ⚠️ 24 / 25 (push_api_id 27 / 28) — o recurso é a RESERVA (`booking_sn`),
    // não o pedido: é só isso que `data` traz, além do rastreio (24) ou do
    // status READY/FAILED (25).
    [
      '24 rastreio da reserva',
      24,
      { booking_sn: 'B1', tracking_number: 'BR2222636885' },
      '24:111:B1:1000',
    ],
    ['24 rastreio da reserva (sem booking_sn)', 24, {}, '24:111:-:1000'],
    [
      '25 documento de envio da reserva',
      25,
      { booking_sn: 'B1', status: 'READY' },
      '25:111:B1:1000',
    ],
    ['25 documento de envio da reserva (sem booking_sn)', 25, {}, '25:111:-:1000'],
    ['28 penalidade', 28, {}, '28:111:-:1000'],
    ['999 desconhecido', 999, {}, '999:111:-:1000'],
  ])('%s', (_nome, code, data, esperado) => {
    expect(docIdOf(payload({ code, shopId: 111, data }))).toBe(esperado);
  });

  // ⚠️ Os codes de conta passam pelo parser REAL: `shopId` é o que ele levanta
  // das quatro colocações, e o segmento da loja vem dele — exatamente como em
  // toda outra linha. Uma loja levantada de `data` aparece nos dois segmentos
  // (redundante, nunca ambíguo); uma loja SÓ no topo do envelope aparece só no
  // primeiro — e é essa colocação que um segmento fixo em `-` apagava.
  it.each([
    [
      '1 autorização (shop_id em data)',
      { code: 1, data: { shop_id: 987654 } },
      '1:987654:987654:1000',
    ],
    [
      '1 autorização (shopid em data)',
      { code: 1, data: { shopid: 987654 } },
      '1:987654:987654:1000',
    ],
    [
      '1 autorização (shop_id SÓ no topo)',
      { code: 1, shop_id: 987654, data: { success: true } },
      '1:987654:-:1000',
    ],
    [
      '1 autorização (shopid SÓ no topo)',
      { code: 1, shopid: 987654, data: { success: true } },
      '1:987654:-:1000',
    ],
    [
      '1 autorização (merchant)',
      { code: 1, data: { merchant_id: 600222872 } },
      '1:-:600222872:1000',
    ],
    [
      '1 autorização (main account)',
      { code: 1, data: { main_account_id: 68272 } },
      '1:-:68272:1000',
    ],
    [
      '1 autorização (lista de lojas)',
      { code: 1, data: { shop_id_list: [62000001, 62000002] } },
      '1:-:62000001_62000002:1000',
    ],
    [
      '2 cancelamento (shopid em data)',
      { code: 2, data: { shopid: 987654, authorize_type: 'expiry' } },
      '2:987654:987654:1000',
    ],
    [
      '2 cancelamento (shop_id SÓ no topo)',
      { code: 2, shop_id: 987654, data: { authorize_type: 'expiry' } },
      '2:987654:-:1000',
    ],
    ['2 sem sujeito nenhum', { code: 2, data: {} }, '2:-:-:1000'],
  ])('%s', (_nome, body, esperado) => {
    expect(docIdOf(parsed({ ...body, timestamp: 1 }))).toBe(esperado);
  });

  // ⚠️ O motivo da regra acima: o `timestamp` do envelope é em SEGUNDOS, então
  // duas lojas autorizadas no mesmo segundo são a norma, não a exceção. Com a
  // loja fora da identidade, as duas dividiam UM doc id — o create-only ignora
  // o segundo (ALREADY_EXISTS), a linha `deferred` da segunda loja nunca
  // existia e a reautorização dela nunca era re-dirigida — e UMA chave de
  // dedup, então o sweep re-dirigia uma por rodada.
  it('1: duas lojas com o id SÓ no topo, no mesmo segundo, têm ids e chaves DISTINTOS', () => {
    const a = parsed({ code: 1, shop_id: 111, timestamp: 1_700_000_000, data: { success: true } });
    const b = parsed({ code: 1, shop_id: 222, timestamp: 1_700_000_000, data: { success: true } });
    expect(docIdOf(a)).toBe('1:111:-:1700000000000');
    expect(docIdOf(b)).toBe('1:222:-:1700000000000');
    expect(dedupKeyOf(a)).toBe('1:111:-');
    expect(dedupKeyOf(b)).toBe('1:222:-');
  });

  // …e o fold ainda APLICA onde deve: a reentrega da mesma loja colapsa na
  // dedup (o carimbo cai fora) e continua distinta no doc id.
  it('1: a reentrega da MESMA loja (id só no topo) colapsa na dedup, não no doc id', () => {
    const a = parsed({ code: 1, shop_id: 111, timestamp: 1_700_000_000, data: { success: true } });
    const b = parsed({ code: 1, shop_id: 111, timestamp: 1_700_000_005, data: { success: true } });
    expect(dedupKeyOf(a)).toBe('1:111:-');
    expect(dedupKeyOf(b)).toBe('1:111:-');
    expect(docIdOf(a)).not.toBe(docIdOf(b));
  });

  // ⚠️ A mesma classe do par acima, para os três codes PARADOS cuja identidade
  // era mais grossa que o recurso: dois pacotes de UM pedido (4 e 15) e duas
  // mensagens de UMA conversa (10), no mesmo segundo do envelope, precisam de
  // ids e chaves DISTINTOS — cada linha parada é create-only, e a segunda era
  // engolida (ALREADY_EXISTS) sem deixar rastro.
  it.each([
    [
      '4 rastreio: dois pacotes do mesmo pedido',
      {
        code: 4,
        shop_id: 111,
        timestamp: 1_660_123_089,
        data: { ordersn: 'ORD1', package_number: 'PKG-A', tracking_no: 'T1' },
      },
      {
        code: 4,
        shop_id: 111,
        timestamp: 1_660_123_089,
        data: { ordersn: 'ORD1', package_number: 'PKG-B', tracking_no: 'T2' },
      },
    ],
    [
      '15 documento de envio: dois pacotes do mesmo pedido',
      {
        code: 15,
        shop_id: 111,
        timestamp: 1_660_123_089,
        data: { ordersn: 'ORD1', package_number: 'PKG-A', status: 'READY' },
      },
      {
        code: 15,
        shop_id: 111,
        timestamp: 1_660_123_089,
        data: { ordersn: 'ORD1', package_number: 'PKG-B', status: 'READY' },
      },
    ],
    [
      '10 chat: duas mensagens da mesma conversa',
      {
        code: 10,
        shop_id: 111,
        timestamp: 1_726_044_722,
        data: {
          type: 'message',
          region: 'BR',
          content: { message_id: 'M1', conversation_id: 'C1' },
        },
      },
      {
        code: 10,
        shop_id: 111,
        timestamp: 1_726_044_722,
        data: {
          type: 'message',
          region: 'BR',
          content: { message_id: 'M2', conversation_id: 'C1' },
        },
      },
    ],
  ])('%s, no mesmo segundo, têm ids e chaves DISTINTOS', (_nome, corpoA, corpoB) => {
    const a = parsed(corpoA);
    const b = parsed(corpoB);
    expect(docIdOf(a)).not.toBe(docIdOf(b));
    expect(dedupKeyOf(a)).not.toBe(dedupKeyOf(b));
  });

  // ⚠️ O corpo REAL do "Verify and Save" do console, byte a byte como ele
  // chegou em 2026-09-09: só `code` e `data.verify_info` — sem `shop_id` e sem
  // `timestamp`. A identidade dele é o ramo default, e é a mesma para os dois
  // envios de cada clique (o console manda duas vezes) — o que é justamente o
  // que se quer: se algum dia ele PARASSE, os cliques colapsariam numa linha só
  // em vez de uma por clique.
  it('0 verificação do console: o corpo real produz 0:-:-:-, sem loja e sem carimbo', () => {
    const p = parsed({
      code: 0,
      data: {
        verify_info: 'This is a Verification message.Please respond in the certain format.',
      },
    });
    expect(p.shopId).toBeNull();
    expect(p.timestamp).toBeNull();
    expect(docIdOf(p)).toBe('0:-:-:-');
    expect(dedupKeyOf(p)).toBe('0:-:-');
  });

  // ⚠️ A mesma classe dos pares 4 / 15 / 10 acima, agora para o code 24: duas
  // reservas de uma mesma loja recebem rastreio no MESMO segundo do envelope
  // (é assim que a Shopee despacha um lote), e cada linha parada é create-only
  // — com a reserva fora da identidade a segunda seria engolida
  // (ALREADY_EXISTS) sem deixar rastro.
  it('24: duas reservas no mesmo segundo têm ids e chaves DISTINTOS', () => {
    const a = parsed({
      code: 24,
      shop_id: 111,
      timestamp: 1_660_123_089,
      data: { booking_sn: '220809MDBFYFT2', tracking_number: 'BR2222636885' },
    });
    const b = parsed({
      code: 24,
      shop_id: 111,
      timestamp: 1_660_123_089,
      data: { booking_sn: '201118BCKPJQQ8', tracking_number: 'BR2222636886' },
    });
    expect(docIdOf(a)).toBe('24:111:220809MDBFYFT2:1660123089000');
    expect(docIdOf(b)).toBe('24:111:201118BCKPJQQ8:1660123089000');
    expect(dedupKeyOf(a)).not.toBe(dedupKeyOf(b));
  });

  // …e o fold APLICA onde deve: a reentrega da MESMA reserva é um trabalho só
  // para a dedup do sweep, e continua distinta no doc id.
  it('24: a reentrega da MESMA reserva colapsa na dedup, não no doc id', () => {
    const a = parsed({
      code: 24,
      shop_id: 111,
      timestamp: 1_660_123_089,
      data: { booking_sn: '220809MDBFYFT2', tracking_number: 'BR2222636885' },
    });
    const b = parsed({
      code: 24,
      shop_id: 111,
      timestamp: 1_660_123_389,
      data: { booking_sn: '220809MDBFYFT2', tracking_number: 'BR2222636885' },
    });
    expect(dedupKeyOf(a)).toBe(dedupKeyOf(b));
    expect(docIdOf(a)).not.toBe(docIdOf(b));
  });

  it('um segmento ausente vira "-", nunca é omitido', () => {
    // Sem shopId, sem ordersn e sem NENHUM relógio (nem `update_time` nem o
    // carimbo do envelope), o code 3 ainda produz quatro segmentos.
    expect(docIdOf(payload({ code: 3, shopId: null, timestamp: null, data: {} }))).toBe('3:-:-:-');
  });

  // ⚠️ push 12 é PAGINADO. Sem o `page_no` na identidade, a página 2 sobrescreve
  // a linha da página 1 e as lojas dela somem em silêncio.
  it('12 expiração: páginas diferentes produzem ids DISTINTOS', () => {
    const p1 = docIdOf(
      payload({ code: 12, shopId: null, data: { expire_before: 1619740800, page_no: 1 } }),
    );
    const p2 = docIdOf(
      payload({ code: 12, shopId: null, data: { expire_before: 1619740800, page_no: 2 } }),
    );
    expect(p1).toBe('12:-:1619740800:1:1000');
    expect(p2).toBe('12:-:1619740800:2:1000');
    expect(p1).not.toBe(p2);
  });
});

describe('dedupKeyOf', () => {
  // O fold APLICA: o carimbo cai fora, então duas reentregas do mesmo trabalho
  // são um trabalho só na deduplicação do sweep.
  it('duas entregas do mesmo pedido com timestamps diferentes colapsam', () => {
    const a = dedupKeyOf(
      payload({ code: 3, shopId: 111, timestamp: 1000, data: { ordersn: 'ORD1', update_time: 1 } }),
    );
    const b = dedupKeyOf(
      payload({ code: 3, shopId: 111, timestamp: 9999, data: { ordersn: 'ORD1', update_time: 2 } }),
    );
    expect(a).toBe('3:111:ORD1');
    expect(b).toBe(a);
  });

  // …e PARA aqui: recursos diferentes continuam distintos.
  it('pedidos diferentes NÃO colapsam', () => {
    const a = dedupKeyOf(payload({ code: 3, shopId: 111, data: { ordersn: 'ORD1' } }));
    const b = dedupKeyOf(payload({ code: 3, shopId: 111, data: { ordersn: 'ORD2' } }));
    expect(a).not.toBe(b);
  });

  it('o mesmo recurso em lojas diferentes NÃO colapsa', () => {
    const a = dedupKeyOf(payload({ code: 3, shopId: 111, data: { ordersn: 'ORD1' } }));
    const b = dedupKeyOf(payload({ code: 3, shopId: 222, data: { ordersn: 'ORD1' } }));
    expect(a).not.toBe(b);
  });

  it('codes diferentes sobre o mesmo recurso NÃO colapsam', () => {
    const a = dedupKeyOf(payload({ code: 3, shopId: 111, data: { ordersn: 'ORD1' } }));
    const b = dedupKeyOf(payload({ code: 4, shopId: 111, data: { ordersn: 'ORD1' } }));
    expect(a).not.toBe(b);
  });

  it('o docId de dois carimbos difere onde a chave de dedup coincide', () => {
    const a = payload({ code: 3, shopId: 111, data: { ordersn: 'ORD1', update_time: 1 } });
    const b = payload({ code: 3, shopId: 111, data: { ordersn: 'ORD1', update_time: 2 } });
    expect(dedupKeyOf(a)).toBe(dedupKeyOf(b));
    expect(docIdOf(a)).not.toBe(docIdOf(b));
  });
});

// ── the dispatch table ──────────────────────────────────────────────────────

describe('destinoDoCodigo — todo push_code tem destino', () => {
  it.each([
    [1, 'conta'],
    [2, 'conta'],
    [12, 'conta'],
    // ⚠️ O code 0 não é evento nenhum: é a mensagem de verificação do callback
    // URL que o console manda ao clicar "Verify and Save". Ele era
    // `desconhecido` — ou seja, cada clique do operador estacionava uma linha.
    [0, 'ack'],
    [5, 'ack'],
    [7, 'ack'],
    [8, 'ack'],
    [9, 'ack'],
    [11, 'ack'],
    [13, 'ack'],
    [22, 'ack'],
    [28, 'ack'],
    // ⚠️ O passo 5 tirou o 3 do bloco parado: ele é o ÚNICO destino `pedido`, e
    // essa linha é o que ARMA a varredura de pedidos (`orderBackfill.ts` lê a
    // tabela, não um literal).
    [3, 'pedido'],
    [4, 'parado'],
    [10, 'parado'],
    [15, 'parado'],
    [16, 'parado'],
    [27, 'parado'],
    [29, 'parado'],
    [30, 'parado'],
    [47, 'parado'],
    // ⚠️ 24 e 25 (booking) chegaram no teste de sandbox de 2026-09-09 SEM estar
    // na tabela — foram exatamente o "único sinal de que um código novo
    // apareceu" que o parque de um code desconhecido existe para dar.
    [24, 'parado'],
    [25, 'parado'],
  ])('push_code %i ⇒ %s', (code, destino) => {
    expect(destinoDoCodigo(code)).toBe(destino);
  });

  it('um code jamais visto é "desconhecido" — o único sinal de que apareceu', () => {
    expect(destinoDoCodigo(999)).toBe('desconhecido');
    expect(destinoDoCodigo(4242)).toBe('desconhecido');
  });

  // ⚠️ O sentinela do `fromDoc`: um documento persistido que perdeu o `code`
  // (o `parseRead` é tolerante e devolve o cru) entra como CODIGO_AUSENTE.
  // Enquanto nenhum código da Shopee for negativo, ele PARA — visível, com um
  // `erro` que aponta para o documento e não para a tabela. Isso passou a
  // importar no dia em que o zero virou uma linha da tabela: com o antigo
  // `?? 0` esse documento seria "ack" ⇒ `drop` ⇒ removido do store, em silêncio.
  it('um documento persistido SEM `code` legível para, nunca vira ack', () => {
    const semCode = payloadDeDocumento({ shop_id: 111, timestamp: 1000, data: null });
    expect(semCode.code).toBe(CODIGO_AUSENTE);
    expect(destinoDoCodigo(semCode.code)).toBe('desconhecido');
    expect(motivoDoParque(semCode.code)).toContain('sem `code` legível');
    expect(motivoDoParque(semCode.code)).not.toContain('push_code');
  });

  // …e o par que tem de continuar DISTINTO: um documento que carrega o code 0
  // de verdade (a mensagem de verificação do console) continua sendo ack.
  it('um documento persistido COM code 0 continua sendo ack', () => {
    const zero = payloadDeDocumento({ code: 0, data: { verify_info: 'x' } });
    expect(zero.code).toBe(0);
    expect(destinoDoCodigo(zero.code)).toBe('ack');
  });

  // ⚠️ O `push_api_id` da URL da doc NÃO é o `code` do envelope: o
  // `shop_authorization_push` é push_api_id 15 e chega como code 1, enquanto o
  // code 15 é o status do documento de envio. Rotear pelo número errado
  // despacharia em silêncio para o handler errado.
  it('o code 15 é o documento de envio, NÃO a autorização (push_api_id 15)', () => {
    expect(destinoDoCodigo(15)).toBe('parado');
    expect(destinoDoCodigo(1)).toBe('conta');
  });

  // ⚠️ O par que substituiu `expect(motivoDoParque(3)).toContain('passo 5')`:
  // com o handler construído, `MOTIVO_PARADO[3]` foi APAGADO, então aquela
  // asserção só poderia passar sobre o texto de fallback ("código novo") — uma
  // frase falsa a respeito do code que este canal mais processa. O que precisa
  // valer agora é que o 3 não passa nem perto do parque.
  it('o code 3 tem handler — vai para o importador, não para o parque', () => {
    expect(destinoDoCodigo(3)).toBe('pedido');
    expect(motivoDoParque(3)).not.toContain('passo 5');
  });

  it('o motivo do parque nomeia o passo dono do handler', () => {
    expect(motivoDoParque(4)).toContain('passo 7');
    expect(motivoDoParque(29)).toContain('passo 17');
    expect(motivoDoParque(24)).toContain('passo 7');
    expect(motivoDoParque(25)).toContain('passo 15');
    expect(motivoDoParque(999)).toContain('desconhecido');
  });

  // ⚠️ O par de quase-falha do de cima: 24 e 25 são a família BOOKING, e o
  // motivo tem de dizer isso — o passo 7 já é dono do code 4 (rastreio do
  // PEDIDO) e o passo 15 do code 15 (documento de envio do PACOTE), então o
  // número do passo sozinho não distingue a linha parada.
  it('o motivo dos codes de booking nomeia a reserva, não o pedido nem o pacote', () => {
    expect(motivoDoParque(24)).toContain('reserva');
    expect(motivoDoParque(25)).toContain('reserva');
    expect(motivoDoParque(4)).not.toContain('reserva');
    expect(motivoDoParque(15)).not.toContain('reserva');
  });
});

describe('toDisposition', () => {
  it('ack ⇒ drop rotulado "ack"', () => {
    expect(toDisposition({ kind: 'ack', reason: 'r', detail: 'd' })).toEqual({
      kind: 'drop',
      reason: 'r',
      label: 'ack',
    });
  });

  it('aviso ⇒ resolve rotulado "aviso"', () => {
    expect(toDisposition({ kind: 'aviso', lojas: 1, avisados: 1, resolvidos: 0 })).toEqual({
      kind: 'resolve',
      label: 'aviso',
    });
  });

  it('sem-conta ⇒ defer', () => {
    expect(toDisposition({ kind: 'sem-conta', shopId: 1, reason: 'r' })).toEqual({
      kind: 'defer',
      reason: 'r',
    });
  });

  it('pedido ⇒ resolve rotulado "pedido" — o mapa `outcomes` da varredura separa import de aviso', () => {
    expect(
      toDisposition({
        kind: 'pedido',
        acao: 'criado',
        orderSn: ORDER_SN,
        pedidoId: 'ped-1',
        orderStatus: 'READY_TO_SHIP',
        itensSemProduto: 0,
        detail: 'criado',
      }),
    ).toEqual({ kind: 'resolve', label: 'pedido' });
  });

  it('pedido-adiado ⇒ defer, com a razão que nomeia a classe', () => {
    expect(
      toDisposition({ kind: 'pedido-adiado', shopId: 1, orderSn: ORDER_SN, reason: 'r' }),
    ).toEqual({ kind: 'defer', reason: 'r' });
  });

  it('parado ⇒ park, nunca defer', () => {
    expect(toDisposition({ kind: 'parado', motivo: 'm' })).toEqual({ kind: 'park', reason: 'm' });
  });
});

// ── processNotificationPayload ──────────────────────────────────────────────

describe('processNotificationPayload — a ordem das portas', () => {
  // ⚠️ O `detail` faz parte da linha porque ele é o token pelo qual se filtra o
  // log de um braço que NÃO persiste nada. O code 0 tem o seu — um clique em
  // "Verify and Save" no console não pode ler como um evento de negócio
  // reconhecido —, e todo o resto continua com o texto de hoje.
  it.each([
    [0, 'verificacao-callback'],
    [5, 'reconhecido'],
    [7, 'reconhecido'],
    [8, 'reconhecido'],
    [9, 'reconhecido'],
    [11, 'reconhecido'],
    [13, 'reconhecido'],
    [22, 'reconhecido'],
    [28, 'reconhecido'],
  ])('push_code %i é ack (detail %s) e NÃO lê nenhuma conta', async (code, detail) => {
    const out = await processNotificationPayload(db, payload({ code, shopId: 111 }), deps);
    expect(out).toMatchObject({ kind: 'ack', detail });
    expect(h.find).not.toHaveBeenCalled();
    expect(h.readConta).not.toHaveBeenCalled();
    expect(h.sweep).not.toHaveBeenCalled();
  });

  // O corpo REAL da verificação do console — sem shop_id e sem timestamp —
  // atravessa o parser e sai como ack, com a razão que o operador lê no log.
  it('o corpo real do "Verify and Save" é ack, com razão própria e sem parque', async () => {
    const out = await processNotificationPayload(
      db,
      parsed({
        code: 0,
        data: {
          verify_info: 'This is a Verification message.Please respond in the certain format.',
        },
      }),
      deps,
    );
    expect(out).toEqual({
      kind: 'ack',
      reason: 'mensagem de verificação do callback URL (console)',
      detail: 'verificacao-callback',
    });
    expect(toDisposition(out).kind).toBe('drop');
    expect(h.find).not.toHaveBeenCalled();
  });

  // ⚠️ O 3 SAIU desta lista no passo 5 — ele agora resolve a conta de propósito.
  // Todo o resto continua tendo de parar antes de qualquer leitura: um code sem
  // handler não pode custar uma consulta ao Firestore por entrega.
  it.each([4, 10, 15, 16, 24, 25, 27, 29, 30, 47, 999])(
    'push_code %i PARA antes de qualquer leitura de conta',
    async (code) => {
      const out = await processNotificationPayload(db, payload({ code, shopId: 111 }), deps);
      expect(out.kind).toBe('parado');
      // ⚠️ A prova de que a porta do parque vem ANTES da resolução da conta: um
      // code sem handler não pode custar uma consulta ao Firestore por entrega.
      expect(h.find).not.toHaveBeenCalled();
      expect(h.readConta).not.toHaveBeenCalled();
    },
  );

  it('um code desconhecido para com um motivo que diz que ele é novo', async () => {
    const out = await processNotificationPayload(db, payload({ code: 4242 }), deps);
    expect(out).toEqual({ kind: 'parado', motivo: motivoDoParque(4242) });
  });
});

// ── code 3 — o braço do pedido (passo 5) ────────────────────────────────────

describe('code 3 — importação do pedido', () => {
  function push3(data: Record<string, unknown>, over: Partial<ShopeeNotificationPayload> = {}) {
    return payload({ code: 3, shopId: SHOP_ID, timestamp: AGORA_MS, data, ...over });
  }

  it('chama importarPedido com o integracaoId da loja, o ordersn do push e UM relógio', async () => {
    h.find.mockResolvedValue(INTEGRACAO_ID);

    const out = await processNotificationPayload(
      db,
      push3({ ordersn: ORDER_SN, status: 'READY_TO_SHIP', update_time: 1_760_000_000 }),
      deps,
    );

    expect(h.find).toHaveBeenCalledWith(db, SHOP_ID);
    expect(importarPedido).toHaveBeenCalledTimes(1);
    expect(importarPedido).toHaveBeenCalledWith(db, {
      integracaoId: INTEGRACAO_ID,
      shopId: SHOP_ID,
      orderSn: ORDER_SN,
      // ⚠️ MILISSEGUNDOS, e o relógio é o do handler (`deps.nowMs()`), nunca o
      // `update_time` do push: o do envelope é síntese, o do pedido vem do
      // `get_order_detail` que o importador re-busca (marca d'água, regra 7).
      nowMs: AGORA_MS,
    });
    expect(out).toEqual({
      kind: 'pedido',
      acao: 'criado',
      orderSn: ORDER_SN,
      pedidoId: 'ped-abc',
      orderStatus: 'READY_TO_SHIP',
      itensSemProduto: 0,
      // Step 6 (#1514): o veredito da transação de pagamento viaja no outcome.
      acaoPagamentos: 'criado',
      detail: 'criado',
    });
    expect(toDisposition(out)).toEqual({ kind: 'resolve', label: 'pedido' });
  });

  it('aceita as DUAS grafias: `ordersn` (push 1) e `order_sn` (get_order_list)', async () => {
    h.find.mockResolvedValue(INTEGRACAO_ID);

    await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);
    await processNotificationPayload(db, push3({ order_sn: ORDER_SN }), deps);

    const alvos = importarPedido.mock.calls.map(([, alvo]) => alvo.orderSn);
    expect(alvos).toEqual([ORDER_SN, ORDER_SN]);
  });

  // …e o par que tem de continuar DISTINTO: `ordersn` ganha quando as duas
  // grafias chegam com valores diferentes, porque é a que `identidadeDoPush` lê
  // — o documento de dead-letter e o alvo da importação têm de falar do MESMO
  // pedido.
  it('⚠️ quase-falha: com as duas grafias presentes, `ordersn` é quem manda', async () => {
    h.find.mockResolvedValue(INTEGRACAO_ID);

    await processNotificationPayload(db, push3({ ordersn: ORDER_SN, order_sn: 'OUTRO' }), deps);

    expect(importarPedido.mock.calls[0]![1].orderSn).toBe(ORDER_SN);
  });

  it('sem shop_id PARA — não há o que um humano resolva, e não se adia o inexistente', async () => {
    const out = await processNotificationPayload(
      db,
      push3({ ordersn: ORDER_SN }, { shopId: null }),
      deps,
    );

    expect(out.kind).toBe('parado');
    expect(toDisposition(out).kind).toBe('park');
    // Nem a conta é consultada: não há loja para consultar.
    expect(h.find).not.toHaveBeenCalled();
    expect(importarPedido).not.toHaveBeenCalled();
  });

  it('sem ordersn PARA', async () => {
    const out = await processNotificationPayload(db, push3({ status: 'CANCELLED' }), deps);

    expect(out).toEqual({ kind: 'parado', motivo: expect.stringContaining('sem ordersn') });
    expect(h.find).not.toHaveBeenCalled();
    expect(importarPedido).not.toHaveBeenCalled();
  });

  it('de uma loja não mapeada ADIA (sem-conta) — ao contrário do code 2, que faz ack', async () => {
    h.find.mockResolvedValue(null);

    const pedido = await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);
    const conta2 = await processNotificationPayload(
      db,
      payload({ code: 2, shopId: SHOP_ID, data: { shop_id: SHOP_ID, authorize_type: 'expiry' } }),
      deps,
    );

    // ⚠️ A INVERSÃO, num par: para o code 2 o evento que limpa a precondição (o
    // operador conectando a loja) é o que torna a notícia FALSA — por isso ack.
    // Para o code 3 ele torna o pedido ACIONÁVEL: a order continua na Shopee e
    // `get_order_detail` continua respondendo. Sem o adiamento, os pedidos
    // feitos antes de uma conexão tardia só seriam alcançáveis pela janela de
    // 24 h da varredura inicial.
    expect(pedido).toEqual({
      kind: 'sem-conta',
      shopId: SHOP_ID,
      reason: expect.stringContaining(String(SHOP_ID)),
    });
    expect(toDisposition(pedido).kind).toBe('defer');
    expect(conta2.kind).toBe('ack');
    expect(toDisposition(conta2).kind).toBe('drop');
    expect(importarPedido).not.toHaveBeenCalled();
  });

  it('⚠️ `ignorado-inexistente` PARA com o detail do importador — os DOIS motivos ficam legíveis', async () => {
    h.find.mockResolvedValue(INTEGRACAO_ID);

    importarPedido.mockResolvedValueOnce(
      resultadoDeImportacao({
        acao: 'ignorado-inexistente',
        pedidoId: null,
        orderStatus: null,
        detail: 'ignorado-inexistente:order_not_found',
      }),
    );
    const shopee404 = await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);

    importarPedido.mockResolvedValueOnce(
      resultadoDeImportacao({
        acao: 'ignorado-inexistente',
        pedidoId: null,
        orderStatus: null,
        detail: 'ignorado-inexistente:ausente-no-order_list',
      }),
    );
    const listaNegou = await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);

    // ⚠️ Um 404 da Shopee e uma lista que negou a linha que ela mesma devolveu
    // (uma contradição do provedor, só alcançável por um push sintético da
    // varredura) são fatos DIFERENTES sobre o mesmo pedido. Os dois param, e a
    // linha parada tem de distinguir qual foi.
    const motivo404 = shopee404.kind === 'parado' ? shopee404.motivo : '';
    const motivoLista = listaNegou.kind === 'parado' ? listaNegou.motivo : '';
    expect(shopee404.kind).toBe('parado');
    expect(listaNegou.kind).toBe('parado');
    expect(motivo404).toContain('order_not_found');
    expect(motivoLista).toContain('ausente-no-order_list');
    expect(motivo404).not.toBe(motivoLista);
    // …e os dois carregam o `order_sn`, que é o que um operador procura.
    expect(motivo404).toContain(ORDER_SN);
    expect(toDisposition(shopee404).kind).toBe('park');
  });

  it.each([
    ['criado', 'ped-1'],
    ['atualizado', 'ped-1'],
    ['ignorado-obsoleto', 'ped-1'],
    ['ignorado-sem-mudanca', 'ped-1'],
  ] as const)('a ação %s resolve com label "pedido"', async (acao, pedidoId) => {
    h.find.mockResolvedValue(INTEGRACAO_ID);
    importarPedido.mockResolvedValueOnce(resultadoDeImportacao({ acao, pedidoId, detail: acao }));

    const out = await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);

    expect(out).toMatchObject({ kind: 'pedido', acao, pedidoId });
    expect(toDisposition(out)).toEqual({ kind: 'resolve', label: 'pedido' });
  });

  it('um resultado sem pedidoId numa ação que promete um PARA — contrato violado, visível', async () => {
    h.find.mockResolvedValue(INTEGRACAO_ID);
    importarPedido.mockResolvedValueOnce(
      resultadoDeImportacao({ acao: 'criado', pedidoId: null, orderStatus: null }),
    );

    const out = await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);

    expect(out).toEqual({
      kind: 'parado',
      motivo: expect.stringContaining('contrato do importador'),
    });
  });

  it('a ordem das portas continua: o braço só resolve a conta DEPOIS do portão do parque', async () => {
    // Um code parado nunca consulta a conta (a asserção original), e o code 3
    // agora consulta — é a única diferença que a virada do passo 5 introduziu.
    await processNotificationPayload(db, payload({ code: 4, shopId: SHOP_ID }), deps);
    expect(h.find).not.toHaveBeenCalled();

    h.find.mockResolvedValue(INTEGRACAO_ID);
    await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);
    expect(h.find).toHaveBeenCalledTimes(1);
  });
});

// ── a tabela erro → disposição ──────────────────────────────────────────────

/** Um envelope de erro da Shopee, com os campos que a classificação lê. */
function initApi(code: string, kind: (typeof SHOPEE_ERROR_KIND)[keyof typeof SHOPEE_ERROR_KIND]) {
  return { code, kind, httpStatus: 200, path: '/api/v2/order/get_order_detail' };
}

function grpcErro(code: number): Error {
  const err = new Error('firestore indisponível');
  (err as { code?: number }).code = code;
  return err;
}

describe('disposicaoDaFalhaDeImportacao — a tabela, classe por classe', () => {
  const burst = new ShopeeRateLimitError('limite curto', {
    ...initApi('error_rate_limit', SHOPEE_ERROR_KIND.burst),
    kind: SHOPEE_ERROR_KIND.burst,
    retryAfterSeconds: 60,
  });
  const diario = new ShopeeRateLimitError('cota diária', {
    ...initApi('error_limit', SHOPEE_ERROR_KIND.daily),
    kind: SHOPEE_ERROR_KIND.daily,
  });
  const reauth = new ShopeeReauthRequiredError(
    'autorização morta',
    initApi('shop_access_expired', SHOPEE_ERROR_KIND.reauth),
  );
  const transitorio = new ShopeeApiError(
    'servidor da Shopee',
    initApi('error_server', SHOPEE_ERROR_KIND.transient),
  );
  const outro = new ShopeeApiError('assinatura', initApi('error_sign', SHOPEE_ERROR_KIND.other));
  const naoAchou = new ShopeeApiError(
    'pedido inexistente',
    initApi('order_not_found', SHOPEE_ERROR_KIND.other),
  );
  const schema = new ShopeeSchemaError('resposta fora do schema', {
    campos: ['response.order_list[].item_list'],
    httpStatus: 200,
    path: '/api/v2/order/get_order_detail',
  });
  const rede = new ShopeeNetworkError('ECONNRESET');
  const http = new ShopeeHttpError('a borda respondeu HTML', {
    httpStatus: 403,
    path: '/api/v2/order/get_order_detail',
  });
  const config = new ShopeeConfigError('SHOPEE_PARTNER_KEY ausente');
  const semShopId = new ShopeeContaSemShopIdError('conta de main account');
  const semCredencial = new ShopeeSemCredencialError('nenhuma credencial');
  const credencialInvalida = new ShopeeCredencialInvalidaError('credencial ilegível', [
    'access_token',
  ]);
  const contaSumiu = new ShopeeContaNotConfiguredError('integração não encontrada');
  const refresh = new ShopeeRefreshEmAndamentoError('outra instância renova', 1_700_000_030_000);
  // `safeParse`, não `try/catch`: um catch aqui seria genérico (não há classe a
  // narrar), e o `.error` é o mesmo `ZodError` que uma escrita recusada levanta.
  const parse = z.object({ numero: z.string() }).safeParse({ numero: 42 });
  const zod: unknown = parse.success ? new Error('o parse deveria ter falhado') : parse.error;

  it.each([
    ['ShopeeRateLimitError burst', burst, 'throw'],
    ['ShopeeRateLimitError daily', diario, 'defer'],
    ['ShopeeReauthRequiredError', reauth, 'defer'],
    ['ShopeeApiError transient', transitorio, 'throw'],
    ['ShopeeApiError other (error_sign)', outro, 'park'],
    ['ShopeeApiError order_not_found', naoAchou, 'park'],
    ['ShopeeSchemaError', schema, 'park'],
    ['ShopeeNetworkError', rede, 'throw'],
    ['ShopeeHttpError', http, 'throw'],
    ['ShopeeConfigError', config, 'throw'],
    ['ShopeeRefreshEmAndamentoError', refresh, 'throw'],
    ['ShopeeContaSemShopIdError', semShopId, 'park'],
    ['ShopeeSemCredencialError', semCredencial, 'defer'],
    ['ShopeeCredencialInvalidaError', credencialInvalida, 'defer'],
    ['ShopeeContaNotConfiguredError', contaSumiu, 'defer'],
    ['erro gRPC (14 UNAVAILABLE)', grpcErro(14), 'throw'],
    ['ZodError na escrita', zod, 'park'],
  ])('%s ⇒ %s', (_nome, err, tipo) => {
    expect(disposicaoDaFalhaDeImportacao(err).tipo).toBe(tipo);
  });

  it('⚠️ NEAR-MISS: burst LANÇA e daily ADIA — duas subclasses de uma classe, respostas opostas', () => {
    // As duas são `ShopeeRateLimitError`, e um `instanceof` sozinho as trata
    // igual. Um `burst` adiado custaria um DIA por um problema de 60 s; uma cota
    // `daily` lançada gastaria as 3 tentativas em ~10 min e as 5 re-conduções
    // horárias dentro da MESMA cota esgotada, parqueando um pedido perfeitamente
    // importável. A cadência da fila diária (× 7) é o que envolve uma cota
    // diária.
    expect(disposicaoDaFalhaDeImportacao(burst).tipo).toBe('throw');
    expect(disposicaoDaFalhaDeImportacao(diario).tipo).toBe('defer');
  });

  it('⚠️ NEAR-MISS: reauth e rate-limit ESTENDEM ShopeeApiError e não caem no braço base', () => {
    // A ordem dos `instanceof` é o que separa as três: com o braço da base
    // primeiro, um grant morto parqueria (nenhuma re-condução) e uma cota diária
    // também.
    expect(reauth).toBeInstanceOf(ShopeeApiError);
    expect(diario).toBeInstanceOf(ShopeeApiError);
    expect(disposicaoDaFalhaDeImportacao(reauth).tipo).not.toBe(
      disposicaoDaFalhaDeImportacao(outro).tipo,
    );
    expect(disposicaoDaFalhaDeImportacao(diario).tipo).not.toBe(
      disposicaoDaFalhaDeImportacao(outro).tipo,
    );
  });

  it('um erro que a tabela não conhece é RELANÇADO — regra 6, um bug de código falha alto', () => {
    expect(disposicaoDaFalhaDeImportacao(new Error('bug qualquer')).tipo).toBe('throw');
    expect(disposicaoDaFalhaDeImportacao(new TypeError('undefined não é função')).tipo).toBe(
      'throw',
    );
    expect(disposicaoDaFalhaDeImportacao('uma string').tipo).toBe('throw');
    expect(disposicaoDaFalhaDeImportacao(null).tipo).toBe('throw');
    // …e um `Error` com um `code` numérico FORA da faixa gRPC não é contido.
    expect(disposicaoDaFalhaDeImportacao(grpcErro(999)).tipo).toBe('throw');
  });

  it('o motivo do parque carrega o CODE da Shopee e o path, nunca o corpo', () => {
    const d = disposicaoDaFalhaDeImportacao(outro);
    expect(d.tipo).toBe('park');
    const motivo = d.tipo === 'park' ? d.reason : '';
    expect(motivo).toContain('push_code 3:');
    expect(motivo).toContain('error_sign');
    expect(motivo).toContain('/api/v2/order/get_order_detail');
    expect(motivo).not.toContain('assinatura'); // a `message` da Shopee fica fora
  });

  it('ShopeeSchemaError parqueia com os CAMINHOS dos campos, sem valores (#1015)', () => {
    const d = disposicaoDaFalhaDeImportacao(schema);
    const motivo = d.tipo === 'park' ? d.reason : '';
    expect(motivo).toContain('response.order_list[].item_list');
    expect(motivo).not.toContain('resposta fora do schema');
  });

  it('o ZodError da escrita parqueia com o CAMINHO do campo, não com o valor', () => {
    const d = disposicaoDaFalhaDeImportacao(zod);
    const motivo = d.tipo === 'park' ? d.reason : '';
    expect(motivo).toContain('numero');
    expect(motivo).not.toContain('42');
  });

  it('toda razão de parque/adiamento começa com o mesmo prefixo filtrável', () => {
    for (const err of [outro, schema, semShopId, diario, reauth, semCredencial, contaSumiu, zod]) {
      const d = disposicaoDaFalhaDeImportacao(err);
      const motivo = d.tipo === 'throw' ? '' : d.reason;
      expect(motivo, String(err)).toMatch(/^push_code 3:/);
    }
  });
});

describe('code 3 — a falha da importação vira disposição no braço', () => {
  function push3(data: Record<string, unknown>) {
    return payload({ code: 3, shopId: SHOP_ID, timestamp: AGORA_MS, data });
  }

  beforeEach(() => {
    h.find.mockResolvedValue(INTEGRACAO_ID);
  });

  it('uma falha transitória SOBE (a fila re-tenta), e sobe o erro ORIGINAL', async () => {
    const err = new ShopeeNetworkError('ECONNRESET');
    importarPedido.mockRejectedValueOnce(err);

    await expect(processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps)).rejects.toBe(
      err,
    );
  });

  it('uma falha permanente vira `parado`, com o code da Shopee no motivo', async () => {
    importarPedido.mockRejectedValueOnce(
      new ShopeeApiError('parâmetro', initApi('error_param', SHOPEE_ERROR_KIND.other)),
    );

    const out = await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);

    expect(out).toEqual({ kind: 'parado', motivo: expect.stringContaining('error_param') });
    expect(toDisposition(out).kind).toBe('park');
  });

  it('uma precondição humana ADIA com kind PRÓPRIO — nunca "sem-conta", que é outro fato', async () => {
    importarPedido.mockRejectedValueOnce(
      new ShopeeReauthRequiredError(
        'grant morto',
        initApi('shop_access_expired', SHOPEE_ERROR_KIND.reauth),
      ),
    );

    const out = await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);

    // ⚠️ `kind` é o que o log da task imprime. Reportar um grant morto como
    // "esta loja não mapeia integração" seria a forma do #1087: um rótulo só
    // cobrindo dois fatos.
    expect(out).toEqual({
      kind: 'pedido-adiado',
      shopId: SHOP_ID,
      orderSn: ORDER_SN,
      reason: expect.stringContaining('ShopeeReauthRequiredError'),
    });
    expect(toDisposition(out).kind).toBe('defer');
  });

  it('⚠️ o adiamento por reauth NÃO levanta aviso — o produtor é avisos/autorizacao.ts', async () => {
    importarPedido.mockRejectedValueOnce(
      new ShopeeReauthRequiredError(
        'grant morto',
        initApi('shop_access_expired', SHOPEE_ERROR_KIND.reauth),
      ),
    );

    await processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps);

    // Um segundo produtor de `shopeeDesautorizado` forkaria a linha do inbox: a
    // chave é (conta, loja) e a de cá teria outro `criadoEm`. O operador já é
    // avisado pelo braço do code 2 e pela varredura semanal.
    expect(h.avisarDesautorizacao).not.toHaveBeenCalled();
    expect(h.resolverAvisos).not.toHaveBeenCalled();
  });

  it('um erro fora da tabela SOBE — o braço não engole bug de código (regra 6)', async () => {
    const bug = new TypeError('cannot read properties of undefined');
    importarPedido.mockRejectedValueOnce(bug);

    await expect(processNotificationPayload(db, push3({ ordersn: ORDER_SN }), deps)).rejects.toBe(
      bug,
    );
  });
});

describe('code 1 — reautorização RESOLVE os avisos da loja', () => {
  it('chama resolverAvisosDeAutorizacao uma vez por loja mapeada', async () => {
    h.find.mockImplementation(async (_db, shopId) => (shopId === 111 ? 'int-1' : 'int-2'));
    const out = await processNotificationPayload(
      db,
      payload({ code: 1, shopId: 111, data: { shop_id_list: [111, 222] } }),
      deps,
    );
    expect(out).toEqual({ kind: 'aviso', lojas: 2, avisados: 0, resolvidos: 2 });
    expect(h.resolverAvisos).toHaveBeenCalledTimes(2);
    expect(h.resolverAvisos).toHaveBeenCalledWith(
      db,
      { integracaoId: 'int-1', shopId: 111 },
      { nowMs: 1_700_000_000_000 },
    );
    // Uma reautorização nunca LEVANTA um aviso.
    expect(h.avisarDesautorizacao).not.toHaveBeenCalled();
  });
});

describe('code 2 — desautorização LEVANTA um aviso por loja mapeada', () => {
  it('passa o nome da loja, o authorize_type como motivo e o relógio do evento', async () => {
    h.find.mockResolvedValue('int-1');
    h.readConta.mockResolvedValue({ nome: 'Loja Delfrance' });
    const out = await processNotificationPayload(
      db,
      payload({
        code: 2,
        shopId: 987654,
        timestamp: 1_660_616_278_000,
        data: { shopid: 987654, authorize_type: 'expiry' },
      }),
      deps,
    );
    expect(out).toEqual({ kind: 'aviso', lojas: 1, avisados: 1, resolvidos: 0 });
    expect(h.avisarDesautorizacao).toHaveBeenCalledWith(
      db,
      {
        integracaoId: 'int-1',
        shopId: 987654,
        lojaNome: 'Loja Delfrance',
        motivo: 'expiry',
        relogioEventoMs: 1_660_616_278_000,
      },
      { increment: deps.increment, nowMs: 1_700_000_000_000 },
    );
    expect(h.resolverAvisos).not.toHaveBeenCalled();
  });

  // ⚠️ Ausente significa "não sei"; um `null` explícito RESETARIA a marca
  // d'água guardada, e uma marca d'água resetada é pior que uma que nunca
  // avança (`camposInformados`, regra 7 do CLAUDE.md).
  it('OMITE relogioEventoMs quando o envelope não trouxe timestamp', async () => {
    h.find.mockResolvedValue('int-1');
    await processNotificationPayload(
      db,
      payload({ code: 2, shopId: 987654, timestamp: null, data: { shop_id: 987654 } }),
      deps,
    );
    const [, evento] = h.avisarDesautorizacao.mock.calls[0]! as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect('relogioEventoMs' in evento).toBe(false);
    expect(evento.relogioEventoMs).toBeUndefined();
  });

  it('cai para null no nome quando a conta não tem `nome`', async () => {
    h.find.mockResolvedValue('int-1');
    h.readConta.mockResolvedValue({ nome: '' });
    await processNotificationPayload(
      db,
      payload({ code: 2, shopId: 987654, data: { shop_id: 987654 } }),
      deps,
    );
    const [, evento] = h.avisarDesautorizacao.mock.calls[0]! as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(evento.lojaNome).toBeNull();
  });

  it('motivo cai para um texto que diz que a Shopee não informou', async () => {
    h.find.mockResolvedValue('int-1');
    await processNotificationPayload(
      db,
      payload({ code: 2, shopId: 987654, data: { shop_id: 987654 } }),
      deps,
    );
    const [, evento] = h.avisarDesautorizacao.mock.calls[0]! as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(evento.motivo).toBe(MOTIVO_SEM_AUTHORIZE_TYPE);
  });
});

describe('defer — só para uma loja de um push code 1 que não mapeia nada', () => {
  it('code 1 nomeando UMA loja não mapeada ⇒ sem-conta ⇒ defer', async () => {
    h.find.mockResolvedValue(null);
    const out = await processNotificationPayload(
      db,
      payload({ code: 1, shopId: 111, data: { shop_id: 111 } }),
      deps,
    );
    expect(out).toMatchObject({ kind: 'sem-conta', shopId: 111 });
    expect(toDisposition(out).kind).toBe('defer');
  });

  // NEAR-MISS do teste acima — MESMA forma de payload, código diferente. No
  // code 2 o defer é INVERTIDO: o operador conectar a loja é justamente o que
  // torna a notícia falsa, e a reentrega diária levantaria `shopeeDesautorizado`
  // para uma loja autorizada, sem watermark que possa rejeitá-la.
  it('code 2 nomeando UMA loja não mapeada é ACK, nunca defer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.find.mockResolvedValue(null);
    const out = await processNotificationPayload(
      db,
      payload({ code: 2, shopId: 987654, data: { shop_id: 987654 } }),
      deps,
    );
    expect(out).toMatchObject({ kind: 'ack', detail: 'nenhuma-loja-mapeada' });
    expect(toDisposition(out).kind).toBe('drop');
    expect(h.avisarDesautorizacao).not.toHaveBeenCalled();
  });

  // NEAR-MISS: um push de conta SEM loja nenhuma (autorização de merchant) é
  // ack, não defer — nenhuma reentrega diária pode melhorar esse estado.
  it('um push de conta sem shop_id é ACK, não defer', async () => {
    const out = await processNotificationPayload(
      db,
      payload({ code: 2, shopId: null, data: { merchant_id: 600222872 } }),
      deps,
    );
    expect(out).toMatchObject({ kind: 'ack', detail: 'nenhuma-loja-mapeada' });
    expect(toDisposition(out).kind).toBe('drop');
  });

  it('várias lojas e nenhuma mapeada é ACK (sem-conta só nomeia uma)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.find.mockResolvedValue(null);
    const out = await processNotificationPayload(
      db,
      payload({ code: 2, shopId: null, data: { shop_id_list: [111, 222] } }),
      deps,
    );
    expect(out.kind).toBe('ack');
  });

  it('lojas parcialmente mapeadas processam as mapeadas', async () => {
    h.find.mockImplementation(async (_db, shopId) => (shopId === 111 ? 'int-1' : null));
    const out = await processNotificationPayload(
      db,
      payload({ code: 2, shopId: null, data: { shop_id_list: [111, 222] } }),
      deps,
    );
    expect(out).toEqual({ kind: 'aviso', lojas: 1, avisados: 1, resolvidos: 0 });
  });

  // ⚠️ O code 12 é de nível PARTNER: lojas dele que não mapeiam nada pertencem
  // a outro parceiro, e um defer diário sobre isso queimaria a faixa lenta.
  it('code 12 sem loja mapeada é ACK, NUNCA defer', async () => {
    h.find.mockResolvedValue(null);
    const out = await processNotificationPayload(
      db,
      payload({ code: 12, shopId: null, data: { shop_expire_soon: [111, 222] } }),
      deps,
    );
    expect(out).toMatchObject({ kind: 'ack', detail: 'nenhuma-loja-mapeada' });
    expect(h.sweep).not.toHaveBeenCalled();
  });
});

describe('code 12 — a expiração re-enumera pelo mesmo produtor do sweep', () => {
  it('roda o sweep escopado às lojas mapeadas', async () => {
    h.find.mockImplementation(async (_db, shopId) => (shopId === 111 ? 'int-1' : null));
    h.sweep.mockResolvedValue({
      lojasEnumeradas: 1,
      paginasLidas: 1,
      truncado: false,
      semIntegracao: 0,
      avisados: 1,
      resolvidos: 0,
      resultados: {},
      erros: [],
    });
    const out = await processNotificationPayload(
      db,
      payload({
        code: 12,
        shopId: null,
        data: { shop_expire_soon: [111, 111, 222], expire_before: 1619740800, page_no: 1 },
      }),
      deps,
    );
    expect(out).toEqual({ kind: 'aviso', lojas: 1, avisados: 1, resolvidos: 0 });
    const [, opts] = h.sweep.mock.calls[0]! as unknown as [unknown, { apenasShopIds: Set<number> }];
    expect([...opts.apenasShopIds]).toEqual([111]);
  });

  // ⚠️ `expire_before` é um CORTE DO LOTE, não a expiração de cada loja — por
  // isso o aviso nunca é montado a partir dele; o sweep lê o `expire_time` real.
  it('não repassa expire_before como prazo de loja nenhuma', async () => {
    h.find.mockResolvedValue('int-1');
    await processNotificationPayload(
      db,
      payload({ code: 12, data: { shop_expire_soon: [111], expire_before: 1619740800 } }),
      deps,
    );
    const [, opts] = h.sweep.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(JSON.stringify(opts)).not.toContain('1619740800');
  });

  // ⚠️ O relógio do ENVELOPE (ms) atravessa até o produtor do aviso: sem ele a
  // marca d'água nunca avança pelo braço do push e uma reentrega velha do
  // mesmo lote seria aplicada de novo — nova ocorrência, novo alerta, sobre um
  // problema já tratado.
  it('repassa o relógio do envelope em milissegundos para o sweep', async () => {
    h.find.mockResolvedValue('int-1');
    await processNotificationPayload(
      db,
      // 1568606634 s → 1568606634000 ms, feito por `parseNotificationBody`; aqui
      // o payload já vem normalizado, então o valor é o de milissegundos.
      payload({ code: 12, timestamp: 1_568_606_634_000, data: { shop_expire_soon: [111] } }),
      deps,
    );
    const [, opts] = h.sweep.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(opts.relogioEventoMs).toBe(1_568_606_634_000);
  });

  // A quase-falha do teste acima: o par que prova onde o repasse PARA. Um
  // envelope sem `timestamp` não pode virar `relogioEventoMs: null` — isso
  // RESETA a marca d'água armazenada, e uma marca resetada é uma guarda que não
  // rejeita mais nada (`camposInformados`, regra 7 do CLAUDE.md da raiz).
  it('um envelope sem timestamp não repassa a chave — nem sequer como null', async () => {
    h.find.mockResolvedValue('int-1');
    await processNotificationPayload(
      db,
      payload({ code: 12, timestamp: null, data: { shop_expire_soon: [111] } }),
      deps,
    );
    const [, opts] = h.sweep.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect('relogioEventoMs' in opts).toBe(false);
  });

  it('deduplica a lista (os próprios exemplos da Shopee repetem ids)', () => {
    expect(
      lojasExpirandoDoPush12(payload({ code: 12, data: { shop_expire_soon: [123, 123, 4342] } })),
    ).toEqual([123, 4342]);
  });
});

describe('lojasDoPushDeConta', () => {
  it('junta as quatro fontes sem repetir e preservando a ordem', () => {
    expect(
      lojasDoPushDeConta(
        payload({
          code: 2,
          shopId: 111,
          data: { shop_id: 111, shopid: 222, shop_id_list: [222, 333] },
        }),
      ),
    ).toEqual([111, 222, 333]);
  });

  it('devolve lista vazia para uma autorização de merchant', () => {
    expect(lojasDoPushDeConta(payload({ code: 1, data: { merchant_id: 600222872 } }))).toEqual([]);
  });

  // ⚠️ As DUAS formas de code 1 que chegaram no teste de sandbox de 2026-09-09,
  // do mesmo console e no mesmo dia — e elas discordam no TIPO dos campos. A
  // primeira traz `shop_id` NUMÉRICO mais um `shop_id_list` com outras lojas;
  // a segunda traz `shop_id` e `success` em STRING e nenhuma lista. Roteiam
  // pelo mesmo coercer, e o resultado é 5 lojas contra exatamente 1.
  // ℹ️ `authorization_expire_time` (segundos) vem junto e NÃO é consumido em
  // lugar nenhum: quem decide prazo é a varredura, que lê o `expire_time` real
  // de cada loja em `get_shops_by_partner`.
  it('forma A (shop_id numérico + shop_id_list): todas as lojas, na ordem de primeira aparição', () => {
    expect(
      lojasDoPushDeConta(
        parsed({
          code: 1,
          timestamp: 1_660_616_278,
          data: {
            authorization_expire_time: 1_691_366_400,
            authorize_type: 'p-shop',
            extra: '',
            shop_id: 987654,
            shop_id_list: [111, 222, 333, 444],
            success: 1,
          },
        }),
      ),
    ).toEqual([987654, 111, 222, 333, 444]);
  });

  it('forma B (shop_id e success em STRING, sem lista): exatamente aquela loja', () => {
    expect(
      lojasDoPushDeConta(
        parsed({
          code: 1,
          timestamp: 1_660_616_278,
          data: {
            authorize_type: 'shop authorization by user',
            extra: '',
            shop_id: '111',
            success: '1',
          },
        }),
      ),
    ).toEqual([111]);
  });
});

// ── the pipeline wiring ─────────────────────────────────────────────────────

describe('a fiação do pipeline', () => {
  it('o nome da fila é o nome da função exportada em functions/src', () => {
    expect(SHOPEE_NOTIFICATION_QUEUE).toBe('processShopeeNotification');
  });

  it('o default de importarPedido existe e é PREGUIÇOSO — nada de `import` estático do pedido', () => {
    // O default tem de existir: sem ele o braço do code 3 não teria importador
    // em produção e a fiação inteira seria letra morta.
    expect(typeof defaultProcessDeps.importarPedido).toBe('function');

    // ⚠️ E tem de continuar preguiçoso. Este módulo é importado pela ROTA do
    // receiver, então um `import { importarPedidoShopee } from '../pedidos/…'`
    // no topo arrastaria a árvore inteira de pedidos (mappers, cascata de
    // produto, captura do comprador e todo schema que eles alcançam) para o
    // bundle Next de um endpoint que só enfileira. O `import type` é apagado na
    // compilação e não conta; o que não pode aparecer é um import de VALOR.
    const fonte = readFileSync(fileURLToPath(new URL('./notificacao.ts', import.meta.url)), 'utf8');
    expect(fonte).toContain("await import('../pedidos/importarPedido')");
    // Um import estático de valor tem esta forma (`import {` … `} from`), e o
    // de tipo carrega o `type` logo depois do `import` — a distinção é o teste.
    expect(fonte).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+'\.\.\/pedidos\//m);
  });

  // ⚠️ `notificationGuardrails.test.ts` (guarda B) IGNORA a forma abreviada
  // `collection,` de propósito — ela é a assinatura dos fakes sintéticos. Uma
  // abreviação aqui leria como "este canal escreveu o próprio store" e
  // avermelharia a suíte do @delfrance/data, sem nada apontar para este arquivo.
  it('passa `collection: notificacaoShopeeCollection` na forma EXPLÍCITA', () => {
    const fonte = readFileSync(fileURLToPath(new URL('./notificacao.ts', import.meta.url)), 'utf8');
    expect(fonte).toContain('collection: notificacaoShopeeCollection');
    expect(fonte).not.toMatch(/\bcollection,\s*$/m);
  });

  it('identidadeDoPush separa o que sobrevive a uma reentrega do que não', () => {
    const id = identidadeDoPush(
      payload({ code: 3, shopId: 111, timestamp: 5000, data: { ordersn: 'ORD1' } }),
    );
    expect(id.entidade).toBe('111:ORD1');
    expect(id.entidade).not.toContain('5000');
  });
});

// ── mensagemDoErro ──────────────────────────────────────────────────────────

describe('mensagemDoErro — a leitura ESTRUTURAL da mensagem de uma falha', () => {
  // ⚠️ Ela mora aqui, e não no receiver, porque a varredura de mensagens
  // perdidas precisa da MESMA leitura: as duas escrevem o mesmo `erro` na mesma
  // coleção, e uma regra duplicada é uma regra que deriva.
  it('lê a message de um Error', () => {
    expect(mensagemDoErro(new Error('sem fila'))).toBe('sem fila');
  });

  it('lê a message de um objeto que NÃO é Error — a leitura é estrutural', () => {
    // O ponto de não usar `err instanceof Error`: ele não estreita nada (é o pai
    // de toda exceção) e ainda perderia isto.
    expect(mensagemDoErro({ message: 'rejeição do transporte' })).toBe('rejeição do transporte');
  });

  it('cai para String(err) quando não há message legível', () => {
    expect(mensagemDoErro('boom')).toBe('boom');
    expect(mensagemDoErro({ message: 42 })).toBe('[object Object]');
    expect(mensagemDoErro(null)).toBe('null');
  });

  it('uma message VAZIA cai para String(err) — nunca uma string vazia no documento', () => {
    expect(mensagemDoErro({ message: '' })).toBe('[object Object]');
  });
});

// ── a identidade de uma entrada ilegível da fila de mensagens perdidas ───────

describe('identidadeDoPush — CODIGO_AUSENTE chaveia na POSIÇÃO do provedor', () => {
  const perdida = (ref: string, shopId: number | null = null): ShopeeNotificationPayload => ({
    code: CODIGO_AUSENTE,
    shopId,
    timestamp: 1_760_000_000_000,
    data: { _lostPush: { ref, code: 3, shopId, timestamp: 1_760_000_000, bruto: 'x' } },
  });

  it('⚠️ duas entradas ilegíveis de nível de PARCEIRO no mesmo segundo geram ids DISTINTOS', () => {
    // Sem esta linha as duas chaveiam `-1:-:-:<carimbo>`; `store.create`
    // estreita ALREADY_EXISTS e retorna em SILÊNCIO, então a varredura
    // confirmaria passando por uma entrada cujo payload nunca foi gravado — a
    // forma do #1488 chegando pela escotilha que existe para evitá-la.
    const a = docIdOf(perdida('176610_0'));
    const b = docIdOf(perdida('176610_1'));

    expect(a).toBe('-1:-:176610_0:1760000000000');
    expect(b).toBe('-1:-:176610_1:1760000000000');
    expect(a).not.toBe(b);
  });

  it('a loja entra no segmento quando a lista trouxe uma', () => {
    expect(docIdOf(perdida('176610_0', 987654))).toBe('-1:987654:176610_0:1760000000000');
  });

  it('a mesma entrada relida numa página NÃO confirmada gera o MESMO id', () => {
    // `last_message_id` + índice são estáveis enquanto a página não é
    // confirmada, então uma releitura colapsa numa linha só em vez de duplicar.
    expect(docIdOf(perdida('176610_0'))).toBe(docIdOf(perdida('176610_0')));
  });

  it('⚠️ um documento persistido sem `code` legível NÃO carrega _lostPush e mantém a identidade padrão', () => {
    // `payloadDeDocumento` cai para CODIGO_AUSENTE por outra razão inteiramente
    // — o documento armazenado é que é ilegível — e essa linha não muda nada
    // para aquele produtor.
    const doDocumento = payloadDeDocumento({ shop_id: 987654, timestamp: 1_760_000_000_000 });

    expect(doDocumento.code).toBe(CODIGO_AUSENTE);
    expect(identidadeDoPush(doDocumento).entidade).toBe('987654:-');
  });
});

// ── persistNotificationParked ───────────────────────────────────────────────

describe('persistNotificationParked', () => {
  it('grava a linha como PARKED — terminal, e nada a re-dirige', async () => {
    // O receiver não pode alcançar isto: um push de entrada que ele não consegue
    // ler é ACKADO (uma retentativa também não vai parsear), e parar um deixaria
    // uma linha por entrega. A varredura de mensagens perdidas é o caso oposto —
    // a entrada só sai da fila do provedor por um ACK NOSSO.
    const fake = new FakeDb();
    await persistNotificationParked(
      asDb(fake),
      { code: CODIGO_AUSENTE, shopId: null, timestamp: 1_760_000_000_000, data: null },
      'entrada ilegível',
    );

    expect(fake.store['notificacoesShopee/-1:-:-:1760000000000']?.data).toMatchObject({
      status: 'parked',
      tentativas: 0,
      erro: 'entrada ilegível',
    });
  });
});

// ── handleNotificationTask — o TaskResult do code 3 (#1514, step 6) ─────────

describe('handleNotificationTask — `acaoPagamentos` no TaskResult', () => {
  it('⚠️ o veredito da transação de pagamento chega ao log da tarefa', async () => {
    h.find.mockResolvedValue(INTEGRACAO_ID);
    importarPedido.mockResolvedValue(
      resultadoDeImportacao({ acao: 'ignorado-sem-mudanca', acaoPagamentos: 'atualizado' }),
    );
    const fake = new FakeDb();

    const r = await handleNotificationTask(
      asDb(fake),
      { code: 3, shopId: SHOP_ID, timestamp: AGORA_MS, data: { ordersn: ORDER_SN } },
      0,
      deps,
    );

    expect(r.outcome).toBe('done');
    expect(r.kind).toBe('pedido');
    // O token do PAGAMENTO viaja junto com o do pedido: `criado` numa entrega que
    // não mexeu no pedido é exatamente o sinal de que o escrow andou sozinho.
    expect(r.acaoPagamentos).toBe('atualizado');
    expect(r.orderSn).toBe(ORDER_SN);
  });

  it('⚠️ quando a transação de pagamento NÃO roda, a chave fica AUSENTE — não `null`', async () => {
    h.find.mockResolvedValue(INTEGRACAO_ID);
    importarPedido.mockResolvedValue(
      resultadoDeImportacao({ acao: 'ignorado-obsoleto', acaoPagamentos: null }),
    );
    const fake = new FakeDb();

    const r = await handleNotificationTask(
      asDb(fake),
      { code: 3, shopId: SHOP_ID, timestamp: AGORA_MS, data: { ordersn: ORDER_SN } },
      0,
      deps,
    );

    // "não rodou" e "rodou e não mudou nada" são fatos diferentes, e uma chave
    // ausente é como este repo escreve o primeiro (regra 7, `camposInformados`).
    expect(Object.prototype.hasOwnProperty.call(r, 'acaoPagamentos')).toBe(false);
    // …e a âncora: o resto do TaskResult chegou, então o negativo não é vácuo.
    expect(r.kind).toBe('pedido');
  });
});
