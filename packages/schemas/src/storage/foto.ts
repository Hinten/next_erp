import { z } from 'zod';
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
    arquivoOuterRef: z.string().min(1),
    arquivo200pxOuterRef: z.string().nullable().default(null),
    arquivo400pxOuterRef: z.string().nullable().default(null),
    arquivoJpegOuterRef: z.string().nullable().default(null),
    grupoDeVariacoesOuterRef: z.string().nullable().default(null),
    variantePath: z.string().nullable().default(null),
  })
  .passthrough();

export type Foto = z.infer<typeof fotoSchema>;
