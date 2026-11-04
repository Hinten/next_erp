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
 * {@link ehEntradaShopeeDaChave} and {@link resolverEntradaShopeeDoGrupo} are
 * the ONE answer to "which element is THE entry of this (conta, LEAF category)
 * pair". Three callers read it: the publisher's tier builder
 * (`apps/shopee/lib/shopee/anuncios/tiersPublicacao.ts`), the import's merge
 * (`apps/shopee/lib/shopee/produtos/taxonomiaShopeeCore.ts`) and the web's
 * binding editor on `/variacoes` (P14). Before #1911 the first two spelled
 * the key twice and disagreed: the publisher matched the conta by its last
 * path segment, the import byte-exact. So a path-form stored id was a binding
 * for the publisher and a stranger for the import, which then appended a twin
 * entry that the publisher never read (first match wins). That is the #1369
 * shape, and it is why both callers now import the key from here.
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
 * Is this `linksVariacoesShopee[]` element the entry of the pair
 * (`integracaoId`, `categoryId`)?
 *
 * It answers yes when `category_id` is EXACTLY `categoryId` and the conta named
 * by `integracaoShopeeId` is `integracaoId`, read through `idDoRef` (fold (1) of
 * `./vinculosShopee`).
 *
 * The scope of the fold, pinned both ways in `shopeeLinkVariacoes.test.ts`:
 *  - EQUAL: the bare id `int-1` and every path form whose last segment is
 *    `int-1` (`documents/integracao/int-1`, `integracao/int-1`, a trailing
 *    `/`). Trap 2 says this schema stores whatever string it is given, so a
 *    migrated entry may still hold a path. Folding it here is what lets both
 *    callers bind it without a migration.
 *  - DISTINCT: `int-12` against `int-1` and the reverse (the whole segment is
 *    compared, never a prefix, suffix or substring); a different case or any
 *    whitespace (`idDoRef` keeps both); a blank, absent or non-string id; a
 *    category that is a different number, a numeric STRING, or absent.
 *  - Recorded widening, the same one fold (1) records: only the last segment is
 *    compared, so a path into another collection whose last segment happened
 *    to be the integração id would match. Nothing writes such a value.
 *
 * ⚠️ Only the STORED side is folded. `integracaoId` is the bare integração doc
 * id, compared as given: a caller holding a path must pass `idDoRef(path)`. An
 * empty `integracaoId` matches nothing, because `idDoRef` never answers `''`.
 *
 * Structural and total, like `vinculoShopeeEhDaConta`: it reads a parsed
 * {@link LinkVariacoesShopee} and an unvalidated element the same way, which is
 * what lets {@link resolverEntradaShopeeDoGrupo} ask the same question of an
 * element its schema refused.
 */
export function ehEntradaShopeeDaChave(
  e: { readonly category_id?: unknown; readonly integracaoShopeeId?: unknown },
  integracaoId: string,
  categoryId: number,
): boolean {
  return e.category_id === categoryId && idDoRef(e.integracaoShopeeId) === integracaoId;
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

/** The fields one refused parse names: dotted paths, in issue order. */
function camposRecusados(erro: z.ZodError): string[] {
  const campos: string[] = [];
  for (const issue of erro.issues) {
    const caminho = issue.path.map((p) => String(p)).join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const chave of issue.keys) campos.push(caminho === '' ? chave : `${caminho}.${chave}`);
    } else {
      campos.push(caminho);
    }
  }
  return campos;
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
