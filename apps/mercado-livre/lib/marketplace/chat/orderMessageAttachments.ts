/**
 * Post-sale message attachment cache — the `mlped` sibling of
 * `claimAttachments.ts` (#1162).
 *
 * Until this existed, an attachment arrived as TEXT: `conteudoComAnexos` appended
 * `[1 anexo no Mercado Livre: foto.jpg]` and the operator had to leave the ERP to
 * see it. That note stays as the fallback — silently dropping an attachment is
 * worse than not having it, because the operator reads "segue a foto" with no
 * foto and no sign one was ever sent.
 *
 * Downloads by the attachment's opaque `filename` and persists it as an
 * `Arquivo` through the shared create-first Admin uploader (`putArquivoAdmin`),
 * returning the outer-ref string the attachment `mensagem`'s `anexoStorage`
 * carries.
 *
 * ---- ⚠️ Three ways this is NOT a copy of the claims path.
 *
 *  1. **`site_id` is a required query param** on `GET /messages/attachments/{id}`
 *     — omitting it is a documented 400. The claims endpoint has no such param.
 *     Handled in the API client.
 *  2. **The limits differ**: post-sale is 25 MB and accepts TXT
 *     (`ML_POST_SALE_ANEXO`), against the claim endpoint's 5 MB and no TXT
 *     (`ML_CLAIM_ANEXO`). ⚠️ Both are documentation-only on the DOWNLOAD half —
 *     nothing here validates size, format or count, because ML already enforced
 *     them on the way in and a file it accepted is one we can fetch back. They
 *     are recorded separately so the OUTBOUND direction, where the limits do
 *     gate a write, reaches for the right ones.
 *  3. **ML documents no 404 for this route** — only 400 and 500 — so a
 *     permanently missing file arrives as a **500**. See the disposition below,
 *     which is why that matters.
 *
 * ---- Dedup: the arquivo doc id is `generateUid(contaPath, filename)`, the same
 * formula the claims path uses, applied to the post-sale filename. ML filenames
 * already carry the uploader's user id and a uuid
 * (`<userId>_<uuid>.<ext>`), so they are globally unique per conta — two packs
 * cannot collide. A cache hit (the doc already carries a `url`) short-circuits
 * BEFORE any ML call, so a re-processed pack re-downloads nothing.
 *
 * ---- Failure disposition, copied deliberately from the claims path because it
 * is the part most easily got backwards:
 *
 *  - a **deterministic** upstream failure (`MercadoLivreHttpError`) warns and
 *    skips, so the TEXT mensagem still lands with its `[n anexos]` note;
 *  - a **transient** `MercadoLivreNetworkError` **RETHROWS** — the import is
 *    idempotent, so the Cloud Tasks retry re-lands the whole message, attachment
 *    included.
 *
 * ⚠️ Getting that backwards either loses attachments silently (rethrow → skip) or
 * retry-loops forever on a file ML will never serve (skip → rethrow). Because ML
 * has no 404 here, a permanently-gone attachment surfaces as a 500 and lands in
 * the FIRST branch — deterministic, skipped with a warn — which is the outcome we
 * want, and is pinned by a test rather than left to chance.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import { filetypeFromMime, toOuterRef } from '@delfrance/schemas';
import {
  type MercadoLivreApi,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
} from '@delfrance/integrations-mercado-livre';

import { type Bucket, putArquivoAdmin } from '../core/arquivoUpload';
import { contaPathLegacyMl, generateUid } from '../claims/claimIds';

export interface OrderMessageAttachmentDeps {
  readonly db: Firestore;
  readonly api: MercadoLivreApi;
  readonly bucket: Bucket;
}

export interface OrderMessageAttachmentArgs {
  /** The `integracao` account doc id (the ML conta). */
  readonly contaId: string;
  /** The pack (or order) id the thread is keyed on — used for the Storage path. */
  readonly packId: string;
  /**
   * The ML attachment `filename` — the opaque server-side name
   * (`<userId>_<uuid>.<ext>`), NOT `original_filename`.
   */
  readonly filename: string;
}

export type OrderMessageAttachmentResult =
  | { ok: true; arquivoOuterRef: string }
  | { ok: false; skipped: 'http-error' | 'empty-body' };

/**
 * The arquivo doc id for one post-sale attachment.
 *
 * Same digest formula as the claims path (`generateUid` over the leading-slash
 * conta path), keyed on the ML filename. ⚠️ `contaPathLegacyMl` keeps the LEADING
 * slash — never normalize it through `toOuterRef`.
 */
export function orderMessageAttachmentArquivoId(contaId: string, filename: string): string {
  return generateUid(contaPathLegacyMl(contaId), filename);
}

/**
 * Download + cache one post-sale attachment, returning its `Arquivo` outer ref —
 * or a skip marker when ML will not serve it.
 */
export async function ensureOrderMessageAttachmentArquivo(
  deps: OrderMessageAttachmentDeps,
  args: OrderMessageAttachmentArgs,
): Promise<OrderMessageAttachmentResult> {
  const docId = orderMessageAttachmentArquivoId(args.contaId, args.filename);
  const arquivoOuterRef = toOuterRef(`arquivos/${docId}`);

  // Cache hit: the arquivo doc already carries a `url` → the bytes are in
  // Storage. A stale create-first anchor (`url: null`) is NOT a hit —
  // `putArquivoAdmin` heals it by re-uploading.
  const existing = await arquivoCollection.docRef(deps.db, {}, docId).get();
  if (existing.exists) {
    const url = (existing.data() ?? {}).url;
    if (typeof url === 'string' && url.length > 0) {
      return { ok: true, arquivoOuterRef };
    }
  }

  let download;
  try {
    download = await deps.api.downloadPostSaleAttachment(args.filename);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError) {
      // Deterministic — a retry would fail identically. A 2xx status is the
      // client's empty-body signal (`downloadAnexo` throws it rather than ever
      // returning zero bytes); anything else is ML refusing to serve the file,
      // which for this route includes the 500 it answers for a missing one.
      const emptyBody = err.status >= 200 && err.status < 300;
      console.warn(
        emptyBody
          ? '[mercado-livre] anexo de mensagem pós-venda com corpo vazio — ignorado'
          : '[mercado-livre] anexo de mensagem pós-venda que o ML não serve — ignorado',
        { packId: args.packId, filename: args.filename, status: err.status },
      );
      return { ok: false, skipped: emptyBody ? 'empty-body' : 'http-error' };
    }
    // Transient — the Cloud Tasks retry re-lands the whole message.
    if (err instanceof MercadoLivreNetworkError) throw err;
    throw err;
  }

  const contentType = download.contentType ?? 'application/octet-stream';
  await putArquivoAdmin({
    db: deps.db,
    bucket: deps.bucket,
    docId,
    storagePath: `mercado-livre/${args.contaId}/packs/${args.packId}/${args.filename}`,
    bytes: download.bytes,
    contentType,
    filetype: filetypeFromMime(contentType),
  });

  return { ok: true, arquivoOuterRef };
}
