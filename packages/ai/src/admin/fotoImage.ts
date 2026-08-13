/**
 * The one photo that rides along with an AI suggestion.
 *
 * Two rules, both learned from the legacy:
 *
 *  1. **Bytes, never a URL.** `getUriForAiVision()` handed Vertex a tokened
 *     `firebasestorage.googleapis.com/…?alt=media` HTTPS URL as `FileData.fileUri`
 *     — a field Vertex documents for `gs://` and YouTube only — so the photo was
 *     very likely never seen by the model at all.
 *  2. **A derivative, never the raw original.** `arquivoOuterRef` is whatever the
 *     operator uploaded: it may be HEIC, a 40 MB PNG, or sideways. Every
 *     derivative is a JPEG the resize function already produced, auto-rotated
 *     and re-encoded at quality 82.
 *
 * ## Which derivative, and why the caller chooses
 *
 * The two agents want opposite things, so the preference order is a parameter
 * rather than a constant:
 *
 *  - **Attribute suggestion** wants `400` — it is looking at a photo of a shirt
 *     to decide "sleeve: short", and a thumbnail answers that for a fraction of
 *     the tokens.
 *  - **Measurement extraction** wants `jpeg` — it is reading digits off a
 *     supplier's size table, and 400 px cannot resolve them. That variant is
 *     `{ key: 'jpeg', width: null }` in `PRODUCT_IMAGE_VARIANTS`: full
 *     resolution, no downscale, just a normalised re-encode.
 *
 * Hence the per-variant byte ceiling below — a 400 px JPEG is tens of KB, so
 * anything near 2 MB means the ref points somewhere unexpected; a full-size one
 * legitimately reaches a few MB.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import type { Arquivo, Foto } from '@delfrance/schemas';

import type { AiInlineImage } from '../prompt';

/** Which derivative to read. Mirrors `PRODUCT_IMAGE_VARIANTS`' keys. */
export type FotoImageVariant = '200' | '400' | 'jpeg';

interface VariantSource {
  /** The `Foto` field holding this variant's `arquivos/<id>` path. */
  ref: keyof Pick<Foto, 'arquivo200pxOuterRef' | 'arquivo400pxOuterRef' | 'arquivoJpegOuterRef'>;
  /**
   * Hard ceiling on what we will base64 and send. Sized to the variant: past it
   * the ref is pointing at something we did not expect, and skipping beats
   * shipping megabytes of it to a billed model call.
   */
  maxBytes: number;
}

const MB = 1024 * 1024;

/**
 * ⚠️ `arquivoOuterRef` (the raw original) is deliberately absent — see the
 * header. Adding it here would let an unconverted HEIC reach the model, which
 * Vertex rejects, and a 40 MB upload past every ceiling below.
 */
export const FOTO_IMAGE_VARIANTS: Record<FotoImageVariant, VariantSource> = {
  '200': { ref: 'arquivo200pxOuterRef', maxBytes: 2 * MB },
  '400': { ref: 'arquivo400pxOuterRef', maxBytes: 2 * MB },
  jpeg: { ref: 'arquivoJpegOuterRef', maxBytes: 7 * MB },
};

/**
 * Default order, unchanged from when this only served attribute suggestion:
 * 400 px is the best detail-per-token trade for "what is this product", and
 * 200 px is the fallback when only it has landed.
 */
const DEFAULT_PREFERENCE: readonly FotoImageVariant[] = ['400', '200'];

export interface LoadFotoImageDeps {
  db: Firestore;
  /** Downloads a Storage object by path. Injected so tests never touch a bucket. */
  download: (storagePath: string) => Promise<Uint8Array>;
}

export interface LoadFotoImageOptions {
  /** Variants to try, best first. Defaults to `['400', '200']`. */
  prefer?: readonly FotoImageVariant[];
}

/**
 * Resolve the first photo to inline bytes, or null when there is nothing
 * suitable.
 *
 * Null is a normal outcome, not an error: a record with no photos, or whose
 * derivatives have not been generated yet, still gets a text-only suggestion.
 * ⚠️ That is not a rare path — the resize is asynchronous, and a photo uploaded
 * before its owner was covered by the resize function has no derivatives at all
 * until a backfill runs. Callers must surface "ran without a photo" rather than
 * implying the model saw one.
 */
export async function loadFotoImage(
  deps: LoadFotoImageDeps,
  fotos: readonly Foto[] | null | undefined,
  options: LoadFotoImageOptions = {},
): Promise<AiInlineImage | null> {
  const foto = (fotos ?? [])[0];
  if (!foto) return null;

  for (const variant of options.prefer ?? DEFAULT_PREFERENCE) {
    const source = FOTO_IMAGE_VARIANTS[variant];
    const ref = foto[source.ref];
    if (!ref) continue;
    const image = await tryLoad(deps, ref, source.maxBytes);
    if (image) return image;
  }
  return null;
}

async function tryLoad(
  deps: LoadFotoImageDeps,
  outerRef: string,
  maxBytes: number,
): Promise<AiInlineImage | null> {
  const arquivoId = outerRef.replace(/^.*arquivos\//, '');
  if (!arquivoId) return null;

  const snap = await arquivoCollection.docRef(deps.db, {}, arquivoId).get();
  if (!snap.exists) return null; // the resize has not created it yet
  const arquivo = arquivoCollection.parseRead(
    snap.data(),
    arquivoCollection.docPath({}, arquivoId),
  ) as Arquivo;

  // ⚠️ `filepath` is the Storage **directory**, never the object name —
  // `arquivo.ts:131` says so and both writers agree (`processOriginal.ts` splits
  // an upload into `filepath: path.slice(0, slash)` + `filename`). Downloading
  // `filepath` alone asks the bucket for `produtos/<id>/derivatives`, which is a
  // 404 for every record whose derivative has actually landed — the main case.
  // The join, including the null-directory branch for a root-level object, is
  // the same one `onArquivoDeleted.ts:49` and the orphan sweep already use.
  const objectName = storageObjectName(arquivo);
  if (!objectName) return null;

  // Downloading through the Admin SDK keeps this inside the project — no public
  // URL, no token, no outbound fetch to a value read out of a document.
  const bytes = await deps.download(objectName);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;

  return {
    base64: Buffer.from(bytes).toString('base64'),
    mimeType: arquivo.contentType ?? 'image/jpeg',
  };
}

/**
 * `filepath` (directory) + `filename` (object name), the repo's standard join.
 *
 * A null/blank `filepath` means the object sits at the bucket root, so the
 * filename alone is the object name — not a reason to skip the image.
 */
function storageObjectName(arquivo: Arquivo): string | null {
  const filename = arquivo.filename?.trim();
  if (!filename) return null;
  const dir = arquivo.filepath?.trim();
  return dir ? `${dir}/${filename}` : filename;
}
