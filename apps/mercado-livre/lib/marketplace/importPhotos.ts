/**
 * Photo import (ML→ERP) — issue #439. Downloads a Mercado Livre listing's photos
 * into Firebase Storage, creates the `Arquivo` docs (via the local Admin
 * `putArquivoAdmin`), and appends them to the produto's `fotos`. The reverse of
 * the publish-side picture cache (`publish.ts` `resolveOnePicture`).
 *
 * Behavior (Lucas):
 *  - **Additive**: a picture whose ML `id` is already cached on one of the
 *    produto's existing photos (its `Arquivo.externalIds` for this integração) is
 *    SKIPPED — we never re-download or overwrite an existing photo.
 *  - **High quality**: `highResPictureUrl` fetches the `-F` max variant, not the
 *    low-res rendition ML sends in the item payload.
 *  - Content-addressed + `resizeState: 'pending'` → the deployed resize function
 *    generates the 200/400/jpeg thumbnails (no image processing here).
 *  - **Best-effort**: a picture-level failure (unreachable / non-2xx / non-image)
 *    is skipped and logged; infra failures (Storage/Firestore) propagate so the
 *    import fails and is retried.
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { highResPictureUrl } from '@delfrance/integrations-mercado-livre';
import {
  type Foto,
  buildFotoRefs,
  deriveFotosArquivosIds,
  filetypeFromMime,
  normalizeContentType,
  productArquivoId,
  productOriginalPath,
  toOuterRef,
} from '@delfrance/schemas';
import { arquivoCollection, produtoCollection } from '@delfrance/data/admin/collections';

import { type Bucket, putArquivoAdmin } from './arquivoUpload';
import { refMatchesIntegracao } from './linkRefs';

export interface PhotoImportDeps {
  db: Firestore;
  bucket: Bucket;
  integracaoId: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

/** The subset of an ML `pictures[]` entry the importer reads. */
export interface MlPicture {
  id?: string | null;
  url?: string | null;
  secure_url?: string | null;
}

export interface PhotoImportResult {
  imported: number;
  skipped: number;
  failed: number;
}

/** A picture-level problem (bad/unreachable image) — skip it, keep importing. */
export class PictureDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PictureDownloadError';
  }
}

const ARQUIVOS_PREFIX = 'arquivos/';

/** ML serves listing images from `*.mlstatic.com` (e.g. `http2.mlstatic.com`). */
const MLSTATIC_HOST = /(^|\.)mlstatic\.com$/i;

/**
 * Guard the picture URL before the server-side fetch (defense-in-depth vs SSRF):
 * only the ML CDN host is allowed, and the scheme is forced to `https`
 * (`.url` may be `http`; `.secure_url` is preferred but this covers the fallback).
 * Throws `PictureDownloadError` (→ skipped) for anything else.
 */
function safeMlstaticUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    if (err instanceof TypeError)
      throw new PictureDownloadError(`URL de imagem inválida: ${rawUrl}`);
    throw err;
  }
  if (!MLSTATIC_HOST.test(parsed.hostname)) {
    throw new PictureDownloadError(`host de imagem não permitido: ${parsed.host}`);
  }
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:'; // mlstatic serves both — force TLS
  } else if (parsed.protocol !== 'https:') {
    throw new PictureDownloadError(`esquema de URL não permitido: ${parsed.protocol}`);
  }
  return parsed.toString();
}

/** mlstatic photos are JPEG/PNG/WEBP/GIF — enough to name the content-addressed object. */
const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export async function importProdutoPhotos(
  deps: PhotoImportDeps,
  produtoId: string,
  pictures: ReadonlyArray<MlPicture>,
): Promise<PhotoImportResult> {
  const { db, integracaoId } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;

  const alreadyImported = await collectImportedPictureIds(db, produtoId, integracaoId);

  const newFotos: Foto[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const pic of pictures) {
    const picId = typeof pic.id === 'string' && pic.id.length > 0 ? pic.id : null;
    if (picId && alreadyImported.has(picId)) {
      skipped += 1;
      continue;
    }
    const url = highResPictureUrl(pic);
    if (!url) {
      skipped += 1;
      continue;
    }
    try {
      newFotos.push(await importOnePicture(deps, doFetch, produtoId, url, picId));
      imported += 1;
    } catch (err) {
      // Picture-level problem → skip it and move on. Infra errors (admin Storage /
      // Firestore) are NOT PictureDownloadError/TypeError → they propagate and fail
      // the import (retryable). A fetch network failure surfaces as a TypeError.
      if (err instanceof PictureDownloadError || err instanceof TypeError) {
        console.warn('[mercado-livre] skipping a picture that failed to import', {
          produtoId,
          picId,
          url,
          cause: err.message,
        });
        failed += 1;
        continue;
      }
      throw err;
    }
  }

  if (newFotos.length > 0) {
    // arrayUnion so a concurrent Flutter photo append isn't dropped (dual-run).
    await produtoCollection.docRef(db, {}, produtoId).update({
      fotos: FieldValue.arrayUnion(...newFotos),
      fotosArquivosIds: FieldValue.arrayUnion(...deriveFotosArquivosIds(newFotos)),
    });
  }

  return { imported, skipped, failed };
}

/* -------------------------------------------------------------------------- */

async function importOnePicture(
  deps: PhotoImportDeps,
  doFetch: typeof globalThis.fetch,
  produtoId: string,
  url: string,
  picId: string | null,
): Promise<Foto> {
  const safeUrl = safeMlstaticUrl(url); // SSRF guard: mlstatic host + https only
  const res = await doFetch(safeUrl);
  if (!res.ok) throw new PictureDownloadError(`HTTP ${res.status} baixando ${safeUrl}`);
  const contentType = normalizeContentType(res.headers.get('content-type') ?? '');
  if (!contentType.startsWith('image/')) {
    throw new PictureDownloadError(`content-type inesperado "${contentType}" em ${url}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha512').update(bytes).digest('hex');
  const ext = IMAGE_EXT[contentType] ?? null;

  await putArquivoAdmin({
    db: deps.db,
    bucket: deps.bucket,
    docId: productArquivoId(produtoId, hash),
    storagePath: productOriginalPath(produtoId, hash, ext),
    bytes,
    contentType,
    filetype: filetypeFromMime(contentType),
    resizeState: 'pending',
    externalIds: picId
      ? [{ externalId: picId, integracaoPath: toOuterRef(`integracao/${deps.integracaoId}`) }]
      : [],
  });

  return {
    ...buildFotoRefs(produtoId, hash),
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  };
}

/**
 * The set of ML picture ids already imported for this integração — resolve each of
 * the produto's current `fotos` to its `Arquivo` and collect the `externalIds`
 * whose `integracaoPath` matches. The additive-dedup guard (skip re-download).
 */
async function collectImportedPictureIds(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): Promise<Set<string>> {
  const snap = await produtoCollection.docRef(db, {}, produtoId).get();
  const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : {};
  const fotos = Array.isArray(raw.fotos) ? (raw.fotos as Array<Record<string, unknown>>) : [];

  const arquivoIds = new Set<string>();
  for (const foto of fotos) {
    const ref = foto?.arquivoOuterRef;
    if (typeof ref !== 'string') continue;
    const id = ref.startsWith(ARQUIVOS_PREFIX) ? ref.slice(ARQUIVOS_PREFIX.length) : ref;
    if (id) arquivoIds.add(id);
  }

  const imported = new Set<string>();
  await Promise.all(
    [...arquivoIds].map(async (id) => {
      const asnap = await arquivoCollection.docRef(db, {}, id).get();
      if (!asnap.exists) return;
      const ext = (asnap.data() as Record<string, unknown> | undefined)?.externalIds;
      if (!Array.isArray(ext)) return;
      for (const e of ext as Array<Record<string, unknown>>) {
        if (
          refMatchesIntegracao(e.integracaoPath, integracaoId) &&
          typeof e.externalId === 'string'
        ) {
          imported.add(e.externalId);
        }
      }
    }),
  );
  return imported;
}
