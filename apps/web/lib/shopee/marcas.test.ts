import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';

/**
 * The shortlist read (#1911, P9): the query shape (rule 1 — the whole
 * subcollection, `limit(500)`, no filter, no order ⇒ no index), what one
 * listener state reads as (through THE reader, #1369), and that the hook hands
 * the Marcas section what its per-document baselines are seeded from.
 */

const h = vi.hoisted(() => ({
  /** Every query the hook handed `useSnapshot`. */
  consultas: [] as unknown[],
  estado: { data: undefined, loading: true, error: undefined } as SnapshotState<
    SnapshotRow<Record<string, unknown>>[]
  >,
}));

vi.mock('@delfrance/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data')>()),
  // Keeps the base's tag and EVERY constraint, so the test reads the shape.
  buildQuery: (base: object, constraints: readonly unknown[]) => ({ ...base, constraints }),
  limit: (n: number) => ({ tipo: 'limit', n }),
}));

vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: (q: unknown) => {
    h.consultas.push(q);
    return q === null ? { data: undefined, loading: false, error: undefined } : h.estado;
  },
}));

vi.mock('@/lib/data/marcaShopeeCollection', () => ({
  marcaShopeeCollection: {
    ref: (_db: unknown, ctx: { integracaoId: string }) => ({
      __col: 'brandshopee',
      integracaoId: ctx.integracaoId,
    }),
  },
}));

const { LIMITE_MARCAS_SHOPEE, consultaMarcasShopee, lerMarcasShopee, useMarcasShopee } =
  await import('./marcas');

const db = {} as never;
const INT = 'int-1';
const linha = (
  id: string,
  data: Record<string, unknown>,
): SnapshotRow<Record<string, unknown>> => ({
  id,
  path: `integracao/${INT}/brandshopee/${id}`,
  data,
});

/** Two legacy auto-id docs for brand 7 (one blank), one unreadable doc, one «Sem marca». */
const LINHAS = [
  linha('AaaaaaaaaaaaaaaaaaA1', {
    brand_id: 7,
    original_brand_name: 'Nike',
    display_brand_name: null,
  }),
  linha('AaaaaaaaaaaaaaaaaaA2', { brand_id: 7, original_brand_name: '', display_brand_name: null }),
  linha('CcccccccccccccccccC1', { brand_id: '123', original_brand_name: 'Quoted' }),
  linha('DdddddddddddddddddD1', {
    brand_id: 0,
    original_brand_name: 'No Brand',
    display_brand_name: null,
  }),
  linha('3001', { brand_id: 3001, original_brand_name: 'Marca Exemplo', display_brand_name: null }),
];

describe('the query — the WHOLE subcollection, limit(500), nothing else (rule 1)', () => {
  it('⭐ the conta’s brandshopee ref with EXACTLY one constraint: limit(500)', () => {
    expect(consultaMarcasShopee(db, INT)).toEqual({
      __col: 'brandshopee',
      integracaoId: INT,
      constraints: [{ tipo: 'limit', n: 500 }],
    });
    expect(LIMITE_MARCAS_SHOPEE).toBe(500);
  });

  it('the real handle addresses integracao/{integracaoId}/brandshopee', async () => {
    const { marcaShopeeCollection } = await vi.importActual<
      typeof import('@/lib/data/marcaShopeeCollection')
    >('@/lib/data/marcaShopeeCollection');
    expect(marcaShopeeCollection.resolvePath({ integracaoId: INT })).toBe(
      `integracao/${INT}/brandshopee`,
    );
  });
});

describe('lerMarcasShopee — one listener state, read through THE reader', () => {
  it('before the first emission: no reading, no documents, not truncated', () => {
    expect(lerMarcasShopee({ data: undefined, loading: true, error: undefined })).toEqual({
      leitura: undefined,
      documentos: undefined,
      truncada: false,
      loading: true,
      error: undefined,
      fromCache: undefined,
      hasPendingWrites: undefined,
    });
  });

  it('⭐ duplicates collapse to ONE brand carrying every doc; unreadable and «Sem marca» are named apart', () => {
    const r = lerMarcasShopee({
      data: LINHAS,
      loading: false,
      error: undefined,
      fromCache: false,
      hasPendingWrites: false,
    });

    expect(r.leitura?.marcas.map((m) => [m.brandId, m.docIds])).toEqual([
      [3001, ['3001']],
      [7, ['AaaaaaaaaaaaaaaaaaA1', 'AaaaaaaaaaaaaaaaaaA2']],
    ]);
    expect(r.leitura?.ilegiveis).toEqual(['CcccccccccccccccccC1']);
    expect(r.leitura?.semMarca).toEqual(['DdddddddddddddddddD1']);
    expect(r.fromCache).toBe(false);
    expect(r.hasPendingWrites).toBe(false);
  });

  it('⭐ `documentos` is EVERY doc with its full path and data verbatim — the unreadable one included', () => {
    const r = lerMarcasShopee({ data: LINHAS, loading: false, error: undefined });

    expect(r.documentos).toEqual(LINHAS.map((l) => ({ id: l.id, path: l.path, data: l.data })));
    expect(r.documentos?.[2]?.data).toBe(LINHAS[2]?.data);
  });

  it('`truncada` at exactly 500 docs ⟷ NEAR-MISS: 499 is complete', () => {
    const n = (k: number) =>
      Array.from({ length: k }, (_, i) =>
        linha(String(i + 1), { brand_id: i + 1, original_brand_name: `M${String(i)}` }),
      );
    expect(lerMarcasShopee({ data: n(500), loading: false, error: undefined }).truncada).toBe(true);
    expect(lerMarcasShopee({ data: n(499), loading: false, error: undefined }).truncada).toBe(
      false,
    );
  });
});

describe('useMarcasShopee', () => {
  it('no conta yet ⇒ NO listener (`useSnapshot(null)`), nothing read', () => {
    h.consultas.length = 0;
    const { result } = renderHook(() => useMarcasShopee(db, null));

    expect(h.consultas.every((q) => q === null)).toBe(true);
    expect(result.current.leitura).toBeUndefined();
  });

  it('a conta ⇒ its shortlist query, and the listener’s state read through the reader', () => {
    h.consultas.length = 0;
    h.estado = {
      data: LINHAS,
      loading: false,
      error: undefined,
      fromCache: false,
      hasPendingWrites: false,
    };
    const { result } = renderHook(() => useMarcasShopee(db, INT));

    expect(h.consultas.at(-1)).toEqual(consultaMarcasShopee(db, INT));
    expect(result.current.leitura?.marcas).toHaveLength(2);
    expect(result.current.documentos).toHaveLength(LINHAS.length);
    expect(result.current.fromCache).toBe(false);
  });
});
