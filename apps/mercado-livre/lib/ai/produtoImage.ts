/**
 * The one product photo that rides along with an AI suggestion.
 *
 * Two rules, both learned from the legacy:
 *
 *  1. **Bytes, never a URL.** `getUriForAiVision()` handed Vertex a tokened
 *     `firebasestorage.googleapis.com/…?alt=media` HTTPS URL as `FileData.fileUri`
 *     — a field Vertex documents for `gs://` and YouTube only — so the photo was
 *     very likely never seen by the model at all.
 *  2. **A derivative, never the original.** The resize function already writes
 *     200 px and 400 px JPEGs; an original can be many megabytes, and there is
 *     no server-side resize here. When no derivative exists yet (the resize is
 *     asynchronous and may still be `pending`), the suggestion runs **without an
 *     image** rather than shipping a huge original or pulling in an image
 *     library for one optional input.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import type { AiInlineImage } from '@delfrance/integrations-mercado-livre';
import type { Arquivo, Foto } from '@delfrance/schemas';

/**
 * Preference order. 400 px is what the legacy used for vision and is the best
 * detail-per-token trade; 200 px is the fallback when only it has landed.
 * `arquivoOuterRef` (the ORIGINAL) is deliberately absent.
 */
const VARIANT_REFS = ['arquivo400pxOuterRef', 'arquivo200pxOuterRef'] as const;

/**
 * Hard ceiling on what we will base64 and send. A 400 px JPEG is tens of KB, so
 * anything near this is a sign the ref points somewhere unexpected — skip
 * rather than send it.
 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface LoadProdutoImageDeps {
  db: Firestore;
  /** Downloads a Storage object by path. Injected so tests never touch a bucket. */
  download: (storagePath: string) => Promise<Uint8Array>;
}

/**
 * Resolve the first produto photo to inline bytes, or null when there is
 * nothing suitable.
 *
 * Null is a normal outcome, not an error: a produto with no photos, or whose
 * derivatives have not been generated yet, still gets a text-only suggestion.
 */
export async function loadProdutoImage(
  deps: LoadProdutoImageDeps,
  fotos: readonly Foto[] | null | undefined,
): Promise<AiInlineImage | null> {
  const foto = (fotos ?? [])[0];
  if (!foto) return null;

  for (const key of VARIANT_REFS) {
    const ref = foto[key];
    if (!ref) continue;
    const image = await tryLoad(deps, ref);
    if (image) return image;
  }
  return null;
}

async function tryLoad(
  deps: LoadProdutoImageDeps,
  outerRef: string,
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
  // 404 for every produto whose derivative has actually landed — the main case.
  // The join, including the null-directory branch for a root-level object, is
  // the same one `onArquivoDeleted.ts:49` and the orphan sweep already use.
  const objectName = storageObjectName(arquivo);
  if (!objectName) return null;

  // Downloading through the Admin SDK keeps this inside the project — no public
  // URL, no token, no outbound fetch to a value read out of a document.
  const bytes = await deps.download(objectName);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;

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
