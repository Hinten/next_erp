import type { Foto } from '../../storage/foto';
import { parseFakePath } from './variacoes';

/**
 * Which photos belong to a variation child — the per-variant gallery resolution.
 *
 * Port of Flutter's `Produto.getFotosForVariacao`
 * (`.old/packages/produtos/lib/src/models.dart:1023-1053`) and its three-rung
 * fallback, which is what makes a per-variant gallery degrade into the parent's:
 *
 *  1. the child's OWN `fotos`, when it has any;
 *  2. the parent photos tagged for one of the child's `variacoesUid`;
 *  3. failing both, EVERY parent photo.
 *
 * Rung 3 is why this cannot simply be "the tagged ones": ML requires every
 * variation to carry at least one picture, so an untagged catalogue still has to
 * publish something.
 *
 * Two deliberate divergences from the Dart, both narrowing:
 *
 *  - **De-duped, in parent order.** The legacy loops per `variacoesUid` and
 *    concatenates the matches of each, so a photo matching two of the child's
 *    uids is emitted twice — a repeated `picture_id` on the wire. One pass over
 *    the parent array drops the duplicate and keeps the operator's chosen
 *    display order (`fotoSchema` has no `ordem`; position IS the order).
 *  - **The grupo is compared too.** `Foto2.ehAMesmaVariacao` (models.dart:3556)
 *    compares the last two path segments, and the second of those is the literal
 *    `variacoes` — so it effectively matches on the variante id ALONE. Two
 *    groups that both hold an `n-azul` variante (the ML importer's slug
 *    fallback, `taxonomiaCore.ts:284`) would cross-match and put the wrong photo
 *    on a variation. Both sides are built by the same `varianteFakePath`, so
 *    requiring the grupo to agree cannot lose a legitimate match.
 *
 * An untagged photo (`variantePath: null`) never matches a uid, so it reaches a
 * variation only through rung 3 — the legacy's `variacaoPath == null` branch,
 * which no caller here exercises.
 */
export function fotosForVariacao(
  ownFotos: readonly Foto[] | null | undefined,
  parentFotos: readonly Foto[] | null | undefined,
  variacoesUid: readonly string[] | null | undefined,
): Foto[] {
  if (ownFotos?.length) return [...ownFotos];

  const parent = parentFotos ?? [];
  if (parent.length === 0) return [];

  const wanted = new Set<string>();
  for (const uid of variacoesUid ?? []) {
    const parsed = parseFakePath(uid);
    if (parsed) wanted.add(varianteKey(parsed.grupoId, parsed.varianteId));
  }
  if (wanted.size === 0) return [...parent];

  const matched = parent.filter((foto) => {
    if (typeof foto.variantePath !== 'string') return false;
    const parsed = parseFakePath(foto.variantePath);
    return parsed != null && wanted.has(varianteKey(parsed.grupoId, parsed.varianteId));
  });

  return matched.length > 0 ? matched : [...parent];
}

function varianteKey(grupoId: string, varianteId: string): string {
  return `${grupoId}/${varianteId}`;
}
