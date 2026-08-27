import type { Foto, Produto } from '@delfrance/schemas';

/**
 * Pure resolution of which `arquivos` documents a produto's photo can be
 * rendered from. No React, no Firestore — so the print assembler
 * (`lib/pedido-print/`), the list hooks (`fotoCapa.ts`) and their tests all
 * share ONE ladder instead of the three copies of `idFromRef` that used to sit
 * in `ProdutoThumbnail.tsx`, `fotoCapa.ts` and `pedido-print/model.ts`.
 */

/** Bare `<id>` from a `Foto` ref string (`arquivos/<id>` or `documents/arquivos/<id>`). */
export function arquivoIdFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const segs = ref.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  return last !== undefined && last.length > 0 ? last : null;
}

/** The four `arquivos` documents a single `Foto` can point at. */
export type FotoVariante = '200' | '400' | 'jpeg' | 'original';

/**
 * The ref field holding each variant. An exhaustive `switch` rather than a
 * lookup table because `fotoSchema` is `.passthrough()`, so indexing `Foto` by
 * a computed key widens the value to `unknown` and would need a cast.
 */
function refDaVariante(foto: Foto, variante: FotoVariante): string | null | undefined {
  switch (variante) {
    case '200':
      return foto.arquivo200pxOuterRef;
    case '400':
      return foto.arquivo400pxOuterRef;
    case 'jpeg':
      return foto.arquivoJpegOuterRef;
    case 'original':
      return foto.arquivoOuterRef;
  }
}

/**
 * Thumbnail preference: smallest useful derivative first, the raw upload LAST.
 *
 * ⚠️ The original is a real rung, not a formality. `buildFotoRefs`
 * (`packages/schemas/src/storage/foto.ts`) writes all four refs
 * **optimistically** at upload time — derivative ids are deterministic, so the
 * ref strings exist long before the `resizeProductImage` Cloud Function creates
 * the documents they name, and forever if it never runs. So a `??` chain over
 * the ref STRINGS never falls through: it always picks the first derivative ref
 * and then resolves it to nothing. The fallback has to be on **document
 * existence**, which is what every consumer of this list does.
 */
export const PREFERENCIA_MINIATURA: readonly FotoVariante[] = ['200', '400', 'original'];

/**
 * The `arquivos` ids a foto can be rendered from, best first — ordered by
 * `preference`, deduped, with absent refs dropped. Empty when there is no foto.
 *
 * Legacy fotos written by `buildOriginalFotoRef` carry null derivative refs and
 * yield a single candidate (the original); a modern upload yields three.
 */
export function fotoArquivoIdCandidates(
  foto: Foto | null | undefined,
  preference: readonly FotoVariante[] = PREFERENCIA_MINIATURA,
): string[] {
  if (!foto) return [];
  const ids: string[] = [];
  for (const variante of preference) {
    const id = arquivoIdFromRef(refDaVariante(foto, variante));
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The cover foto's renderable arquivo ids, best first (200 → 400 → original). */
export function coverArquivoIds(
  produto: Pick<Produto, 'fotos'> | null | undefined,
  preference: readonly FotoVariante[] = PREFERENCIA_MINIATURA,
): string[] {
  return fotoArquivoIdCandidates(produto?.fotos?.[0], preference);
}

/**
 * The cover foto's PREFERRED arquivo id, or null when the produto has no photo.
 *
 * ⚠️ Use this for "does this produto have a photo?" only — never for "which
 * document do I read". A produto whose derivatives were never generated still
 * has a non-null id here, and reading only that one is the bug
 * {@link coverArquivoIds} exists to avoid.
 */
export function coverArquivoId(produto: Pick<Produto, 'fotos'> | null | undefined): string | null {
  return coverArquivoIds(produto)[0] ?? null;
}
