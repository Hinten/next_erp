/**
 * The legacy `generateLocalId` doc-id shape, and its ONE implementation.
 *
 * The Flutter app minted a deterministic Firestore doc id for a variation's
 * produto and its marketplace link by concatenating two ML identifiers into a
 * fixed-width string (`models.dart:1585-1587`, used from `produtos.dart:718,764`):
 *
 * ```
 * XMLB000000000000000<a>vMLB<b>
 * ```
 *
 * The port carries it because the **migrated corpus is keyed on it**: a produto
 * this app re-imports has to land on the document the Flutter app wrote, not
 * beside it. That is the whole reason the shape survives at all.
 *
 * ## Why this is one function rather than four string literals
 *
 * It was four (#1398): the importer built it twice — once for a User-Products
 * member, once for a legacy variation link — publish's adoption built it a third
 * time, and the tests a fourth. Publish and the importer must agree **exactly**
 * or a produto does not survive delete → re-import, which is the #1087 bug; four
 * copies of a format string is not a way to keep that true. The compiler can
 * check one function; a reviewer cannot diff four literals by eye.
 *
 * ## ⚠️ What this unifies, and what it does NOT
 *
 * It unifies the **shape**, and nothing else. The two segments are not the same
 * pair of things at every call site, and that is deliberate:
 *
 * | caller | `a` | `b` |
 * |---|---|---|
 * | importer, User-Products member | the PARENT LINK's doc id | the member's `MLB…` item id |
 * | importer, legacy variation link | the parent's `MLB…` item id | the ML variation id |
 * | publish, adopting a live listing | the PARENT LINK's doc id | the adopted `MLB…` item id |
 *
 * ⚠️ **Publish and the importer converging has never rested on this formula, and
 * still does not.** Publish's `parentLinkDocId` is a random Firestore auto-id on a
 * first publish (`publish.ts:249`) while the importer's is deterministic
 * (`import.ts:349-353`), so the two produce different strings for the same
 * listing. What makes delete → re-import converge is `resolveExistingChild`'s
 * three reuse rules — link, SKU, variation combination — never this. Unifying the
 * shape removes a way for them to drift; it does not create an equality that was
 * never there.
 */

/** `'XMLB'` + 15 zeros — the legacy fixed-width prefix, verbatim. */
const PREFIXO = 'XMLB000000000000000';

/** The separator between the two identifiers. */
const SEPARADOR = 'vMLB';

/**
 * Build a legacy `generateLocalId` doc id from its two segments.
 *
 * ⚠️ Neither segment is validated or normalised. The value has to be
 * byte-identical to whatever the Flutter app wrote, so trimming, casing or
 * rejecting an odd-looking id here would move this app OFF the migrated corpus's
 * documents — the opposite of what the format is for.
 */
export function idLocalMercadoLivre(a: string, b: string): string {
  return `${PREFIXO}${a}${SEPARADOR}${b}`;
}
