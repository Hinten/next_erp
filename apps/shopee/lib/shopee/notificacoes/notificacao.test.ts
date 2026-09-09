import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only — erased at compile time, so it does not defeat the mocks below.
import type { ShopeeNotificationPayload } from './notificacao';

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
  destinoDoCodigo,
  docIdOf,
  identidadeDoPush,
  lojasDoPushDeConta,
  lojasExpirandoDoPush12,
  motivoDoParque,
  MOTIVO_SEM_AUTHORIZE_TYPE,
  parseNotificationBody,
  payloadDeDocumento,
  processNotificationPayload,
  sanitizarData,
  SHOPEE_NOTIFICATION_QUEUE,
  toDisposition,
} = await import('./notificacao');

const db = {} as unknown as Firestore;

const deps = {
  partnerClient: () => ({ getShopsByPartner: async () => ({}) }) as never,
  increment: (by: number) => by,
  nowMs: () => 1_700_000_000_000,
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
    [3, 'parado'],
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

  it('o motivo do parque nomeia o passo dono do handler', () => {
    expect(motivoDoParque(3)).toContain('passo 5');
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

  it('sem-conta ⇒ defer (a ÚNICA saída defer do canal)', () => {
    expect(toDisposition({ kind: 'sem-conta', shopId: 1, reason: 'r' })).toEqual({
      kind: 'defer',
      reason: 'r',
    });
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

  it.each([3, 4, 10, 15, 16, 24, 25, 27, 29, 30, 47, 999])(
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
