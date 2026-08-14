import { z } from 'zod';
import { idRefSchema, outerRefSchema } from '../shared/outerRef';
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
  // Nullable: an owner whose photos are not resized has no derivatives — see
  // `buildOriginalFotoRef`. Both resized owners get non-null strings.
  arquivo200pxOuterRef: string | null;
  arquivo400pxOuterRef: string | null;
  arquivoJpegOuterRef: string | null;
}

/**
 * Build the optimistic `Foto` refs from the ORIGINAL's full `arquivos` doc id
 * (`<ownerId>_<hash>`) — the value every upload helper returns.
 *
 * Owner-agnostic, because a derivative id is just the original's id plus the
 * variant suffix. That is what lets tabela-de-medidas photos reuse the produto
 * derivative pipeline wholesale rather than growing a parallel one.
 */
export function buildFotoRefsFromArquivoId(arquivoId: string): FotoRefs {
  const ref = (id: string) => `${ARQUIVOS_COLLECTION}/${id}`;
  return {
    arquivoOuterRef: ref(arquivoId),
    arquivo200pxOuterRef: ref(`${arquivoId}_200`),
    arquivo400pxOuterRef: ref(`${arquivoId}_400`),
    arquivoJpegOuterRef: ref(`${arquivoId}_jpeg`),
  };
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
 * Build `Foto` refs for an original whose derivatives are NOT generated. Only
 * `arquivoOuterRef` points at a real doc; the derivative refs are `null`, so a
 * gallery thumbnail falls back to the original.
 *
 * ⚠️ No owner uses this on the write path any more — tabela de medidas was the
 * last one, and it moved to {@link buildFotoRefsFromArquivoId} when the resize
 * function started watching its prefix. It stays because **stored** fotos
 * written before that change still carry null derivative refs, and readers must
 * keep tolerating them until the backfill runs.
 */
export function buildOriginalFotoRef(arquivoId: string): FotoRefs {
  return {
    arquivoOuterRef: `${ARQUIVOS_COLLECTION}/${arquivoId}`,
    arquivo200pxOuterRef: null,
    arquivo400pxOuterRef: null,
    arquivoJpegOuterRef: null,
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
