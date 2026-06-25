import { z } from 'zod';
import { idRefSchema, outerRefSchema } from '../outerRef';
import { ARQUIVOS_COLLECTION } from './arquivo';
import { derivativeArquivoId, productArquivoId } from './storagePaths';

/**
 * The `Foto`-compatible reference fields for a product photo. Each value is a
 * plain `arquivos/<id>` document path string — the exact wire shape the Flutter
 * `Foto2` model reads (`json['arquivoOuterRef'] as String`). Derivative ids are
 * deterministic, so these can be written **optimistically** at upload time; the
 * resize Cloud Function later creates the derivative `Arquivo` docs at those
 * ids.
 *
 * This lives in `@delfrance/schemas` (next to the Produto schema) because it is
 * a Produto wire-shape concern, not an upload concern.
 */
export interface FotoRefs {
  arquivoOuterRef: string;
  arquivo200pxOuterRef: string;
  arquivo400pxOuterRef: string;
  arquivoJpegOuterRef: string;
}

/** Build the optimistic `Foto` ref strings for a product's original `hash`. */
export function buildFotoRefs(produtoId: string, hash: string): FotoRefs {
  const ref = (id: string) => `${ARQUIVOS_COLLECTION}/${id}`;
  return {
    arquivoOuterRef: ref(productArquivoId(produtoId, hash)),
    arquivo200pxOuterRef: ref(derivativeArquivoId(produtoId, hash, '200')),
    arquivo400pxOuterRef: ref(derivativeArquivoId(produtoId, hash, '400')),
    arquivoJpegOuterRef: ref(derivativeArquivoId(produtoId, hash, 'jpeg')),
  };
}

/**
 * A product photo, embedded as an element of `Produto.fotos`. Mirrors the
 * Flutter `Foto2` wire shape (`packages/produtos/lib/src/models.dart` ->
 * `_$Foto2ToJson`): every `*OuterRef` is a plain `arquivos/<id>` document-path
 * **string** (the generated ODM reads `json['arquivoOuterRef'] as String`),
 * and there is **no `ordem`** field — display order is the array position.
 *
 * `arquivoOuterRef` (the uploaded original) is required; the resize-derived
 * refs are nullable because the resize Cloud Function fills them in
 * asynchronously after the upload finalizes. `grupoDeVariacoesOuterRef` /
 * `variantePath` scope a photo to a specific variation (per-variant galleries).
 * `.passthrough()` keeps any extra fields the Flutter app may write. Build the
 * refs with `buildFotoRefs`.
 */
export const fotoSchema = z
  .object({
    arquivoOuterRef: idRefSchema,
    arquivo200pxOuterRef: idRefSchema.nullable().default(null),
    arquivo400pxOuterRef: idRefSchema.nullable().default(null),
    arquivoJpegOuterRef: idRefSchema.nullable().default(null),
    grupoDeVariacoesOuterRef: outerRefSchema.nullable().default(null),
    variantePath: z.string().nullable().default(null),
  })
  .passthrough();

export type Foto = z.infer<typeof fotoSchema>;

/**
 * Collect the bare `<id>` of every `arquivos/<id>` a produto's photos own, for
 * the `produto.fotosArquivosIds` denorm — mirror of the Flutter `Produto.save()`
 * derivation (`models.dart:2022-2026`): the original + the 200px/400px
 * derivative refs, deduped, with the `arquivos/` prefix stripped to the bare id.
 *
 * This denorm is a **coexistence cache** for the legacy Flutter deletion guard;
 * the new arquivo-orphan architecture tracks references via each foto's
 * `arquivoOuterRef` directly (plus the `onArquivoDeleted` derivative cascade), so
 * it does not read this field. The jpeg derivative is intentionally **excluded**
 * to match the legacy wire shape — the cascade frees it via the original anyway.
 */
export function deriveFotosArquivosIds(fotos: readonly Foto[] | null | undefined): string[] {
  const prefix = `${ARQUIVOS_COLLECTION}/`;
  const ids = new Set<string>();
  for (const foto of fotos ?? []) {
    for (const ref of [
      foto.arquivoOuterRef,
      foto.arquivo200pxOuterRef,
      foto.arquivo400pxOuterRef,
    ]) {
      if (typeof ref !== 'string') continue;
      const id = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
      if (id !== '') ids.add(id); // skip a bare `arquivos/` (would yield an empty id)
    }
  }
  return [...ids];
}
