import { describe, expect, it } from 'vitest';
import type { MlShipmentOrder } from '@delfrance/integrations-mercado-livre';
import type { ItemDoPedido } from '@delfrance/schemas';
import {
  conferirItensDoEnvio,
  descreverDivergencia,
  type ResultadoConferencia,
} from './orderShipmentConference';

function item(over: Partial<ItemDoPedido> = {}): ItemDoPedido {
  return {
    produtoUid: 'produto-1',
    ordem: 1,
    ensureUniqueId: 'uid-1',
    mktplaceId: 'MLB1',
    sku: null,
    gtin: null,
    nomeDeVenda: null,
    precoDeVenda: 100,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
    ...over,
  };
}

function linha(over: Partial<MlShipmentOrder> = {}): MlShipmentOrder {
  return {
    order_id: '2000014428837134',
    pack_id: null,
    item_id: 'MLB1',
    variation_id: null,
    user_product_id: null,
    seller_id: 555,
    requested_quantity: 1,
    ...over,
  };
}

const conferir = (
  linhasDoEnvio: MlShipmentOrder[],
  itensDoPedido: ItemDoPedido[],
  sellerUserId: number | string | null = 555,
): ResultadoConferencia => conferirItensDoEnvio({ linhasDoEnvio, itensDoPedido, sellerUserId });

/** Narrow to the divergent case so tests can read its fields without casts. */
function divergente(r: ResultadoConferencia) {
  expect(r.tipo).toBe('divergente');
  return r as Extract<ResultadoConferencia, { tipo: 'divergente' }>;
}

describe('conferirItensDoEnvio — reconciles', () => {
  it('matches on item_id when the line has no variation', () => {
    expect(conferir([linha()], [item()])).toEqual({ tipo: 'ok' });
  });

  it('matches on variation_id when the line has one', () => {
    // The pedido keys `mktplaceId` as `variation_id ?? item.id`
    // (`orderMapping.ts:169`), so a variation sale must be compared on the
    // variation and the item_id must never be consulted.
    const r = conferir(
      [linha({ item_id: 'MLB1', variation_id: 9876543210 })],
      [item({ mktplaceId: '9876543210' })],
    );
    expect(r).toEqual({ tipo: 'ok' });
  });

  it('treats variation_id 0 as "no variation" and falls back to item_id', () => {
    // `/orders` documents a nullable Long, but `/shipments/{id}/items` uses 0 as
    // its sentinel and the pedido side never keys on '0'. If that sentinel ever
    // appears here it must not mismatch every variation-less sale.
    expect(conferir([linha({ variation_id: 0 })], [item({ mktplaceId: 'MLB1' })])).toEqual({
      tipo: 'ok',
    });
  });

  it('AGGREGATES per mktplaceId — two pedido lines of 1 against one row of 2', () => {
    // The case legacy failed. Its per-line float equality could not see that two
    // lines of the same listing add up to the row ML reports; a pack routinely
    // produces exactly this shape.
    const r = conferir(
      [linha({ requested_quantity: 2 })],
      [
        item({ ensureUniqueId: 'uid-1', quantidade: 1 }),
        item({ ensureUniqueId: 'uid-2', ordem: 2, quantidade: 1 }),
      ],
    );
    expect(r).toEqual({ tipo: 'ok' });
  });

  it('aggregates the SHIPMENT side too — two rows of the same listing across pack orders', () => {
    const r = conferir(
      [
        linha({ order_id: '1', requested_quantity: 1 }),
        linha({ order_id: '2', requested_quantity: 2 }),
      ],
      [item({ quantidade: 3 })],
    );
    expect(r).toEqual({ tipo: 'ok' });
  });

  it('accepts requested_quantity as a numeric string', () => {
    expect(conferir([linha({ requested_quantity: '2' })], [item({ quantidade: 2 })])).toEqual({
      tipo: 'ok',
    });
  });

  it('tolerates float summation error', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754. An exact `!==` would fail this.
    const r = conferir(
      [linha({ requested_quantity: 0.3 })],
      [
        item({ ensureUniqueId: 'uid-1', quantidade: 0.1 }),
        item({ ensureUniqueId: 'uid-2', ordem: 2, quantidade: 0.2 }),
      ],
    );
    expect(r).toEqual({ tipo: 'ok' });
  });
});

describe('conferirItensDoEnvio — blocking divergences (the pedido has what ML does not)', () => {
  it('flags a listing ML is not selling at all', () => {
    const r = divergente(conferir([linha()], [item(), item({ mktplaceId: 'MLB-FANTASMA' })]));
    expect(r.bloqueia).toBe(true);
    expect(r.excedentes).toEqual([{ mktplaceId: 'MLB-FANTASMA', noPedido: 1, noEnvio: 0 }]);
    expect(r.faltantes).toEqual([]);
  });

  it('flags a quantity above what was bought', () => {
    const r = divergente(conferir([linha({ requested_quantity: 1 })], [item({ quantidade: 2 })]));
    expect(r.bloqueia).toBe(true);
    expect(r.excedentes).toEqual([{ mktplaceId: 'MLB1', noPedido: 2, noEnvio: 1 }]);
  });

  it('flags a stored line with no mktplaceId — unreconcilable, and it WOULD ship', () => {
    // `PrincipalTab`'s `addItem` seeds `mktplaceId: null`. Reachable only on a
    // pedido whose `hasUserInteraction` was never stamped, since the flag skips
    // the conference entirely.
    const r = divergente(conferir([linha()], [item(), item({ mktplaceId: null, ordem: 2 })]));
    expect(r.bloqueia).toBe(true);
    expect(r.semIdentificacao).toBe(1);
    expect(r.excedentes).toEqual([]);
  });

  it('treats an empty-string mktplaceId the same as null', () => {
    const r = divergente(conferir([linha()], [item(), item({ mktplaceId: '', ordem: 2 })]));
    expect(r.semIdentificacao).toBe(1);
    expect(r.bloqueia).toBe(true);
  });

  it('blocks when a surplus and a shortfall occur together', () => {
    const r = divergente(
      conferir(
        [linha({ item_id: 'MLB-SO-NO-ML' }), linha({ item_id: 'MLB1' })],
        [item({ mktplaceId: 'MLB1', quantidade: 5 })],
      ),
    );
    expect(r.excedentes).toEqual([{ mktplaceId: 'MLB1', noPedido: 5, noEnvio: 1 }]);
    expect(r.faltantes).toEqual([{ mktplaceId: 'MLB-SO-NO-ML', noPedido: 0, noEnvio: 1 }]);
    expect(r.bloqueia).toBe(true);
  });
});

describe('conferirItensDoEnvio — NON-blocking divergences (ML has what the pedido does not)', () => {
  // This direction fires transiently and legitimately: `pack_id` can be missing
  // from a partial order payload (#793), so between the first order's import and
  // its siblings' the pedido really does hold a subset of the sale. Blocking
  // here would `error` a perfectly healthy pedido on a routine race — pinned so
  // nobody later "symmetrises" the check.
  it('does NOT block on a listing the pedido has not imported yet', () => {
    const r = divergente(
      conferir([linha({ item_id: 'MLB1' }), linha({ item_id: 'MLB2' })], [item()]),
    );
    expect(r.bloqueia).toBe(false);
    expect(r.faltantes).toEqual([{ mktplaceId: 'MLB2', noPedido: 0, noEnvio: 1 }]);
    expect(r.excedentes).toEqual([]);
  });

  it('does NOT block on a quantity below what was bought', () => {
    const r = divergente(conferir([linha({ requested_quantity: 3 })], [item({ quantidade: 1 })]));
    expect(r.bloqueia).toBe(false);
    expect(r.faltantes).toEqual([{ mktplaceId: 'MLB1', noPedido: 1, noEnvio: 3 }]);
  });
});

describe('conferirItensDoEnvio — indeterminate (refuses to judge)', () => {
  it('reports indeterminado for an EMPTY response rather than "everything mismatched"', () => {
    // ML documents `204 No Content` for this resource and the plugin schema
    // parses it to `[]`. Reading that as "the shipment covers nothing" would
    // flag every line of a perfectly good pedido.
    expect(conferir([], [item()])).toMatchObject({ tipo: 'indeterminado' });
  });

  it('reports indeterminado for a row with neither item_id nor variation_id', () => {
    expect(conferir([linha({ item_id: null, variation_id: null })], [item()])).toMatchObject({
      tipo: 'indeterminado',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['non-numeric', 'muitos'],
  ])('reports indeterminado for requested_quantity = %s', (_label, valor) => {
    // NOT bare `Number(...)`: `Number(null)` and `Number('')` are both 0, which
    // would turn an absent quantity into a "zero units" claim and, against a
    // pedido that holds the line, into a spurious BLOCKING divergence.
    expect(conferir([linha({ requested_quantity: valor as never })], [item()])).toMatchObject({
      tipo: 'indeterminado',
    });
  });

  it('reports indeterminado when every row belongs to another seller', () => {
    expect(conferir([linha({ seller_id: 999 })], [item()])).toMatchObject({
      tipo: 'indeterminado',
    });
  });
});

describe('conferirItensDoEnvio — multi-seller filtering', () => {
  it('ignores rows attributed to another seller', () => {
    const r = conferir([linha(), linha({ item_id: 'MLB-OUTRO', seller_id: 999 })], [item()]);
    expect(r).toEqual({ tipo: 'ok' });
  });

  it('keeps a row whose seller_id is unknown rather than dropping it silently', () => {
    const r = divergente(
      conferir([linha(), linha({ item_id: 'MLB2', seller_id: null })], [item()]),
    );
    expect(r.faltantes).toEqual([{ mktplaceId: 'MLB2', noPedido: 0, noEnvio: 1 }]);
  });

  it('keeps every row when our own seller id is unknown', () => {
    const r = conferir([linha({ seller_id: 999 })], [item()], null);
    expect(r).toEqual({ tipo: 'ok' });
  });

  it('compares seller ids across number/string forms', () => {
    expect(conferir([linha({ seller_id: '555' })], [item()], 555)).toEqual({ tipo: 'ok' });
  });
});

describe('descreverDivergencia', () => {
  it('names the shipment, the marketplace ids and the unit counts', () => {
    const r = divergente(conferir([linha({ requested_quantity: 1 })], [item({ quantidade: 2 })]));
    const texto = descreverDivergencia(r, 777);
    expect(texto).toContain('777');
    expect(texto).toContain('MLB1');
    expect(texto).toContain('pedido 2 un.');
    expect(texto).toContain('ML 1 un.');
  });

  it('says the pedido was blocked only when it was', () => {
    const bloqueante = divergente(conferir([linha()], [item({ quantidade: 2 })]));
    expect(descreverDivergencia(bloqueante, 777)).toContain('erro');

    const naoBloqueante = divergente(conferir([linha({ requested_quantity: 5 })], [item()]));
    expect(descreverDivergencia(naoBloqueante, 777)).toContain('continua liberado');
  });

  it('reports unidentifiable lines by count', () => {
    const r = divergente(conferir([linha()], [item(), item({ mktplaceId: null, ordem: 2 })]));
    expect(descreverDivergencia(r, 777)).toContain('1 item(ns) do pedido sem identificação');
  });

  it('is deterministic regardless of input order', () => {
    const a = divergente(
      conferir([linha()], [item({ mktplaceId: 'MLB-B' }), item({ mktplaceId: 'MLB-A', ordem: 2 })]),
    );
    const b = divergente(
      conferir([linha()], [item({ mktplaceId: 'MLB-A' }), item({ mktplaceId: 'MLB-B', ordem: 2 })]),
    );
    expect(descreverDivergencia(a, 777)).toBe(descreverDivergencia(b, 777));
  });

  it('🔒 leaks NO pedido content — ids and counts only', () => {
    // Legacy's `throw Exception('Erro ao atualizar frete \n $pedido \n $freteInicial')`
    // (tasks.dart:616) interpolated the whole pedido, and the sweep rethrew it
    // out of the Cloud Run handler — buyer name, CPF/CNPJ, address, phone and
    // every price into the logs. That is the one thing from that line which must
    // never be ported.
    const r = divergente(
      conferir(
        [linha({ requested_quantity: 1 })],
        [
          item({
            quantidade: 2,
            precoDeVenda: 1234.56,
            nomeDeVenda: 'Camiseta Preta M',
            sku: 'SKU-SEGREDO',
          }),
        ],
      ),
    );
    const texto = descreverDivergencia(r, 777);
    expect(texto).not.toContain('1234.56');
    expect(texto).not.toContain('Camiseta');
    expect(texto).not.toContain('SKU-SEGREDO');
  });
});
