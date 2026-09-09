import { describe, expect, it } from 'vitest';

import { dedupKeyOf, destinoDoCodigo, docIdOf } from './notificacao';
import { notificacaoSinteticaDePedido } from './notificacaoSintetica';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real shop id, partner id or key.      */
/* -------------------------------------------------------------------------- */

const SHOP = 987654;
const AGORA_MS = 1_760_000_000_000;
const ORDER_SN = '2601010ABCDEF';

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
    // The code the payload claims really is the one the dispatch table reads.
    expect(destinoDoCodigo(p.code)).toBe(destinoDoCodigo(3));
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

  it('origem viaja em data e NÃO entra na identidade: backfill e reserva-travada colapsam no MESMO documento', () => {
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
    expect(docIdOf(backfill)).toBe(docIdOf(reserva));
    expect(dedupKeyOf(backfill)).toBe(dedupKeyOf(reserva));
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
