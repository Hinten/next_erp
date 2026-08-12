import { describe, expect, it } from 'vitest';
import {
  ITEM_CHECKOUT_ERRORS,
  checkoutFretePedidoMeta,
  checkoutFretePedidoSchema,
  itemCheckoutPedidoSchema,
} from './checkout';

// A minimal-but-valid FreteDoPedido: `estado` is its only field with no default.
const frete = { estado: 'checkFinalizado' };

describe('itemCheckoutPedidoSchema', () => {
  it('defaults an empty item to a single-unit, non-deleted, no-error row', () => {
    const out = itemCheckoutPedidoSchema.parse({});
    expect(out.produtoCheckoutPedidoOuterRef).toBeNull();
    expect(out.quantidade).toBe(1);
    expect(out.dataExclusao).toBeNull();
    expect(out.error).toBeNull();
    expect(out.timestamp).toBeNull();
  });

  it('rejects quantidade < 1 and non-integers', () => {
    expect(itemCheckoutPedidoSchema.safeParse({ quantidade: 0 }).success).toBe(false);
    expect(itemCheckoutPedidoSchema.safeParse({ quantidade: 1.5 }).success).toBe(false);
  });

  it('reads a legacy ms timestamp and a documents/ ref through tolerantly', () => {
    const out = itemCheckoutPedidoSchema.parse({
      produtoCheckoutPedidoOuterRef: 'documents/produtos/prod-1',
      quantidade: 1,
      dataExclusao: null,
      error: null,
      timestamp: 1_700_000_000_000, // ms since epoch (Nov 2023)
    });
    expect(out.produtoCheckoutPedidoOuterRef).toBe('documents/produtos/prod-1');
    expect(out.timestamp).toBe(1_700_000_000_000);
  });

  it('keeps the exact legacy error literal on an error row', () => {
    const out = itemCheckoutPedidoSchema.parse({
      produtoCheckoutPedidoOuterRef: null,
      error: ITEM_CHECKOUT_ERRORS.produtoNaoEsperado,
    });
    expect(out.error).toBe('Produto não esperado');
    expect(out.produtoCheckoutPedidoOuterRef).toBeNull();
  });
});

describe('checkoutFretePedidoSchema', () => {
  it('parses a verbatim legacy doc (omitted-null keys, base-model keys, explicit-null items)', () => {
    const legacy = {
      // base-model keys the Flutter writer emits (omit-when-null) — kept by passthrough
      docId: 'chk-1',
      createTime: 1_700_000_000_000,
      // legacy OMITS title/obs/ehDoFreteInicial when null; here title is present, the rest absent
      title: '12345',
      freteNoMomentoDoCheckout: frete,
      usuarioCheckoutFretePedidoOuterRef: 'documents/usuarios/uid-1',
      itensCheckout: [
        {
          produtoCheckoutPedidoOuterRef: 'documents/produtos/p1',
          quantidade: 1,
          dataExclusao: null,
          error: null,
          timestamp: 1_700_000_000_000,
        },
        {
          produtoCheckoutPedidoOuterRef: null,
          quantidade: 1,
          dataExclusao: null,
          error: ITEM_CHECKOUT_ERRORS.produtoNaoEsperado,
          timestamp: 1_700_000_000_001,
        },
      ],
      timestamp: 1_700_000_000_500,
    };
    const out = checkoutFretePedidoSchema.parse(legacy);
    expect(out.title).toBe('12345');
    expect(out.obs).toBeNull(); // absent → defaulted null
    expect(out.ehDoFreteInicial).toBeNull(); // absent → defaulted null
    expect(out.itensCheckout).toHaveLength(2);
    expect(out.itensCheckout?.[1]?.error).toBe('Produto não esperado');
    expect(out.timestamp).toBe(1_700_000_000_500);
    // passthrough keeps the base-model keys the Flutter writer added
    expect((out as Record<string, unknown>).docId).toBe('chk-1');
  });

  it('round-trips a new-writer doc (explicit nulls, empty itensCheckout array)', () => {
    const doc = {
      title: '999',
      obs: null,
      freteNoMomentoDoCheckout: frete,
      ehDoFreteInicial: true,
      usuarioCheckoutFretePedidoOuterRef: 'documents/usuarios/uid-9',
      itensCheckout: [],
      timestamp: 1_700_000_123_456,
    };
    const out = checkoutFretePedidoSchema.parse(doc);
    expect(out.ehDoFreteInicial).toBe(true);
    expect(out.itensCheckout).toEqual([]);
    expect(out.timestamp).toBe(1_700_000_123_456);
  });

  it('requires freteNoMomentoDoCheckout and the usuario ref (always-present keys)', () => {
    expect(
      checkoutFretePedidoSchema.safeParse({
        usuarioCheckoutFretePedidoOuterRef: 'documents/usuarios/uid-1',
      }).success,
    ).toBe(false); // missing frete
    expect(checkoutFretePedidoSchema.safeParse({ freteNoMomentoDoCheckout: frete }).success).toBe(
      false,
    ); // missing usuario ref
  });

  it('rejects a bare (non-documents/) usuario ref', () => {
    expect(
      checkoutFretePedidoSchema.safeParse({
        freteNoMomentoDoCheckout: frete,
        usuarioCheckoutFretePedidoOuterRef: 'usuarios/uid-1',
      }).success,
    ).toBe(false);
  });

  it('lives at pedidos/{pedidoId}/checkout with pedido perms', () => {
    expect(checkoutFretePedidoMeta.collectionPath).toBe('pedidos/{pedidoId}/checkout');
    expect(checkoutFretePedidoMeta.permissions.read).toBe(1n << 16n);
    expect(checkoutFretePedidoMeta.permissions.write).toBe(1n << 17n);
    expect(checkoutFretePedidoMeta.permissions.delete).toBe(1n << 18n);
  });
});
