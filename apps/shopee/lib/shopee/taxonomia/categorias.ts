/**
 * The in-memory index over Shopee's category tree, and the three-valued leaf
 * gate every other taxonomy read hangs off.
 *
 * `get_category` takes no id and no paging: one call returns the WHOLE tree
 * (~10⁴ nodes). So the shape of every question we actually ask — "is this a
 * leaf?", "what is the path from the root?", "what are this node's children?" —
 * is a lookup over an index built once per cache window, never a second
 * provider call and never the whole tree crossing our own wire.
 *
 * ## Why the leaf verdict has THREE values
 *
 * `get_attribute_tree`, `get_brand_list`, `get_variations` and the kit bands all
 * document leaf ids, and a non-leaf id answers with something useless or an
 * error. Two of the three cases are ordinary answers; the third is not:
 *
 *  - `folha` — `has_children === false`, exactly. The read proceeds.
 *  - `nao-folha` — the node exists and has children. The route answers 200 with
 *    nothing and makes ZERO calls to the gated operation (`get_attribute_tree`,
 *    `get_brand_list`, `get_variations`, `get_kit_item_limit`). Reading this
 *    index is not free on a cold window — it is the one `get_category` above —
 *    but it is paid once per window for every taxonomy answer, gated or not.
 *  - `desconhecida` — the id is not in the tree at all. That is NOT "has
 *    children": it means the caller sent an id from another region, a stale
 *    picker, or a typo, and the honest answer is a 404. Folding it into
 *    `nao-folha` would answer 200-with-nothing to a caller who is asking about
 *    a category that does not exist — indistinguishable, in the UI, from a
 *    perfectly valid mid-tree node.
 *
 * ## `has_children === false`, never `!has_children`
 *
 * The comparison is against the literal `false` and nothing else. The package
 * schema declares `has_children` as a strict `z.boolean()`, so a `"false"`
 * string fails the parse and never reaches here — but this reader must not be
 * the place that would have coerced it: `!('false')` is `false`, so the loose
 * test would call a NON-leaf a leaf and publish attributes for the wrong node.
 * A value that is not the literal `false` is treated as "has children", which is
 * the conservative direction (an extra 200-with-nothing, never a wrong write).
 */

/**
 * One `response.category_list[]` row from `get_category`, as the package parses
 * it (`shopeeCategoriaSchema`: `wireInt()` on both ids, a STRICT `z.boolean()`
 * on `has_children`, `.passthrough()` for the fields Shopee adds without
 * notice).
 *
 * ⚠️ Imported rather than re-declared. A local mirror of a provider row is a
 * second contract that drifts toward plausible while both copies stay green;
 * the one this module walks must be the one the wire was parsed against.
 */
import type { ShopeeCategoria } from '@delfrance/integrations-shopee';

/**
 * The whole tree, indexed both ways.
 *
 * Built once per cache window and shared by reference with every reader — so it
 * is `readonly` throughout, and nothing downstream may mutate it.
 */
export interface ShopeeCategoriaIndice {
  /** Every node, in the order Shopee sent it, minus repeated ids. */
  readonly lista: readonly ShopeeCategoria[];
  readonly porId: ReadonlyMap<number, ShopeeCategoria>;
  /** Keyed by `parent_category_id`; `0` holds the roots. */
  readonly filhosPorPai: ReadonlyMap<number, readonly ShopeeCategoria[]>;
}

/**
 * How many levels {@link caminhoDaCategoria} will walk before giving up.
 *
 * Shopee's tree is four or five levels deep, so this is not a limit any real
 * category reaches — it is the second half of the cycle guard: the `visitados`
 * set stops a cycle that closes on a node already seen, and this stops a chain
 * that is merely absurd (a provider bug producing a very long parent chain).
 */
export const SHOPEE_CATEGORIA_PROFUNDIDADE_MAX = 32;

/**
 * Index a `category_list` payload.
 *
 * ⚠️ A repeated `category_id` keeps the FIRST occurrence, in both maps and in
 * `lista`. The answer must not depend on which of two identical-id rows the
 * index happened to keep, and a duplicate that survived into `filhosPorPai`
 * would show the same child twice in the picker while `porId` served the other
 * copy — the two structures disagreeing about the same tree.
 */
export function construirIndice(rows: readonly ShopeeCategoria[]): ShopeeCategoriaIndice {
  const porId = new Map<number, ShopeeCategoria>();
  const filhosPorPai = new Map<number, ShopeeCategoria[]>();
  const lista: ShopeeCategoria[] = [];

  for (const row of rows) {
    if (porId.has(row.category_id)) continue;
    porId.set(row.category_id, row);
    lista.push(row);
    const irmaos = filhosPorPai.get(row.parent_category_id);
    if (irmaos === undefined) filhosPorPai.set(row.parent_category_id, [row]);
    else irmaos.push(row);
  }

  return { lista, porId, filhosPorPai };
}

/** Whether a category may be published to. See the module header. */
export type VerdictoFolha = 'folha' | 'nao-folha' | 'desconhecida';

/**
 * The leaf verdict for `categoryId`.
 *
 * `desconhecida` is returned for an id the tree does not contain — never
 * `nao-folha`, and never a throw: the route maps it to a 404
 * (`SHOPEE_CATEGORIA_DESCONHECIDA`).
 */
export function ehFolha(indice: ShopeeCategoriaIndice, categoryId: number): VerdictoFolha {
  const no = indice.porId.get(categoryId);
  if (no === undefined) return 'desconhecida';
  // Exactly `false`. See the header: `!no.has_children` would call a non-leaf
  // carrying the string "false" a leaf.
  return no.has_children === false ? 'folha' : 'nao-folha';
}

/**
 * The path from the ROOT down to `categoryId`, inclusive of both ends.
 *
 * Root first, the way `apps/web`'s cascade picker renders it and the way ML's
 * `path_from_root` already reads — the two channels' pickers must not disagree
 * about which end of the array is the root.
 *
 * An unknown id answers `[]`. A cycle or an absurd chain terminates: the walk
 * stops on the first node it has already visited, and after
 * {@link SHOPEE_CATEGORIA_PROFUNDIDADE_MAX} levels regardless. ⚠️ Truncation is
 * at the ROOT end — the requested node is always the last element, so a caller
 * rendering a breadcrumb loses ancestors rather than the node it asked about.
 */
export function caminhoDaCategoria(
  indice: ShopeeCategoriaIndice,
  categoryId: number,
): readonly ShopeeCategoria[] {
  const caminho: ShopeeCategoria[] = [];
  const visitados = new Set<number>();

  let atual = indice.porId.get(categoryId);
  while (atual !== undefined && caminho.length < SHOPEE_CATEGORIA_PROFUNDIDADE_MAX) {
    if (visitados.has(atual.category_id)) break;
    visitados.add(atual.category_id);
    caminho.push(atual);
    if (atual.parent_category_id === 0) break;
    atual = indice.porId.get(atual.parent_category_id);
  }

  caminho.reverse();
  return caminho;
}

/** The direct children of `categoryId`, in the order Shopee sent them. */
export function filhosDe(
  indice: ShopeeCategoriaIndice,
  categoryId: number,
): readonly ShopeeCategoria[] {
  return indice.filhosPorPai.get(categoryId) ?? [];
}

/**
 * The top level: every node whose `parent_category_id` is exactly `0`.
 *
 * ⚠️ An ORPHAN — a node whose parent id is non-zero but absent from the tree —
 * is deliberately NOT promoted to a root. Shopee marks a root with `0` and
 * nothing else; inventing roots out of unreachable nodes would put a mid-tree
 * category at the top of the operator's picker with no way to tell it apart
 * from a real one.
 */
export function raizes(indice: ShopeeCategoriaIndice): readonly ShopeeCategoria[] {
  return indice.filhosPorPai.get(0) ?? [];
}
