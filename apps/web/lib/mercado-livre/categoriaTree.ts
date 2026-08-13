/**
 * Pure helpers for navigating the Mercado Livre category tree.
 *
 * The cascade is the only way an operator reaches a **leaf**, and only a leaf
 * has attributes and listing types — so "am I allowed to pick this?" is a rule
 * worth stating once, in a testable place, rather than re-deriving it in the
 * component.
 */
import type {
  MercadoLivreCategoriaNo,
  MercadoLivreCategoriaSugestao,
  MercadoLivreCategorias,
} from './client';

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

/** The separator between path segments, shared by every caller. */
export const PATH_SEPARATOR = ' › ';

/**
 * A suggestion's full path, split into the trail and the leaf so the caller can
 * emphasise the leaf without re-parsing a joined string.
 *
 * ⚠️ **The whole reason this exists.** `domain_discovery/search` returns only
 * `category_name`, which is the leaf, and ML files the same leaf name under
 * several different parents — so a suggestion list showed "Camisetas e Regatas"
 * five times with five different opaque ids and no way to tell them apart. The
 * ancestors ARE the distinguishing information.
 *
 * ML repeats the node itself at the end of `path_from_root`, so the leaf is
 * dropped from the trail rather than shown twice. When the path could not be
 * resolved the trail is empty and only the leaf remains — the row stays usable.
 */
export function sugestaoPath(sugestao: MercadoLivreCategoriaSugestao): {
  /** Ancestors, root-first, excluding the leaf. Empty when unknown. */
  trail: string[];
  /** Always present — falls back to the category id when ML sends no name. */
  leaf: string;
} {
  const path = sugestao.pathFromRoot ?? [];
  // ⚠️ Prefer the resolved path's own entry over the raw id. `category_name` is
  // `.nullable().optional()` on `domain_discovery/search`, so it legitimately
  // arrives null — and when it does, the node the route already fetched carries
  // the real name, in the very entry the filter below drops. Falling straight to
  // the id would print `MLB31447` at the operator with the answer sitting one
  // array element away, which is the exact failure this helper exists to remove.
  const self = path.find((c) => c.id === sugestao.categoryId);
  const leaf = blankToNull(sugestao.categoryName) ?? blankToNull(self?.name) ?? sugestao.categoryId;
  const trail = path
    // ML repeats the node itself at the end of the path; the caller renders the
    // leaf separately, so including it here would duplicate it.
    .filter((c) => c.id !== sugestao.categoryId)
    .map((c) => blankToNull(c.name) ?? c.id);
  return { trail, leaf };
}

/** `"Roupas › Camisetas e Regatas"` — the one-line form, for a title or a test. */
export function formatSugestaoPath(sugestao: MercadoLivreCategoriaSugestao): string {
  const { trail, leaf } = sugestaoPath(sugestao);
  return [...trail, leaf].join(PATH_SEPARATOR);
}

function blankToNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
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
