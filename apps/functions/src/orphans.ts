/**
 * Pure helpers for the storage-cleanup functions. No Firebase imports — the
 * trigger wrappers do the I/O and call these for the decisions, so the policy
 * is exhaustively unit-tested.
 */

/** The `Foto`/`Video`/`Anexo` ref fields that point at an `Arquivo` doc path. */
const REF_FIELDS = [
  'arquivoOuterRef',
  'arquivo200pxOuterRef',
  'arquivo400pxOuterRef',
  'arquivoJpegOuterRef',
] as const;

const MEDIA_ARRAYS = ['fotos', 'videos', 'anexos'] as const;

/** Last segment of an `arquivos/<id>` ref string (or any '/'-delimited path). */
export function refId(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Collect every `Arquivo` doc id a produto references via its `fotos` /
 * `videos` / `anexos` arrays (the `*OuterRef` path strings) and the
 * denormalized `fotosArquivosIds` list.
 */
export function referencedArquivoIds(
  produto: Record<string, unknown>,
): Set<string> {
  const ids = new Set<string>();
  for (const arrKey of MEDIA_ARRAYS) {
    const arr = produto[arrKey];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as Record<string, unknown>;
      for (const field of REF_FIELDS) {
        const v = obj[field];
        if (typeof v === 'string' && v.length > 0) ids.add(refId(v));
      }
    }
  }
  const flat = produto['fotosArquivosIds'];
  if (Array.isArray(flat)) {
    for (const id of flat) if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

/** Storage object path for an `Arquivo` (`filepath` dir + `filename`). */
export function objectPathOf(arquivo: {
  filepath?: string | null;
  filename?: string | null;
}): string | null {
  if (!arquivo.filename) return null;
  return arquivo.filepath
    ? `${arquivo.filepath}/${arquivo.filename}`
    : arquivo.filename;
}

/**
 * Whether to delete the Storage object on an `Arquivo` doc delete. `count` is
 * the number of OTHER `Arquivo` docs sharing the same `filepath`+`filename`;
 * delete only when none remain (refcount = 0).
 */
export function shouldDeleteObject(otherRefsWithSamePath: number): boolean {
  return otherRefsWithSamePath === 0;
}

/**
 * Grace-period guard for the orphan sweep: only reap a doc whose `criadoEm` is
 * older than `graceMs`. A missing/invalid timestamp returns false — so a
 * just-uploaded (not-yet-linked) file, and any pre-`criadoEm` Flutter doc, are
 * never reaped by our sweep.
 */
export function isOlderThanGrace(
  criadoEm: string | null | undefined,
  nowMs: number,
  graceMs: number,
): boolean {
  if (!criadoEm) return false;
  const t = Date.parse(criadoEm);
  if (Number.isNaN(t)) return false;
  return nowMs - t >= graceMs;
}
