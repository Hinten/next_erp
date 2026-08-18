import { describe, expect, it } from 'vitest';
import { diffDocumentFields } from '@delfrance/core';
import { PEDIDO_ITEM_POSITIONAL_PREFIX, PEDIDO_ITENS_EXPAND, pedidoItemKey } from './itemIdentity';

describe('pedidoItemKey', () => {
  it('prefers ensureUniqueId — the only genuinely stable id (Mercado Livre lines)', () => {
    expect(pedidoItemKey({ ensureUniqueId: 'sha-256-hex', ordem: 7 }, 'p1')).toBe('sha-256-hex');
  });

  it('keeps an ensureUniqueId key group-INDEPENDENT, so a rebind is one change', () => {
    // The map key must not leak into a real id, or moving an ML line to another
    // produto would read as remove + add instead of one `produtoUid` change.
    expect(pedidoItemKey({ ensureUniqueId: 'sha-256-hex' }, 'p1')).toBe(
      pedidoItemKey({ ensureUniqueId: 'sha-256-hex' }, 'p2'),
    );
  });

  it('scopes the #<ordem> fallback to the group (every apps/web line)', () => {
    expect(pedidoItemKey({ ensureUniqueId: null, ordem: 3 }, 'p1')).toBe(
      `p1${PEDIDO_ITEM_POSITIONAL_PREFIX}3`,
    );
  });

  it('gives the SAME ordem in different groups different keys', () => {
    // `ordem` is not unique across produtos — the schema default is 1 and
    // `devolucaoForm` hardcodes 1 — so an unscoped key would collide.
    expect(pedidoItemKey({ ordem: 1 }, 'p1')).not.toBe(pedidoItemKey({ ordem: 1 }, 'p2'));
  });

  it('treats an empty-string ensureUniqueId as absent', () => {
    expect(pedidoItemKey({ ensureUniqueId: '', ordem: 3 }, 'p1')).toBe(
      `p1${PEDIDO_ITEM_POSITIONAL_PREFIX}3`,
    );
  });

  it('returns null when neither field is usable, handing the decision to the diff engine', () => {
    expect(pedidoItemKey({}, 'p1')).toBeNull();
    expect(pedidoItemKey({ ensureUniqueId: null, ordem: 'nao-numero' }, 'p1')).toBeNull();
    expect(pedidoItemKey({ ordem: Number.NaN }, 'p1')).toBeNull();
  });
});

describe('PEDIDO_ITENS_EXPAND', () => {
  const linha = (over: Record<string, unknown> = {}) => ({
    produtoUid: 'p1',
    ordem: 1,
    ensureUniqueId: null,
    quantidade: 2,
    precoDeVenda: 10,
    ...over,
  });

  it('is a mapOfArrays spec that ignores the per-line creation stamp', () => {
    expect(PEDIDO_ITENS_EXPAND.kind).toBe('mapOfArrays');
    expect(PEDIDO_ITENS_EXPAND.ignore).toContain('timestamp');
  });

  it('drives a per-line diff end to end through diffDocumentFields', () => {
    const diff = diffDocumentFields(
      { itens: { p1: [linha(), linha({ ordem: 2 })] } },
      { itens: { p1: [linha({ quantidade: 5 }), linha({ ordem: 2 })] } },
      { expand: { itens: PEDIDO_ITENS_EXPAND } },
    );

    expect(Object.keys(diff?.changes ?? {})).toEqual(['itens.p1#1.quantidade']);
    expect(diff?.changes['itens.p1#1.quantidade']).toEqual({ old: 2, new: 5 });
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

  it('ADDING an unrelated produto does not fabricate a change on an untouched line', () => {
    // Regression: with an unscoped `#<ordem>` key, two id-less lines sharing an
    // `ordem` collided, and the engine's occurrence suffix is assigned in sorted
    // GROUP-KEY order — so inserting a group renumbered them and the diff paired
    // lines belonging to different produtos. It reported the untouched line as
    // `added` AND attributed a quantity change to it that nobody made, which in
    // an audit trail is worse than a coarse whole-map entry.
    const zzz = { produtoUid: null, ordem: 0, ensureUniqueId: null, quantidade: 1 };
    const aaa = { produtoUid: null, ordem: 0, ensureUniqueId: null, quantidade: 9 };

    const diff = diffDocumentFields(
      { itens: { zzz: [zzz] } },
      { itens: { aaa: [aaa], zzz: [zzz] } },
      { expand: { itens: PEDIDO_ITENS_EXPAND } },
    );

    // Exactly one change: the genuinely new line.
    expect(Object.keys(diff?.changes ?? {})).toEqual(['itens.aaa#0']);
    expect(diff?.changes['itens.aaa#0']).toEqual({ old: null, new: aaa });
    // And nothing at all is attributed to the untouched one.
    expect(Object.keys(diff?.changes ?? {}).filter((k) => k.startsWith('itens.zzz'))).toEqual([]);
  });

  it('REMOVING a group leaves the surviving line untouched', () => {
    const zzz = { produtoUid: null, ordem: 0, ensureUniqueId: null, quantidade: 1 };
    const aaa = { produtoUid: null, ordem: 0, ensureUniqueId: null, quantidade: 9 };

    const diff = diffDocumentFields(
      { itens: { aaa: [aaa], zzz: [zzz] } },
      { itens: { zzz: [zzz] } },
      { expand: { itens: PEDIDO_ITENS_EXPAND } },
    );

    expect(Object.keys(diff?.changes ?? {})).toEqual(['itens.aaa#0']);
    expect(diff?.changes['itens.aaa#0']).toEqual({ old: aaa, new: null });
  });
});
