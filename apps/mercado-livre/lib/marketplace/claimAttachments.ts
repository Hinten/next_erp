/**
 * Claim-attachment cache for the Mercado Livre claims import (Step 14) — port
 * of the download/upload/skip block of `getClaimMercadoLivre`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:1939-1990`).
 * Downloads a claim message's attachment by its ML `filename` and persists it
 * as an `Arquivo` via the shared create-first Admin uploader
 * (`putArquivoAdmin`), returning the outer-ref string the attachment
 * `mensagem`'s `anexoStorage` carries.
 *
 * Dedup: the arquivo doc id reuses the digest of the attachment MENSAGEM —
 * `generateUid(conta.docId.path, filename)` =
 * `sha256('/documents/integracao/<contaId>-<filename>')` — a NEW deterministic
 * convention, NOT a legacy id. Legacy passed that digest as the upload name
 * (tasks.dart:1962), but `UploadFileManager.fromRequest` silently dropped the
 * arg (storage utils.dart:80-99) and its name pick had an inverted `isEmpty`
 * check (utils.dart:214-216), so real legacy claim Arquivos ended up keyed by
 * sha512(bytes) — a key unreachable here without downloading first.
 * Consequence: the first re-process of a claim the Flutter app imported
 * re-downloads its attachments ONCE into this key and re-points the mensagem;
 * the old sha512-keyed arquivo is left to the orphan sweep. From then on a
 * cache hit (doc already carries a `url`) short-circuits BEFORE any ML call.
 * A stale create-first anchor (`url: null`) is NOT a hit — `putArquivoAdmin`
 * heals it by re-uploading.
 *
 * Failure disposition: legacy swallowed EVERY `getAttachment` error and moved
 * on (tasks.dart:1953-1959). This port narrows that: a DETERMINISTIC upstream
 * failure skips the attachment (warn + `{ ok: false }` so the caller still
 * writes the text mensagem) — a `MercadoLivreHttpError` with a 2xx status is
 * the client's empty-body signal (`downloadClaimAttachment` throws it instead
 * of returning zero bytes) and classifies as `'empty-body'`; any other status
 * (ML serves some historical attachments as permanent 4xx/5xx) is
 * `'http-error'`. A TRANSIENT `MercadoLivreNetworkError` RETHROWS — the claim
 * import is idempotent, so the Cloud Tasks retry re-lands the whole claim,
 * attachment included.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import { filetypeFromMime, toOuterRef } from '@delfrance/schemas';
import {
  type MercadoLivreApi,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
} from '@delfrance/integrations-mercado-livre';

import { type Bucket, putArquivoAdmin } from './arquivoUpload';
import { makeAttachmentMensagemId } from './claimIds';

export interface ClaimAttachmentDeps {
  readonly db: Firestore;
  readonly api: MercadoLivreApi;
  readonly bucket: Bucket;
}

export interface ClaimAttachmentArgs {
  /** The `integracao` account doc id (the ML conta). */
  readonly contaId: string;
  readonly claimId: number;
  /** The ML attachment `filename` (the opaque server-side name, not `original_filename`). */
  readonly filename: string;
}

export type ClaimAttachmentResult =
  | { ok: true; arquivoOuterRef: string }
  | { ok: false; skipped: 'http-error' | 'empty-body' };

/**
 * The arquivo doc id — the SAME digest as the attachment mensagem doc id
 * (`makeAttachmentMensagemId`), on purpose: one formula, one implementation
 * (`claimIds.ts`), so the arquivo and the mensagem pointing at it can never
 * fork. See the module doc for why this is a new convention, not a legacy id.
 */
export function claimAttachmentArquivoId(contaId: string, filename: string): string {
  return makeAttachmentMensagemId(contaId, filename);
}

/**
 * Download + cache one claim attachment, returning its `Arquivo` outer ref —
 * or a skip marker when the attachment is deterministically unavailable.
 */
export async function ensureClaimAttachmentArquivo(
  deps: ClaimAttachmentDeps,
  args: ClaimAttachmentArgs,
): Promise<ClaimAttachmentResult> {
  const docId = claimAttachmentArquivoId(args.contaId, args.filename);
  const arquivoOuterRef = toOuterRef(`arquivos/${docId}`);

  // Cache hit: the arquivo doc already carries a `url` → bytes are in Storage.
  const existing = await arquivoCollection.docRef(deps.db, {}, docId).get();
  if (existing.exists) {
    const url = (existing.data() ?? {}).url;
    if (typeof url === 'string' && url.length > 0) {
      return { ok: true, arquivoOuterRef };
    }
  }

  let download;
  try {
    download = await deps.api.downloadClaimAttachment(args.claimId, args.filename);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError) {
      // Deterministic upstream failure — a retry would fail identically. A
      // 2xx status is the client's empty-body signal (`downloadClaimAttachment`
      // throws it instead of ever returning zero bytes).
      const emptyBody = err.status >= 200 && err.status < 300;
      console.warn(
        emptyBody
          ? '[mercado-livre] skipping a claim attachment with an empty body'
          : '[mercado-livre] skipping a claim attachment ML refuses to serve',
        { claimId: args.claimId, filename: args.filename, status: err.status },
      );
      return { ok: false, skipped: emptyBody ? 'empty-body' : 'http-error' };
    }
    if (err instanceof MercadoLivreNetworkError) throw err; // transient — task retry re-lands it
    throw err;
  }

  const contentType = download.contentType ?? 'application/octet-stream';
  await putArquivoAdmin({
    db: deps.db,
    bucket: deps.bucket,
    docId,
    storagePath: `mercado-livre/${args.contaId}/claims/${args.claimId}/${args.filename}`,
    bytes: download.bytes,
    contentType,
    filetype: filetypeFromMime(contentType),
  });

  return { ok: true, arquivoOuterRef };
}
