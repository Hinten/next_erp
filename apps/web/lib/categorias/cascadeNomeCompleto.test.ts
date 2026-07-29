import { describe, expect, it, vi } from 'vitest';
import {
  buildChildNomeCompletoPatches,
  cascadeNomeCompletoToDescendants,
  listDescendantCategoriaIds,
  type CategoriaChild,
  type CategoriaNomeCompletoPatch,
} from './cascadeNomeCompleto';

describe('buildChildNomeCompletoPatches', () => {
  it('prefixes each child nome with the parent breadcrumb', () => {
    expect(
      buildChildNomeCompletoPatches(
        [
          { id: 'c1', nome: 'Masculinas' },
          { id: 'c2', nome: 'Femininas' },
        ],
        'Roupas',
      ),
    ).toEqual([
      { id: 'c1', nomeCompleto: 'Roupas > Masculinas' },
      { id: 'c2', nomeCompleto: 'Roupas > Femininas' },
    ]);
  });

  it('returns empty for no children', () => {
    expect(buildChildNomeCompletoPatches([], 'Roupas')).toEqual([]);
  });
});

describe('cascadeNomeCompletoToDescendants', () => {
  it('BFS-updates direct children and grandchildren', async () => {
    // root → a, b; a → a1
    const tree: Record<string, CategoriaChild[]> = {
      root: [
        { id: 'a', nome: 'A' },
        { id: 'b', nome: 'B' },
      ],
      a: [{ id: 'a1', nome: 'A1' }],
      b: [],
      a1: [],
    };
    const applied: CategoriaNomeCompletoPatch[] = [];
    const updated = await cascadeNomeCompletoToDescendants(
      {
        listDirectChildren: async (id) => tree[id] ?? [],
        applyPatches: async (patches) => {
          applied.push(...patches);
        },
        now: () => 1_700_000_000_000,
      },
      'root',
      'Root',
    );

    expect(updated).toBe(3);
    expect(applied).toEqual([
      { id: 'a', nomeCompleto: 'Root > A', ultimaModificacao: 1_700_000_000_000 },
      { id: 'b', nomeCompleto: 'Root > B', ultimaModificacao: 1_700_000_000_000 },
      { id: 'a1', nomeCompleto: 'Root > A > A1', ultimaModificacao: 1_700_000_000_000 },
    ]);
  });

  it('no-ops when the root has no children', async () => {
    const applyPatches = vi.fn();
    const updated = await cascadeNomeCompletoToDescendants(
      {
        listDirectChildren: async () => [],
        applyPatches,
        now: () => 0,
      },
      'root',
      'Root',
    );
    expect(updated).toBe(0);
    expect(applyPatches).not.toHaveBeenCalled();
  });
});

describe('listDescendantCategoriaIds', () => {
  it('returns every descendant id excluding the root', async () => {
    const tree: Record<string, CategoriaChild[]> = {
      root: [{ id: 'a', nome: 'A' }],
      a: [{ id: 'a1', nome: 'A1' }],
      a1: [],
    };
    await expect(listDescendantCategoriaIds(async (id) => tree[id] ?? [], 'root')).resolves.toEqual(
      ['a', 'a1'],
    );
  });
});
