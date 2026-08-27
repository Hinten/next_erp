import { describe, expect, it } from 'vitest';
import {
  ESTADO_BUCKET_LABELS,
  bucketOf,
  itemDoPedidoSchema,
  itemSubtotal,
  pedidoSchema,
  pedidoTotal,
} from './pedido';
import type { ItemDoPedido } from './pedido';
import { ESTADO_PEDIDO } from './pedido';

const baseInput = {
  estado: 'pago' as const,
  integracaoPedidoOuterRef: 'documents/integracao/x',
};

// All nullable fields of itemDoPedidoSchema set to null — combine with the
// fields the test cares about via spread.
const baseItem: ItemDoPedido = {
  produtoUid: null,
  ordem: 1,
  ensureUniqueId: null,
  mktplaceId: null,
  sku: null,
  gtin: null,
  nomeDeVenda: null,
  precoDeVenda: 1,
  descontoUnitario: 0,
  quantidade: 1,
  custo: null,
  timestamp: null,
  imposto: null,
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
    expect(pedidoSchema.safeParse({ ...baseInput, estado: 'bogus' }).success).toBe(false);
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

  it('accepts a zero-priced item line (100% coupon / marketplace bonus) — #794', () => {
    const parsed = pedidoSchema.safeParse({
      ...baseInput,
      itens: { x: [{ precoDeVenda: 0, quantidade: 1 }] },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.itens.x?.[0]?.precoDeVenda).toBe(0);
  });

  it('rejects item with a negative precoDeVenda', () => {
    expect(
      pedidoSchema.safeParse({
        ...baseInput,
        itens: { x: [{ precoDeVenda: -1, quantidade: 1 }] },
      }).success,
    ).toBe(false);
  });

  // No `.passthrough()` (#462): an unmodeled key is stripped on a lenient
  // parse (the read path, `parseSoftRead` in `@delfrance/data`) — this is what
  // keeps a legacy corpus doc carrying a since-retired field readable (root
  // `CLAUDE.md` rule 8) — but throws on the write path, which re-parses
  // strictly whenever the lenient parse dropped a caller-supplied key
  // (`parseForWrite`/`parseMergePatch`, `packages/data/src/zodParse.ts`).
  it('silently strips a genuinely unknown top-level key on a lenient (read) parse', () => {
    const parsed = pedidoSchema.parse({ ...baseInput, someRetiredLegacyField: 'whatever' });
    expect(parsed).not.toHaveProperty('someRetiredLegacyField');
  });

  it('rejects a genuinely unknown top-level key on a strict (write) parse', () => {
    // Mirrors the `.strict()` re-parse `parseForWrite`/`parseMergePatch` run
    // internally once they notice the lenient parse above dropped a key.
    expect(() =>
      pedidoSchema.strict().parse({ ...baseInput, someUnknownField: 'whatever' }),
    ).toThrow(/nrecognized/);
  });
});

describe('itemDoPedidoSchema', () => {
  it('silently strips a genuinely unknown key on a lenient (read) parse', () => {
    const parsed = itemDoPedidoSchema.parse({ ...baseItem, someRetiredLegacyField: 'whatever' });
    expect(parsed).not.toHaveProperty('someRetiredLegacyField');
  });

  it('rejects a genuinely unknown key on a strict (write) parse', () => {
    expect(() =>
      itemDoPedidoSchema.strict().parse({ ...baseItem, someUnknownField: 'whatever' }),
    ).toThrow(/nrecognized/);
  });
});

describe('itemSubtotal', () => {
  it('applies (preco - desconto) * quantidade', () => {
    expect(
      itemSubtotal({ ...baseItem, precoDeVenda: 10, descontoUnitario: 2, quantidade: 3 }),
    ).toBe(24);
  });

  it('treats zero desconto as no discount', () => {
    expect(itemSubtotal({ ...baseItem, precoDeVenda: 7, quantidade: 2, descontoUnitario: 0 })).toBe(
      14,
    );
  });
});

describe('pedidoTotal', () => {
  it('sums every item across every group', () => {
    const total = pedidoTotal({
      ...pedidoSchema.parse(baseInput),
      itens: {
        a: [{ ...baseItem, precoDeVenda: 10, quantidade: 2 }],
        b: [
          { ...baseItem, precoDeVenda: 5, quantidade: 1 },
          { ...baseItem, precoDeVenda: 8, quantidade: 1, ordem: 2, descontoUnitario: 1 },
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
    expect(bucketOf(ESTADO_PEDIDO.iniciado)).toBe('aberto');
    expect(bucketOf(ESTADO_PEDIDO.carrinho)).toBe('aberto');
  });

  it('groups pago/finalizado into "concluido"', () => {
    expect(bucketOf(ESTADO_PEDIDO.pago)).toBe('concluido');
    expect(bucketOf(ESTADO_PEDIDO.finalizado)).toBe('concluido');
  });

  it('groups error/fraude into "cancelado"', () => {
    expect(bucketOf(ESTADO_PEDIDO.error)).toBe('cancelado');
    expect(bucketOf(ESTADO_PEDIDO.fraude)).toBe('cancelado');
  });
});
