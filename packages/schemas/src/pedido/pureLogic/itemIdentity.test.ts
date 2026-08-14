import { describe, expect, it } from 'vitest';
import { diffDocumentFields } from '@delfrance/core';
import { PEDIDO_ITEM_POSITIONAL_PREFIX, PEDIDO_ITENS_EXPAND, pedidoItemKey } from './itemIdentity';

describe('pedidoItemKey', () => {
  it('prefers ensureUniqueId — the only genuinely stable id (Mercado Livre lines)', () => {
    expect(pedidoItemKey({ ensureUniqueId: 'sha-256-hex', ordem: 7 })).toBe('sha-256-hex');
  });

  it('falls back to #<ordem> when ensureUniqueId is null (every apps/web line)', () => {
    expect(pedidoItemKey({ ensureUniqueId: null, ordem: 3 })).toBe(
      `${PEDIDO_ITEM_POSITIONAL_PREFIX}3`,
    );
  });

  it('treats an empty-string ensureUniqueId as absent', () => {
    expect(pedidoItemKey({ ensureUniqueId: '', ordem: 3 })).toBe(
      `${PEDIDO_ITEM_POSITIONAL_PREFIX}3`,
    );
  });

  it('falls back when ensureUniqueId is missing entirely', () => {
    expect(pedidoItemKey({ ordem: 0 })).toBe(`${PEDIDO_ITEM_POSITIONAL_PREFIX}0`);
  });

  it('returns null when neither field is usable, handing the decision to the diff engine', () => {
    expect(pedidoItemKey({})).toBeNull();
    expect(pedidoItemKey({ ensureUniqueId: null, ordem: 'nao-numero' })).toBeNull();
    expect(pedidoItemKey({ ordem: Number.NaN })).toBeNull();
  });

  it('does NOT derive produtoUid from anywhere — identity is the item alone', () => {
    // `flattenPedidoItens` backfills `produtoUid` from the map key; history must
    // record what is on disk, so the key must not depend on the group.
    const item = { ensureUniqueId: null, ordem: 1, produtoUid: null };
    expect(pedidoItemKey(item)).toBe(`${PEDIDO_ITEM_POSITIONAL_PREFIX}1`);
  });
});

describe('PEDIDO_ITENS_EXPAND', () => {
  it('is a mapOfArrays spec that ignores the per-line creation stamp', () => {
    expect(PEDIDO_ITENS_EXPAND.kind).toBe('mapOfArrays');
    expect(PEDIDO_ITENS_EXPAND.ignore).toContain('timestamp');
  });

  it('drives a per-line diff end to end through diffDocumentFields', () => {
    const linha = (over: Record<string, unknown> = {}) => ({
      produtoUid: 'p1',
      ordem: 1,
      ensureUniqueId: null,
      quantidade: 2,
      precoDeVenda: 10,
      ...over,
    });

    const diff = diffDocumentFields(
      { itens: { p1: [linha(), linha({ ordem: 2 })] } },
      { itens: { p1: [linha({ quantidade: 5 }), linha({ ordem: 2 })] } },
      { expand: { itens: PEDIDO_ITENS_EXPAND } },
    );

    expect(Object.keys(diff?.changes ?? {})).toEqual(['itens.#1.quantidade']);
    expect(diff?.changes['itens.#1.quantidade']).toEqual({ old: 2, new: 5 });
    // The coarse name stays in `campos` so `array-contains 'itens'` still works.
    expect(diff?.campos).toContain('itens');
  });

  it('does not record a line whose only change is the ignored timestamp', () => {
    const diff = diffDocumentFields(
      { itens: { p1: [{ ensureUniqueId: 'u-a', ordem: 1, timestamp: 1 }] } },
      { itens: { p1: [{ ensureUniqueId: 'u-a', ordem: 1, timestamp: 2 }] } },
      { expand: { itens: PEDIDO_ITENS_EXPAND } },
    );

    expect(diff).toBeNull();
  });
});
