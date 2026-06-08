import { normalizeContentType } from '@delfrance/schemas';

/**
 * MIME ↔ extension maps. Ported from the Flutter `Arquivo.maybeExtension` /
 * `Arquivo.mimetype`. Used to give content-addressed objects a sensible
 * extension (the hash carries no type info on its own).
 */
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/xml': 'xml',
  'text/plain': 'txt',
  'text/html': 'html',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** Extension (no dot) for a content type, or `null` when unknown. Tolerates
 *  full Content-Type header values (params/casing). */
export function extensionForContentType(contentType: string): string | null {
  return MIME_TO_EXT[normalizeContentType(contentType)] ?? null;
}
