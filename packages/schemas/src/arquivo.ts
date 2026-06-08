import { z } from 'zod';
import type { CollectionMetadata } from './types';

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
export const FILETYPE = [
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

export const filetypeSchema = z.enum(FILETYPE);
export type Filetype = z.infer<typeof filetypeSchema>;

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
 * Bucket a MIME type into a {@link Filetype}. Ported from the Flutter
 * `FILETYPE.fromMime` so an upload's `filetype` is derived identically.
 */
export function filetypeFromMime(mimeType: string): Filetype {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'text/plain') return 'txt';
  if (mimeType === 'text/html') return 'html';
  if (DOCUMENT_MIMES.has(mimeType)) return 'document';
  if (mimeType.startsWith('application/')) return 'application';
  return 'fallback';
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
    // Server/helper-set creation time (ISO-8601). The orphan sweep filters on
    // it (`where('criadoEm','<', cutoff)`); ISO strings sort chronologically.
    // Optional because the Flutter app's docs predate it — those are simply
    // never reaped by our sweep, which is the safe behaviour.
    criadoEm: z.string().datetime().nullable().optional(),
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
