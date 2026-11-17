import { z } from 'zod';

import { idDoRef } from './vinculosShopee';

/**
 * The `grupoDeVariacoes.linksVariacoesShopee[]` element — the Flutter
 * `LinkVariacoesShopee` shape, byte for byte
 * (`.old/packages/produtos/lib/src/models.dart:5190-5263`). Step 9 (#1517) is
 * its FIRST non-Flutter author: the array is not per-produto, it hangs on the
 * grupo, one entry per (integração, Shopee category).
 *
 * ⚠️ THREE traps, each a real field of the legacy model:
 *  1. `variation_group_list` is a SCALAR int despite the plural name (the group
 *     id). An array here is a bug, not a shape to tolerate.
 *  2. `integracaoShopeeId` is a BARE doc id — NOT a `documents/integracao/<id>`
 *     outer-ref, unlike every other conta reference in the Shopee models.
 *     Normalising it to a path without a migration orphans every
 *     operator-authored entry, so this schema deliberately neither normalises
 *     nor refuses a stored `documents/…` value: it stores the string it is
 *     given. Only blank is refused.
 *  3. `arakene_variation_id` is a LIST: one Shopee option may map to several
 *     ERP variantes, and the legacy export reader takes `.first` of the
 *     matching options.
 *
 * ⚠️ `0` is a VALUE, not an absence, at both id levels (`announcement 873`,
 * `faq 288` — outside Fashion every tier/option is custom and only the NAMES
 * identify them): the legacy types both ids as non-nullable ints, so `0` is the
 * only expressible "custom". Never refused here, never defaulted away.
 *
 * This schema is wired into `grupoDeVariacoesSchema`; stored mappings reject
 * unknown properties instead of carrying provider-unrelated metadata.
 *
 * ## The binding key (#1911, D12)
 *
 * {@link chaveDaEntradaShopee} spells the key once: the (conta, LEAF category)
 * pair an element names. {@link ehEntradaShopeeDaChave} asks it of one element
 * and {@link resolverEntradaShopeeDoGrupo} of a whole list, and together they
 * are the ONE answer to "which element is THE entry of this (conta, LEAF
 * category) pair". Three callers read it: the publisher's tier builder
 * (`apps/shopee/lib/shopee/anuncios/tiersPublicacao.ts`), the import's merge
 * (`apps/shopee/lib/shopee/produtos/taxonomiaShopeeCore.ts`) and the binding
 * editor on `/variacoes/[id]`
 * (`apps/web/app/(app)/variacoes/_components/vinculadorShopee.ts`). Before
 * #1911 the first two spelled the key twice and disagreed: the publisher
 * matched the conta by its last path segment, the import byte-exact. So a
 * path-form stored id was a binding for the publisher and a stranger for the
 * import, which then appended a twin entry that the publisher never read (first
 * match wins). That is the #1369 shape, and it is why all three import the key
 * from here.
 *
 * ## The tier NAME fold (#1911 batch-A; here since #1911 P14b)
 *
 * {@link nomeDeTierShopee} is the ONE fold of a Shopee tier or option NAME. It
 * moved here from the import's pure core, which re-exports it, so a surface that
 * cannot import `apps/shopee` (the binding editor in `apps/web`) decides "the
 * same name" with the very function the publisher sends and pairs with.
 */

/** One Shopee tier OPTION of a {@link linkVariacoesShopeeSchema} entry. */
export const linkVariacaoOpcaoShopeeSchema = z.strictObject({
  /** `0` = a CUSTOM option; the name is then the only identity it has. */
  shopee_option_id: z.number().int(),
  shopee_option_name: z.string(),
  /** ERP Variante ids — a LIST, bare ids, MANY per option (trap 3). */
  arakene_variation_id: z.array(z.string()),
});
export type LinkVariacaoOpcaoShopee = z.infer<typeof linkVariacaoOpcaoShopeeSchema>;

/** One `(integração, Shopee category)` mapping on a `grupoDeVariacoes` doc. */
export const linkVariacoesShopeeSchema = z.strictObject({
  /** The LEAF category's display name — what the operator picked in the Flutter form. */
  name: z.string(),
  category_id: z.number().int(),
  /** `0` = a CUSTOM variation (trap: `0` is a value, never an absence). */
  variation_id: z.number().int(),
  /** A SCALAR int despite the plural name — the group id (trap 1). */
  variation_group_list: z.number().int(),
  /** A BARE integração doc id, stored verbatim — never an outer-ref path (trap 2). */
  integracaoShopeeId: z.string().min(1),
  variationOptions: z.array(linkVariacaoOpcaoShopeeSchema).default([]),
});
export type LinkVariacoesShopee = z.infer<typeof linkVariacoesShopeeSchema>;

/**
 * The (conta, LEAF category) key this `linksVariacoesShopee[]` element names, or
 * `null` when it names no conta or no category.
 *
 * The conta is `integracaoShopeeId` read through `idDoRef` (fold (1) of
 * `./vinculosShopee`). The category is `category_id` exactly as stored, never
 * coerced.
 *
 * The scope of the fold, pinned both ways in `shopeeLinkVariacoes.test.ts`:
 *  - THE SAME KEY: the bare id `int-1` and every path form whose last segment is
 *    `int-1` (`documents/integracao/int-1`, `integracao/int-1`, a trailing
 *    `/`). Trap 2 says this schema stores whatever string it is given, so a
 *    migrated entry may still hold a path. Folding it here is what lets every
 *    caller bind it without a migration.
 *  - DIFFERENT KEYS: `int-12` against `int-1` and the reverse (the whole segment
 *    is compared, never a prefix, suffix or substring); a different case or any
 *    whitespace (`idDoRef` keeps both); a different category number.
 *  - `null`: a blank, absent or non-string id; a category that is a numeric
 *    STRING, absent, or not finite.
 *  - Recorded widening, the same one fold (1) records: only the last segment is
 *    read, so a path into another collection whose last segment happened to be
 *    the integração id names that conta. Nothing writes such a value.
 *
 * ⚠️ `NaN` and `±Infinity` have `typeof 'number'` and still name no category.
 * The schema refuses all three, `NaN` never equals itself, and `JSON.stringify`
 * writes all three as `null`, which would turn different stored values into one
 * key for the editor that keys its entries by this key's JSON.
 *
 * Structural, like `vinculoShopeeEhDaConta`: it reads a parsed
 * {@link LinkVariacoesShopee} and an unvalidated object the same way, which is
 * what lets {@link resolverEntradaShopeeDoGrupo} ask the same question of an
 * element its schema refused. It takes an object: a raw array element may be
 * anything, so a caller narrows it first.
 */
export function chaveDaEntradaShopee(e: {
  readonly category_id?: unknown;
  readonly integracaoShopeeId?: unknown;
}): { readonly integracaoId: string; readonly categoryId: number } | null {
  const integracaoId = idDoRef(e.integracaoShopeeId);
  const categoryId = e.category_id;
  if (integracaoId === null) return null;
  if (typeof categoryId !== 'number' || !Number.isFinite(categoryId)) return null;
  return { integracaoId, categoryId };
}

/**
 * Is this `linksVariacoesShopee[]` element the entry of the pair
 * (`integracaoId`, `categoryId`)? Yes when {@link chaveDaEntradaShopee} names
 * exactly that pair. The scope of the fold is documented there.
 *
 * ⚠️ Only the STORED side is folded. `integracaoId` is the bare integração doc
 * id, compared as given: a caller holding a path must pass `idDoRef(path)`. An
 * empty `integracaoId` and a non-finite `categoryId` match nothing, because the
 * key never holds either.
 */
export function ehEntradaShopeeDaChave(
  e: { readonly category_id?: unknown; readonly integracaoShopeeId?: unknown },
  integracaoId: string,
  categoryId: number,
): boolean {
  const chave = chaveDaEntradaShopee(e);
  return chave !== null && chave.integracaoId === integracaoId && chave.categoryId === categoryId;
}

/**
 * What a grupo's `linksVariacoesShopee` holds for one (conta, LEAF category)
 * pair. See {@link resolverEntradaShopeeDoGrupo}.
 */
export type ResolucaoEntradaShopeeDoGrupo =
  /** The first element that parses AND names the key. `indice` = its position in the stored array. */
  | {
      readonly tipo: 'armazenada';
      readonly entrada: LinkVariacoesShopee;
      readonly indice: number;
    }
  /**
   * No element that names the key parses, but at least one element names the
   * key and fails {@link linkVariacoesShopeeSchema}. `indice` is the first such
   * element's position. `campos` lists the fields its parse refused, as dotted
   * paths in zod's issue order. An unknown key is named itself, for example
   * `lixo` or `variationOptions.0.lixo`. It is diagnostic text for a message or
   * the editor; no decision reads it.
   */
  | {
      readonly tipo: 'ilegivel';
      readonly indice: number;
      readonly campos: readonly string[];
    }
  /** Nothing names the key: the publisher builds a CUSTOM tier (`variation_id: 0`). */
  | { readonly tipo: 'personalizada-implicita' };

const PERSONALIZADA_IMPLICITA: ResolucaoEntradaShopeeDoGrupo = {
  tipo: 'personalizada-implicita',
};

function ehObjeto(bruto: unknown): bruto is Record<string, unknown> {
  return typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto);
}

/**
 * The fields one refused parse of a `linksVariacoesShopee[]` element names:
 * dotted paths in zod's issue order, each path once. An unknown key is named
 * itself (`lixo`, `variationOptions.0.lixo`). A refusal of the value as a whole
 * (an element that is not an object at all) names no field, so it adds nothing.
 *
 * Diagnostic text, which no decision reads. It is the ONE spelling of the list:
 * {@link resolverEntradaShopeeDoGrupo}'s `ilegivel.campos` and the binding
 * editor's unreadable item both call it, so the two cannot drift apart (#1369).
 * The resolver asks it only of an object, where the strict schema reports each
 * path once and never the value as a whole, so neither rule changes its answer.
 */
export function camposRecusados(erro: z.ZodError): string[] {
  const campos = new Set<string>();
  for (const issue of erro.issues) {
    const caminho = issue.path.map((p) => String(p)).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const chave of issue.keys) campos.add(caminho === '' ? chave : `${caminho}.${chave}`);
    } else if (caminho !== '') {
      campos.add(caminho);
    }
  }
  return [...campos];
}

/**
 * What the grupo holds for the pair (`integracaoId`, `categoryId`). There are
 * three answers, and the publisher builds one tier from each.
 *
 *  1. `armazenada`: the FIRST element that parses and names the key wins. This
 *     is the pre-#1911 publisher's rule, so a twin further down the array is
 *     never read.
 *  2. `ilegivel`: no element that names the key parses, but one that the
 *     schema REFUSES still names it on its raw `category_id` and
 *     `integracaoShopeeId`, through the same predicate. That is the operator's
 *     STANDARD binding, stored broken. The publisher REFUSES it. It must never
 *     fall back to a custom tier, because the fallback would silently replace
 *     the operator's binding with a different variation (DB F3).
 *  3. `personalizada-implicita`: nothing names the key. The publisher builds a
 *     custom tier named after the grupo (D12).
 *
 * The order matters. An unreadable element BEFORE a readable match does not
 * hide the match, because the publisher already skipped unreadable elements
 * before #1911. An element that names no conta (an absent or blank
 * `integracaoShopeeId`) or no category cannot be attributed to this pair. It
 * is therefore not `ilegivel` for this pair, even when it is broken.
 *
 * `links` may be anything. A value that is not a list holds no element, which
 * is what both readers already hand over: `publicarAnuncio.ts` and the
 * import's `lerGrupo` read a non-list as `null`. Pure: no clock, no
 * Firestore, no Shopee.
 */
export function resolverEntradaShopeeDoGrupo(
  links: unknown,
  integracaoId: string,
  categoryId: number,
): ResolucaoEntradaShopeeDoGrupo {
  if (!Array.isArray(links)) return PERSONALIZADA_IMPLICITA;
  let ilegivel: ResolucaoEntradaShopeeDoGrupo | null = null;
  for (let indice = 0; indice < links.length; indice++) {
    const bruto: unknown = links[indice];
    const lido = linkVariacoesShopeeSchema.safeParse(bruto);
    if (lido.success) {
      if (ehEntradaShopeeDaChave(lido.data, integracaoId, categoryId)) {
        return { tipo: 'armazenada', entrada: lido.data, indice };
      }
      continue;
    }
    if (ilegivel === null && ehObjeto(bruto)) {
      if (ehEntradaShopeeDaChave(bruto, integracaoId, categoryId)) {
        ilegivel = { tipo: 'ilegivel', indice, campos: camposRecusados(lido.error) };
      }
    }
  }
  return ilegivel ?? PERSONALIZADA_IMPLICITA;
}

/**
 * THE fold of a Shopee tier NAME or tier-option NAME: the ends trimmed
 * (`String.prototype.trim`, so an NBSP too) and nothing else. ONE function for
 * every side of the wire (#1911 batch-A, the #1369 shape):
 *
 * - the READER: the import's `tiersDoItem`
 *   (`apps/shopee/lib/shopee/produtos/taxonomiaShopeeCore.ts`, which re-exports
 *   this function) reads every live tier and option name through it, so a
 *   listing's names always arrive trimmed;
 * - the PUBLISHER: `apps/shopee/lib/shopee/anuncios/tiersPublicacao.ts` folds
 *   every name it SENDS (`variation_name` and `variation_option_name`, on the
 *   create, the init and the update) and BOTH sides of every name it PAIRS (a
 *   grupo with a live custom tier; a variante, or a stored
 *   `shopee_option_name`, with a live option);
 * - the binding editor on `/variacoes/[id]` (#1911 P14b), which is why it lives
 *   in this package: `apps/web` has no dependency edge to `apps/shopee`, and a
 *   second trim kept equal by a comment is the #1369 smell.
 *
 * So the string sent, the string read back and the string compared are one.
 * Before this, the reader trimmed while the publisher sent and compared
 * `grupo.nome` / `variante.nome` verbatim: a grupo `'Cor '` was refused on every
 * update of the listing its own create had made, and a variante `'Azul '`
 * appended a ghost option on every republish.
 *
 * EQUAL: `'Azul '` ≡ `' Azul'` ≡ `'Azul'` (space, tab, newline, NBSP at the
 * ends); `null`, absent and a non-string ≡ `''`. DISTINCT: case (`'Azul'` vs
 * `'azul'`), inner whitespace (`'Azul Claro'` vs `'Azul  Claro'`) and a
 * zero-width space (U+200B is not whitespace to `trim`). Pinned by
 * `shopeeLinkVariacoes.test.ts` (the pair and its near-miss), by "nomeDeTierShopee
 * — IGUAL: as pontas; DISTINTO: a caixa e o espaço de dentro" in
 * `taxonomiaShopeeCore.test.ts` (through the re-export, which a test there holds
 * to be THIS function) and by the `(2d)` pairs and near-misses of
 * `tiersPublicacao.test.ts`.
 *
 * ⚠️ Not the import's cascades: rung 2 of the import's `planejarTaxonomia`
 * compares a STORED ERP grupo/variante name verbatim against this fold's output
 * (`'Cor '` ≠ `'Cor'` is pinned there), and its option merge (`mesmaOpcao`)
 * compares two stored option names byte-exact. Those are step 9's decisions;
 * #1911 did not change them. The ONE import consumer is rung 1's custom-option
 * arm (#1911 P14a), which reads the stored id-`0` row the publisher pairs a live
 * custom option with — so it folds both sides exactly as the publisher does.
 */
export function nomeDeTierShopee(nome: string | null | undefined): string {
  return typeof nome === 'string' ? nome.trim() : '';
}
