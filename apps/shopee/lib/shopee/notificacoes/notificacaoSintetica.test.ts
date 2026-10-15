import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { alvoDoPushDeDevolucao, type OrigemImportacaoDevolucao } from '../devolucoes/pushDevolucao';
import { alvoDoPushDeFrete } from '../pedidos/fretePushShopee';
import {
  dedupKeyOf,
  destinoDoCodigo,
  docIdOf,
  parseNotificationBody,
  sanitizarData,
  shopeeNotificationTaskSchema,
} from './notificacao';
import {
  carimboDoDiaUtcMs,
  notificacaoSinteticaDeDevolucao,
  notificacaoSinteticaDePacote,
  notificacaoSinteticaDePedido,
  type OrigemSinteticaDeDevolucao,
} from './notificacaoSintetica';

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
/** The code-29 fixtures (step 17): two digits-only returns and the ALPHANUMERIC one. */
const DEVOLUCAO = '2609100000000001';
const DEVOLUCAO_2 = '2609100000000002';
const DEVOLUCAO_ALFA = '260910ABCDE0001';
/** The start of `AGORA_MS`'s UTC day — 2025-10-09T00:00:00Z, written as a date. */
const DIA_DE_AGORA_MS = Date.UTC(2025, 9, 9);

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

describe('notificacaoSinteticaDePedido — origem `devolucao` (passo 17, #1525)', () => {
  it('o code 3 de uma devolução sem pedido carrega SÓ ordersn e origem, e o carimbo do DIA vira o documento do dia', () => {
    // The returns importer's deferred path: a code-29 delivery found no pedido,
    // so ONE code 3 for its order, stamped with the day — never `nowMs`.
    const p = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      nowMs: carimboDoDiaUtcMs(AGORA_MS),
      origem: 'devolucao',
    });

    expect(p.code).toBe(3);
    expect(destinoDoCodigo(p.code)).toBe('pedido');
    // A return names no `order_status`: the key is ABSENT, never null.
    expect(p.data).toEqual({ ordersn: ORDER_SN_DO_PACOTE, origem: 'devolucao' });
    expect(docIdOf(p)).toBe(`3:${String(SHOP)}:${ORDER_SN_DO_PACOTE}:${String(DIA_DE_AGORA_MS)}`);
    // Same work as the backfill's code 3 for the order — the origem is not identity.
    const backfill = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      nowMs: carimboDoDiaUtcMs(AGORA_MS),
      origem: 'backfill',
    });
    expect(dedupKeyOf(p)).toBe(dedupKeyOf(backfill));
    expect(p.data?.origem).not.toBe(backfill.data?.origem);
  });

  it('a origem de DEVOLUÇÃO do code 29 não compila no code 3 — cada construtor declara a sua', () => {
    const p = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      nowMs: AGORA_MS,
      // @ts-expect-error — `'reconciliacao'` names the RETURNS poll; the code-3 union names `'devolucao'`.
      origem: 'reconciliacao',
    });
    expect(p.code).toBe(3);
  });
});

describe('notificacaoSinteticaDeDevolucao (passo 17, #1525)', () => {
  function devolucao(
    sobrescrever: Partial<Parameters<typeof notificacaoSinteticaDeDevolucao>[0]> = {},
  ): ReturnType<typeof notificacaoSinteticaDeDevolucao> {
    return notificacaoSinteticaDeDevolucao({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      returnSn: DEVOLUCAO,
      nowMs: AGORA_MS,
      origem: 'reconciliacao',
      ...sobrescrever,
    });
  }

  it('monta um code 29 com timestamp em MILISSEGUNDOS', () => {
    const p = devolucao();

    // ⚠️ The LITERAL code. Its route is pinned where the table lives
    // (`notificacao.test.ts`, step 17's arm), never here against itself.
    expect(p.code).toBe(29);
    expect(p.shopId).toBe(SHOP);
    expect(p.timestamp).toBe(AGORA_MS);
    // The magnitude check of the other two suites: a SECONDS stamp would be ~1.76e9.
    expect(p.timestamp).toBeGreaterThan(1_000_000_000_000);
  });

  it('data carrega EXATAMENTE order_sn (COM underscore), return_sn e origem — sem diário, sem relógio, sem status', () => {
    const p = devolucao();

    expect(p.data).toEqual({
      order_sn: ORDER_SN_DO_PACOTE,
      return_sn: DEVOLUCAO,
      origem: 'reconciliacao',
    });
    // ⚠️ THE near-miss of the code-3/30 builders: push 32 spells `order_sn`,
    // and the `ordersn` those two write must NOT appear here.
    expect(p.data).toHaveProperty('order_sn', ORDER_SN_DO_PACOTE);
    expect(p.data).not.toHaveProperty('ordersn');
    // The absences, named: a synthetic witnessed no transition (no diary, no
    // per-field clock) and pulls its status, never carries one.
    expect(p.data).not.toHaveProperty('updated_values');
    expect(p.data).not.toHaveProperty('update_time');
    expect(p.data).not.toHaveProperty('status');
  });

  it('docIdOf/dedupKeyOf batem com o contrato do docblock — a DEVOLUÇÃO é o recurso, o pedido não entra', () => {
    const p = devolucao();

    expect(docIdOf(p)).toBe(`29:${String(SHOP)}:${DEVOLUCAO}:${String(AGORA_MS)}`);
    expect(dedupKeyOf(p)).toBe(`29:${String(SHOP)}:${DEVOLUCAO}`);
    // The order is NOT part of the identity: the same return named under
    // another order_sn is the same work, on the same row.
    const outroPedido = devolucao({ orderSn: `${ORDER_SN_DO_PACOTE}0` });
    expect(docIdOf(outroPedido)).toBe(docIdOf(p));
    expect(dedupKeyOf(outroPedido)).toBe(dedupKeyOf(p));
  });

  it('o return_sn ALFANUMÉRICO viaja verbatim até a identidade', () => {
    const p = devolucao({ returnSn: DEVOLUCAO_ALFA });

    expect(p.data).toHaveProperty('return_sn', DEVOLUCAO_ALFA);
    expect(docIdOf(p)).toBe(`29:${String(SHOP)}:${DEVOLUCAO_ALFA}:${String(AGORA_MS)}`);
  });

  it('duas DEVOLUÇÕES do mesmo pedido no mesmo tick não colapsam — o near-miss do dedup', () => {
    const a = devolucao();
    const b = devolucao({ returnSn: DEVOLUCAO_2 });

    expect(dedupKeyOf(a)).not.toBe(dedupKeyOf(b));
    expect(docIdOf(a)).not.toBe(docIdOf(b));
  });

  it('origem viaja em data e NÃO entra na identidade: reconciliação e ação do vendedor no MESMO carimbo colapsam', () => {
    const reconciliacao = devolucao();
    const acao = devolucao({ origem: 'acao-vendedor' });

    expect(acao.data).toHaveProperty('origem', 'acao-vendedor');
    expect(docIdOf(acao)).toBe(docIdOf(reconciliacao));
    expect(dedupKeyOf(acao)).toBe(dedupKeyOf(reconciliacao));
    expect(acao.data?.origem).not.toBe(reconciliacao.data?.origem);
  });

  it('com o carimbo do DIA, dois ticks do mesmo dia são UM documento, e o dia seguinte é outro', () => {
    // The poll's bound (≤ 1 failure row per return per UTC day): it stamps the
    // day, so a delivery that fails every 6 h keeps hitting ONE row.
    const manha = devolucao({ nowMs: carimboDoDiaUtcMs(AGORA_MS) });
    const noite = devolucao({ nowMs: carimboDoDiaUtcMs(AGORA_MS + 14 * 3_600_000) });
    const amanha = devolucao({ nowMs: carimboDoDiaUtcMs(AGORA_MS + 86_400_000) });

    expect(docIdOf(manha)).toBe(`29:${String(SHOP)}:${DEVOLUCAO}:${String(DIA_DE_AGORA_MS)}`);
    expect(docIdOf(noite)).toBe(docIdOf(manha));
    expect(docIdOf(amanha)).not.toBe(docIdOf(manha));
    expect(dedupKeyOf(amanha)).toBe(dedupKeyOf(manha));
  });

  it('o payload atravessa o fio do Cloud Tasks: o schema da tarefa e a sanitização o devolvem IGUAL', () => {
    const p = devolucao({ returnSn: DEVOLUCAO_ALFA });

    expect(shopeeNotificationTaskSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(sanitizarData(p.data)).toEqual(p.data);
  });

  it('o leitor do braço de devolução aceita o payload: o MESMO alvo, a origem do produtor e um diário VAZIO', () => {
    for (const origem of ['reconciliacao', 'acao-vendedor'] as const) {
      const p = devolucao({ origem });
      const alvo = alvoDoPushDeDevolucao(p.data ?? {});

      expect(alvo).toEqual({
        ok: true,
        orderSn: ORDER_SN_DO_PACOTE,
        returnSn: DEVOLUCAO,
        origem,
        // The absences again, as the arm sees them: nothing changed that a
        // push would name, no push clock, no status token.
        diario: { camposMudados: [], relogioDoPushS: null, statusNoPush: null },
      });
    }
  });

  it('near-miss do leitor: sem return_sn o MESMO leitor recusa — o aceite acima não é vácuo', () => {
    const p = devolucao();
    const semDevolucao = Object.fromEntries(
      Object.entries(p.data ?? {}).filter(([chave]) => chave !== 'return_sn'),
    );

    expect(alvoDoPushDeDevolucao(semDevolucao).ok).toBe(false);
  });

  it('toda origem sintética de devolução é uma origem que o leitor conhece (subconjunto, por tipo)', () => {
    // A compile-time pin: widening the synthetic union with a member the
    // reader's union lacks stops compiling here. The runtime half is the
    // reader test above, which gets each member back verbatim.
    const origens: readonly OrigemSinteticaDeDevolucao[] = ['reconciliacao', 'acao-vendedor'];
    const lidas: readonly OrigemImportacaoDevolucao[] = origens;
    expect(lidas).toEqual(['reconciliacao', 'acao-vendedor']);
  });

  it('um push 32 REAL da mesma devolução é o mesmo trabalho (dedup) e, fora da virada do dia, nunca o mesmo documento', () => {
    const agoraS = AGORA_MS / 1000;
    const real = parseNotificationBody({
      code: 29,
      shop_id: SHOP,
      timestamp: agoraS,
      data: {
        order_sn: ORDER_SN_DO_PACOTE,
        return_sn: DEVOLUCAO,
        updated_values: [
          {
            update_field: 'return_status',
            old_value: 'REQUESTED',
            new_value: 'ACCEPTED',
            update_time: agoraS,
          },
        ],
      },
    });
    if (real === null)
      throw new Error('parseNotificationBody devolveu null para um envelope válido');
    const sintetica = devolucao({ nowMs: carimboDoDiaUtcMs(AGORA_MS) });

    expect(dedupKeyOf(sintetica)).toBe(dedupKeyOf(real));
    expect(docIdOf(sintetica)).not.toBe(docIdOf(real));
    // The real push's carimbo is its ENVELOPE stamp, parsed to ms (push 32 has
    // no top-level clock) — the same unit as the synthetic's.
    expect(docIdOf(real)).toBe(`29:${String(SHOP)}:${DEVOLUCAO}:${String(AGORA_MS)}`);
  });

  it('⚠️ …e um push 32 REAL entregue no segundo da virada do dia cai no MESMO documento — aceito: os dois são o mesmo PONTEIRO', () => {
    const real = parseNotificationBody({
      code: 29,
      shop_id: SHOP,
      timestamp: DIA_DE_AGORA_MS / 1000,
      data: { order_sn: ORDER_SN_DO_PACOTE, return_sn: DEVOLUCAO },
    });
    if (real === null)
      throw new Error('parseNotificationBody devolveu null para um envelope válido');

    expect(docIdOf(devolucao({ nowMs: carimboDoDiaUtcMs(AGORA_MS) }))).toBe(docIdOf(real));
  });

  it('o code 29 nunca colapsa no code 3 nem no code 30 do mesmo pedido — o código faz parte da identidade', () => {
    const daDevolucao = devolucao();
    const doPedido = notificacaoSinteticaDePedido({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      nowMs: AGORA_MS,
      origem: 'devolucao',
    });
    const doPacote = notificacaoSinteticaDePacote({
      shopId: SHOP,
      orderSn: ORDER_SN_DO_PACOTE,
      packageNumber: PACOTE,
      nowMs: AGORA_MS,
      origem: 'arranjo-automatico',
    });

    for (const outro of [doPedido, doPacote]) {
      expect(dedupKeyOf(daDevolucao)).not.toBe(dedupKeyOf(outro));
      expect(docIdOf(daDevolucao)).not.toBe(docIdOf(outro));
    }
  });

  it('a origem da devolução é um tipo PRÓPRIO: `push` (o real) e uma origem de pedido não compilam aqui', () => {
    devolucao({
      // @ts-expect-error — `'push'` is the READER's answer for a real delivery; a push is never synthesized.
      origem: 'push',
    });
    devolucao({
      // @ts-expect-error — `'devolucao'` names the code-3 producer; the code-29 union is its own.
      origem: 'devolucao',
    });
    expect(devolucao().data).toHaveProperty('origem', 'reconciliacao');
  });
});

describe('carimboDoDiaUtcMs — o INÍCIO do dia UTC (movido do sweep do passo 15b)', () => {
  it('leva um instante ao início do SEU dia UTC', () => {
    expect(carimboDoDiaUtcMs(AGORA_MS)).toBe(DIA_DE_AGORA_MS);
    expect(carimboDoDiaUtcMs(Date.UTC(2026, 8, 10, 14, 23, 45, 678))).toBe(Date.UTC(2026, 8, 10));
  });

  it('as bordas: o início é ponto fixo, o último ms fica no dia, o ms seguinte é o dia seguinte', () => {
    const inicio = Date.UTC(2026, 8, 10);

    expect(carimboDoDiaUtcMs(inicio)).toBe(inicio);
    expect(carimboDoDiaUtcMs(inicio + 86_400_000 - 1)).toBe(inicio);
    expect(carimboDoDiaUtcMs(inicio + 86_400_000)).toBe(inicio + 86_400_000);
    expect(carimboDoDiaUtcMs(inicio - 1)).toBe(inicio - 86_400_000);
  });

  it('é idempotente e sempre múltiplo de um dia', () => {
    for (const nowMs of [AGORA_MS, AGORA_MS + 1, AGORA_MS + 23 * 3_600_000, 0, 1]) {
      const carimbo = carimboDoDiaUtcMs(nowMs);
      expect(carimboDoDiaUtcMs(carimbo)).toBe(carimbo);
      expect(carimbo % 86_400_000).toBe(0);
      expect(nowMs - carimbo).toBeGreaterThanOrEqual(0);
      expect(nowMs - carimbo).toBeLessThan(86_400_000);
    }
  });

  describe('⚠️ num fuso que NÃO é UTC, o dia continua sendo o UTC', () => {
    // The runner is pinned to TZ=UTC (`vitest.config.ts`), where a LOCAL-time
    // floor agrees with the UTC one by luck. `apps/nfe` runs São Paulo, so the
    // zone is switched here — and each case first proves the switch took.
    let fusoOriginal: string | undefined;
    beforeAll(() => {
      fusoOriginal = process.env.TZ;
    });
    afterAll(() => {
      if (fusoOriginal === undefined) delete process.env.TZ;
      else process.env.TZ = fusoOriginal;
    });

    it.each([
      // 01:30Z is 22:30 of the PREVIOUS day in São Paulo (UTC−3).
      ['America/Sao_Paulo', Date.UTC(2026, 8, 10, 1, 30)],
      // 20:00Z is 05:00 of the NEXT day in Tokyo (UTC+9).
      ['Asia/Tokyo', Date.UTC(2026, 8, 10, 20, 0)],
    ])('%s', (fuso, instante) => {
      process.env.TZ = fuso;
      // The anchor: in this zone the instant's LOCAL day really differs from
      // its UTC day — otherwise the assertion below would prove nothing.
      expect(new Date(instante).getDate()).not.toBe(new Date(instante).getUTCDate());

      expect(carimboDoDiaUtcMs(instante)).toBe(Date.UTC(2026, 8, 10));
    });
  });
});
