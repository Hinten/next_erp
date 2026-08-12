import { describe, expect, it } from 'vitest';
import type { MercadoLivreCategoriaSugestao, MercadoLivreCategorias } from './client';

import {
  canSelectCategoria,
  categoriaBreadcrumb,
  formatCategoriaPath,
  formatSugestaoPath,
  levelChildren,
  ROOT_LABEL,
  sugestaoPath,
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

describe('sugestaoPath', () => {
  function sugestao(over: Partial<MercadoLivreCategoriaSugestao> = {}) {
    return {
      categoryId: 'MLB31447',
      categoryName: 'Camisetas e Regatas',
      domainId: 'MLB-T_SHIRTS',
      domainName: 'Camisetas',
      pathFromRoot: [
        { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
        { id: 'MLB108704', name: 'Roupas' },
        { id: 'MLB31447', name: 'Camisetas e Regatas' },
      ],
      ...over,
    } satisfies MercadoLivreCategoriaSugestao;
  }

  it('separates the ancestors from the leaf', () => {
    // The ancestors ARE the distinguishing information: ML files the same leaf
    // name under several parents, so a leaf-only label renders identically on
    // every row and the list looks like one category suggested five times.
    expect(sugestaoPath(sugestao())).toEqual({
      trail: ['Calçados, Roupas e Bolsas', 'Roupas'],
      leaf: 'Camisetas e Regatas',
    });
  });

  it('never repeats the leaf in the trail', () => {
    // ML includes the node itself at the end of `path_from_root`, and the caller
    // renders the leaf separately.
    expect(sugestaoPath(sugestao()).trail).not.toContain('Camisetas e Regatas');
  });

  it('distinguishes two suggestions that share a leaf name', () => {
    // The exact bug: five rows reading "Camisetas e Regatas", told apart only by
    // an opaque MLB id.
    const masculinas = sugestao({
      categoryId: 'MLB31447',
      pathFromRoot: [
        { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
        { id: 'MLB108704', name: 'Roupas Masculinas' },
        { id: 'MLB31447', name: 'Camisetas e Regatas' },
      ],
    });
    const femininas = sugestao({
      categoryId: 'MLB439327',
      pathFromRoot: [
        { id: 'MLB1430', name: 'Calçados, Roupas e Bolsas' },
        { id: 'MLB108705', name: 'Roupas Femininas' },
        { id: 'MLB439327', name: 'Camisetas e Regatas' },
      ],
    });
    expect(formatSugestaoPath(masculinas)).not.toBe(formatSugestaoPath(femininas));
    expect(formatSugestaoPath(masculinas)).toContain('Roupas Masculinas');
    expect(formatSugestaoPath(femininas)).toContain('Roupas Femininas');
  });

  it('degrades to the leaf alone when the path could not be resolved', () => {
    // One unresolvable category must not take the whole list down, so the route
    // sends `null` and the row stays selectable.
    expect(sugestaoPath(sugestao({ pathFromRoot: null }))).toEqual({
      trail: [],
      leaf: 'Camisetas e Regatas',
    });
  });

  it('falls back to ids when ML sends no names', () => {
    const out = sugestaoPath(
      sugestao({
        categoryName: null,
        pathFromRoot: [
          { id: 'MLB1430', name: '  ' },
          { id: 'MLB31447', name: null },
        ],
      }),
    );
    expect(out).toEqual({ trail: ['MLB1430'], leaf: 'MLB31447' });
  });
});

describe('formatSugestaoPath', () => {
  it('joins the whole path root-first', () => {
    expect(
      formatSugestaoPath({
        categoryId: 'MLB31447',
        categoryName: 'Camisetas e Regatas',
        domainId: null,
        domainName: null,
        pathFromRoot: [
          { id: 'MLB1430', name: 'Roupas' },
          { id: 'MLB31447', name: 'Camisetas e Regatas' },
        ],
      }),
    ).toBe('Roupas › Camisetas e Regatas');
  });
});
