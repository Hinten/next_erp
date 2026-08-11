import { describe, expect, it } from 'vitest';
import type { MercadoLivreCategorias } from './client';

import {
  canSelectCategoria,
  categoriaBreadcrumb,
  formatCategoriaPath,
  levelChildren,
  ROOT_LABEL,
} from './categoriaTree';

type Node = NonNullable<MercadoLivreCategorias['node']>;

function node(over: Partial<Node> = {}): Node {
  return {
    id: 'MLB31447',
    name: 'Camisetas',
    pathFromRoot: [
      { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
      { id: 'MLB1431', name: 'Roupas' },
      { id: 'MLB31447', name: 'Camisetas' },
    ],
    children: [],
    isLeaf: true,
    settings: null,
    ...over,
  };
}

describe('categoriaBreadcrumb', () => {
  it('starts at the tree root so the operator can always go back', () => {
    const trail = categoriaBreadcrumb(node());
    expect(trail[0]).toEqual({ id: null, name: ROOT_LABEL });
  });

  it('does not repeat the current node, which ML puts in path_from_root', () => {
    // ML's `path_from_root` ends with the node itself. Rendering it twice would
    // give the operator a link to the level they are already on.
    const trail = categoriaBreadcrumb(node());
    expect(trail.map((c) => c.id)).toEqual([null, 'MLB1430', 'MLB1431', 'MLB31447']);
  });

  it('is just the root when nothing is selected', () => {
    expect(categoriaBreadcrumb(null)).toEqual([{ id: null, name: ROOT_LABEL }]);
  });

  it('falls back to the id when ML omits a name', () => {
    const trail = categoriaBreadcrumb(
      node({ name: null, pathFromRoot: [{ id: 'MLB1430', name: null }] }),
    );
    expect(trail.map((c) => c.name)).toEqual([ROOT_LABEL, 'MLB1430', 'MLB31447']);
  });
});

describe('formatCategoriaPath', () => {
  it('renders the human path, not the opaque id', () => {
    expect(formatCategoriaPath(node())).toBe('Calçados, Roupas e Bolsas › Roupas › Camisetas');
  });

  it('is null when there is no category yet', () => {
    expect(formatCategoriaPath(null)).toBeNull();
  });
});

describe('canSelectCategoria', () => {
  it('allows only a leaf', () => {
    // Attributes and listing types exist on leaves alone — a mid-tree pick
    // hands the operator an empty grid and a listing ML rejects.
    expect(canSelectCategoria(node({ isLeaf: true }))).toBe(true);
    expect(canSelectCategoria(node({ isLeaf: false }))).toBe(false);
    expect(canSelectCategoria(null)).toBe(false);
  });
});

describe('levelChildren', () => {
  it('shows the roots before anything is selected', () => {
    const roots = [{ id: 'MLB1430', name: 'Calçados' }];
    expect(levelChildren({ roots, node: null })).toEqual(roots);
  });

  it('shows the node children once the operator has descended', () => {
    const children = [{ id: 'MLB31448', name: 'Manga curta' }];
    expect(levelChildren({ roots: null, node: node({ children }) })).toEqual(children);
  });

  it('is empty while the level is still loading', () => {
    expect(levelChildren(undefined)).toEqual([]);
  });
});
