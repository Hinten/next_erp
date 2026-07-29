import { z } from 'zod';
import { nowMicros } from '@delfrance/core/datetime';
import { microsSinceEpoch } from '../shared/datetime';
import type { CollectionMetadata } from '../types';

// Mirror `PERM.arquivo` from @delfrance/auth (byte 80); duplicated locally to
// avoid a circular dep — same approach as cargo.ts / deposito.ts.
const PERM_ARQUIVO_READ = 1n << 80n;
const PERM_ARQUIVO_WRITE = 1n << 81n;
const PERM_ARQUIVO_DELETE = 1n << 82n;

/** Collection that stores file metadata. Mirrors the Flutter
 *  `ARQUIVOS_COLLECTION` (`.old/packages/backend/storage/storage`). */
export const ARQUIVOS_COLLECTION = 'arquivos';

/**
 * File kind. Same string codes as the Flutter `FILETYPE` enum
 * (`.old/.../storage/lib/src/models.dart`) so the two apps round-trip the
 * `filetype` field unchanged.
 */
export const FILETYPE_VALUES = [
  'html',
  'image',
  'audio',
  'video',
  'txt',
  'error',
  'application',
  'fallback',
  'file',
  'interactive',
  'button',
  'order',
  'sticker',
  'system',
  'unknown',
  'document',
  'unsupported',
  'reaction',
] as const;

export const filetypeSchema = z.enum(FILETYPE_VALUES);
export type Filetype = z.infer<typeof filetypeSchema>;

/**
 * Named members of {@link filetypeSchema}. Each name is its own wire value, so
 * this buys rename-safety and `Find all references` — and, with 19 members
 * spanning MIME kinds and WhatsApp message kinds, a discoverable list.
 *
 * Enforced by the `delfrance/prefer-schema-enum` lint rule, which fires for any
 * Zod enum that has a companion constant like this one.
 */
export const FILETYPE = {
  html: 'html',
  image: 'image',
  audio: 'audio',
  video: 'video',
  txt: 'txt',
  error: 'error',
  application: 'application',
  fallback: 'fallback',
  file: 'file',
  interactive: 'interactive',
  button: 'button',
  order: 'order',
  sticker: 'sticker',
  system: 'system',
  unknown: 'unknown',
  document: 'document',
  unsupported: 'unsupported',
  reaction: 'reaction',
} as const satisfies Record<string, Filetype>;

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/**
 * Reduce a Content-Type header value to its base MIME type: strip parameters
 * (`; charset=…`), trim, and lowercase — e.g. `Text/Plain; charset=utf-8` →
 * `text/plain`. Real HTTP `content-type` headers carry params + casing that
 * would otherwise defeat the exact-match lookups below.
 */
export function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Bucket a MIME type into a {@link Filetype}. Ported from the Flutter
 * `FILETYPE.fromMime` so an upload's `filetype` is derived identically.
 * Tolerates full Content-Type header values (params/casing) via
 * {@link normalizeContentType}.
 */
export function filetypeFromMime(mimeType: string): Filetype {
  const mime = normalizeContentType(mimeType);
  if (mime.startsWith('image/')) return FILETYPE.image;
  if (mime.startsWith('audio/')) return FILETYPE.audio;
  if (mime.startsWith('video/')) return FILETYPE.video;
  if (mime === 'text/plain') return FILETYPE.txt;
  if (mime === 'text/html') return FILETYPE.html;
  if (DOCUMENT_MIMES.has(mime)) return FILETYPE.document;
  if (mime.startsWith('application/')) return FILETYPE.application;
  return FILETYPE.fallback;
}

/** Maps an `Arquivo` to its id in an external integration (marketplace). */
export const externalIdSchema = z.object({
  externalId: z.string(),
  integracaoPath: z.string(),
});
export type ExternalId = z.infer<typeof externalIdSchema>;

/**
 * Arquivo — file-metadata document in the `arquivos` collection. Content is in
 * Cloud Storage; this doc carries the public `url`, MIME type, and the storage
 * path (`filepath` dir + `filename`). Parity with the Flutter `Arquivo` model;
 * `.passthrough()` keeps fields the Flutter app writes that we don't model yet.
 *
 * Optional fields are `.nullable()` (never bare `.optional()`) so the parsed
 * type is `T | null` and Firebase JS SDK v12 never sees `undefined`.
 */
export const arquivoSchema = z
  .object({
    filetype: filetypeSchema.describe('Tipo'),
    // Storage directory WITHOUT the filename (e.g. `produtos/<id>/originals`).
    filepath: z.string().nullable().default(null).describe('Caminho'),
    filename: z.string().min(1).describe('Arquivo'),
    originalFilename: z.string().nullable().default(null).describe('Nome original'),
    contentType: z.string().nullable().default(null).describe('Content-Type'),
    url: z.string().nullable().default(null).describe('URL'),
    externalIds: z.array(externalIdSchema).default([]),
    // Creation time as **microseconds since epoch** (the repo's MicrosSinceEpoch
    // convention). Required, defaulting to `nowMicros()` so every doc is queryable
    // by age — the orphan sweeps range-query it (`where criadoEm < cutoff`, ordered
    // oldest-first) for the grace window. The upload helpers + resize function still
    // set it explicitly; the default only covers an omitted write. The
    // `microsSinceEpoch()` builder tolerates the legacy ISO-string form on read.
    criadoEm: microsSinceEpoch().default(() => nowMicros()),
    // Resize lifecycle marker for product-image ORIGINALS only: 'pending' when
    // the client uploads (set by uploadProductImage), 'done' once the resize
    // Cloud Function has written all derivatives. `null` for everything else
    // (derivatives, videos, generic/chat media). The scheduled reconcile sweep
    // queries `where resizeState == 'pending'` to find originals whose
    // derivatives are missing — see apps/functions `reconcileProductImages`.
    resizeState: z.enum(['pending', 'done']).nullable().default(null).describe('Estado do resize'),
    // Upload lifecycle marker (general — images, videos AND generic media):
    // 'pending' when the client CREATES the doc just before uploading the bytes
    // (create-first), flipped to 'finalized' by the `onObjectFinalized` trigger
    // once the object actually arrives. Orthogonal to `resizeState` (which only
    // tracks derivative creation for product images). `null` for legacy docs that
    // predate create-first. The phantom-doc orphan sweep queries
    // `where uploadState == 'pending'` to find docs whose upload never completed.
    uploadState: z
      .enum(['pending', 'finalized'])
      .nullable()
      .default(null)
      .describe('Estado do upload'),
    // Soft-delete marker (microseconds-since-epoch). Set by the
    // `onProdutoMediaChanged` Cloud Function when a produto edit removes this
    // arquivo's `arquivoOuterRef` from `fotos`/`videos`; cleared (back to null)
    // if the ref is re-added in a later edit. The `sweepMarkedForDeletion` pass
    // deletes marked docs past a short grace, re-verifying the owning produto
    // still doesn't reference it (so a missed unmark never loses a live photo).
    // `null` = not marked — the default for every freshly uploaded arquivo.
    markedForDeletionAt: microsSinceEpoch()
      .nullable()
      .default(null)
      .describe('Marcado para exclusão em'),
  })
  .passthrough();

export type Arquivo = z.infer<typeof arquivoSchema>;

export const arquivoMeta: CollectionMetadata = {
  collectionPath: ARQUIVOS_COLLECTION,
  permissions: {
    read: PERM_ARQUIVO_READ,
    write: PERM_ARQUIVO_WRITE,
    delete: PERM_ARQUIVO_DELETE,
  },
};

export const arquivo = { schema: arquivoSchema, meta: arquivoMeta };
