import { z } from 'zod';
import {
  RECURSO_URI_LI,
  TIPO_PAI_CATEGORIA_LI,
  idDoRecursoLi,
  type CategoriaCatalogoLi,
} from './catalogoLojaIntegrada';
import { inteiroPositivoCanonicoLi } from './mapaFreteLojaIntegrada';
import { contaIdFromRef, outerRefSchema } from './shared/outerRef';

/**
 * The Loja Integrada CATEGORY link and the store's category tree, as the product import (master
 * plan step 9) reads them.
 *
 * ## The link doc: `categorias/{categoriaId}/categorialojaintegrada/{docId}`
 * It ties an ERP categoria to ONE store category. The migrated docs carry `id` (the store
 * category id, as TEXT) and `nome`, and NO conta field; the docs the import writes add
 * `contaLojaIntegrada`. The `id` stays a STRING on purpose: a typed numeric field would never
 * match a migrated doc (Firestore equality is type-strict), so nothing queries it — the import
 * reads the whole (small) collection group once per job, and decides each doc through
 * {@link idCategoriaLiDoVinculo} and {@link vinculoCategoriaServeAConta}, which read the RAW stored
 * value and so also accept a numeric `id`.
 *
 * Bare and admin-only: no Meta, not a DomainSchema, not in `ALL_DOMAINS`, so the rulesets do not
 * change.
 *
 * ## The tree
 * Built from step 10's three-state parent ({@link TIPO_PAI_CATEGORIA_LI}). A chain is REFUSED,
 * never flattened: an unreadable parent, a parent that is not in the store's list, a cycle, or a
 * chain deeper than {@link PROFUNDIDADE_MAX_CATEGORIA_LI}. Never a root by default.
 *
 * Pure and total: no clock, no network, no Firestore, and no input throws.
 *
 * ⚠️ The id and conta readers decide "the same", so they are listed in
 * `packages/config-eslint/rules/equivalence-fold-inventory.test.js`, with their equal pairs and
 * near-misses pinned in `categoriaLojaIntegrada.test.ts`.
 */

/** `categorias/{categoriaId}/categorialojaintegrada/{docId}` — the store-category link doc. */
export const categoriaLojaIntegradaLinkSchema = z
  .object({
    /** The store category id, as TEXT (the migrated corpus's form; see the header). */
    id: z.string(),
    nome: z.string().max(255).nullable().default(null),
    /** Absent on every migrated doc; written by the import as `documents/integracao/<id>`. */
    contaLojaIntegrada: outerRefSchema.nullable().default(null),
  })
  .passthrough();
export type CategoriaLojaIntegradaLink = z.infer<typeof categoriaLojaIntegradaLinkSchema>;

/** A plain object in the Firestore sense: not `null`, not an array, not a primitive. */
function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Record<string, unknown>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/**
 * The store category id a stored link names, else `null`. Its `id` goes through
 * `inteiroPositivoCanonicoLi`, as text or number.
 *
 * Equal (⇒ `7645875`): a migrated `'7645875'` ≡ a new `'7645875'` ≡ a numeric `7645875`.
 * Distinct (⇒ `null`): `'07645875'`, `' 7645875'`, `'7645875.0'`, `'None'`, `''`, `0`, and a doc
 * that is not an object.
 */
export function idCategoriaLiDoVinculo(doc: unknown): number | null {
  if (!ehObjeto(doc)) return null;
  const id = inteiroPositivoCanonicoLi(proprio(doc, 'id'));
  return id === null ? null : Number(id);
}

/**
 * Does this stored category link serve conta `contaId`?
 *
 *  - a doc WITH a conta (`contaLojaIntegrada` present and not `null`): only when it reads as
 *    `contaId` — a doc of another conta, or one whose ref does not read, serves no one else;
 *  - a migrated doc WITHOUT a conta: only when its id is in THIS store's category list
 *    (`idsDaLoja`). Category ids are platform-wide, so a conta-less doc whose id this store does
 *    not list belongs to another store.
 *  - a doc whose id does not read serves nobody.
 *
 * Equal (serves C1): a new doc of C1; a conta-less doc whose id C1's store lists.
 * Distinct: a new doc of C2 never serves C1; a conta-less doc whose id C1's store does not list.
 */
export function vinculoCategoriaServeAConta(
  doc: unknown,
  contaId: string,
  idsDaLoja: ReadonlySet<number>,
): boolean {
  const id = idCategoriaLiDoVinculo(doc);
  if (id === null || !ehObjeto(doc)) return false;
  const conta = proprio(doc, 'contaLojaIntegrada');
  if (conta === null || conta === undefined) return idsDaLoja.has(id);
  return contaIdFromRef(conta) === contaId;
}

/* -------------------------------------------------------------------------- */
/*                                  The tree                                   */
/* -------------------------------------------------------------------------- */

/** The deepest chain accepted (a root alone is depth 1). Deeper is refused, never truncated. */
export const PROFUNDIDADE_MAX_CATEGORIA_LI = 32;

/**
 * Why a category chain is refused:
 *  - `ausente`: the category itself is not in the store's list;
 *  - `pai-ilegivel`: an ancestor's parent is unreadable (or two rows of one id disagree on it);
 *  - `pai-ausente`: an ancestor's parent id is not in the list;
 *  - `ciclo`: the chain returns to a category already on it;
 *  - `profundidade`: deeper than {@link PROFUNDIDADE_MAX_CATEGORIA_LI}.
 */
export const motivoCadeiaCategoriaLiSchema = z.enum([
  'ausente',
  'pai-ilegivel',
  'pai-ausente',
  'ciclo',
  'profundidade',
]);
export type MotivoCadeiaCategoriaLi = z.infer<typeof motivoCadeiaCategoriaLiSchema>;

/** Named members of {@link motivoCadeiaCategoriaLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_CADEIA_CATEGORIA_LI = {
  ausente: 'ausente',
  paiIlegivel: 'pai-ilegivel',
  paiAusente: 'pai-ausente',
  ciclo: 'ciclo',
  profundidade: 'profundidade',
} as const satisfies Record<string, MotivoCadeiaCategoriaLi>;

/** A category's chain: its ids from the ROOT down to itself, or the reason it is refused. */
export type CadeiaCategoriaLi =
  | { readonly tipo: 'ok'; readonly ids: readonly number[] }
  | { readonly tipo: 'recusada'; readonly motivo: MotivoCadeiaCategoriaLi };

export interface ArvoreCategoriasLi {
  /** The chain of category `id`, root first. */
  cadeia(id: number): CadeiaCategoriaLi;
  /** The category of `id` as the store listed it, else `null`. */
  categoria(id: number): CategoriaCatalogoLi | null;
}

/** A parent reading that is unusable whatever its form: two rows of one id that disagree. */
const PAI_EM_CONFLITO = Symbol('pai-em-conflito');

function mesmoPai(a: CategoriaCatalogoLi['pai'], b: CategoriaCatalogoLi['pai']): boolean {
  if (a.tipo !== b.tipo) return false;
  return (
    a.tipo !== TIPO_PAI_CATEGORIA_LI.id || b.tipo !== TIPO_PAI_CATEGORIA_LI.id || a.id === b.id
  );
}

/**
 * The tree of a store's category list (step 10's projection, in the store's order, which is NOT
 * relied on: a parent may come after its child). A list paged under concurrent edits can repeat a
 * row: an id listed twice with the same parent is one category; with two different parents it is
 * refused (`pai-ilegivel`) wherever a chain goes through it.
 */
export function arvoreCategoriasLi(categorias: readonly CategoriaCatalogoLi[]): ArvoreCategoriasLi {
  const porId = new Map<number, CategoriaCatalogoLi | typeof PAI_EM_CONFLITO>();
  for (const c of categorias) {
    const ja = porId.get(c.id);
    if (ja === undefined) porId.set(c.id, c);
    else if (ja !== PAI_EM_CONFLITO && !mesmoPai(ja.pai, c.pai)) porId.set(c.id, PAI_EM_CONFLITO);
  }

  const recusada = (motivo: MotivoCadeiaCategoriaLi): CadeiaCategoriaLi => ({
    tipo: 'recusada',
    motivo,
  });

  return {
    categoria(id) {
      const c = porId.get(id);
      return c === undefined || c === PAI_EM_CONFLITO ? null : c;
    },
    cadeia(id) {
      if (!porId.has(id)) return recusada(MOTIVO_CADEIA_CATEGORIA_LI.ausente);
      const subida: number[] = [];
      const vistos = new Set<number>();
      let atual = id;
      for (;;) {
        if (vistos.has(atual)) return recusada(MOTIVO_CADEIA_CATEGORIA_LI.ciclo);
        vistos.add(atual);
        subida.push(atual);
        if (subida.length > PROFUNDIDADE_MAX_CATEGORIA_LI) {
          return recusada(MOTIVO_CADEIA_CATEGORIA_LI.profundidade);
        }
        const c = porId.get(atual);
        if (c === undefined) return recusada(MOTIVO_CADEIA_CATEGORIA_LI.paiAusente);
        if (c === PAI_EM_CONFLITO) return recusada(MOTIVO_CADEIA_CATEGORIA_LI.paiIlegivel);
        if (c.pai.tipo === TIPO_PAI_CATEGORIA_LI.raiz) return { tipo: 'ok', ids: subida.reverse() };
        if (c.pai.tipo === TIPO_PAI_CATEGORIA_LI.ilegivel) {
          return recusada(MOTIVO_CADEIA_CATEGORIA_LI.paiIlegivel);
        }
        atual = c.pai.id;
      }
    },
  };
}

/** The leaf a product's categories resolve to — see {@link folhaDoProdutoLi}. */
export type FolhaDoProdutoLi =
  | { readonly tipo: 'folha'; readonly id: number; readonly vinculada: boolean }
  | { readonly tipo: 'nenhuma' }
  | { readonly tipo: 'ambigua'; readonly ids: readonly number[] }
  | { readonly tipo: 'ilegivel'; readonly uris: number }
  /** The product's categories that sit ON a parent cycle, ascending. */
  | { readonly tipo: 'ciclo'; readonly ids: readonly number[] };

/**
 * The ancestors of `id` the tree can name (a refused chain still names those below the break),
 * and whether the walk came back to `id` itself — `id` sits ON a parent cycle. `id` is never its
 * own ancestor. Not bounded by depth: every step adds an id or stops, so it ends on any list, and a
 * long cycle is still seen as one.
 */
function ancestrais(arvore: ArvoreCategoriasLi, id: number): { ids: Set<number>; ciclo: boolean } {
  const ids = new Set<number>();
  let c = arvore.categoria(id);
  while (c !== null && c.pai.tipo === TIPO_PAI_CATEGORIA_LI.id) {
    if (c.pai.id === id) return { ids, ciclo: true };
    if (ids.has(c.pai.id)) break;
    ids.add(c.pai.id);
    c = arvore.categoria(c.pai.id);
  }
  return { ids, ciclo: false };
}

/**
 * THE category a product gets, from its `categorias` URIs, under the linked-leaf rule.
 *
 * The LEAVES are the product's categories that are no other of its categories' ancestor (a
 * product listed under `A`, `A > B` and `A > B > C` has the one leaf `C`). Then:
 *  - exactly ONE leaf linked for this conta ⇒ that leaf (a product often also sits in a promotion
 *    branch: the branch the operator linked wins);
 *  - NO leaf linked and exactly one leaf ⇒ that leaf, unlinked (created under "create and link",
 *    else reported);
 *  - two or more linked, or none linked with two or more leaves ⇒ `ambigua`: no category, never a
 *    guess;
 *  - no category at all ⇒ `nenhuma`;
 *  - any URI that does not read as a category ⇒ `ilegivel`: the leaf could be the unreadable one,
 *    so no leaf is picked;
 *  - any of the product's categories sitting ON a parent cycle ⇒ `ciclo`: such a category is
 *    above and below its cycle-mates at once, so "no other's ancestor" cannot place it, and no
 *    leaf is picked — not even a linked one elsewhere (the import refuses the category, motivo
 *    `ciclo`). A category merely BELOW a cycle is not on it: it can be the leaf, and its chain
 *    read refuses it.
 */
export function folhaDoProdutoLi(
  uris: readonly unknown[],
  arvore: ArvoreCategoriasLi,
  estaVinculada: (id: number) => boolean,
): FolhaDoProdutoLi {
  const ids: number[] = [];
  let ilegiveis = 0;
  for (const uri of uris) {
    const id = idDoRecursoLi(uri, RECURSO_URI_LI.categoria);
    if (id === null) ilegiveis += 1;
    else if (!ids.includes(id)) ids.push(id);
  }
  if (ilegiveis > 0) return { tipo: 'ilegivel', uris: ilegiveis };
  if (ids.length === 0) return { tipo: 'nenhuma' };

  const deAlguem = new Set<number>();
  const emCiclo: number[] = [];
  for (const id of ids) {
    const subida = ancestrais(arvore, id);
    if (subida.ciclo) emCiclo.push(id);
    for (const a of subida.ids) deAlguem.add(a);
  }
  if (emCiclo.length > 0) return { tipo: 'ciclo', ids: emCiclo.sort((a, b) => a - b) };
  const folhas = ids.filter((id) => !deAlguem.has(id));

  const vinculadas = folhas.filter((id) => estaVinculada(id));
  if (vinculadas.length === 1) return { tipo: 'folha', id: vinculadas[0]!, vinculada: true };
  if (vinculadas.length === 0 && folhas.length === 1) {
    return { tipo: 'folha', id: folhas[0]!, vinculada: false };
  }
  return { tipo: 'ambigua', ids: vinculadas.length > 1 ? vinculadas : folhas };
}
