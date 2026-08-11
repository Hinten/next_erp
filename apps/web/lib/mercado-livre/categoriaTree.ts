/**
 * Pure helpers for navigating the Mercado Livre category tree.
 *
 * The cascade is the only way an operator reaches a **leaf**, and only a leaf
 * has attributes and listing types — so "am I allowed to pick this?" is a rule
 * worth stating once, in a testable place, rather than re-deriving it in the
 * component.
 */
import type { MercadoLivreCategoriaNo, MercadoLivreCategorias } from './client';

type CategoriaNode = NonNullable<MercadoLivreCategorias['node']>;

/** Label for the tree root, where the cascade starts. */
export const ROOT_LABEL = 'Todas as categorias';

/**
 * The clickable trail above the current level, root-first.
 *
 * `id: null` is the root pseudo-entry — selecting it clears the cursor and
 * shows ML's top-level categories. The CURRENT node is included as the last
 * entry so the trail reads as a complete path; the caller renders it inert.
 */
export function categoriaBreadcrumb(
  node: CategoriaNode | null,
): Array<{ id: string | null; name: string }> {
  const trail: Array<{ id: string | null; name: string }> = [{ id: null, name: ROOT_LABEL }];
  if (!node) return trail;
  for (const ancestor of node.pathFromRoot) {
    // ML repeats the node itself at the end of `path_from_root`; skip it here so
    // it is not offered twice, once as a link and once as the current level.
    if (ancestor.id === node.id) continue;
    trail.push({ id: ancestor.id, name: ancestor.name ?? ancestor.id });
  }
  trail.push({ id: node.id, name: node.name ?? node.id });
  return trail;
}

/** `"Roupas > Camisetas > Manga curta"` — the human form of a category id. */
export function formatCategoriaPath(node: CategoriaNode | null): string | null {
  if (!node) return null;
  const names = categoriaBreadcrumb(node)
    .slice(1)
    .map((c) => c.name);
  return names.length > 0 ? names.join(' › ') : (node.name ?? node.id);
}

/**
 * Only a leaf can be published into: ML exposes attributes and listing types
 * on leaves alone, so selecting a mid-tree node would hand the operator an
 * empty attribute grid and a listing ML then rejects.
 */
export function canSelectCategoria(node: CategoriaNode | null): boolean {
  return node?.isLeaf === true;
}

/** The level's children, or the tree roots when no node is selected yet. */
export function levelChildren(data: MercadoLivreCategorias | undefined): MercadoLivreCategoriaNo[] {
  if (!data) return [];
  return data.node ? data.node.children : (data.roots ?? []);
}
