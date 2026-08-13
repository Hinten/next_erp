import { getDoc, setDoc, updateDoc, type Firestore } from 'firebase/firestore';
import {
  getDownloadURL,
  ref as storageRef,
  uploadBytes,
  type FirebaseStorage,
} from 'firebase/storage';
import {
  FILETYPE,
  type Arquivo,
  type Filetype,
  STORAGE_ROOT,
  filetypeFromMime,
  normalizeContentType,
  nowMicros,
  productAnexoPath,
  productArquivoId,
  productOriginalPath,
  productVideoPath,
  tabMediArquivoId,
  tabMediOriginalPath,
} from '@delfrance/schemas';

import { arquivoCollection } from './collection';
import { StorageUploadError } from './errors';
import { sha512Hex, toBytes } from './hash';
import { extensionForContentType } from './mime';

export interface UploadResult {
  /** `Arquivo` doc id (content-addressed). */
  id: string;
  arquivo: Arquivo;
}

interface PutArquivoArgs {
  storage: FirebaseStorage;
  db: Firestore;
  bytes: Uint8Array;
  contentType: string;
  /** Doc id in `arquivos`. */
  docId: string;
  /** Full storage object path (directory + filename). */
  storagePath: string;
  filetype: Filetype;
  originalFilename?: string | null;
  /** Resize lifecycle marker — only product-image originals pass `'pending'`. */
  resizeState?: 'pending' | 'done' | null;
}

/**
 * Create the `Arquivo` doc, then upload the bytes (**create-first**).
 * Content-addressed: if the doc already exists at `docId` the object is already
 * in Storage, so we reuse it and skip both the upload and the write (the Flutter
 * dedup contract).
 *
 * The doc is the durable **anchor**: it is written BEFORE the upload so that a
 * client that dies mid-upload leaves a `uploadState: 'pending'` doc with no
 * object — a phantom the orphan sweep reaps — rather than the old failure mode
 * (upload-then-`setDoc`) that orphaned the OBJECT with no doc. The object is
 * tagged with its owning doc id (`arquivoId` custom metadata) so the finalize
 * trigger can map object → doc directly.
 *
 * All Firestore access goes through the schema-validated `arquivoCollection`
 * handle, never raw refs.
 */
async function putArquivo(args: PutArquivoArgs): Promise<UploadResult> {
  const docRef = arquivoCollection.docRef(args.db, {}, args.docId);

  const existing = await getDoc(docRef);
  if (existing.exists()) {
    return { id: args.docId, arquivo: existing.data() };
  }

  const slash = args.storagePath.lastIndexOf('/');
  const filepath = slash >= 0 ? args.storagePath.slice(0, slash) : null;
  const filename = slash >= 0 ? args.storagePath.slice(slash + 1) : args.storagePath;

  // 1. Create-first: write the anchor doc with `url` not yet known and
  //    `uploadState: 'pending'` (flipped to 'finalized' by the onObjectFinalized
  //    trigger once the object lands — the authoritative upload-complete signal).
  const arquivo: Arquivo = {
    filetype: args.filetype,
    filepath,
    filename,
    originalFilename: args.originalFilename ?? null,
    contentType: normalizeContentType(args.contentType),
    url: null,
    externalIds: [],
    criadoEm: nowMicros(),
    resizeState: args.resizeState ?? null,
    uploadState: 'pending',
    markedForDeletionAt: null,
  };
  await setDoc(docRef, arquivo);

  // 2. Upload the bytes, tagging the object with its owning doc id.
  const objectRef = storageRef(args.storage, args.storagePath);
  await uploadBytes(objectRef, args.bytes, {
    contentType: args.contentType,
    customMetadata: { arquivoId: args.docId },
  });

  // 3. Patch the public URL for an immediate UI render (partial update — bypasses
  //    the converter's full-doc validation). `uploadState` stays 'pending' until
  //    the onObjectFinalized trigger flips it to 'finalized'. If the client dies
  //    after the upload but before this patch, the doc keeps `url: null`
  //    (the trigger only flips `uploadState`, it does NOT backfill `url` today —
  //    a deferred refinement; product images still render via their derivative
  //    docs, which carry their own URLs).
  const url = await getDownloadURL(objectRef);
  await updateDoc(docRef, { url });

  return { id: args.docId, arquivo: { ...arquivo, url } };
}

export interface UploadFileArgs {
  storage: FirebaseStorage;
  db: Firestore;
  bytes: Uint8Array | ArrayBuffer | Blob;
  contentType: string;
  /** Storage directory (no filename). Defaults to `media`. */
  filepath?: string;
  originalFilename?: string | null;
}

/** Upload a generic file to `<filepath>/<hash>[.ext]` (defaults to `media/`). */
export async function uploadFile(args: UploadFileArgs): Promise<UploadResult> {
  const bytes = await toBytes(args.bytes);
  const hash = await sha512Hex(bytes);
  const ext = extensionForContentType(args.contentType);
  const dir = args.filepath ?? STORAGE_ROOT.media;
  const filename = ext ? `${hash}.${ext}` : hash;
  return putArquivo({
    storage: args.storage,
    db: args.db,
    bytes,
    contentType: args.contentType,
    docId: hash,
    storagePath: `${dir}/${filename}`,
    filetype: filetypeFromMime(args.contentType),
    originalFilename: args.originalFilename,
  });
}

export interface UploadProductImageArgs {
  storage: FirebaseStorage;
  db: Firestore;
  /** Owning product id. For a NEW product, mint it first
   *  (`doc(collection(db,'produtos')).id`) and pass it before saving. */
  produtoId: string;
  bytes: Uint8Array | ArrayBuffer | Blob;
  contentType: string;
  originalFilename?: string | null;
}

/**
 * Upload a product photo original to `produtos/<produtoId>/originals/<hash>.ext`
 * with the product-scoped doc id `<produtoId>_<hash>`. The resize Cloud
 * Function (`apps/functions`) then generates the 200/400/jpeg derivatives.
 */
export async function uploadProductImage(args: UploadProductImageArgs): Promise<UploadResult> {
  if (!args.contentType.startsWith('image/')) {
    throw new StorageUploadError(
      `uploadProductImage expects an image/* content type, got "${args.contentType}".`,
    );
  }
  const bytes = await toBytes(args.bytes);
  const hash = await sha512Hex(bytes);
  const ext = extensionForContentType(args.contentType);
  return putArquivo({
    storage: args.storage,
    db: args.db,
    bytes,
    contentType: args.contentType,
    docId: productArquivoId(args.produtoId, hash),
    storagePath: productOriginalPath(args.produtoId, hash, ext),
    filetype: FILETYPE.image,
    originalFilename: args.originalFilename,
    // Marks the original so the resize function (→ 'done') and the reconcile
    // sweep (queries 'pending') can track derivative completion. Only written
    // when this CREATES the doc — a dedup hit (doc already exists) keeps the
    // existing marker, which is correct: the first upload already stamped
    // 'pending', so a failed resize leaves it 'pending' and the sweep heals it.
    // (Docs created before this marker existed — legacy / Flutter-written — have
    // no marker and would need a one-off migration; there is no such backlog yet.)
    resizeState: 'pending',
  });
}

export interface UploadTabMediImageArgs {
  storage: FirebaseStorage;
  db: Firestore;
  /** Owning tabela-de-medidas id. Save the tabela first (save-first UX). */
  tabMediId: string;
  bytes: Uint8Array | ArrayBuffer | Blob;
  contentType: string;
  originalFilename?: string | null;
}

/**
 * Upload a tabela-de-medidas photo original to
 * `tabMedi/<tabMediId>/originals/<hash>.ext` with the owner-scoped doc id
 * `<tabMediId>_<hash>`.
 *
 * These **are** resized, exactly like product images: `shouldResize` watches
 * both owner roots, so the trigger generates the 200/400/jpeg derivatives here
 * too. Two things wanted that — a gallery thumbnail was loading the full
 * original, and the size-chart AI agent needs the full-size `jpeg` variant to
 * read measurements off a supplier's table (400 px cannot resolve digits).
 *
 * ⚠️ `resizeState: 'pending'` is what the 48-hour reconcile sweep queries, so it
 * is also the backfill lever: stamping it on a photo uploaded before this change
 * is enough to make the sweep generate its missing derivatives.
 *
 * The owner-scoped `tabMedi/` path keeps these out of the produto namespace, so
 * the produto orphan-sweep never reaps them; the `tabMedi`-aware reaper/sweep
 * handle their lifecycle instead.
 */
export async function uploadTabMediImage(args: UploadTabMediImageArgs): Promise<UploadResult> {
  if (!args.contentType.startsWith('image/')) {
    throw new StorageUploadError(
      `uploadTabMediImage expects an image/* content type, got "${args.contentType}".`,
    );
  }
  const bytes = await toBytes(args.bytes);
  const hash = await sha512Hex(bytes);
  const ext = extensionForContentType(args.contentType);
  return putArquivo({
    storage: args.storage,
    db: args.db,
    bytes,
    contentType: args.contentType,
    docId: tabMediArquivoId(args.tabMediId, hash),
    storagePath: tabMediOriginalPath(args.tabMediId, hash, ext),
    filetype: FILETYPE.image,
    originalFilename: args.originalFilename,
    // Same marker product images use: the resize flips it to 'done', and the
    // reconcile sweep queries only `resizeState == 'pending'`, so a dropped
    // trigger delivery heals within 48h instead of leaving a photo the AI agent
    // can never see. Only written when this CREATES the doc — a dedup hit keeps
    // the existing marker, which is correct.
    resizeState: 'pending',
  });
}

export interface UploadProductVideoArgs {
  storage: FirebaseStorage;
  db: Firestore;
  /** Owning product id. For a NEW product, mint it first and pass it before saving. */
  produtoId: string;
  bytes: Uint8Array | ArrayBuffer | Blob;
  contentType: string;
  originalFilename?: string | null;
}

/**
 * Upload a product video to `produtos/<produtoId>/videos/<hash>.ext` with the
 * product-scoped doc id `<produtoId>_<hash>`. Unlike product images, videos are
 * **not** resized — the original is played back directly, so this writes to the
 * `videos` subdir (which the resize Cloud Function does not watch) and never
 * triggers it.
 */
export async function uploadProductVideo(args: UploadProductVideoArgs): Promise<UploadResult> {
  if (!args.contentType.startsWith('video/')) {
    throw new StorageUploadError(
      `uploadProductVideo expects a video/* content type, got "${args.contentType}".`,
    );
  }
  const bytes = await toBytes(args.bytes);
  const hash = await sha512Hex(bytes);
  const ext = extensionForContentType(args.contentType);
  return putArquivo({
    storage: args.storage,
    db: args.db,
    bytes,
    contentType: args.contentType,
    docId: productArquivoId(args.produtoId, hash),
    storagePath: productVideoPath(args.produtoId, hash, ext),
    filetype: FILETYPE.video,
    originalFilename: args.originalFilename,
  });
}

export interface UploadProductAnexoArgs {
  storage: FirebaseStorage;
  db: Firestore;
  /** Owning product id. For a NEW product, mint it first and pass it before saving. */
  produtoId: string;
  bytes: Uint8Array | ArrayBuffer | Blob;
  contentType: string;
  originalFilename?: string | null;
}

/**
 * Upload a product attachment (anexo) to `produtos/<produtoId>/anexos/<hash>[.<ext>]`
 * (the extension is omitted for an unknown MIME, e.g. `application/zip`), with the
 * product-scoped doc id `<produtoId>_<hash>`. Accepts ANY content type
 * (PDFs, datasheets, archives…); the `filetype` is derived from the MIME via
 * `filetypeFromMime` — fixing the Flutter port's hardcoded `image`. Like videos,
 * anexos live in their own subdir, are never resized, and are reaped by the same
 * product-scoped orphan sweeps (`produtos/<id>/anexos`).
 */
export async function uploadProductAnexo(args: UploadProductAnexoArgs): Promise<UploadResult> {
  const bytes = await toBytes(args.bytes);
  const hash = await sha512Hex(bytes);
  const ext = extensionForContentType(args.contentType);
  return putArquivo({
    storage: args.storage,
    db: args.db,
    bytes,
    contentType: args.contentType,
    docId: productArquivoId(args.produtoId, hash),
    storagePath: productAnexoPath(args.produtoId, hash, ext),
    filetype: filetypeFromMime(args.contentType),
    originalFilename: args.originalFilename,
  });
}

export interface UploadFromUrlArgs {
  storage: FirebaseStorage;
  db: Firestore;
  url: string;
  /** Storage directory (no filename). Defaults to `media`. */
  filepath?: string;
  originalFilename?: string | null;
}

/**
 * Fetch a URL and upload its bytes (content-addressed). Mirrors the Flutter
 * `UploadFileManager.fromUrl` — handy for importing marketplace images.
 */
export async function uploadFromUrl(args: UploadFromUrlArgs): Promise<UploadResult> {
  const resp = await fetch(args.url);
  if (!resp.ok) {
    throw new StorageUploadError(`Failed to fetch "${args.url}": HTTP ${resp.status}.`);
  }
  const contentType = resp.headers.get('content-type');
  if (!contentType) {
    throw new StorageUploadError(`Missing content-type for "${args.url}".`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return uploadFile({
    storage: args.storage,
    db: args.db,
    bytes,
    contentType,
    filepath: args.filepath,
    originalFilename: args.originalFilename,
  });
}
