const ARQUIVOS_PREFIX = 'arquivos/';

/**
 * `arquivos/<id>` → `<id>` (or `null` for an absent ref). Shared by the gallery
 * card and the fullscreen viewer so both resolve a `Foto`'s refs identically.
 */
export function idFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const id = ref.startsWith(ARQUIVOS_PREFIX) ? ref.slice(ARQUIVOS_PREFIX.length) : ref;
  return id || null;
}
