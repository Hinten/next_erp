/**
 * Admin-SDK "create-first" Arquivo uploader — the server-side mirror of the
 * client `@delfrance/storage` `putArquivo` (which is Firebase JS-SDK only and
 * can't run here). Used by the ML photo import (#439); a follow-up (#449) extracts
 * this into a shared `@delfrance/storage/admin` so client + server share one core.
 *
 * Contract parity with the client uploader + the resize function
 * (`apps/functions/.../processOriginal.ts`):
 *  - content-addressed doc id → dedup: if the doc already exists the bytes are
 *    already in Storage, so we only `arrayUnion` the new `externalIds` (never
 *    clobber the shared array) and skip the re-upload;
 *  - create-first: the anchor doc is written (`uploadState: 'pending'`, `url: null`)
 *    BEFORE the bytes, so a crash mid-upload leaves a phantom the orphan sweep
 *    reaps rather than an orphaned object;
 *  - the object carries `customMetadata.arquivoId` (so `onObjectFinalized` maps
 *    object → doc + flips `uploadState`) and a self-minted download token (the
 *    Admin SDK can't mint `getDownloadURL` tokens);
 *  - a product original written with `resizeState: 'pending'` triggers the deployed
 *    `resizeProductImage` function to generate the 200/400/jpeg derivatives.
 */
import { randomUUID } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import {
  type ExternalId,
  type Filetype,
  firebaseDownloadUrl,
  normalizeContentType,
  nowMicros,
} from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/data/admin/collections';

/** A firebase-admin Storage bucket handle (`getStorage(app).bucket(name)`). */
export type Bucket = ReturnType<Storage['bucket']>;

export interface PutArquivoAdminArgs {
  db: Firestore;
  bucket: Bucket;
  /** Content-addressed Arquivo doc id (`<produtoId>_<hash>`). */
  docId: string;
  /** Full Storage object path (directory + filename). */
  storagePath: string;
  bytes: Buffer | Uint8Array;
  contentType: string;
  filetype: Filetype;
  /** `'pending'` for product-image originals (triggers derivative generation). */
  resizeState?: 'pending' | 'done' | null;
  /** Marketplace cache entries stamped on the Arquivo (arrayUnion on a dedup hit). */
  externalIds?: readonly ExternalId[];
}

export interface PutArquivoAdminResult {
  id: string;
  /** False when the doc already existed (content-addressed dedup hit). */
  created: boolean;
}

export async function putArquivoAdmin(args: PutArquivoAdminArgs): Promise<PutArquivoAdminResult> {
  const ref = arquivoCollection.docRef(args.db, {}, args.docId);
  const existing = await ref.get();
  if (existing.exists) {
    // Bytes already in Storage. Never overwrite — just record any new externalIds
    // (a re-import, or a byte-identical picture from another listing/account).
    if (args.externalIds && args.externalIds.length > 0) {
      await ref.update({ externalIds: FieldValue.arrayUnion(...args.externalIds) });
    }
    return { id: args.docId, created: false };
  }

  const slash = args.storagePath.lastIndexOf('/');
  const filepath = slash >= 0 ? args.storagePath.slice(0, slash) : null;
  const filename = slash >= 0 ? args.storagePath.slice(slash + 1) : args.storagePath;

  // 1. Create-first anchor (`uploadState: 'pending'`; the onObjectFinalized trigger
  //    flips it to 'finalized' once the object lands).
  await arquivoCollection.set(args.db, {}, args.docId, {
    filetype: args.filetype,
    filepath,
    filename,
    originalFilename: null,
    contentType: normalizeContentType(args.contentType),
    url: null,
    externalIds: [...(args.externalIds ?? [])],
    criadoEm: nowMicros(),
    resizeState: args.resizeState ?? null,
    uploadState: 'pending',
    markedForDeletionAt: null,
  });

  // 2. Upload the bytes, tagging the object with its owning doc id + a download token.
  const token = randomUUID();
  const buffer = Buffer.isBuffer(args.bytes) ? args.bytes : Buffer.from(args.bytes);
  await args.bucket.file(args.storagePath).save(buffer, {
    contentType: args.contentType,
    metadata: {
      metadata: { firebaseStorageDownloadTokens: token, arquivoId: args.docId },
    },
  });

  // 3. Patch the public URL (the Admin SDK builds the tokened URL itself).
  const url = firebaseDownloadUrl(args.bucket.name, args.storagePath, token);
  await arquivoCollection.merge(args.db, {}, args.docId, { url });

  return { id: args.docId, created: true };
}
