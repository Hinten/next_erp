import { describe, expect, it } from 'vitest';

import { alvoDoPushDeFrete } from '../pedidos/fretePushShopee';
import {
  dedupKeyOf,
  destinoDoCodigo,
  docIdOf,
  parseNotificationBody,
  sanitizarData,
  shopeeNotificationTaskSchema,
} from './notificacao';
import { notificacaoSinteticaDePacote, notificacaoSinteticaDePedido } from './notificacaoSintetica';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real shop id, partner id or key.      */
/* -------------------------------------------------------------------------- */

const SHOP = 987654;
const AGORA_MS = 1_760_000_000_000;
const ORDER_SN = '2601010ABCDEF';
/** The code-30 fixtures: the shared step-15b order and its two packages. */
const ORDER_SN_DO_PACOTE = '260910KJBHUJDM';
const PACOTE = 'OFG000000000001';
const PACOTE_2 = 'OFG000000000002';

describe('notificacaoSinteticaDePedido', () => {
  it('monta um code 3 com timestamp em MILISSEGUNDOS — a síntese, não o relógio do evento', () => {
    const p = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(p.code).toBe(3);
    expect(p.shopId).toBe(SHOP);
    expect(p.timestamp).toBe(AGORA_MS);
    // A magnitude check, not just an equality: a SECONDS stamp here would be
    // ~1.76e9 and would still pass an `expect.any(Number)`.
    expect(p.timestamp).toBeGreaterThan(1_000_000_000_000);
    // ⚠️ Asserted against the LITERAL destination, not against
    // `destinoDoCodigo(3)`. Comparing the table to itself was a tautology: it
    // held for any code the builder emitted, because both sides moved together.
    // Naming `'pedido'` is what makes this prove the synthesized payload really
    // carries code 3 AND that the code-3 row still routes to the importer — the
    // row that arms this very sweep.
    expect(destinoDoCodigo(p.code)).toBe('pedido');
  });

  it('a chave é `ordersn` (sem underscore) — é o que identidadeDoPush lê', () => {
    const p = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(p.data).toHaveProperty('ordersn', ORDER_SN);
    // The wire spelling must NOT leak through: `identidadeDoPush` would then
    // fall to `-` and every order of one tick would share ONE dead-letter row.
    expect(p.data).not.toHaveProperty('order_sn');
  });

  it('order_status vira data.status quando a Shopee o devolve, e é OMITIDO quando não', () => {
    const com = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
      orderStatus: 'READY_TO_SHIP',
    });
    const sem = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(com.data).toHaveProperty('status', 'READY_TO_SHIP');
    // ⚠️ ABSENT, never `null`: an absent optional and a null are different
    // things, and a null would claim we read a status and got none.
    expect(Object.keys(sem.data ?? {})).not.toContain('status');
  });

  it('não carrega update_time, items nem completed_scenario', () => {
    const p = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
      orderStatus: 'SHIPPED',
    });

    const chaves = Object.keys(p.data ?? {});
    expect(chaves).not.toContain('update_time');
    expect(chaves).not.toContain('items');
    expect(chaves).not.toContain('completed_scenario');
    // The whole payload is exactly these three keys — a new one would be a new
    // claim about an order we only saw the `order_sn` of.
    expect(chaves.sort()).toEqual(['ordersn', 'origem', 'status']);
  });

  it('origem viaja em data e NÃO entra na identidade: no MESMO carimbo, backfill e reserva-travada colapsam', () => {
    const backfill = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });
    const reserva = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'reserva-travada',
    });

    expect(backfill.data).toHaveProperty('origem', 'backfill');
    expect(reserva.data).toHaveProperty('origem', 'reserva-travada');
    // ⚠️ As duas chamadas recebem o MESMO `nowMs` de propósito: é a condição
    // que isola a variável sob teste (`origem`). Dois AGENDAMENTOS nunca leem o
    // mesmo relógio — o teste "dois TICKS" abaixo é o que descreve a produção.
    expect(docIdOf(backfill)).toBe(docIdOf(reserva));
    expect(dedupKeyOf(backfill)).toBe(dedupKeyOf(reserva));
  });

  it('origem `liquidacao` (passo 6) produz o MESMO code 3 e a MESMA identidade que o backfill', () => {
    // The settlement sweep is the third producer, and it is the only one that
    // synthesizes from the MONEY side: `get_escrow_list` named an order whose
    // pedido/pagamento is not here yet. Its payload must be indistinguishable
    // from the backfill's for everything that decides identity — otherwise a
    // week in which both sweeps find the same order would enqueue two jobs and
    // write two dead-letter rows for one order.
    const liquidacao = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'liquidacao',
    });
    const backfill = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(liquidacao.code).toBe(3);
    expect(destinoDoCodigo(liquidacao.code)).toBe('pedido');
    expect(liquidacao.data).toHaveProperty('origem', 'liquidacao');
    expect(docIdOf(liquidacao)).toBe(docIdOf(backfill));
    expect(dedupKeyOf(liquidacao)).toBe(dedupKeyOf(backfill));
    // ⚠️ NEAR-MISS: the settlement listing carries no `order_status` at all, so
    // the key must be ABSENT rather than present-and-null — a null would claim
    // the sweep read a status and got none, and `identidadeDoPush` would then
    // be reading a field nothing wrote.
    expect(Object.keys(liquidacao.data ?? {}).sort()).toEqual(['ordersn', 'origem']);
  });

  it('origem `rastreio` (passo 7) é aceita e NÃO faz parte da identidade', () => {
    // ⚠️ The fourth producer, and the one that is NOT a sweep: a code 4/30/47
    // delivery whose pedido is not here yet (no page states an ordering between
    // push codes, and `push_guarantee = 0`). It must be indistinguishable from
    // the other three for everything that decides identity — otherwise a
    // shipment push and the 15-minute backfill finding the same order in the
    // same tick would enqueue two jobs and write two dead-letter rows.
    const rastreio = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'rastreio',
    });
    const backfill = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(rastreio.code).toBe(3);
    expect(destinoDoCodigo(rastreio.code)).toBe('pedido');
    expect(rastreio.data).toHaveProperty('origem', 'rastreio');
    expect(docIdOf(rastreio)).toBe(docIdOf(backfill));
    expect(dedupKeyOf(rastreio)).toBe(dedupKeyOf(backfill));
    // ⚠️ NEAR-MISS, and it is the same one: a shipment push carries no
    // `order_status`, so the key is ABSENT rather than present-and-null.
    expect(Object.keys(rastreio.data ?? {}).sort()).toEqual(['ordersn', 'origem']);
    // …and the anchor that keeps the identity claim from being vacuous: the two
    // payloads really do DIFFER, in exactly one place.
    expect(rastreio.data?.origem).not.toBe(backfill.data?.origem);
  });

  it('origem `arranjo-automatico` (passo 15b) monta um code 3 que o schema da tarefa devolve IGUAL, com a identidade do backfill', () => {
    // ⚠️ The fifth producer, and the one origem that sits in BOTH unions: the
    // package sweep enqueues THIS code 3 — one per order_sn, never a code 30 —
    // for a candidate package whose pedido does not exist here yet.
    const arranjo = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      nowMs: AGORA_MS,
      origem: 'arranjo-automatico',
    });
    const backfill = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(arranjo.code).toBe(3);
    expect(destinoDoCodigo(arranjo.code)).toBe('pedido');
    // EXACTLY two keys: neither package read carries an `order_status`, so the
    // key is ABSENT (never null), and no `update_time` is ever synthesized.
    expect(arranjo.data).toEqual({ ordersn: ORDER_SN_DO_PACOTE, origem: 'arranjo-automatico' });
    // It parses where it is read: the task handler re-validates every payload
    // after the JSON hop, and the failure path stores `data` through
    // `sanitizarData`.
    expect(shopeeNotificationTaskSchema.parse(JSON.parse(JSON.stringify(arranjo)))).toEqual(
      arranjo,
    );
    expect(sanitizarData(arranjo.data)).toEqual(arranjo.data);
    // Same work as any other producer's code 3 for the order…
    expect(docIdOf(arranjo)).toBe(`3:${String(SHOP)}:${ORDER_SN_DO_PACOTE}:${String(AGORA_MS)}`);
    expect(docIdOf(arranjo)).toBe(docIdOf(backfill));
    expect(dedupKeyOf(arranjo)).toBe(dedupKeyOf(backfill));
    // …and the anchor that keeps that from being vacuous: the payloads differ.
    expect(arranjo.data?.origem).not.toBe(backfill.data?.origem);
  });

  it('a origem é o nome do PRODUTOR, nunca do canal: `arranjo-turbo` não compila no code 3', () => {
    // The near-miss of the member above. "Turbo" is a channel name Shopee has
    // already renamed once (announcement 1465); the producer's name is
    // channel-neutral. The builder copies `origem` verbatim at runtime, so the
    // union is the WHOLE guard — which the second assertion makes visible.
    const p = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      nowMs: AGORA_MS,
      // @ts-expect-error — `'arranjo-turbo'` names a channel; the code-3 union names producers.
      origem: 'arranjo-turbo',
    });

    expect(p.code).toBe(3);
    expect(p.data).toHaveProperty('origem', 'arranjo-turbo');
  });

  it('docIdOf/dedupKeyOf batem com o contrato escrito no docblock', () => {
    const p = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(docIdOf(p)).toBe(`3:${String(SHOP)}:${ORDER_SN}:${String(AGORA_MS)}`);
    expect(dedupKeyOf(p)).toBe(`3:${String(SHOP)}:${ORDER_SN}`);
  });

  it('dois pedidos DIFERENTES no mesmo tick não colapsam — o near-miss do dedup', () => {
    const a = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });
    const b = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: `${ORDER_SN}0`,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(dedupKeyOf(a)).not.toBe(dedupKeyOf(b));
    expect(docIdOf(a)).not.toBe(docIdOf(b));
  });

  it('dois TICKS do mesmo pedido são dois documentos e uma só chave de dedup', () => {
    const primeiro = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });
    const segundo = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN,
      nowMs: AGORA_MS + 900_000,
      origem: 'backfill',
    });

    // Two ticks are two genuine attempts, so two rows; the dedup key is what
    // collapses them for anything that asks "same work?".
    expect(docIdOf(primeiro)).not.toBe(docIdOf(segundo));
    expect(dedupKeyOf(primeiro)).toBe(dedupKeyOf(segundo));
  });
});

describe('notificacaoSinteticaDePacote (passo 15b, #1744)', () => {
  function pacote(
    sobrescrever: Partial<Parameters<typeof notificacaoSinteticaDePacote>[0]> = {},
  ): ReturnType<typeof notificacaoSinteticaDePacote> {
    return notificacaoSinteticaDePacote({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      packageNumber: PACOTE,
      nowMs: AGORA_MS,
      origem: 'arranjo-automatico',
      ...sobrescrever,
    });
  }

  it('monta um code 30 com timestamp em MILISSEGUNDOS, roteado para o braço de frete', () => {
    const p = pacote();

    expect(p.code).toBe(30);
    expect(p.shopId).toBe(SHOP);
    expect(p.timestamp).toBe(AGORA_MS);
    // The magnitude check of the code-3 suite: a SECONDS stamp would be ~1.76e9.
    expect(p.timestamp).toBeGreaterThan(1_000_000_000_000);
    // ⚠️ The LITERAL destination, never `destinoDoCodigo(30)` against itself.
    expect(destinoDoCodigo(p.code)).toBe('frete');
  });

  it('data carrega EXATAMENTE ordersn, package_number e origem — sem update_time, sem fulfillment_status', () => {
    const p = pacote();

    expect(Object.keys(p.data ?? {}).sort()).toEqual(['ordersn', 'origem', 'package_number']);
    expect(p.data).toEqual({
      ordersn: ORDER_SN_DO_PACOTE,
      package_number: PACOTE,
      origem: 'arranjo-automatico',
    });
    // The two absences, named: a synthetic witnessed no transition (no event
    // clock) and observed no token of its own (the push-vs-pull diagnostic).
    expect(p.data).not.toHaveProperty('update_time');
    expect(p.data).not.toHaveProperty('fulfillment_status');
    // …and the wire spelling of the order key never leaks through.
    expect(p.data).not.toHaveProperty('order_sn');
  });

  it('docIdOf/dedupKeyOf batem com o contrato do docblock — o PACOTE é o recurso, o carimbo é a síntese', () => {
    const p = pacote();

    expect(docIdOf(p)).toBe(`30:${String(SHOP)}:${PACOTE}:${String(AGORA_MS)}`);
    expect(dedupKeyOf(p)).toBe(`30:${String(SHOP)}:${PACOTE}`);
  });

  it('dois PACOTES do mesmo pedido no mesmo tick não colapsam — o near-miss do dedup', () => {
    const a = pacote();
    const b = pacote({ packageNumber: PACOTE_2 });

    expect(dedupKeyOf(a)).not.toBe(dedupKeyOf(b));
    expect(docIdOf(a)).not.toBe(docIdOf(b));
  });

  it('dois TICKS do mesmo pacote são dois documentos e uma só chave de dedup', () => {
    const primeiro = pacote();
    const segundo = pacote({ nowMs: AGORA_MS + 300_000 });

    expect(docIdOf(primeiro)).not.toBe(docIdOf(segundo));
    expect(dedupKeyOf(primeiro)).toBe(dedupKeyOf(segundo));
  });

  it('um push 33 REAL do mesmo pacote é o mesmo trabalho (dedup) e nunca o mesmo documento', () => {
    // A real delivery, through the receiver's own parser: `update_time` is the
    // wire's SECONDS and becomes the carimbo, so it can never collide with the
    // synthetic's millisecond carimbo — while the dedup key, which drops the
    // carimbo, says "same package" for both.
    const agoraS = AGORA_MS / 1000;
    const real = parseNotificationBody({
      code: 30,
      shop_id: SHOP,
      timestamp: agoraS,
      data: {
        ordersn: ORDER_SN_DO_PACOTE,
        package_number: PACOTE,
        fulfillment_status: 'LOGISTICS_READY',
        update_time: agoraS,
      },
    });
    if (real === null)
      throw new Error('parseNotificationBody devolveu null para um envelope válido');
    const sintetica = pacote();

    expect(dedupKeyOf(sintetica)).toBe(dedupKeyOf(real));
    expect(docIdOf(sintetica)).not.toBe(docIdOf(real));
    expect(docIdOf(real)).toBe(`30:${String(SHOP)}:${PACOTE}:${String(agoraS)}`);
  });

  it('o code 30 do pacote nunca colapsa no code 3 do pedido — o código faz parte da identidade', () => {
    const doPacote = pacote();
    const doPedido = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      nowMs: AGORA_MS,
      origem: 'backfill',
    });

    expect(dedupKeyOf(doPacote)).not.toBe(dedupKeyOf(doPedido));
    expect(docIdOf(doPacote)).not.toBe(docIdOf(doPedido));
  });

  it('o payload atravessa o fio do Cloud Tasks: o schema da tarefa e a sanitização o devolvem IGUAL', () => {
    const p = pacote();

    // The task handler re-validates every payload with this schema after a
    // JSON hop; the failure path stores `data` through `sanitizarData`.
    expect(shopeeNotificationTaskSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(sanitizarData(p.data)).toEqual(p.data);
  });

  it('o leitor do braço de frete aceita o payload — `origem` a mais é tolerado, e o alvo é o MESMO pacote', () => {
    const p = pacote();
    const alvo = alvoDoPushDeFrete(p.code, p.data);

    expect(alvo).toEqual({
      ok: true,
      code: 30,
      orderSn: ORDER_SN_DO_PACOTE,
      packageNumber: PACOTE,
      diagnostico: {
        code: 30,
        grafiaDoPedido: 'ordersn',
        trackingNoDoPush: null,
        // The two absences again, as the arm sees them: no token to compare
        // against the pull, and no push clock to log beside the package's.
        statusDoPush: null,
        camposMudados: null,
        shipByDateAntigaS: null,
        shipByDateNovaS: null,
        canalAntigo: null,
        canalNovo: null,
        relogioDoPushS: null,
      },
    });
  });

  it('near-miss do leitor: sem package_number o MESMO leitor recusa — o aceite acima não é vácuo', () => {
    const p = pacote();
    const semPacote = Object.fromEntries(
      Object.entries(p.data ?? {}).filter(([chave]) => chave !== 'package_number'),
    );

    expect(alvoDoPushDeFrete(30, semPacote).ok).toBe(false);
  });

  it('a origem do pacote é um tipo PRÓPRIO: uma origem de varredura de pedidos não compila aqui', () => {
    notificacaoSinteticaDePacote({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      packageNumber: PACOTE,
      nowMs: AGORA_MS,
      // @ts-expect-error — `'backfill'` names an ORDER sweep; the package builder's union is its own.
      origem: 'backfill',
    });
    expect(pacote().data).toHaveProperty('origem', 'arranjo-automatico');
  });
});
