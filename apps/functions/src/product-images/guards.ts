import { isDerivativeName, isWatchedProductOriginal } from '@delfrance/schemas';

export interface StorageObjectInfo {
  /** Object path within the bucket, e.g. `produtos/<id>/originals/<hash>.png`. */
  name: string;
  contentType?: string | null;
  /** Object custom metadata (`event.data.metadata`). */
  metadata?: Record<string, string> | null;
}

/**
 * The infinite-loop / over-trigger guard for the resize function — the
 * cost-critical core. Returns true ONLY for a fresh product-image original:
 *
 *  1. must be a watched product original (`produtos/<id>/originals/…`) — this
 *     alone excludes derivatives, videos, generic media and Flutter's flat
 *     `produtos/<hash>` uploads;
 *  2. must be an image;
 *  3. must NOT carry our `resized=true` marker (our own derivative outputs);
 *  4. must NOT already look like a derivative (defense in depth).
 *
 * Pure + total so it is exhaustively unit-tested without touching Firebase.
 */
export function shouldResize(obj: StorageObjectInfo): boolean {
  if (!obj.name) return false;
  if (!isWatchedProductOriginal(obj.name)) return false;
  if (!obj.contentType || !obj.contentType.startsWith('image/')) return false;
  if (obj.metadata?.resized === 'true') return false;
  if (isDerivativeName(obj.name)) return false;
  return true;
}
