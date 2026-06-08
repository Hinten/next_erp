/**
 * Cloud Storage path conventions — pure string math, no Firebase imports.
 * Shared by the upload helpers (`@delfrance/storage`), the resize Cloud
 * Function (`apps/functions`) and the `storage.rules` reference.
 *
 * Product media is **product-scoped**: every file for a product lives under
 * `produtos/<produtoId>/…`, and product `Arquivo` doc ids are likewise scoped
 * (`<produtoId>_<hash>`). This isolates products — a delete/reorder on one can
 * never touch another — at the cost of not de-duping an identical image across
 * products (accepted tradeoff). The resize function watches **only** the
 * `originals` subdir, so derivatives (a different subdir, tagged with
 * `resized` metadata) never re-trigger it.
 */

export const STORAGE_ROOT = {
  produtos: 'produtos',
  media: 'media',
} as const;

export const PRODUTO_SUBDIR = {
  originals: 'originals',
  derivatives: 'derivatives',
  videos: 'videos',
} as const;

/**
 * A product-image derivative. Output is always JPEG to match the Flutter
 * `Foto` refs (`arquivo200px` / `arquivo400px` / `arquivojpeg`). `width: null`
 * means "do not resize" — re-encode at full size (the `arquivojpeg` variant).
 */
export interface VariantSpec {
  /** Stable key — also the storage suffix and the derivative-id suffix. */
  key: string;
  /** Target max width in px, or `null` for full-size (no downscale). */
  width: number | null;
}

export const PRODUCT_IMAGE_VARIANTS: readonly VariantSpec[] = [
  { key: '200', width: 200 },
  { key: '400', width: 400 },
  { key: 'jpeg', width: null },
] as const;

/** Storage extension for every product-image derivative. */
export const DERIVATIVE_EXT = 'jpeg';

function withExt(base: string, ext?: string | null): string {
  if (!ext) return base;
  const clean = ext.replace(/^\.+/, '').toLowerCase();
  return clean ? `${base}.${clean}` : base;
}

/** `produtos/<produtoId>/originals/<hash>[.<ext>]` — the watched prefix. */
export function productOriginalPath(produtoId: string, hash: string, ext?: string | null): string {
  return withExt(`${STORAGE_ROOT.produtos}/${produtoId}/${PRODUTO_SUBDIR.originals}/${hash}`, ext);
}

/** `produtos/<produtoId>/derivatives/<hash>_<variantKey>.jpeg`. */
export function productDerivativePath(produtoId: string, hash: string, variantKey: string): string {
  return `${STORAGE_ROOT.produtos}/${produtoId}/${PRODUTO_SUBDIR.derivatives}/${hash}_${variantKey}.${DERIVATIVE_EXT}`;
}

/** `produtos/<produtoId>/videos/<hash>[.<ext>]` — NOT watched, NOT resized. */
export function productVideoPath(produtoId: string, hash: string, ext?: string | null): string {
  return withExt(`${STORAGE_ROOT.produtos}/${produtoId}/${PRODUTO_SUBDIR.videos}/${hash}`, ext);
}

/** `media/<hash>[.<ext>]` — generic, non-product files. */
export function mediaPath(hash: string, ext?: string | null): string {
  return withExt(`${STORAGE_ROOT.media}/${hash}`, ext);
}

/** Product-scoped `Arquivo` doc id for an original. */
export function productArquivoId(produtoId: string, hash: string): string {
  return `${produtoId}_${hash}`;
}

/** Product-scoped `Arquivo` doc id for a derivative. */
export function derivativeArquivoId(produtoId: string, hash: string, variantKey: string): string {
  return `${productArquivoId(produtoId, hash)}_${variantKey}`;
}

export interface ParsedOriginalPath {
  produtoId: string;
  hash: string;
  /** Lowercased extension without the dot, or `null` when absent. */
  ext: string | null;
}

/**
 * Parse a watched-original object name back into its parts, or `null` if the
 * name is not a `produtos/<produtoId>/originals/<file>` path. Used by the
 * resize function to recover `{produtoId, hash}` from the finalized object.
 */
export function parseProductOriginalPath(name: string): ParsedOriginalPath | null {
  const parts = name.split('/');
  if (
    parts.length !== 4 ||
    parts[0] !== STORAGE_ROOT.produtos ||
    parts[2] !== PRODUTO_SUBDIR.originals
  ) {
    return null;
  }
  const produtoId = parts[1];
  const file = parts[3];
  if (!produtoId || !file) return null;
  const dot = file.lastIndexOf('.');
  const hash = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : null;
  if (!hash) return null;
  return { produtoId, hash, ext };
}

/** True when `name` is a watched product original (resize candidate). */
export function isWatchedProductOriginal(name: string): boolean {
  return parseProductOriginalPath(name) !== null;
}

/**
 * Defense-in-depth guard: true when the file name carries a derivative suffix
 * (`<hash>_200`, `_400`, `_jpeg`). A real original is content-hashed (hex, no
 * such suffix), so this only matches our own outputs.
 */
export function isDerivativeName(name: string): boolean {
  const file = name.split('/').pop() ?? name;
  const base = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file;
  return PRODUCT_IMAGE_VARIANTS.some((v) => base.endsWith(`_${v.key}`));
}

/**
 * Build a Firebase Storage public download URL carrying a download token. The
 * Admin SDK does not mint tokened URLs the way the client `getDownloadURL`
 * does, so the resize function writes a `firebaseStorageDownloadTokens`
 * custom-metadata value and constructs the matching URL with this helper.
 */
export function firebaseDownloadUrl(bucketName: string, objectPath: string, token: string): string {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}` +
    `/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`
  );
}

/**
 * Sanitize a human filename for use as a storage name. Lowercases, replaces
 * each non-alphanumeric character with `_` (so runs become multiple `_`), and
 * preserves a trailing extension. Ported from the Flutter `Arquivo.normalize`.
 */
export function normalizeName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const stem = name
      .slice(0, dot)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');
    const ext = name
      .slice(dot + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_');
    return `${stem}.${ext}`;
  }
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}
