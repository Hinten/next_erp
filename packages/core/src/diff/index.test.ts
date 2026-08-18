import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_VALUE_BYTES,
  type ExpandSpec,
  TRUNCATED_VALUE_KEY,
  diffDocumentFields,
} from './index';

describe('diffDocumentFields', () => {
  it('returns null when both sides are undefined', () => {
    expect(diffDocumentFields(undefined, undefined)).toBeNull();
  });

  it('returns null when nothing changed', () => {
    expect(diffDocumentFields({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBeNull();
  });

  it('derives kind "create" when before is undefined', () => {
    const diff = diffDocumentFields(undefined, { a: 1 });
    expect(diff?.kind).toBe('create');
    expect(diff?.campos).toEqual(['a']);
    expect(diff?.changes.a).toEqual({ old: null, new: 1 });
  });

  it('derives kind "delete" when after is undefined', () => {
    const diff = diffDocumentFields({ a: 1 }, undefined);
    expect(diff?.kind).toBe('delete');
    expect(diff?.campos).toEqual(['a']);
    expect(diff?.changes.a).toEqual({ old: 1, new: null });
  });

  it('derives kind "update" when both sides are defined', () => {
    const diff = diffDocumentFields({ a: 1 }, { a: 2 });
    expect(diff?.kind).toBe('update');
  });

  it('skips fields listed in opts.ignore', () => {
    const diff = diffDocumentFields({ a: 1, b: 2 }, { a: 1, b: 3 }, { ignore: ['b'] });
    expect(diff).toBeNull();
  });

  it('skips fields that are structurally (deep) equal via valuesEqual', () => {
    const diff = diffDocumentFields(
      { a: { nested: [1, 2, { c: 3 }] }, b: 1 },
      { a: { nested: [1, 2, { c: 3 }] }, b: 2 },
    );
    expect(diff?.campos).toEqual(['b']);
  });

  it('sorts campos ascending regardless of key insertion order', () => {
    const diff = diffDocumentFields({ z: 1, a: 1, m: 1 }, { z: 2, a: 2, m: 2 });
    expect(diff?.campos).toEqual(['a', 'm', 'z']);
  });

  it('coerces undefined to null on both sides', () => {
    const added = diffDocumentFields({}, { a: 1 });
    expect(added?.changes.a).toEqual({ old: null, new: 1 });

    const removed = diffDocumentFields({ a: 1 }, {});
    expect(removed?.changes.a).toEqual({ old: 1, new: null });
  });

  it('records an added field within an update (old absent)', () => {
    const diff = diffDocumentFields({ a: 1 }, { a: 1, b: 2 });
    expect(diff?.kind).toBe('update');
    expect(diff?.campos).toEqual(['b']);
    expect(diff?.changes.b).toEqual({ old: null, new: 2 });
  });

  it('records a removed field within an update (new absent)', () => {
    const diff = diffDocumentFields({ a: 1, b: 2 }, { a: 1 });
    expect(diff?.kind).toBe('update');
    expect(diff?.campos).toEqual(['b']);
    expect(diff?.changes.b).toEqual({ old: 2, new: null });
  });

  it('handles bigint values without throwing, reporting changes and stable values', () => {
    expect(diffDocumentFields({ a: 1n }, { a: 1n })).toBeNull();

    const diff = diffDocumentFields({ a: 1n }, { a: 2n });
    expect(diff?.changes.a).toEqual({ old: 1n, new: 2n });
  });

  it('truncates a value whose JSON encoding exceeds maxValueBytes', () => {
    const before = { a: 'short' };
    const after = { a: 'x'.repeat(100) };
    const diff = diffDocumentFields(before, after, { maxValueBytes: 20 });

    expect(diff?.changes.a?.old).toBe('short');
    expect(diff?.changes.a?.new).toMatchObject({ [TRUNCATED_VALUE_KEY]: true });
    const truncated = diff?.changes.a?.new as { _bytes: number };
    expect(truncated._bytes).toBeGreaterThan(20);
  });

  it('uses DEFAULT_MAX_VALUE_BYTES when no override is given', () => {
    const huge = 'x'.repeat(DEFAULT_MAX_VALUE_BYTES + 1);
    const diff = diffDocumentFields({ a: 'small' }, { a: huge });
    expect(diff?.changes.a?.new).toMatchObject({ [TRUNCATED_VALUE_KEY]: true });
  });

  it('truncates with _bytes: -1 when the value cannot be JSON-serialized (circular)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const diff = diffDocumentFields({ a: null }, { a: circular });
    expect(diff?.changes.a?.new).toEqual({ [TRUNCATED_VALUE_KEY]: true, _bytes: -1 });
  });

  it('returns null when the only differing fields are all ignored', () => {
    const diff = diffDocumentFields(
      { keep: 1, drop1: 'x', drop2: 'y' },
      { keep: 1, drop1: 'z', drop2: 'w' },
      { ignore: ['drop1', 'drop2'] },
    );
    expect(diff).toBeNull();
  });
});

/**
 * `expand` mirrors `pedido.itens` (`Record<produtoUid, ItemDoPedido[]>`) and
 * `pedido.freteInicial` (a flat object). The identity function here is a local
 * stand-in for `@delfrance/schemas`' `pedidoItemKey` — core cannot import
 * schemas (schemas depends on core), so the behaviour is pinned on both sides.
 */
describe('diffDocumentFields — expand', () => {
  const identify = (item: Record<string, unknown>): string | null => {
    const id = item.ensureUniqueId;
    if (typeof id === 'string' && id !== '') return id;
    return typeof item.ordem === 'number' ? `#${item.ordem}` : null;
  };

  const ITENS: ExpandSpec = { kind: 'mapOfArrays', identify, ignore: ['timestamp'] };

  const item = (over: Record<string, unknown> = {}) => ({
    produtoUid: 'p1',
    ordem: 1,
    ensureUniqueId: 'u-a',
    quantidade: 2,
    precoDeVenda: 10,
    ...over,
  });

  describe('regression — the shallow path must not move', () => {
    it('is byte-identical to the shallow result when no expand is given', () => {
      const before = { itens: { p1: [item()] }, nome: 'a' };
      const after = { itens: { p1: [item({ quantidade: 3 })] }, nome: 'a' };

      const diff = diffDocumentFields(before, after);

      expect(diff).toEqual({
        kind: 'update',
        campos: ['itens'],
        changes: { itens: { old: before.itens, new: after.itens } },
      });
    });

    it('leaves a field absent from expand on the shallow path beside an expanded sibling', () => {
      const before = { itens: { p1: [item()] }, observacoesInternas: 'antes' };
      const after = { itens: { p1: [item({ quantidade: 3 })] }, observacoesInternas: 'depois' };

      const diff = diffDocumentFields(before, after, { expand: { itens: ITENS } });

      expect(diff?.changes.observacoesInternas).toEqual({ old: 'antes', new: 'depois' });
      expect(diff?.changes['itens.u-a.quantidade']).toEqual({ old: 2, new: 3 });
      // The whole-map value is NOT stored once the field is expanded.
      expect(diff?.changes.itens).toBeUndefined();
    });
  });

  describe('kind: mapOfArrays', () => {
    it('records only the sub-field that moved, on only the item that moved', () => {
      const before = { itens: { p1: [item(), item({ ensureUniqueId: 'u-b', ordem: 2 })] } };
      const after = {
        itens: { p1: [item({ quantidade: 3 }), item({ ensureUniqueId: 'u-b', ordem: 2 })] },
      };

      const diff = diffDocumentFields(before, after, { expand: { itens: ITENS } });

      expect(Object.keys(diff?.changes ?? {})).toEqual(['itens.u-a.quantidade']);
      expect(diff?.changes['itens.u-a.quantidade']).toEqual({ old: 2, new: 3 });
    });

    it('puts BOTH the coarse field and the fine keys in campos, but only fine keys in changes', () => {
      const before = { itens: { p1: [item()] } };
      const after = { itens: { p1: [item({ quantidade: 3, precoDeVenda: 12 })] } };

      const diff = diffDocumentFields(before, after, { expand: { itens: ITENS } });

      expect(diff?.campos).toEqual(['itens', 'itens.u-a.precoDeVenda', 'itens.u-a.quantidade']);
      expect(Object.keys(diff?.changes ?? {}).sort()).toEqual([
        'itens.u-a.precoDeVenda',
        'itens.u-a.quantidade',
      ]);
    });

    it('records an added item as ONE whole-item change', () => {
      const added = item({ ensureUniqueId: 'u-b', ordem: 2 });
      const before = { itens: { p1: [item()] } };
      const after = { itens: { p1: [item(), added] } };

      const diff = diffDocumentFields(before, after, { expand: { itens: ITENS } });

      expect(Object.keys(diff?.changes ?? {})).toEqual(['itens.u-b']);
      expect(diff?.changes['itens.u-b']).toEqual({ old: null, new: added });
    });

    it('records a removed item as ONE whole-item change', () => {
      const removed = item({ ensureUniqueId: 'u-b', ordem: 2 });
      const before = { itens: { p1: [item(), removed] } };
      const after = { itens: { p1: [item()] } };

      const diff = diffDocumentFields(before, after, { expand: { itens: ITENS } });

      expect(Object.keys(diff?.changes ?? {})).toEqual(['itens.u-b']);
      expect(diff?.changes['itens.u-b']).toEqual({ old: removed, new: null });
    });

    it('reports a produto rebind as ONE produtoUid change, not a remove + add', () => {
      const before = { itens: { p1: [item()] } };
      const after = { itens: { p2: [item({ produtoUid: 'p2' })] } };

      const diff = diffDocumentFields(before, after, { expand: { itens: ITENS } });

      expect(Object.keys(diff?.changes ?? {})).toEqual(['itens.u-a.produtoUid']);
      expect(diff?.changes['itens.u-a.produtoUid']).toEqual({ old: 'p1', new: 'p2' });
    });

    it('is blind to a pure reorder within a group', () => {
      const a = item();
      const b = item({ ensureUniqueId: 'u-b', ordem: 2 });

      const diff = diffDocumentFields(
        { itens: { p1: [a, b] } },
        { itens: { p1: [b, a] } },
        { expand: { itens: ITENS } },
      );

      expect(diff).toBeNull();
    });

    it('disambiguates colliding keys deterministically, independent of map key order', () => {
      // Both lines are web-created (no ensureUniqueId) and share `ordem`, so both
      // derive the key `#1` — across two DIFFERENT groups.
      const mk = (produtoUid: string, quantidade: number) => ({
        produtoUid,
        ordem: 1,
        ensureUniqueId: null,
        quantidade,
      });

      const forward = diffDocumentFields(
        { itens: { p1: [mk('p1', 1)], p2: [mk('p2', 1)] } },
        { itens: { p1: [mk('p1', 1)], p2: [mk('p2', 9)] } },
        { expand: { itens: ITENS } },
      );
      // Reversed insertion order — Firestore wire order is not a contract.
      const reversed = diffDocumentFields(
        { itens: { p2: [mk('p2', 1)], p1: [mk('p1', 1)] } },
        { itens: { p2: [mk('p2', 9)], p1: [mk('p1', 1)] } },
        { expand: { itens: ITENS } },
      );

      expect(forward).toEqual(reversed);
      expect(Object.keys(forward?.changes ?? {})).toEqual(['itens.#1~1.quantidade']);
    });

    it('returns null when only an ignored per-item sub-field moved', () => {
      const diff = diffDocumentFields(
        { itens: { p1: [item({ timestamp: 1 })] } },
        { itens: { p1: [item({ timestamp: 2 })] } },
        { expand: { itens: ITENS } },
      );

      expect(diff).toBeNull();
    });

    it('collapses back to the coarse change past maxExpandedChanges', () => {
      const before = {
        itens: {
          p1: [
            item({ ensureUniqueId: 'u-a' }),
            item({ ensureUniqueId: 'u-b' }),
            item({ ensureUniqueId: 'u-c' }),
          ],
        },
      };
      const after = {
        itens: {
          p1: [
            item({ ensureUniqueId: 'u-a', quantidade: 9 }),
            item({ ensureUniqueId: 'u-b', quantidade: 9 }),
            item({ ensureUniqueId: 'u-c', quantidade: 9 }),
          ],
        },
      };

      const diff = diffDocumentFields(before, after, {
        expand: { itens: ITENS },
        maxExpandedChanges: 2,
      });

      expect(diff?.campos).toEqual(['itens']);
      expect(diff?.changes.itens).toEqual({ old: before.itens, new: after.itens });
    });

    it('treats a non-object element as a whole-item leaf instead of throwing', () => {
      const diff = diffDocumentFields(
        { itens: { p1: ['corrupto'] } },
        { itens: { p1: ['outro'] } },
        { expand: { itens: ITENS } },
      );

      expect(diff?.changes['itens.@p1[0]']).toEqual({ old: 'corrupto', new: 'outro' });
    });

    it('falls back to the coarse change when a group value is not an array', () => {
      const before = { itens: { p1: 'nao-e-array' } };
      const after = { itens: { p1: 'ainda-nao' } };

      const diff = diffDocumentFields(before, after, { expand: { itens: ITENS } });

      expect(diff?.campos).toEqual(['itens']);
      expect(diff?.changes.itens).toEqual({ old: before.itens, new: after.itens });
    });

    it('truncates per expanded leaf, not across the whole field', () => {
      const huge = 'x'.repeat(200);
      const before = { itens: { p1: [item({ imposto: 'pequeno' })] } };
      const after = { itens: { p1: [item({ imposto: huge, quantidade: 3 })] } };

      const diff = diffDocumentFields(before, after, {
        expand: { itens: ITENS },
        maxValueBytes: 50,
      });

      expect(diff?.changes['itens.u-a.imposto']?.new).toMatchObject({
        [TRUNCATED_VALUE_KEY]: true,
      });
      // The sibling leaf is small and survives intact.
      expect(diff?.changes['itens.u-a.quantidade']).toEqual({ old: 2, new: 3 });
    });
  });

  describe('kind: object', () => {
    const FRETE: ExpandSpec = { kind: 'object', ignore: ['ultimaModificacao'] };

    it('descends exactly one level, leaving nested values as whole-value leaves', () => {
      const before = {
        freteInicial: { custoFinal: 10, transportadora: { nome: 'A', cnpj: '1' } },
      };
      const after = {
        freteInicial: { custoFinal: 12, transportadora: { nome: 'B', cnpj: '1' } },
      };

      const diff = diffDocumentFields(before, after, { expand: { freteInicial: FRETE } });

      expect(diff?.changes['freteInicial.custoFinal']).toEqual({ old: 10, new: 12 });
      expect(diff?.changes['freteInicial.transportadora']).toEqual({
        old: { nome: 'A', cnpj: '1' },
        new: { nome: 'B', cnpj: '1' },
      });
      expect(diff?.changes['freteInicial.transportadora.nome']).toBeUndefined();
    });

    it('emits ONE coarse change when the field appears or disappears', () => {
      const appeared = diffDocumentFields(
        { freteInicial: null },
        { freteInicial: { custoFinal: 10 } },
        { expand: { freteInicial: FRETE } },
      );
      expect(appeared?.campos).toEqual(['freteInicial']);
      expect(appeared?.changes.freteInicial).toEqual({ old: null, new: { custoFinal: 10 } });

      const vanished = diffDocumentFields(
        { freteInicial: { custoFinal: 10 } },
        { freteInicial: null },
        { expand: { freteInicial: FRETE } },
      );
      expect(vanished?.campos).toEqual(['freteInicial']);
    });

    it('returns null when only an ignored sub-key moved', () => {
      const diff = diffDocumentFields(
        { freteInicial: { custoFinal: 10, ultimaModificacao: 1 } },
        { freteInicial: { custoFinal: 10, ultimaModificacao: 2 } },
        { expand: { freteInicial: FRETE } },
      );

      expect(diff).toBeNull();
    });
  });
});
