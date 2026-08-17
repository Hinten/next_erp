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

/**
 * Which stored image to read. `200`/`400`/`jpeg` mirror `PRODUCT_IMAGE_VARIANTS`;
 * `original` is the raw upload.
 */
export type FotoImageVariant = '200' | '400' | 'jpeg' | 'original';

interface VariantSource {
  /** The `Foto` field holding this variant's `arquivos/<id>` path. */
  ref: keyof Pick<
    Foto,
    'arquivo200pxOuterRef' | 'arquivo400pxOuterRef' | 'arquivoJpegOuterRef' | 'arquivoOuterRef'
  >;
  /**
   * Hard ceiling on what we will base64 and send. Sized to the variant: past it
   * the ref is pointing at something we did not expect, and skipping beats
   * shipping megabytes of it to a billed model call.
   */
  maxBytes: number;
  /**
   * Content types allowed for this variant. Every derivative is a JPEG the
   * resize function produced, so the check is redundant there; the ORIGINAL is
   * whatever the operator uploaded, so it is the reason this field exists.
   */
  allow?: ReadonlySet<string>;
}

const MB = 1024 * 1024;

/**
 * What Vertex accepts as an inline image. HEIC/HEIF matter — that is what
 * phones produce, and a supplier's size table is usually a phone photo.
 */
const ORIGINAL_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/**
 * ⚠️ `original` is offered LAST and only to callers that ask for it.
 *
 * It used to be banned outright, for three reasons — unknown format, unbounded
 * size, possibly unrotated. Each is now a guard rather than a ban, because the
 * ban had a much worse consequence than any of them: **nothing generates
 * derivatives for tabela-de-medidas photos until the `functions:storage` deploy
 * lands and a backfill runs**, so refusing the original meant the size-chart
 * agent could never see a photo at all. The same gap reopens, briefly, for every
 * new upload between the write and the trigger firing.
 *
 * Rotation is accepted deliberately: an unrotated photo is still legible to the
 * model, and refusing one is worse than reading it sideways.
 */
export const FOTO_IMAGE_VARIANTS: Record<FotoImageVariant, VariantSource> = {
  '200': { ref: 'arquivo200pxOuterRef', maxBytes: 2 * MB },
  '400': { ref: 'arquivo400pxOuterRef', maxBytes: 2 * MB },
  jpeg: { ref: 'arquivoJpegOuterRef', maxBytes: 7 * MB },
  original: { ref: 'arquivoOuterRef', maxBytes: 7 * MB, allow: ORIGINAL_CONTENT_TYPES },
};

/**
 * Default order, unchanged from when this only served attribute suggestion:
 * 400 px is the best detail-per-token trade for "what is this product", and
 * 200 px is the fallback when only it has landed.
 *
 * ⚠️ Neither `jpeg` nor `original` is here, and a test asserts it. Appending
 * either would multiply the cost of every attribute suggestion — a full-size
 * photo where a thumbnail answered the question — with nothing failing.
 */
const DEFAULT_PREFERENCE: readonly FotoImageVariant[] = ['400', '200'];

/** How many photos to send when the caller does not say. */
const DEFAULT_MAX_IMAGES = 1;

/**
 * Ceiling on the batch, independent of the per-image ones.
 *
 * Vertex bounds the whole request, so four originals at their individual 7 MB
 * ceiling would pass every per-image check and still fail the call. Stopping
 * early yields fewer photos rather than an error.
 */
const DEFAULT_TOTAL_BYTES = 12 * MB;

export interface LoadFotoImageDeps {
  db: Firestore;
  /** Downloads a Storage object by path. Injected so tests never touch a bucket. */
  download: (storagePath: string) => Promise<Uint8Array>;
}

export interface LoadFotoImageOptions {
  /** Variants to try per photo, best first. Defaults to `['400', '200']`. */
  prefer?: readonly FotoImageVariant[];
  /** How many photos to return at most. Defaults to 1. */
  max?: number;
  /** Shared byte budget across the batch. Defaults to 12 MB. */
  totalBytes?: number;
}

/**
 * Resolve photos to inline bytes, in gallery order, skipping any that cannot be
 * read.
 *
 * An empty result is a normal outcome, not an error: a record with no photos, or
 * one whose photos are all unreadable, still gets a text-only suggestion.
 * ⚠️ Callers must surface how many photos actually made it rather than implying
 * the model saw them all — that difference is exactly what made a silent
 * text-only run look like a broken feature.
 */
export async function loadFotoImages(
  deps: LoadFotoImageDeps,
  fotos: readonly Foto[] | null | undefined,
  options: LoadFotoImageOptions = {},
): Promise<AiInlineImage[]> {
  const prefer = options.prefer ?? DEFAULT_PREFERENCE;
  const max = options.max ?? DEFAULT_MAX_IMAGES;
  let budget = options.totalBytes ?? DEFAULT_TOTAL_BYTES;

  const out: AiInlineImage[] = [];
  for (const foto of fotos ?? []) {
    if (out.length >= max) break;
    for (const variant of prefer) {
      const source = FOTO_IMAGE_VARIANTS[variant];
      const ref = foto[source.ref];
      if (!ref) continue;
      const loaded = await tryLoad(deps, ref, source);
      if (!loaded) continue;
      // Over budget: stop taking photos rather than shipping a request the
      // provider will reject. What we already have is still worth sending.
      if (loaded.bytes > budget) return out;
      budget -= loaded.bytes;
      out.push(loaded.image);
      break;
    }
  }
  return out;
}

/** Single-photo convenience for callers that only ever want one. */
export async function loadFotoImage(
  deps: LoadFotoImageDeps,
  fotos: readonly Foto[] | null | undefined,
  options: LoadFotoImageOptions = {},
): Promise<AiInlineImage | null> {
  const [first] = await loadFotoImages(deps, fotos, { ...options, max: 1 });
  return first ?? null;
}

async function tryLoad(
  deps: LoadFotoImageDeps,
  outerRef: string,
  source: VariantSource,
): Promise<{ image: AiInlineImage; bytes: number } | null> {
  const arquivoId = outerRef.replace(/^.*arquivos\//, '');
  if (!arquivoId) return null;

  const snap = await arquivoCollection.docRef(deps.db, {}, arquivoId).get();
  if (!snap.exists) return null; // the resize has not created it yet
  const arquivo = arquivoCollection.parseRead(
    snap.data(),
    arquivoCollection.docPath({}, arquivoId),
  ) as Arquivo;

  // The format gate, and it only bites on the ORIGINAL — every derivative is a
  // JPEG we produced. A PDF or a TIFF uploaded as a "photo" is rejected here
  // rather than by the provider, which would fail the whole suggestion.
  const contentType = arquivo.contentType ?? 'image/jpeg';
  if (source.allow && !source.allow.has(contentType.toLowerCase())) return null;

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
  if (bytes.byteLength === 0 || bytes.byteLength > source.maxBytes) return null;

  return {
    image: { base64: Buffer.from(bytes).toString('base64'), mimeType: contentType },
    bytes: bytes.byteLength,
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
