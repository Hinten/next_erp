/**
 * Every `mensagem` field that may reference a top-level `arquivos` document.
 * This list is also the source of truth for the collection-group indexes used
 * by the orphan sweep.
 */
export const MENSAGEM_ARQUIVO_REF_FIELDS = [
  'anexoStorage',
  'audio.audio',
  'image.image',
  'video.video',
  'sticker.sticker',
  'genericDocument.genericDocument',
] as const;

export type MensagemArquivoRefField = (typeof MENSAGEM_ARQUIVO_REF_FIELDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Extract and de-duplicate Arquivo ids from a raw mensagem shape.
 *
 * Both legacy wire forms are accepted (`arquivos/<id>` and
 * `documents/arquivos/<id>`). Malformed refs and refs to another collection are
 * ignored: trigger/sweep callers operate on untrusted legacy snapshots and must
 * not turn one bad field into an infinite Eventarc retry.
 */
export function extractMensagemArquivoIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  for (const field of MENSAGEM_ARQUIVO_REF_FIELDS) {
    const ref = readPath(raw, field);
    if (typeof ref !== 'string') continue;
    const parts = ref.split('/');
    const id =
      parts.length === 2 && parts[0] === 'arquivos'
        ? parts[1]
        : parts.length === 3 && parts[0] === 'documents' && parts[1] === 'arquivos'
          ? parts[2]
          : null;
    if (id) ids.add(id);
  }
  return ids;
}

/** Both string encodings found in the imported corpus and current writers. */
export function mensagemArquivoRefValues(arquivoId: string): readonly [string, string] {
  return [`arquivos/${arquivoId}`, `documents/arquivos/${arquivoId}`];
}
