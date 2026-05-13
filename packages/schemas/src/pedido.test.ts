import { describe, expect, it } from 'vitest';
import {
  ESTADO_BUCKET_LABELS,
  bucketOf,
  itemSubtotal,
  pedidoSchema,
  pedidoTotal,
} from './pedido';

const baseInput = {
  estado: 'pago' as const,
  integracaoPedidoOuterRef: { uid: 'integracao/x' },
};

describe('pedidoSchema', () => {
  it('parses a minimal Pedido with defaults applied', () => {
    const out = pedidoSchema.parse(baseInput);
    expect(out.ehSaida).toBe(true);
    expect(out.itens).toEqual({});
    expect(out.itensIds).toEqual([]);
  });

  it('rejects missing estado', () => {
    const { estado: _omit, ...withoutEstado } = baseInput;
    expect(pedidoSchema.safeParse(withoutEstado).success).toBe(false);
  });

  it('rejects unknown estado', () => {
    expect(
      pedidoSchema.safeParse({ ...baseInput, estado: 'bogus' }).success,
    ).toBe(false);
  });

  it('round-trips itens grouped by produtoUid', () => {
    const out = pedidoSchema.parse({
      ...baseInput,
      itens: {
        'prod-a': [
          { precoDeVenda: 10, quantidade: 2 },
          { precoDeVenda: 10, quantidade: 1, ordem: 2 },
        ],
        NONE: [{ precoDeVenda: 5, quantidade: 1, descontoUnitario: 1 }],
      },
    });
    expect(out.itens['prod-a']?.length).toBe(2);
    expect(out.itens.NONE?.[0]?.descontoUnitario).toBe(1);
  });

  it('rejects item with precoDeVenda below minimum', () => {
    expect(
      pedidoSchema.safeParse({
        ...baseInput,
        itens: { x: [{ precoDeVenda: 0, quantidade: 1 }] },
      }).success,
    ).toBe(false);
  });
});

describe('itemSubtotal', () => {
  it('applies (preco - desconto) * quantidade', () => {
    expect(
      itemSubtotal({ precoDeVenda: 10, descontoUnitario: 2, quantidade: 3, ordem: 1 }),
    ).toBe(24);
  });

  it('treats missing desconto as zero', () => {
    expect(
      itemSubtotal({ precoDeVenda: 7, quantidade: 2, ordem: 1, descontoUnitario: 0 }),
    ).toBe(14);
  });
});

describe('pedidoTotal', () => {
  it('sums every item across every group', () => {
    const total = pedidoTotal({
      ...pedidoSchema.parse(baseInput),
      itens: {
        a: [{ precoDeVenda: 10, quantidade: 2, ordem: 1, descontoUnitario: 0 }],
        b: [
          { precoDeVenda: 5, quantidade: 1, ordem: 1, descontoUnitario: 0 },
          { precoDeVenda: 8, quantidade: 1, ordem: 2, descontoUnitario: 1 },
        ],
      },
    });
    expect(total).toBe(20 + 5 + 7);
  });
});

describe('bucketOf', () => {
  it('maps every status to a labeled bucket', () => {
    const labels = new Set(Object.keys(ESTADO_BUCKET_LABELS));
    for (const e of [
      'iniciado',
      'pago',
      'cancelado',
      'fraude',
      'finalizado',
      'emProcessamento',
    ] as const) {
      expect(labels.has(bucketOf(e))).toBe(true);
    }
  });

  it('groups iniciado/carrinho into "aberto"', () => {
    expect(bucketOf('iniciado')).toBe('aberto');
    expect(bucketOf('carrinho')).toBe('aberto');
  });

  it('groups pago/finalizado into "concluido"', () => {
    expect(bucketOf('pago')).toBe('concluido');
    expect(bucketOf('finalizado')).toBe('concluido');
  });

  it('groups error/fraude into "cancelado"', () => {
    expect(bucketOf('error')).toBe('cancelado');
    expect(bucketOf('fraude')).toBe('cancelado');
  });
});
