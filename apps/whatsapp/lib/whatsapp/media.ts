/**
 * WhatsApp inbound media cache — port of `getAndUploadMedia`
 * (`.old/.../whatsapp_cloud_api/lib/src/notificacoes/messages.dart:164`).
 * Downloads a Meta media object by its media id and persists it as an `Arquivo`
 * via the shared create-first Admin uploader (`@delfrance/storage/admin`,
 * extracted in TASK B), returning the `Arquivo` outer-ref string the
 * `mensagemSchema` media sub-objects (`image`/`video`/`audio`/`sticker`/
 * `genericDocument`, and `anexoStorage`) carry.
 *
 * Dedup: the arquivo doc id is deterministic (`wa_<mediaId>`), so a redelivered
 * webhook — or two media fields pointing at the same id — resolves to the same
 * doc. A cache hit (doc already carries a `url`) short-circuits BEFORE any Graph
 * call, so there is no re-`getMediaData`, no re-download, and no re-upload.
 *
 * Ref format: legacy serialized the media `OuterRefField` as `pathWithDocuments`
 * (`documents/arquivos/<id>`); `toOuterRef` produces exactly that canonical
 * form, which the loose `mensagemSchema` media fields accept and the Flutter
 * reader (`DocumentId.fromPathPrependDocuments`) round-trips.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import { filetypeFromMime, toOuterRef } from '@delfrance/schemas';
import { type Bucket, putArquivoAdmin } from '@delfrance/storage/admin';
import type { WhatsAppClient } from '@delfrance/integrations-whatsapp-cloud-api';

/** Everything `getAndUploadMedia` needs beyond the media id itself. */
export interface MediaCacheContext {
  readonly db: Firestore;
  readonly bucket: Bucket;
  /** Client bound to the owning account's number + token (Graph media API). */
  readonly client: WhatsAppClient;
  /** The `integracao` account id — the `whatsapp/<contaId>/<mediaId>` prefix. */
  readonly contaId: string;
}

/** The content-addressed-by-media-id arquivo doc id. */
function arquivoDocId(mediaId: string): string {
  return `wa_${mediaId}`;
}

/** `documents/arquivos/<docId>` — the media outer-ref stored on a mensagem. */
function arquivoRef(docId: string): string {
  return toOuterRef(`arquivos/${docId}`);
}

/**
 * Download + cache a WhatsApp media object, returning its `Arquivo` outer ref.
 *
 * @param ctx     db / bucket / client / contaId.
 * @param mediaId the Meta media id (from an inbound message's
 *                `image`/`video`/`audio`/`document`/`sticker` field).
 */
export async function getAndUploadMedia(ctx: MediaCacheContext, mediaId: string): Promise<string> {
  const docId = arquivoDocId(mediaId);

  // Cache hit: the arquivo doc already carries a `url` → bytes are in Storage.
  // Return without touching the Graph API (no re-download, no re-upload). This
  // is the deterministic-id equivalent of legacy's `filename+filepath` lookup.
  const existing = await arquivoCollection.docRef(ctx.db, {}, docId).get();
  if (existing.exists) {
    const url = (existing.data() ?? {}).url;
    if (typeof url === 'string' && url.length > 0) {
      return arquivoRef(docId);
    }
  }

  // Resolve the short-lived lookaside URL + mime, then download the bytes
  // (both require the account's Bearer token — the client carries it).
  const meta = await ctx.client.getMediaData(mediaId);
  const download = await ctx.client.downloadMedia(meta.url);
  const contentType = download.contentType ?? meta.mime_type;

  await putArquivoAdmin({
    db: ctx.db,
    bucket: ctx.bucket,
    docId,
    storagePath: `whatsapp/${ctx.contaId}/${mediaId}`,
    bytes: download.data,
    contentType,
    filetype: filetypeFromMime(meta.mime_type),
  });

  return arquivoRef(docId);
}
