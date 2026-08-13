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
  tabMedi: 'tabMedi',
  media: 'media',
} as const;

export const PRODUTO_SUBDIR = {
  originals: 'originals',
  derivatives: 'derivatives',
  videos: 'videos',
  anexos: 'anexos',
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

/**
 * `<produtos|tabMedi>/<ownerId>/derivatives/<hash>_<variantKey>.jpeg`.
 *
 * Owner-aware because the resize function now covers tabela-de-medidas photos
 * too: a size chart is a photo of a *table*, and the measurement agent reads
 * digits off it, which the full-size `jpeg` variant makes possible and the
 * original (HEIC, unrotated, tens of MB) does not.
 */
export function ownedDerivativePath(
  ownerCollection: MediaOwnerCollection,
  ownerId: string,
  hash: string,
  variantKey: string,
): string {
  return `${STORAGE_ROOT[ownerCollection]}/${ownerId}/${PRODUTO_SUBDIR.derivatives}/${hash}_${variantKey}.${DERIVATIVE_EXT}`;
}

/**
 * Produto-only view of {@link ownedDerivativePath}. Kept because most callers
 * and their tests are produto-scoped and must stay byte-identical — the same
 * shape `parseProductMediaDir` has over `parseOwnedMediaDir`.
 */
export function productDerivativePath(produtoId: string, hash: string, variantKey: string): string {
  return ownedDerivativePath('produtos', produtoId, hash, variantKey);
}

/** `produtos/<produtoId>/videos/<hash>[.<ext>]` — NOT watched, NOT resized. */
export function productVideoPath(produtoId: string, hash: string, ext?: string | null): string {
  return withExt(`${STORAGE_ROOT.produtos}/${produtoId}/${PRODUTO_SUBDIR.videos}/${hash}`, ext);
}

/**
 * `produtos/<produtoId>/anexos/<hash>[.<ext>]` — generic product attachments
 * (PDFs, datasheets, contracts…). Product-scoped like originals/videos so the
 * orphan sweep can reclaim them; NOT watched, NOT resized (any content type).
 */
export function productAnexoPath(produtoId: string, hash: string, ext?: string | null): string {
  return withExt(`${STORAGE_ROOT.produtos}/${produtoId}/${PRODUTO_SUBDIR.anexos}/${hash}`, ext);
}

/** `media/<hash>[.<ext>]` — generic, non-product files. */
export function mediaPath(hash: string, ext?: string | null): string {
  return withExt(`${STORAGE_ROOT.media}/${hash}`, ext);
}

// ── Tabela de medidas media (owner-scoped like produtos, but NOT resized) ──

/**
 * `tabMedi/<tabMediId>/originals/<hash>[.<ext>]` — a tabela-de-medidas photo.
 * Owner-scoped like product originals, but NO resize function watches this
 * prefix, so it stays original-only (no derivatives).
 */
export function tabMediOriginalPath(tabMediId: string, hash: string, ext?: string | null): string {
  return withExt(`${STORAGE_ROOT.tabMedi}/${tabMediId}/${PRODUTO_SUBDIR.originals}/${hash}`, ext);
}

/**
 * Owner-scoped `Arquivo` doc id for an original — `<ownerId>_<hash>`.
 *
 * The id shape carries no owner *collection*, only the owner id, which is why
 * produtos and tabelas de medidas can share one derivative-id scheme. The
 * collection is recovered from the storage path, not from the id.
 */
export function ownedArquivoId(ownerId: string, hash: string): string {
  return `${ownerId}_${hash}`;
}

/** Owner-scoped `Arquivo` doc id for a tabela-de-medidas original. */
export function tabMediArquivoId(tabMediId: string, hash: string): string {
  return ownedArquivoId(tabMediId, hash);
}

/** Product-scoped `Arquivo` doc id for an original. */
export function productArquivoId(produtoId: string, hash: string): string {
  return ownedArquivoId(produtoId, hash);
}

/**
 * `Arquivo` doc id for a derivative — `<ownerId>_<hash>_<variantKey>`.
 *
 * Owner-agnostic: pass a produto id or a tabela-de-medidas id. It reads
 * "product-scoped" historically because produtos were the only owner with
 * derivatives; the arithmetic never depended on that.
 */
export function derivativeArquivoId(ownerId: string, hash: string, variantKey: string): string {
  return `${ownedArquivoId(ownerId, hash)}_${variantKey}`;
}

export interface ParsedOriginalPath {
  produtoId: string;
  hash: string;
  /** Lowercased extension without the dot, or `null` when absent. */
  ext: string | null;
}

export interface ParsedOwnedOriginalPath {
  ownerCollection: MediaOwnerCollection;
  ownerId: string;
  hash: string;
  /** Lowercased extension without the dot, or `null` when absent. */
  ext: string | null;
}

/**
 * Parse a watched-original object name into its owning collection, owner id and
 * hash — `<produtos|tabMedi>/<ownerId>/originals/<file>` — or `null` when the
 * name is not one. The resize function uses it to recover where to write the
 * derivatives back to.
 *
 * ⚠️ **Both roots are watched.** `tabMedi` joined when the measurement agent
 * needed to read digits off a supplier's size table: 400 px cannot resolve them,
 * so the agent wants the full-size `jpeg` variant, and nothing was producing it.
 * Widening the predicate is what makes the trigger fire on those uploads at all.
 */
export function parseOwnedOriginalPath(name: string): ParsedOwnedOriginalPath | null {
  const parts = name.split('/');
  if (parts.length !== 4 || parts[2] !== PRODUTO_SUBDIR.originals) return null;
  const [root, ownerId, , file] = parts;
  const ownerCollection: MediaOwnerCollection | null =
    root === STORAGE_ROOT.produtos ? 'produtos' : root === STORAGE_ROOT.tabMedi ? 'tabMedi' : null;
  if (!ownerCollection || !ownerId || !file) return null;
  const dot = file.lastIndexOf('.');
  const hash = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : null;
  if (!hash) return null;
  return { ownerCollection, ownerId, hash, ext };
}

/**
 * Produto-only view of {@link parseOwnedOriginalPath} — returns `null` for any
 * `tabMedi/…` path. Kept byte-identical for the produto-scoped callers and their
 * tests, mirroring how `parseProductMediaDir` sits over `parseOwnedMediaDir`.
 */
export function parseProductOriginalPath(name: string): ParsedOriginalPath | null {
  const parsed = parseOwnedOriginalPath(name);
  return parsed && parsed.ownerCollection === 'produtos'
    ? { produtoId: parsed.ownerId, hash: parsed.hash, ext: parsed.ext }
    : null;
}

/**
 * True when `name` is a watched original of ANY media owner — i.e. a resize
 * candidate. This is the predicate `shouldResize` gates on, so widening it is
 * what brings a new owner's photos into the resize pipeline.
 */
export function isWatchedOriginal(name: string): boolean {
  return parseOwnedOriginalPath(name) !== null;
}

/** A product-media subdir the orphan sweep is allowed to reclaim. */
export type ProductMediaKind = 'originals' | 'videos' | 'anexos';

export interface ParsedProductMediaDir {
  produtoId: string;
  kind: ProductMediaKind;
}

/** A media-owning collection whose files live at `<collection>/<id>/<kind>`. */
export type MediaOwnerCollection = 'produtos' | 'tabMedi';

export interface ParsedOwnedMediaDir {
  ownerCollection: MediaOwnerCollection;
  ownerId: string;
  kind: ProductMediaKind;
}

/**
 * Parse an owner-media **directory** (`Arquivo.filepath`, no filename) into its
 * owning collection, owner id and kind — `<produtos|tabMedi>/<ownerId>/<originals
 * |videos|anexos>`. Returns `null` for derivatives, generic `media/`, an unknown
 * root, wrong depth, or empty id.
 *
 * The generalized core of {@link parseProductMediaDir}: the arquivo orphan-sweep
 * and the media reaper use it to scope candidates AND recover the right owner
 * collection, so they verify references against the correct owning doc
 * (`produtos` vs `tabMedi`) — never deleting a tabMedi photo as a phantom produto.
 */
export function parseOwnedMediaDir(
  filepath: string | null | undefined,
): ParsedOwnedMediaDir | null {
  if (typeof filepath !== 'string') return null;
  const parts = filepath.split('/');
  if (parts.length !== 3) return null;
  const [root, ownerId, sub] = parts;
  if (!ownerId) return null;
  const ownerCollection: MediaOwnerCollection | null =
    root === STORAGE_ROOT.produtos ? 'produtos' : root === STORAGE_ROOT.tabMedi ? 'tabMedi' : null;
  if (!ownerCollection) return null;
  if (sub === PRODUTO_SUBDIR.originals) return { ownerCollection, ownerId, kind: 'originals' };
  if (sub === PRODUTO_SUBDIR.videos) return { ownerCollection, ownerId, kind: 'videos' };
  if (sub === PRODUTO_SUBDIR.anexos) return { ownerCollection, ownerId, kind: 'anexos' };
  return null;
}

/**
 * Produto-only view of {@link parseOwnedMediaDir} — `produtos/<produtoId>/<kind>`
 * → `{produtoId, kind}`, else `null` (including for any `tabMedi/…` path). Kept
 * for the produto-scoped callers (the resize cascade and the produto media
 * reaper/sweep) and their existing tests, which must stay byte-identical.
 */
export function parseProductMediaDir(
  filepath: string | null | undefined,
): ParsedProductMediaDir | null {
  const parsed = parseOwnedMediaDir(filepath);
  return parsed && parsed.ownerCollection === 'produtos'
    ? { produtoId: parsed.ownerId, kind: parsed.kind }
    : null;
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
